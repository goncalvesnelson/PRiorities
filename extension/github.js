import { parseDiff } from './diff.js';
import { defaultFileLimit, isGeneratedFile, maxChangedFiles, validateSnapshot } from './review-data.js';

const shaPattern = /^[a-f0-9]{40}$/;
const MAX_HTML = 16_000_000;
const diffFragmentSelector = '.js-diff-progressive-container include-fragment[src], .js-file include-fragment[src], .js-file include-fragment.js-diff-entry-loader[data-fragment-url]';

export function pullRequestLocation(href) {
  const url = new URL(href);
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/|$)/.exec(url.pathname);
  if (url.origin !== 'https://github.com' || !match) return null;
  return { url: `${url.origin}/${match[1]}/${match[2]}/pull/${match[3]}`, owner: match[1], repo: match[2], number: Number(match[3]) };
}

function embeddedData(doc) {
  const result = [];
  for (const script of doc.querySelectorAll('script[type="application/json"][data-target$="embeddedData"]')) {
    try { result.push(JSON.parse(script.textContent)); } catch {}
  }
  return result;
}

function findObject(value, predicate, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 12) return null;
  if (!Array.isArray(value) && predicate(value)) return value;
  for (const child of Object.values(value)) {
    if (child === null || typeof child !== 'object') continue;
    const found = findObject(child, predicate, depth + 1);
    if (found) return found;
  }
  return null;
}

function reactDiff(doc) {
  for (const data of embeddedData(doc)) {
    const route = findObject(data, item => Array.isArray(item.diffEntryData) && item.diffEntryData.length && item.diffEntryData.every(file => typeof file.path === 'string' && Array.isArray(file.diffLines)));
    if (route) return route;
  }
  return null;
}

function changesRoute(doc) {
  for (const data of embeddedData(doc)) {
    const route = data?.payload?.pullRequestsChangesRoute;
    if (route) return route;
  }
  return null;
}

export function readPageIdentity(doc = document, href = location.href) {
  const identity = pullRequestLocation(href);
  if (!identity) return null;
  const route = changesRoute(doc);
  const comparison = route?.comparison;
  if (comparison) {
    const selected = comparison.selectedRange ?? (comparison.viewing === 'FULL' ? comparison.fullDiff : null);
    // Full-PR file diffs use the merge base; fullDiff.baseOid names the target branch commit.
    const baseOid = comparison.selectedRange ? selected.baseOid : selected && route.diffContents?.[0]?.oldCommitOid;
    return { ...identity, baseSha: shaPattern.test(baseOid) ? baseOid : null, headSha: shaPattern.test(selected?.headOid) ? selected.headOid : null };
  }
  for (const element of doc.querySelectorAll('[data-url]')) {
    const url = new URL(element.getAttribute('data-url'), identity.url);
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith(`/${identity.owner}/${identity.repo}/`)) continue;
    const diff = /\/diffs\/([a-f0-9]{40})\.\.([a-f0-9]{40})$/.exec(url.pathname);
    if (diff) return { ...identity, baseSha: diff[1], headSha: diff[2] };
    if (url.pathname === new URL(identity.url).pathname + '/show_partial_comparison') {
      const baseSha = url.searchParams.get('start_commit_oid');
      const headSha = url.searchParams.get('end_commit_oid');
      if (shaPattern.test(baseSha) && shaPattern.test(headSha)) return { ...identity, baseSha, headSha };
    }
  }
  for (const data of embeddedData(doc)) {
    const pull = findObject(data, item => shaPattern.test(item.headOid ?? item.headRefOid ?? item.headSha) && shaPattern.test(item.mergeBaseOid ?? item.baseOid ?? item.baseRefOid ?? item.baseSha));
    if (pull) return { ...identity, headSha: pull.headOid ?? pull.headRefOid ?? pull.headSha, baseSha: pull.mergeBaseOid ?? pull.baseOid ?? pull.baseRefOid ?? pull.baseSha };
  }
  const entries = reactDiff(doc)?.diffEntryData;
  if (entries?.length && entries.every(file => file.oldOid === entries[0].oldOid && file.newOid === entries[0].newOid) && shaPattern.test(entries[0].oldOid) && shaPattern.test(entries[0].newOid)) return { ...identity, baseSha: entries[0].oldOid, headSha: entries[0].newOid };
  return { ...identity, baseSha: null, headSha: null };
}

function codeRow(row) {
  const codes = [...row.querySelectorAll('.blob-code-inner[data-code-marker]')];
  if (!codes.length && row.classList.contains('diff-line-row') && row.children.length === 3) {
    const code = row.querySelector('.diff-text > .diff-text-inner');
    const numbers = [...row.querySelectorAll('.diff-line-number, .new-diff-line-number')];
    if (!code || numbers.length !== 2) return null;
    const text = code.textContent;
    const type = code.parentElement.classList.contains('addition') ? 'add' : code.parentElement.classList.contains('deletion') ? 'delete' : 'context';
    const oldLine = type === 'add' ? null : Number(numbers[0].textContent.trim()) || null;
    const newLine = type === 'delete' ? null : Number(numbers[1].textContent.trim()) || null;
    if (oldLine === null && newLine === null) return null;
    return { element: row, oldLine, newLine, type, text };
  }
  if (codes.length !== 1) return null;
  const code = codes[0];
  const marker = code.getAttribute('data-code-marker');
  if (![' ', '+', '-'].includes(marker)) return null;
  const numbers = [...row.querySelectorAll('[data-line-number]')];
  const left = numbers.find(cell => /L\d+$/.test(cell.id));
  const right = numbers.find(cell => /R\d+$/.test(cell.id));
  const oldLine = left ? Number(left.getAttribute('data-line-number')) : null;
  const newLine = right ? Number(right.getAttribute('data-line-number')) : null;
  if (oldLine === null && newLine === null) return null;
  return { element: row, oldLine, newLine, type: marker === '+' ? 'add' : marker === '-' ? 'delete' : 'context', text: code.textContent };
}

export function findNativeFiles(doc = document) {
  const classic = [...doc.querySelectorAll('.js-file')].flatMap(element => {
    const path = element.getAttribute('data-tagsearch-path') ?? element.querySelector('.file-header[data-path]')?.getAttribute('data-path');
    if (!path || path.includes('{{')) return [];
    const rows = [...element.querySelectorAll('table tr')].map(codeRow).filter(Boolean);
    return [{ path, element, rows }];
  });
  const entries = changesRoute(doc)?.diffSummaries ?? reactDiff(doc)?.diffEntryData ?? [];
  const modern = [...doc.querySelectorAll('table[data-diff-anchor]')].filter(table => !table.closest('.js-file')).flatMap(table => {
    const entry = entries.find(file => `diff-${file.pathDigest}` === table.getAttribute('data-diff-anchor'));
    const element = table.closest('[role="region"][aria-labelledby]') ?? table;
    const path = entry?.path ?? element.querySelector('[class*="file-name"] code')?.textContent;
    if (!path) return [];
    return [{ path, element, rows: [...table.querySelectorAll('tr.diff-line-row')].map(codeRow).filter(Boolean) }];
  });
  const mounted = new Set(modern.map(file => file.element));
  for (const entry of entries) {
    const element = doc.getElementById(`diff-${entry.pathDigest}`);
    if (!element?.matches('[role="region"][aria-labelledby]') || mounted.has(element) || element.closest('.js-file')) continue;
    modern.push({ path: entry.path, element, rows: [] });
  }
  return [...classic, ...modern];
}

function assertCompleteHunks(files) {
  for (const file of files) {
    for (const hunk of file.hunks) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
      const rows = hunk.items.flatMap(item => item.type === 'edit' ? item.rows : [item]).filter(row => row.type !== 'marker');
      if (!match || rows.filter(row => row.type !== 'add').length !== Number(match[2] ?? 1) || rows.filter(row => row.type !== 'delete').length !== Number(match[4] ?? 1)) throw new Error(`GitHub supplied an incomplete hunk for ${file.path}. No analysis was sent.`);
    }
  }
}

function fileDiff(file) {
  const result = [`diff --git a/${file.path} b/${file.path}`, `--- a/${file.path}`, `+++ b/${file.path}`];
  let oldCount = 0;
  let newCount = 0;
  let expected = null;
  const checkCounts = () => {
    if (expected && (oldCount !== expected.old || newCount !== expected.new)) throw new Error(`GitHub has not supplied the complete diff for ${file.path}. Load that file and retry.`);
  };
  for (const row of file.element.querySelectorAll('table tr')) {
    const header = row.querySelector('.blob-code-hunk')?.textContent.trim();
    const match = header && /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (match) {
      checkCounts();
      expected = { old: Number(match[2] ?? 1), new: Number(match[4] ?? 1) };
      oldCount = 0;
      newCount = 0;
      result.push(header);
      continue;
    }
    const code = codeRow(row);
    if (!code) continue;
    if (!expected) throw new Error(`GitHub's diff layout for ${file.path} could not be read.`);
    result.push((code.type === 'add' ? '+' : code.type === 'delete' ? '-' : ' ') + code.text);
    if (code.type !== 'add') oldCount++;
    if (code.type !== 'delete') newCount++;
  }
  checkCounts();
  return result.join('\n');
}

function expectedFileCount(doc) {
  const types = [...doc.querySelectorAll('.js-file-type-count[data-all-file-count-markup]')];
  if (types.length) {
    const counts = types.map(type => Number(/^\(([\d,]+)\)$/.exec(type.getAttribute('data-all-file-count-markup'))?.[1].replace(/,/g, '')));
    if (counts.every(count => Number.isSafeInteger(count) && count >= 0)) return counts.reduce((sum, count) => sum + count, 0);
  }
  const count = doc.querySelector('#files_tab_counter, [data-tab-item="files-tab"] .Counter, a[href$="/files"] .Counter, a[href$="/changes"] .Counter');
  const value = Number(count?.textContent.replace(/,/g, '').trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function checkFileCount(total, deleted, fileLimit) {
  if (total > maxChangedFiles) throw new Error(`This PR changes ${total} files; PRiorities reads up to ${maxChangedFiles}. Use Full diff to review it. No analysis was sent.`);
  const analyzed = total - deleted;
  if (analyzed <= fileLimit) return;
  const scope = deleted ? `${analyzed} files besides ${deleted} deleted ${deleted === 1 ? 'file' : 'files'}` : `${analyzed} files`;
  throw new Error(`This PR changes ${scope}; PRiorities analyzes up to ${fileLimit} (change this in Settings). Use Full diff to review it. No analysis was sent.`);
}

function isDeletedFile(file) {
  return file.hunks.length === 1 && / \+0,0 @@/.test(file.hunks[0].header);
}

function separateDeletedFiles(loaded, { fileLimit, listDeletedFiles }) {
  const deleted = listDeletedFiles ? loaded.files.filter(isDeletedFile) : [];
  checkFileCount(loaded.files.length, deleted.length, fileLimit);
  if (!listDeletedFiles) return loaded;
  const deletedPaths = new Set(deleted.map(file => file.path));
  return { ...loaded, files: loaded.files.filter(file => !deletedPaths.has(file.path)), deletedFiles: deleted.map(file => ({ path: file.path, deletions: file.deletions })) };
}

function repositoryUrl(href, identity) {
  const url = new URL(href, identity.url);
  if (url.origin !== 'https://github.com' || url.username || url.password || !url.pathname.startsWith(`/${identity.owner}/${identity.repo}/`)) throw new Error('GitHub returned an unexpected diff URL.');
  return url;
}

async function loadFileCount(doc, identity, signal) {
  const count = expectedFileCount(doc);
  if (count !== null) return count;
  const tabsPath = new URL(identity.url).pathname + '/partials/tabs';
  for (const fragment of doc.querySelectorAll('include-fragment[src]')) {
    const url = new URL(fragment.getAttribute('src'), identity.url);
    if (url.pathname !== tabsPath) continue;
    return expectedFileCount(await fetchDocument(repositoryUrl(url.href, identity).href, signal));
  }
  return null;
}

async function fetchText(url, signal, redirect = 'follow', headers = { Accept: 'text/html' }, rawOrigin) {
  const response = await fetch(url, { credentials: 'same-origin', signal, redirect, headers });
  if (!response.ok) throw new Error(`GitHub could not load the PR source (${response.status}). Check that you can open this repository, then retry.`);
  const requested = new URL(url);
  const received = new URL(response.url || url);
  if (received.pathname.startsWith('/login')) throw new Error('Sign in to GitHub, then analyze this PR again.');
  const repository = requested.pathname.split('/').slice(0, 3).join('/') + '/';
  if (received.origin !== requested.origin && received.origin !== rawOrigin || !received.pathname.toLowerCase().startsWith(repository.toLowerCase())) throw new Error('GitHub redirected this source outside the requested repository.');
  if (Number(response.headers.get('content-length')) > MAX_HTML) throw new Error('This GitHub page is too large for the prototype.');
  const text = await response.text();
  if (text.length > MAX_HTML) throw new Error('This GitHub page is too large for the prototype.');
  return text;
}

// Reading pages one at a time made each capture, including opening a saved review, take over 12 seconds. The cap keeps bursts to GitHub bounded.
const PARALLEL_REQUESTS = 6;

async function mapLimited(items, task) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_REQUESTS, items.length) }, worker));
  return results;
}

async function fetchDocument(url, signal, redirect = 'follow') {
  return new DOMParser().parseFromString(await fetchText(url, signal, redirect), 'text/html');
}

function needsDiffText(file) {
  return Boolean(file.isTooBig || file.truncatedReason || (Array.isArray(file.diffLines) && !file.diffLines.length && file.linesChanged > 0 && !file.isBinary && !file.isSubmodule));
}

function parseEntries(entries) {
  const patches = entries.map(file => {
    if (!file || typeof file.path !== 'string' || !Array.isArray(file.diffLines)) throw new Error('GitHub returned an unsupported diff entry. No analysis was sent.');
    if (needsDiffText(file)) throw new Error(`GitHub has not supplied the full text diff for ${file.path}. Load it and retry.`);
    const lines = file.diffLines.map(line => {
      const prefix = { HUNK: '@@ ', ADDITION: '+', DELETION: '-', CONTEXT: ' ' }[line.type];
      if (!prefix || typeof line.text !== 'string' || !line.text.startsWith(prefix)) throw new Error('GitHub returned an unsupported diff row. No analysis was sent.');
      return line.text;
    });
    return [`diff --git a/${file.path} b/${file.path}`, `--- a/${file.path}`, `+++ b/${file.path}`, ...lines].join('\n');
  });
  const files = parseDiff(patches.join('\n'));
  assertCompleteHunks(files);
  for (let index = 0; index < files.length; index++) {
    const entry = entries[index];
    if (entry.isGenerated === true || entry.newTreeEntry?.isGenerated === true || !entry.newTreeEntry && entry.oldTreeEntry?.isGenerated === true) files[index].isGenerated = true;
    if (entry.diffLines.length && (files[index].additions !== entry.linesAdded || files[index].deletions !== entry.linesDeleted)) throw new Error(`GitHub supplied an incomplete diff for ${entry.path}. No analysis was sent.`);
  }
  return { files, warnings: files.filter(file => !file.hunks.length).map(file => `No text diff was available for ${file.path}; inspect it in GitHub. It will not be folded.`) };
}

async function fetchChangeData(doc, identity, endpoint, params, signal) {
  const nonce = doc.querySelector('meta[name="fetch-nonce"]')?.content;
  if (!nonce) throw new Error('GitHub did not supply the request information needed to load the remaining files. Refresh the PR and retry.');
  const headers = {
    Accept: 'application/json', 'Content-Type': 'application/json',
    'GitHub-Is-React': 'true', 'GitHub-Verified-Fetch': 'true',
    'X-Requested-With': 'XMLHttpRequest', 'X-Fetch-Nonce': nonce,
    'X-GitHub-Client-Version': doc.querySelector('meta[name="release"]')?.content ?? ''
  };
  const text = await fetchText(`${identity.url}/page_data/${endpoint}?${params}`, signal, 'error', headers);
  try { return JSON.parse(text); } catch { throw new Error('GitHub returned unreadable diff data. No analysis was sent.'); }
}

function fetchChangeEntries(doc, identity, range, paths, signal) {
  const params = new URLSearchParams({ paths: paths.map(encodeURIComponent).join(','), w: '0', range });
  return fetchChangeData(doc, identity, 'diff_entries', params, signal);
}

async function loadChanges(doc, route, identity, { fileLimit, listDeletedFiles }, signal, onProgress) {
  const { diffSummaries, diffContents, comparison, pageLimits } = route;
  if (!Array.isArray(diffSummaries) || !diffSummaries.length || !Array.isArray(diffContents)) throw new Error('GitHub did not supply a readable list of changed files. No analysis was sent.');
  const selected = comparison?.selectedRange ?? (comparison?.viewing === 'FULL' ? comparison.fullDiff : null);
  if (comparison?.selectedRange && selected.baseOid !== identity.baseSha || selected?.headOid !== identity.headSha || pageLimits?.filesLimitExceeded || pageLimits?.linesChangedLimitExceeded) throw new Error('GitHub supplied an incomplete comparison. Load the selected diff with whitespace changes shown and retry.');
  const range = comparison.selectedRange ? `${identity.baseSha}..${identity.headSha}` : identity.headSha;
  const summaries = new Map();
  for (const summary of diffSummaries) {
    if (!summary || typeof summary.path !== 'string' || summaries.has(summary.path) || ![summary.linesAdded, summary.linesDeleted, summary.linesChanged].every(count => Number.isSafeInteger(count) && count >= 0) || summary.linesChanged !== summary.linesAdded + summary.linesDeleted) throw new Error('GitHub returned an invalid or duplicate file inventory. No analysis was sent.');
    summaries.set(summary.path, summary);
  }
  const deleted = listDeletedFiles ? [...summaries.values()].filter(summary => summary.changeType === 'REMOVED') : [];
  checkFileCount(summaries.size, deleted.length, fileLimit);
  const deletedPaths = new Set(deleted.map(summary => summary.path));
  for (const path of deletedPaths) summaries.delete(path);
  const entries = new Map();
  function addEntries(batch, paths) {
    if (!Array.isArray(batch) || paths && batch.length !== paths.length) throw new Error('GitHub did not supply every requested file diff. No analysis was sent.');
    for (const entry of batch) {
      const summary = summaries.get(entry?.path);
      if (!summary || entries.has(entry.path) || paths && !paths.includes(entry.path)) throw new Error('GitHub returned an unexpected or duplicate diff file. No analysis was sent.');
      if (entry.oldCommitOid !== identity.baseSha || entry.newCommitOid !== identity.headSha) throw new Error('The pull request changed while reading its diffs. Analyze again to review the latest version.');
      if (entry.linesAdded !== summary.linesAdded || entry.linesDeleted !== summary.linesDeleted || entry.linesChanged !== summary.linesChanged) throw new Error(`GitHub supplied inconsistent diff counts for ${entry.path}. No analysis was sent.`);
      entries.set(entry.path, entry);
    }
  }
  addEntries(diffContents.filter(entry => !deletedPaths.has(entry?.path)));
  const missing = [...summaries.keys()].filter(path => !entries.has(path));
  onProgress(`Reading all ${summaries.size} changed files…`);
  const batches = [];
  for (let offset = 0; offset < missing.length; offset += 4) batches.push(missing.slice(offset, offset + 4));
  await mapLimited(batches, async paths => {
    addEntries(await fetchChangeEntries(doc, identity, range, paths, signal), paths);
    onProgress(`Reading changed files: ${entries.size} of ${summaries.size}…`, { done: entries.size, total: summaries.size });
  });
  await mapLimited([...entries.values()].filter(needsDiffText), async entry => {
    onProgress(`Loading deferred diff for ${entry.path}…`);
    const paths = [entry.path];
    const batch = await fetchChangeEntries(doc, identity, range, paths, signal);
    entries.delete(entry.path);
    addEntries(batch, paths);
    const loaded = entries.get(entry.path);
    if (!needsDiffText(loaded)) return;
    const params = new URLSearchParams({ path: entry.path, w: '0', range });
    const data = await fetchChangeData(doc, identity, 'diff_entry_lines', params, signal);
    if (!Array.isArray(data?.diffEntryLines) || !data.diffEntryLines.length) throw new Error(`GitHub has not supplied the full text diff for ${entry.path}. Load it and retry.`);
    entries.set(entry.path, { ...loaded, diffLines: data.diffEntryLines, isTooBig: false, truncatedReason: null });
  });
  if (entries.size !== summaries.size) throw new Error(`GitHub supplied ${entries.size} of ${summaries.size} files. No analysis was sent.`);
  const loaded = parseEntries([...summaries.keys()].map(path => entries.get(path)));
  return listDeletedFiles ? { ...loaded, deletedFiles: deleted.map(summary => ({ path: summary.path, deletions: summary.linesDeleted })) } : loaded;
}

async function loadFiles(doc, identity, limits, signal, onProgress) {
  const changes = changesRoute(doc);
  if (changes) return loadChanges(doc, changes, identity, limits, signal, onProgress);
  const modern = reactDiff(doc);
  if (modern) {
    if (modern.moreDiffsToLoad || modern.asyncDiffLoadInfo?.truncated || modern.ignoreWhitespace || Number.isInteger(modern.headerInfo?.filesChanged) && modern.headerInfo.filesChanged !== modern.diffEntryData.length) throw new Error('GitHub supplied a partial or whitespace-filtered diff. Load all files with whitespace changes shown, then retry.');
    return separateDeletedFiles(parseEntries(modern.diffEntryData), limits);
  }
  const expected = await loadFileCount(doc, identity, signal);
  if (expected === null) throw new Error('GitHub did not supply the total changed-file count. Refresh the PR and retry. No analysis was sent.');
  // Deleted files are only recognizable once their diffs load, so this early check can bound only the whole inventory.
  checkFileCount(expected, 0, limits.listDeletedFiles ? maxChangedFiles : limits.fileLimit);
  onProgress(`Reading all ${expected} changed files…`);
  const visited = new Set();
  for (let page = 0; page < 200; page++) {
    const fragment = [...doc.querySelectorAll(diffFragmentSelector)].find(element => !visited.has(element.getAttribute('src') ?? element.getAttribute('data-fragment-url')));
    if (!fragment) break;
    const href = fragment.getAttribute('src') ?? fragment.getAttribute('data-fragment-url');
    const url = repositoryUrl(href, identity);
    visited.add(href);
    const next = await fetchDocument(url.href, signal);
    fragment.replaceWith(...next.body.childNodes);
  }
  const native = findNativeFiles(doc);
  if (!native.length) throw new Error('This GitHub diff layout is not supported yet. Open Files changed in the classic unified view and retry.');
  if (native.length !== expected) throw new Error(`GitHub supplied ${native.length} of ${expected} files. Load the full Files changed page and retry.`);
  if (doc.querySelector(diffFragmentSelector)) throw new Error('Some GitHub diffs have not loaded. Load the remaining files and retry.');
  const files = parseDiff(native.map(fileDiff).join('\n'));
  assertCompleteHunks(files);
  const warnings = files.filter(file => !file.hunks.length).map(file => `No text diff was available for ${file.path}; inspect it in GitHub. It will not be folded.`);
  return separateDeletedFiles({ files, warnings }, limits);
}

function originalBody(doc) {
  return doc.querySelector('[data-testid="issue-body-viewer"], [id^="issue-"] .js-comment-body, [id^="issue-"] .comment-body');
}

async function linkedIssueContext(body, identity, warnings, signal) {
  if (!body) return '';
  const references = body.cloneNode(true);
  for (const code of references.querySelectorAll('pre, code')) code.remove();
  const urls = new Set();
  for (const link of references.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    link.replaceWith(' [linked reference] ');
    let url;
    try { url = new URL(href, identity.url); } catch { continue; }
    const match = /^\/([\w.-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
    if (url.origin !== 'https://github.com' || url.username || url.password || !match || match[1].toLowerCase() !== identity.owner.toLowerCase() || match[2].toLowerCase() !== identity.repo.toLowerCase()) continue;
    urls.add(`https://github.com/${identity.owner}/${identity.repo}/issues/${match[3]}`);
  }
  for (const match of references.textContent.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/gi)) {
    urls.add(`https://github.com/${identity.owner}/${identity.repo}/issues/${match[1]}`);
  }
  if (urls.size > 3) warnings.push(`Linked issue context is limited to 3 of ${urls.size} references in the PR description.`);
  const issues = await mapLimited([...urls].slice(0, 3), async url => {
    const number = url.split('/').at(-1);
    try {
      const issue = await fetchDocument(url, signal, 'error');
      const title = issue.querySelector('.js-issue-title, [data-testid="issue-title"]')?.textContent.trim();
      const description = originalBody(issue)?.textContent.trim();
      if (!title || !description) throw new Error('The issue title or original description was unavailable.');
      const context = `\n\nLinked issue #${number}: ${url}\nTitle: ${title}\nDescription:\n${description}`;
      return { context: context.slice(0, 4000), warning: context.length > 4000 ? `Linked issue #${number} exceeded its context budget; its description was truncated.` : '' };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { context: '', warning: `Could not read linked issue #${number}; its context was not included.` };
    }
  });
  let result = '';
  for (const { context, warning } of issues) {
    result += context;
    if (warning) warnings.push(warning);
  }
  return result;
}

async function readDescription(url, identity, warnings, signal) {
  const body = originalBody(await fetchDocument(url, signal));
  const description = body?.textContent.trim() ?? '';
  if (!description) warnings.push('The PR description was unavailable; intent was inferred only from code.');
  return description + await linkedIssueContext(body, identity, warnings, signal);
}

export async function capturePullRequest({ onProgress = () => {}, signal, fileLimit = defaultFileLimit, listDeletedFiles = false } = {}) {
  const initial = readPageIdentity(document, location.href);
  if (!initial) throw new Error('Open a GitHub pull request first.');
  const pathname = location.pathname;
  if (!/^\/[^/]+\/[^/]+\/pull\/\d+\/(?:(?:files|changes)(?:\/|$)|commits\/[a-f0-9]{40}(?:\/|$))/.test(pathname)) throw new Error('Open the pull request’s Files changed tab first.');
  const filesUrl = `${location.origin}${pathname}?diff=unified&w=0`;
  onProgress('Reading the complete selected diff…');
  const doc = await fetchDocument(filesUrl, signal);
  const identity = readPageIdentity(doc, filesUrl);
  if (!identity?.baseSha || !identity.headSha) throw new Error('GitHub did not identify the commits in this diff. Refresh Files changed and retry.');
  if (initial.baseSha && initial.baseSha !== identity.baseSha || initial.headSha && initial.headSha !== identity.headSha) throw new Error('The comparison changed while reading its diffs. Analyze again to review the selected commits.');
  const descriptionWarnings = [];
  const [{ files, warnings, deletedFiles }, description] = await Promise.all([
    loadFiles(doc, identity, { fileLimit, listDeletedFiles }, signal, onProgress),
    readDescription(initial.url, identity, descriptionWarnings, signal)
  ]);
  if (!files.length) throw new Error('Every file in this PR is deleted, and Settings lists deleted files without analyzing them. Use Full diff to review it, or turn that setting off. No analysis was sent.');
  warnings.push(...descriptionWarnings);
  const title = doc.querySelector('.js-issue-title, [data-testid="issue-title"]')?.textContent.trim() ?? doc.title.replace(/ · Pull Request.*$/, '');
  onProgress(`Reading context for ${files.length} changed files…`);
  const context = [];
  let contextBytes = 0;
  const runtime = files.filter(file => file.hunks.length && !isGeneratedFile(file) && !/(^|\/)(tests?|__tests__|__snapshots__|vendor|node_modules)\/|(?:\.snap|\.lock|\.min\.js|_test\.go)$|(?:\.test|\.spec)\./i.test(file.path));
  const sourced = runtime.slice(0, 6);
  const sides = sourced.flatMap(file => ['after', 'before'].map(side => ({ file, side })));
  const sources = await mapLimited(sides, async ({ file, side }) => {
    const emptySide = side === 'before' ? /^@@ -0,0 / : / \+0,0 @@/;
    if (file.hunks.length === 1 && emptySide.test(file.hunks[0].header)) return { empty: true };
    const sha = side === 'after' ? identity.headSha : identity.baseSha;
    const path = file.path.split('/').map(encodeURIComponent).join('/');
    try {
      // GitHub's raw route redirects to raw.githubusercontent.com, which serves the exact file bytes under the same owner and repository path.
      return { text: await fetchText(`https://github.com/${identity.owner}/${identity.repo}/raw/${sha}/${path}`, signal, 'follow', {}, 'https://raw.githubusercontent.com') };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { failed: true };
    }
  });
  // The context budget is spent in file order, so the snapshot and its saved-review key match a sequential read.
  sides.forEach(({ file, side }, index) => {
    const { empty, failed, text } = sources[index];
    if (empty) {
      context.push({ path: file.path, side, text: '' });
      return;
    }
    if (failed) {
      warnings.push(`Could not read ${side} context for ${file.path}; only its diff was analyzed.`);
      return;
    }
    if (text.length > 220_000 || contextBytes + text.length > 700_000) {
      warnings.push(`Full ${side} source for ${file.path} exceeded the context budget; only its diff was analyzed.`);
      return;
    }
    context.push({ path: file.path, side, text });
    contextBytes += text.length;
  });
  // Empty sides of added and deleted files are part of the context too, so a file is complete when both of its sides are.
  const collected = sourced.filter(file => context.filter(source => source.path === file.path).length === 2).length;
  if (runtime.length > 6) warnings.push(`Full source was collected for ${collected} of ${runtime.length} runtime files. Other files are represented by their complete diff.`);
  onProgress('Checking that the PR has not changed…');
  const latest = readPageIdentity(await fetchDocument(filesUrl, signal), filesUrl);
  if (latest?.headSha !== identity.headSha || latest?.baseSha !== identity.baseSha || location.pathname !== pathname) throw new Error('The comparison changed while reading it. Analyze again to review the selected commits.');
  return validateSnapshot({ url: initial.url, title, description, baseSha: identity.baseSha, headSha: identity.headSha, files, context, warnings, ...(deletedFiles ? { deletedFiles } : {}) });
}
