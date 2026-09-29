import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNativeHost } from './install-native-host.mjs';
import { deferred } from './test-fixtures/github-deferred.mjs';
import { changes } from './test-fixtures/github-changes.mjs';

const baseSha = '998fb692680cc20d70a805df8fa59cb1443bc897';
const headSha = '9ed10330f92962e92c6b121fd0cf6588268e89a8';
const prUrl = 'https://github.com/microsoft/vscode/pull/200000';
const sourcePath = 'src/vs/editor/contrib/suggest/browser/suggestWidgetRenderer.ts';
const classic = await readFile(new URL('test-fixtures/github-classic.html', import.meta.url), 'utf8');
const react = await readFile(new URL('test-fixtures/github-react.html', import.meta.url), 'utf8');
const rawLines = JSON.parse(await readFile(new URL('test-fixtures/github-source.json', import.meta.url), 'utf8'));
const sourcePage = `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { blob: { rawLines } } }).replace(/</g, '\\u003c')}</script>`;
const fixtureStyle = '<style>:root{--bgColor-default:#fff;--bgColor-muted:#f6f8fa;--fgColor-default:#1f2328;--fgColor-muted:#59636e;--borderColor-default:#d1d9e0;--fgColor-accent:#0969da;--diffBlob-additionLine-bgColor:#dafbe1;--diffBlob-deletionLine-bgColor:#ffebe9}body{margin:24px;font:14px system-ui;color:#1f2328;background:#fff}main{max-width:1300px;margin:auto}.file{border:1px solid #d1d9e0;border-radius:6px;margin:16px 0}.file-header{background:#f6f8fa;padding:12px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}.blob-code-inner{white-space:pre;font:12px monospace}.blob-num{width:45px;color:#59636e}.blob-code-addition{background:#dafbe1}.blob-code-hunk{background:#ddf4ff}.sr-only,template{display:none}button{cursor:pointer}</style>';
const fixture = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + fixtureStyle + '<main><h1 class="js-issue-title">Apply font variation settings to suggestions</h1><a href="/microsoft/vscode/pull/200000/files">Files changed <span class="Counter">1</span></a>' + classic.replace(/^.*?<main>/s, '').replace(/<\/main>\s*$/, '') + '</main>';
const description = 'Apply editor font variation settings to suggestion labels.';
const discussionPage = `<main><div id="issue-2025089863"><div class="js-comment-body">${description}
  <p>Fixes <a href="/microsoft/vscode/issues/901#issuecomment-1">#901</a>.
  <a href="https://github.com/microsoft/vscode/issues/901?duplicate=1">Same issue</a>.</p>
  <p>Closes #902. Resolves #903. Fixes #904.</p>
  <p>Closes <a href="https://example.com/microsoft/vscode/issues/990">#990</a>.
  Fixes <a href="https://github.com/other/repo/issues/991">#991</a>.
  <a href="https://github.com/microsoft/vscode/pull/992">Related PR</a>.</p>
  <pre>Fixes #993</pre><code>Resolves #994</code>
  </div></div><div id="issuecomment-1"><div class="js-comment-body">Fixes #995.
  <a href="/microsoft/vscode/issues/996">A later comment's reference</a>.</div></div></main>`;
const issuePage = `<h1 data-testid="issue-title">Suggestion font parity</h1><div data-testid="issue-body">
  <div data-testid="issue-body-viewer">The widget must match the editor when font variations change.
  ${'Bounded issue evidence. '.repeat(250)}NOT_INCLUDED_PAST_ISSUE_BUDGET</div></div>
  <div class="comment-body">NOT_INCLUDED_ISSUE_COMMENT</div>`;
const assessment = {
  summary: 'Confirm the suggestion widget follows editor font variation settings.',
  topics: [{ id: 'font-settings', priority: 'review', title: 'Check both suggestion rendering paths', reason: 'Both rendering paths must match the editor typography; missing one leaves suggestions inconsistent.', before: 'The widget did not set font variation settings.', after: 'Each path applies the configured variation settings.', question: 'Do both paths receive the intended font setting?', uncertainty: 'No application tests were run.', evidenceSummary: 'Two assignments update the suggestion widget.', editIds: ['0-0-3', '0-1-3'], excerpts: [{ path: sourcePath, side: 'after', startLine: 137, endLine: 137 }] }]
};
const classifications = ['0-0-3', '0-1-3'].map(editId => ({ editId, kinds: ['behavior'], reason: 'The assignment applies a font variation setting.', uncertainty: '' }));
const profile = await mkdtemp(join(tmpdir(), 'review-focus-extension-'));
const requestLog = join(profile, 'codex-requests.jsonl');
const statusLog = join(profile, 'cli-status.jsonl');
const lifecycleLog = join(profile, 'codex-lifecycle.jsonl');
const modeFile = join(profile, 'codex-mode');
const uxGate = join(profile, 'review-progress-gate');
const fakeCodex = join(profile, 'fake-codex.mjs');
await writeFile(requestLog, '');
await writeFile(statusLog, '');
await writeFile(lifecycleLog, '');
await writeFile(modeFile, 'normal');
await writeFile(fakeCodex, `#!${process.execPath}
import { readFile, writeFile, appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const isClaude = args.includes('--safe-mode');
const mode = await readFile(${JSON.stringify(modeFile)}, 'utf8');
if (args.includes('auth') || args.includes('login')) await appendFile(${JSON.stringify(statusLog)}, 'status\\n');
if (args.includes('auth')) {
  process.stdout.write(JSON.stringify({loggedIn:mode!=='signed-out',authMethod:mode==='signed-out'?'none':'claude.ai',apiProvider:'firstParty'}));
  process.exit(0);
}
if (args.includes('login')) {
  process.stderr.write(mode === 'signed-out' ? 'Not logged in\\n' : 'Logged in using ChatGPT\\n');
  process.exit(mode === 'signed-out' ? 1 : 0);
}
if (args.includes('app-server') || args.includes('--input-format')) {
  const { createInterface } = await import('node:readline');
  createInterface({input:process.stdin}).on('line', line => {
    const message = JSON.parse(line);
    if (isClaude) console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'catalog',response:{models:[{value:'default',resolvedModel:'claude-fixture-model',displayName:'Claude fixture model',supportedEffortLevels:['low','medium','high']},{value:'older',resolvedModel:'claude-fixture-older',displayName:'Older Claude fixture',supportedEffortLevels:['low','high']}]}}}));
    else if (message.method === 'initialize') console.log(JSON.stringify({id:1,result:{}}));
    else if (message.method === 'model/list') console.log(JSON.stringify({id:2,result:{data:[{model:'fixture-model',displayName:'Codex fixture model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}],defaultReasoningEffort:'high',isDefault:true}],nextCursor:null}}));
  });
} else {
if (mode === 'analysis-failed') process.exit(1);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const schema = isClaude ? JSON.parse(args[args.indexOf('--json-schema')+1]) : JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
const evidence = JSON.parse(input);
let labels = ${JSON.stringify(classifications)};
let review = ${JSON.stringify(assessment)};
if (mode === 'parallel' || mode === 'generated-review' || mode === 'many-decisions') {
  labels = evidence.files.flatMap(file => file.hunks.flatMap(hunk => hunk.items.filter(item => !Array.isArray(item)).map(item => ({editId:item.id,kinds:['behavior'],reason:'Synthetic change.',uncertainty:''}))));
  review = { summary:'Synthetic parallel review.', topics:[{...review.topics[0],id:'parallel-change',priority:'supporting',title:'Synthetic supporting changes',editIds:labels.map(entry=>entry.editId),excerpts:[]}] };
}
if (mode === 'many-decisions') {
  review = {
    summary: 'Five separate behavior decisions remain available across loaded and unloaded files.',
    topics: evidence.files.flatMap(file => file.hunks.flatMap(hunk => hunk.items.filter(item => !Array.isArray(item)).map(item => ({
      id: item.id, priority: 'review', title: 'Check ' + file.path,
      reason: 'Verify the replacement value before consumers receive the changed content.',
      before: 'The fixture returned its previous value.', after: 'The fixture returns the replacement value.',
      question: 'Does the replacement match the intended change?', uncertainty: '', evidenceSummary: 'One value is replaced.',
      editIds: [item.id], excerpts: [{path:file.path,side:'after',startLine:1,endLine:1}]
    }))))
  };
  const initialFile = evidence.files.length === 1 && evidence.files[0].path === 'tests/change-1.ts';
  const final = !schema.required.includes('edits');
  const started = Date.now();
  while (!initialFile) {
    const gate = await readFile(${JSON.stringify(uxGate)}, 'utf8');
    if (final ? gate === 'finish' : gate !== 'waiting') break;
    if (Date.now() - started > 60000) throw new Error('The incremental review fixture did not continue.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
if (mode === 'parallel') {
  await appendFile(${JSON.stringify(lifecycleLog)}, JSON.stringify({type:'start',pid:process.pid})+'\\n');
  if (schema.required.includes('edits')) {
    const start = Date.now();
    while ((await readFile(${JSON.stringify(lifecycleLog)},'utf8')).split('\\n').filter(Boolean).map(line=>JSON.parse(line)).filter(event=>event.type==='start').length < 3) {
      if(Date.now()-start>5000) throw new Error('Three independent Codex helpers did not start concurrently.');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
  }
}
if (mode === 'unresolved') {
  labels[1].kinds = ['unknown'];
  labels[1].uncertainty = 'The second rendering path cannot be established from this fixture.';
  review.topics[0].editIds = ['0-0-3'];
  review.topics.push({ ...review.topics[0], id: 'second-path', priority: 'supporting', title: 'The other rendering path', editIds: ['0-1-3'], excerpts: [], uncertainty: labels[1].uncertainty });
}
await appendFile(${JSON.stringify(requestLog)}, JSON.stringify({ provider:isClaude?'claude':'codex', schema, evidence: JSON.parse(input), labels, args }) + '\\n');
const result = schema.required.includes('edits') ? { edits: labels } : review;
if (isClaude) process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:result}));
else await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
if (mode === 'parallel') await appendFile(${JSON.stringify(lifecycleLog)}, JSON.stringify({type:'finish',pid:process.pid})+'\\n');
}
`, { mode: 0o755 });
await installNativeHost({ browserProfileDirectory: profile, hostDirectory: join(profile, 'helper'), executablePath: fakeCodex });
await installNativeHost({ provider: 'claude', browserProfileDirectory: profile, hostDirectory: join(profile, 'helper'), executablePath: fakeCodex });
async function modelRequests() {
  return (await readFile(requestLog, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function checkEvidence(requests) {
  for (const submitted of requests) {
    const { evidence, schema, labels, args } = submitted;
    assert.equal(evidence.headSha, headSha);
    assert.equal(evidence.baseSha, baseSha);
    assert.equal(evidence.files[0].path, sourcePath);
    assert.equal(evidence.context.length, 1);
    assert.ok(evidence.description.startsWith(description));
    assert.ok(evidence.description.includes('Linked issue #901: https://github.com/microsoft/vscode/issues/901\nTitle: Suggestion font parity'));
    assert.ok(evidence.description.includes('The widget must match the editor when font variations change.'));
    assert.equal(evidence.description.split('Linked issue #901:').length, 2);
    assert.equal(evidence.description.length - evidence.description.indexOf('\n\nLinked issue #901:'), 4000);
    assert.ok(!evidence.description.includes('NOT_INCLUDED_'));
    assert.ok(evidence.evidenceLimits.some(warning => warning.includes('limited to 3 of 4')));
    assert.ok(evidence.evidenceLimits.some(warning => warning.includes('#901') && warning.includes('truncated')));
    assert.ok(evidence.evidenceLimits.some(warning => warning.includes('Could not read linked issue #902')));
    assert.ok(evidence.evidenceLimits.some(warning => warning.includes('Could not read linked issue #903')));
    assert.ok(args.includes('--ignore-user-config'));
    assert.equal(args[args.indexOf('--model') + 1], 'fixture-model');
    if (schema.required.includes('edits')) assert.equal(evidence.classifications, undefined);
    else assert.deepEqual(evidence.classifications, labels, 'Prioritization must receive the validated first-stage labels.');
  }
}

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-sync', 'about:blank'
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let sequence = 0;
let incoming = '';
let browserLog = '';
const pending = new Map();
const eventErrors = [];
const exceptions = [];
const workers = [];
const executionContexts = new Map();
const expiredVirtualBudgets = new Set();
const issueRequests = [];
let extensionId;
let incomplete = false;
let modernMode = false;
let deferredMode = '';
const deferredRequests = [];
let changesMode = '';
let descriptionSuffix = '';
let transientIssueFailure = false;
let transientSourceFailure = false;
const changesRequests = [];
chrome.stderr.on('data', chunk => { browserLog = (browserLog + chunk).slice(-6000); });
chrome.on('error', error => eventErrors.push(error));
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out. ${browserLog}`)); }, 20000);
  pending.set(id, { resolve, reject, timer });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
});
chrome.stdio[4].on('data', chunk => {
  incoming += chunk.toString();
  let boundary;
  while ((boundary = incoming.indexOf('\0')) >= 0) {
    const message = JSON.parse(incoming.slice(0, boundary));
    incoming = incoming.slice(boundary + 1);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${message.error.message} (${message.error.code})`));
      else request.resolve(message.result);
    } else handleEvent(message).catch(error => eventErrors.push(error));
  }
});

async function handleEvent(message) {
  if (message.method === 'Emulation.virtualTimeBudgetExpired') expiredVirtualBudgets.add(message.sessionId);
  if (message.method === 'Runtime.executionContextCreated') executionContexts.set(`${message.sessionId}:${message.params.context.id}`, { ...message.params.context, sessionId: message.sessionId });
  if (message.method === 'Runtime.executionContextDestroyed') executionContexts.delete(`${message.sessionId}:${message.params.executionContextId}`);
  if (message.method === 'Runtime.executionContextsCleared') {
    for (const [key, context] of executionContexts) if (context.sessionId === message.sessionId) executionContexts.delete(key);
  }
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  if (message.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = message.params;
    if (targetInfo.type === 'service_worker') {
      workers.push(sessionId);
      await send('Runtime.enable', {}, sessionId);
    }
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }
  if (message.method !== 'Fetch.requestPaused') return;
  const { request, requestId } = message.params;
  const url = new URL(request.url);
  if (deferredMode) deferredRequests.push(url.href);
  if (changesMode) changesRequests.push({ url: url.href, headers: request.headers });
  if (url.pathname.includes('/issues/')) issueRequests.push(url.href);
  let body;
  let contentType = 'text/html; charset=utf-8';
  let status = 200;
  const headers = [];
  if (url.origin === 'https://github.com') {
    if (changesMode && url.pathname === changes.root + '/files') {
      status = 302;
      headers.push({ name: 'Location', value: `https://github.com${changes.root}/changes${url.search}` });
      body = '';
    } else if (changesMode && url.pathname === changes.root + '/changes') {
      const route = structuredClone(changes.route);
      if (changesMode === 'parallel' || changesMode === 'generated-review' || changesMode === 'all-generated') {
        route.diffSummaries = route.diffSummaries.slice(0,3);
        route.diffContents = route.diffContents.slice(0,3);
      }
      if (changesMode === 'many-decisions') route.diffSummaries = route.diffSummaries.slice(0,5);
      if (changesMode === 'all-generated') for (const entry of route.diffContents) entry.newTreeEntry = { isGenerated: true };
      if (changesMode === 'duplicate-summary') route.diffSummaries[4] = route.diffSummaries[0];
      if (changesMode === 'truncated-list') route.pageLimits.filesLimitExceeded = true;
      if (changesMode === 'inline-revision') route.diffContents[0].newCommitOid = '1'.repeat(40);
      if (changesMode === 'deferred-large') {
        route.diffContents[0].isTooBig = true;
        route.diffContents[0].diffLines = [];
      }
      if (changesMode.startsWith('generated')) {
        route.diffContents[0].newTreeEntry = { isGenerated: true };
        route.diffContents[0].diffLines = [];
      }
      body = changes.page(route, ['parallel', 'generated-review', 'all-generated', 'many-decisions'].includes(changesMode));
    } else if (changesMode && url.pathname === changes.root + '/page_data/diff_entries') {
      const paths = url.searchParams.get('paths').split(',').map(decodeURIComponent);
      const entries = structuredClone(changes.entries.filter(entry => paths.includes(entry.path)));
      if (changesMode.startsWith('generated') && paths.includes(changes.paths[0])) {
        entries[0].newTreeEntry = { isGenerated: true };
        entries[0].diffLines = [];
      }
      if (paths.includes(changes.paths[4])) {
        if (changesMode === 'missing') entries.shift();
        if (changesMode === 'duplicate') entries.push(entries[0]);
        if (changesMode === 'wrong-path') entries[0].path = 'tests/unrequested.ts';
        if (changesMode === 'wrong-revision') entries[0].newCommitOid = '1'.repeat(40);
        if (changesMode === 'truncated') entries[0].truncatedReason = 'SIZE';
        if (changesMode === 'deferred-large' && paths.length > 1) {
          entries[0].isTooBig = true;
          entries[0].diffLines = [];
        }
      }
      contentType = 'application/json';
      body = JSON.stringify(entries);
      const requestHeaders = new Map(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
      if (requestHeaders.get('x-requested-with') !== 'XMLHttpRequest' || requestHeaders.get('x-fetch-nonce') !== changes.fetchNonce || requestHeaders.get('x-github-client-version') !== changes.release) {
        status = 406;
        body = JSON.stringify({ error: 'Missing GitHub verified-fetch headers.' });
      }
    } else if (changesMode && url.pathname === changes.root + '/page_data/diff_entry_lines') {
      const entry = changes.entries.find(file => file.path === url.searchParams.get('path'));
      contentType = 'application/json';
      body = JSON.stringify({ diffEntryLines: ['generated', 'generated-review'].includes(changesMode) ? entry?.diffLines : changesMode === 'generated-incomplete' ? entry?.diffLines.slice(0, -1) : [] });
    } else if (deferredMode && deferred.pages.has(url.pathname + url.search)) {
      body = deferred.pages.get(url.pathname + url.search);
    } else if (url.pathname.endsWith('/files')) {
      body = deferredMode ? deferred[deferredMode] : modernMode ? react : incomplete ? fixture.replace('class="Counter">1', 'class="Counter">2') : fixture;
    } else if (url.pathname === '/microsoft/vscode/pull/200000') {
      body = discussionPage.replace(description, description + descriptionSuffix);
    } else if (url.pathname === '/microsoft/vscode/pull/200000/checks') {
      body = '<main><h1>Checks</h1></main>';
    } else if (url.pathname.includes('/issues/')) {
      if (url.pathname === '/microsoft/vscode/issues/901') {
        status = transientIssueFailure ? 503 : 200;
        body = transientIssueFailure ? 'Temporary error' : issuePage;
      }
      else if (url.pathname === '/microsoft/vscode/issues/903') {
        status = 302;
        headers.push({ name: 'Location', value: 'https://github.com/other/repo/issues/903' });
        body = '';
      } else { status = 404; body = '<main>Issue unavailable in this fixture.</main>'; }
    } else if (url.pathname.includes(`/blob/${headSha}/`)) {
      status = transientSourceFailure ? 503 : 200;
      body = transientSourceFailure ? 'Temporary error' : sourcePage;
    }
    else { status = 404; body = '<main>Source unavailable in this fixture.</main>'; }
  } else {
    await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, message.sessionId);
    return;
  }
  await send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: contentType }, ...headers], body: Buffer.from(body).toString('base64') }, message.sessionId);
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (eventErrors.length) throw eventErrors[0];
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

try {
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'service_worker' }, { exclude: true }] });
  ({ id: extensionId } = await send('Extensions.loadUnpacked', { path: fileURLToPath(new URL('extension/', import.meta.url)) }));
  assert.equal(extensionId, 'bjmajanmepopjciklnijlfbdpafokfpe');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params = {}) => send(method, params, sessionId);
  const evaluate = async (expression, evaluationSessionId = sessionId) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, evaluationSessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const evaluateExtension = async (expression, evaluationSessionId = sessionId) => {
    for (const context of executionContexts.values()) {
      if (context.sessionId !== evaluationSessionId || context.auxData?.isDefault) continue;
      const identity = await send('Runtime.evaluate', { expression: 'chrome.runtime?.id', contextId: context.id, returnByValue: true }, evaluationSessionId);
      if (identity.result?.value !== extensionId) continue;
      const result = await send('Runtime.evaluate', { expression, contextId: context.id, returnByValue: true, awaitPromise: true }, evaluationSessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    }
    throw new Error('The installed extension execution context is unavailable.');
  };
  await page('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.fixtureViewedClicks = 0;
    window.fixtureInstallReviewControl = (container, path, modern = false) => {
      const header = container.querySelector('.file-header, .diff-file-header');
      const reviewed = new Set(JSON.parse(localStorage.getItem('fixture-viewed-files') || '[]'));
      const control = document.createElement(modern ? 'button' : 'input');
      if (modern) {
        control.type = 'button';
        control.setAttribute('aria-pressed', String(reviewed.has(path)));
        control.setAttribute('aria-label', reviewed.has(path) ? 'Viewed' : 'Not Viewed');
        control.textContent = 'Viewed';
      } else {
        control.type = 'checkbox';
        control.className = 'js-reviewed-checkbox';
        control.checked = reviewed.has(path);
        control.setAttribute('aria-label', 'Viewed');
      }
      control.addEventListener(modern ? 'click' : 'change', () => {
        window.fixtureViewedClicks++;
        const checked = modern ? control.getAttribute('aria-pressed') !== 'true' : control.checked;
        if (modern) {
          control.setAttribute('aria-pressed', String(checked));
          control.setAttribute('aria-label', checked ? 'Viewed' : 'Not Viewed');
        }
        control.disabled = true;
        setTimeout(() => {
          const rollback = window.fixtureViewedRollback;
          window.fixtureViewedRollback = false;
          if (!rollback) {
            const reviewed = new Set(JSON.parse(localStorage.getItem('fixture-viewed-files') || '[]'));
            if (checked) reviewed.add(path);
            else reviewed.delete(path);
            localStorage.setItem('fixture-viewed-files', JSON.stringify([...reviewed]));
          }
          const replacement = header.cloneNode(true);
          replacement.querySelector('input.js-reviewed-checkbox, button[aria-pressed]')?.remove();
          header.replaceWith(replacement);
          window.fixtureInstallReviewControl(container, path, modern);
        }, window.fixtureViewedDelay || 0);
      });
      header.append(control);
    };
    document.addEventListener('DOMContentLoaded', () => {
      for (const file of document.querySelectorAll('.js-file')) {
        window.fixtureInstallReviewControl(file, file.getAttribute('data-tagsearch-path') || file.querySelector('.file-header').getAttribute('data-path'));
      }
      for (const file of document.querySelectorAll('section[id^="diff-"][role="region"]')) {
        const path = file.querySelector('.diff-file-header code').textContent;
        const template = file.cloneNode(true);
        let mounted = file;
        const renderExpandedFile = expanded => {
          const replacement = template.cloneNode(true);
          if (expanded) {
            const body = replacement.querySelector('tbody');
            for (let number = 2; number <= 202; number++) {
              const row = body.lastElementChild.cloneNode(true);
              row.dataset.fixtureContext = '';
              row.style.height = '24px';
              for (const cell of row.querySelectorAll('.new-diff-line-number')) cell.textContent = String(number);
              row.querySelector('.diff-text').className = 'diff-text';
              row.querySelector('.diff-text-inner').textContent = 'Unchanged context line ' + number;
              body.append(row);
            }
          }
          const toggle = replacement.querySelector('.js-expand-all-difflines-button');
          toggle.setAttribute('aria-label', (expanded ? 'Collapse non-diff lines: ' : 'Expand all lines: ') + path);
          toggle.textContent = expanded ? 'Collapse non-diff lines' : 'Expand all';
          toggle.addEventListener('click', () => renderExpandedFile(!expanded));
          window.fixtureInstallReviewControl(replacement, path, true);
          mounted.replaceWith(replacement);
          mounted = replacement;
        };
        file.querySelector('.js-expand-all-difflines-button').addEventListener('click', () => renderExpandedFile(true));
        window.fixtureInstallReviewControl(file, path, true);
      }
    });
  ` });
  await page('Page.enable');
  await page('Runtime.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1080, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url: 'chrome://extensions/' });
  await waitFor(() => evaluate('Boolean(chrome.developerPrivate?.updateProfileConfiguration)'), 'extension developer controls');
  await evaluate('new Promise(resolve => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}, resolve))');
  const invalidSettings = await page('Page.addScriptToEvaluateOnNewDocument', { source: `chrome.runtime.sendMessage = async () => ({ configured: true, provider: 'invalid-provider', model: 'invalid-model' });` });
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent !== "Checking the local helper…" && Boolean(document.querySelector("#connection-status"))'), 'invalid settings rejected');
  assert.match(await evaluate('document.querySelector("#connection-status").textContent'), /invalid provider settings/, 'Malformed provider settings must be rejected.');
  assert.equal(await evaluate('document.querySelector("#model").value'), '', 'Invalid settings must not populate the model input.');
  await page('Page.removeScriptToEvaluateOnNewDocument', { identifier: invalidSettings.identifier });
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex") && !document.querySelector("#model").disabled'), 'native Codex connection');
  assert.equal(await evaluate('document.querySelector("#api-key")'), null);
  await evaluate('document.querySelector("#model").value="fixture-model"; document.querySelector("#settings-form").requestSubmit()');
  await waitFor(() => evaluate('document.querySelector("#status")?.textContent.includes("Settings saved")'), 'saving the model');
  assert.equal(await evaluate('document.querySelector("#model").tagName'), 'SELECT');
  assert.deepEqual(await evaluate('Array.from(document.querySelector("#effort").options,option=>option.value)'), ['low','medium','high']);
  assert.equal(await evaluate('document.querySelector("#effort").value'), 'high');
  await writeFile('/tmp/review-focus-extension-settings.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await page('Fetch.enable', { patterns: [{ urlPattern: 'https://github.com/*' }, { urlPattern: 'https://example.com/*' }] });
  await page('Page.navigate', { url: prUrl + '/files' });
  const shadow = 'document.querySelector("#review-focus-extension")?.shadowRoot';
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'the installed content script');
  assert.equal((await modelRequests()).length, 0, 'Opening a PR must not start a model analysis.');
  await evaluateExtension(`
    globalThis.pendingSettingsMessages = [];
    globalThis.originalSettingsSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function(message, ...args) {
      const response = originalSettingsSend.call(this, message, ...args);
      if (message?.type === 'get-settings') pendingSettingsMessages.push(response);
      return response;
    };
  `);
  const statusBeforeFocus = await readFile(statusLog, 'utf8');
  await evaluate(`(async () => {
    for (let index = 0; index < 4; index++) window.dispatchEvent(new Event('focus'));

  })()`);
  await evaluateExtension('Promise.all(pendingSettingsMessages.splice(0))');
  assert.equal(await readFile(statusLog, 'utf8'), statusBeforeFocus, 'Returning focus within the shared cooldown must not start another CLI connection check.');
  const connectionWorker = workers.at(-1);
  const expireConnection = async () => {
    const response = await send('Runtime.evaluate', {
      expression: `(async () => {
        const stored = await chrome.storage.session.get('codexConnectionStatus');
        stored.codexConnectionStatus.checkedAt = Date.now() - 60000;
        await chrome.storage.session.set(stored);
      })()`, awaitPromise: true
    }, connectionWorker);
    assert.equal(response.exceptionDetails, undefined);
  };
  await expireConnection();
  const idleTarget = await send('Target.createTarget', {url:'about:blank'});
  const idleSession = (await send('Target.attachToTarget', {targetId:idleTarget.targetId,flatten:true})).sessionId;
  try {
    await send('Runtime.enable', {}, idleSession);
    await send('Fetch.enable', {patterns:[{urlPattern:'https://github.com/*'}]}, idleSession);
    await send('Page.navigate', {url:prUrl+'/files'}, idleSession);
    await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`, idleSession), 'isolated visible idle PR');
    await evaluateExtension(`
      globalThis.idleSettingsRequests = 0;
      const originalSendMessage = chrome.runtime.sendMessage;
      chrome.runtime.sendMessage = function(message, ...args) {
        if (message?.type === 'get-settings') idleSettingsRequests++;
        return originalSendMessage.call(this, message, ...args);
      };
      globalThis.minuteElapsed = false;
      setTimeout(() => { minuteElapsed = true; }, 60_000);
    `, idleSession);
    await expireConnection();
    await send('Emulation.setVirtualTimePolicy', {policy:'advance',budget:65_000,maxVirtualTimeTaskStarvationCount:100}, idleSession);
    await waitFor(() => expiredVirtualBudgets.has(idleSession), '65 seconds of browser virtual time');
    assert.equal(await evaluateExtension('minuteElapsed', idleSession), true, 'The isolated content-script clock must advance through a full minute.');
    assert.equal(await evaluateExtension('idleSettingsRequests', idleSession), 0, 'An idle PR must not poll connection settings after its cooldown expires.');
  } finally {
    await send('Target.closeTarget', {targetId:idleTarget.targetId});
  }
  await page('Page.bringToFront');
  await waitFor(() => evaluateExtension('chrome.runtime.sendMessage({type:"get-settings"}).then(value=>value.configured)'), 'idle-check cleanup');
  const statusAfterIdle = await readFile(statusLog, 'utf8');
  await writeFile(modeFile, 'signed-out');
  await expireConnection();
  await evaluate("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Connect your local Codex')`), 'automatic login refresh after the cooldown');
  assert.equal((await readFile(statusLog, 'utf8')).split('\n').length, statusAfterIdle.split('\n').length + 1);
  await writeFile(modeFile, 'normal');
  await evaluate(`(async () => {
    for (let index = 0; index < 4; index++) window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));

  })()`);
  await evaluateExtension('Promise.all(pendingSettingsMessages.splice(0))');
  assert.equal((await readFile(statusLog, 'utf8')).split('\n').length, statusAfterIdle.split('\n').length + 1, 'Signed-out results also share the cooldown.');
  assert.ok(await evaluate(`${shadow}.querySelector('.rf-status').textContent.includes('Connect your local Codex')`));
  const cacheProbeWorker = workers.at(-1);
  const probeFault = await send('Runtime.evaluate', {expression:`
    globalThis.originalCacheProbe = IDBIndex.prototype.getAll;
    IDBIndex.prototype.getAll = function(...args) {
      if (this.name === 'lookup') throw new Error('Synthetic saved-review lookup failure.');
      return originalCacheProbe.call(this, ...args);
    };
  `}, cacheProbeWorker);
  assert.equal(probeFault.exceptionDetails, undefined);
  await evaluate("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-cache-notice').textContent.includes('Could not check saved reviews') && ${shadow}.querySelector('.rf-analyze').textContent === 'Run fresh review'`), 'cache lookup failure is visible before any paid analysis');
  assert.equal((await modelRequests()).length, 0);
  await send('Runtime.evaluate', {expression:'IDBIndex.prototype.getAll = globalThis.originalCacheProbe; delete globalThis.originalCacheProbe;'}, cacheProbeWorker);
  await evaluate("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-cache-notice').hidden && ${shadow}.querySelector('.rf-analyze').textContent === 'Analyze PR'`), 'returning to the tab retries the cache lookup');
  const click = label => evaluate(`(() => {
    const buttons = [...${shadow}.querySelectorAll('button')];
    const target = buttons.find(button => button.textContent === ${JSON.stringify(label)}) ?? (${JSON.stringify(label)} === 'Analyze PR' ? buttons.find(button => button.textContent === 'Run fresh review' && !button.hidden) : null);
    if (!target) throw new Error('Missing action: ' + ${JSON.stringify(label)});
    const menu = target.closest('.rf-menu');
    if (menu && !menu.open) menu.querySelector('summary').click();
    if (!target.checkVisibility()) throw new Error('Action is not visible: ' + ${JSON.stringify(label)});
    target.click();
  })()`);
  const openFiles = () => evaluate(`(() => {
    if (${shadow}.querySelector('.rf-file-progress').hidden) ${shadow}.querySelector('.rf-progress-toggle').click();
  })()`);
  await evaluate(`(() => {
    window.readingFocus = document.createElement('button');
    window.readingFocus.textContent = 'Continue reading GitHub';
    document.querySelector('main').prepend(window.readingFocus);
    window.readingFocus.focus();
  })()`);
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-overview-title')?.textContent === '1 review decision' && !${shadow}?.querySelector('.rf-analyze')?.disabled`), 'capture → native helper → Codex → validated review');
  assert.equal((await readFile(statusLog, 'utf8')).split('\n').length, statusAfterIdle.split('\n').length + 4, 'Analyze PR must refresh the cached login before the two analysis passes, each of which also verifies authentication.');
  assert.equal(await evaluate('document.activeElement === window.readingFocus'), true, 'New AI badges must not steal focus from GitHub while analysis finishes.');
  await evaluate('window.readingFocus.remove()');
  const initialRequestCount = (await modelRequests()).length;
  assert.equal(initialRequestCount, 2);
  checkEvidence(await modelRequests());
  assert.ok(await evaluate(`${shadow}.querySelector('.rf-run-settings').textContent.includes('fixture-model · Effort: high')`));
  assert.ok((await modelRequests()).every(request => request.args.includes('model_reasoning_effort="high"')), 'Every Codex pass must receive the selected effort explicitly.');
  assert.deepEqual(issueRequests, [901, 902, 903].map(number => `https://github.com/microsoft/vscode/issues/${number}`), 'Read bounded, unique same-repository issue references only; never comments, external links, or redirects.');
  assert.ok(await evaluate(`${shadow}.textContent.includes('Could not read linked issue #902')`));
  const fileShadow = 'document.querySelector(".review-focus-file-progress[data-state=complete]")?.shadowRoot';
  const fileBadge = 'document.querySelector(".review-focus-file-status[data-state=complete]")?.shadowRoot';
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-file-progress').hidden`), true, 'Analysis keeps the file list closed until requested.');
  const initialLayout = await evaluate(`(() => {
    const overview = ${shadow};
    const file = ${fileShadow};
    return {
      height: document.querySelector('#review-focus-extension').getBoundingClientRect().height,
      indexOpen: overview.querySelector('.rf-review-index').open,
      filesOpen: !overview.querySelector('.rf-file-progress').hidden,
      visibleOverviewDecisions: [...overview.querySelectorAll('.rf-topic-body')].filter(node => node.checkVisibility()).length,
      visibleFileDecisions: [...file.querySelectorAll('.rf-review > .rf-topic-body')].filter(node => node.checkVisibility()).length,
      change: file.querySelector('.rf-change-explanation').textContent,
      rationale: file.querySelector('.rf-reason').textContent,
      limits: file.querySelector('.rf-uncertainty').textContent,
      limitsVisible: file.querySelector('.rf-uncertainty').checkVisibility(),
      questionVisible: Boolean(file.querySelector('.rf-question')?.checkVisibility()),
      visibleActions: [...overview.querySelectorAll('button')].filter(node => node.checkVisibility()).map(node => node.textContent),
      headerBadge: Boolean(document.querySelector('.file-header > .review-focus-file-status')?.shadowRoot.querySelector('.rf-file-state')?.checkVisibility()),
      repeatedBrand: Boolean(file.querySelector('.rf-file-heading')),
      visibleCode: [...overview.querySelectorAll('.rf-code'), ...file.querySelectorAll('.rf-code')].filter(node => node.checkVisibility()).length
    };
  })()`);
  assert.ok(initialLayout.height <= 110, `The default toolbar should fit within 110px, got ${initialLayout.height}.`);
  assert.equal(initialLayout.indexOpen, false);
  assert.equal(initialLayout.filesOpen, false);
  assert.equal(initialLayout.visibleOverviewDecisions, 0, 'The overview must not duplicate the file explanations by default.');
  assert.equal(initialLayout.visibleFileDecisions, 1, 'Important file explanations must be readable without opening a disclosure.');
  assert.equal(initialLayout.change, assessment.topics[0].after);
  assert.equal(initialLayout.rationale, assessment.topics[0].reason);
  assert.ok(initialLayout.limits.includes(assessment.topics[0].uncertainty));
  assert.equal(initialLayout.visibleCode, 0, 'Native code must not be duplicated in the default annotations.');
  assert.equal(initialLayout.limitsVisible, true, 'Evidence limits stay visible without opening Details.');
  assert.equal(initialLayout.questionVisible, false, 'The review question is available on demand.');
  assert.equal(initialLayout.headerBadge, true, 'AI status belongs inside GitHub’s file header.');
  assert.equal(initialLayout.repeatedBrand, false, 'Each file must not add a separate branded status bar.');
  assert.ok(!initialLayout.visibleActions.includes('Settings') && !initialLayout.visibleActions.includes('Run fresh review'), 'Secondary actions stay in the overflow menu.');
  await evaluate(`${shadow}.querySelector('.rf-menu > summary').focus()`);
  await page('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await page('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-menu').open`), 'overflow menu opens from the keyboard');
  assert.equal(await evaluate(`[...${shadow}.querySelectorAll('.rf-menu button')].find(button=>button.textContent==='Settings').checkVisibility()`), true);
  await page('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await page('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(await evaluate(`!${shadow}.querySelector('.rf-menu').open && ${shadow}.activeElement === ${shadow}.querySelector('.rf-menu > summary')`), true, 'Escape closes the menu and restores focus to its trigger.');
  await evaluate(`${shadow}.querySelector('.rf-menu > summary').click(); ${shadow}.querySelector('.rf-brand').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true}))`);
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-menu').open`), false, 'A click outside the menu closes it.');
  await openFiles();
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-progress-toggle').getAttribute('aria-expanded') === 'true' && ${shadow}.querySelector('.rf-file-list').checkVisibility()`), true, 'The progress control exposes its file list accessibly.');
  await evaluate(`${shadow}.querySelector('.rf-progress-toggle').click()`);
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-progress-toggle').getAttribute('aria-expanded') === 'false' && ${shadow}.querySelector('.rf-file-progress').hidden`), true);
  await evaluate(`${fileShadow}.querySelector('.rf-evidence > summary').click()`);
  await waitFor(() => evaluate(`${fileShadow}.querySelector('.rf-code tr')?.checkVisibility()`), 'optional evidence without hiding the main explanation');
  assert.equal(await evaluate(`${fileShadow}.querySelector('.rf-before').textContent`), `Before: ${assessment.topics[0].before}`);
  assert.equal(await evaluate(`${fileShadow}.querySelectorAll('.rf-edit').length`), 2);
  assert.ok(await evaluate(`${fileShadow}.querySelector('.rf-question').checkVisibility() && ${fileShadow}.querySelector('.rf-question').textContent.includes(${JSON.stringify(assessment.topics[0].question)})`), 'Details retains the complete review question.');
  await evaluate(`${fileShadow}.querySelector('.rf-excerpt .rf-link-button').click()`);
  assert.ok(await evaluate('document.querySelector(".review-focus-native-target")?.checkVisibility()'), 'Show in diff must reveal and identify the captured source in GitHub’s native rows.');
  await evaluate('window.scrollTo(0,0)');

  await evaluate(`${fileShadow}.querySelector('.rf-evidence > summary').click()`);
  assert.ok(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length > 10'));
  await writeFile('/tmp/review-focus-extension-installed.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  const mobileLayout = await evaluate(`(() => {
    const overview = document.querySelector('#review-focus-extension');
    const file = ${fileShadow};
    return {
      overviewWidth: overview.getBoundingClientRect().width,
      actionOverflow: ${shadow}.querySelector('.rf-actions').scrollWidth > ${shadow}.querySelector('.rf-actions').clientWidth,
      explanationWidth: file.querySelector('.rf-change-explanation').getBoundingClientRect().width,
      visibleCode: [...file.querySelectorAll('.rf-code')].filter(node => node.checkVisibility()).length
    };
  })()`);
  assert.ok(mobileLayout.overviewWidth <= 390);
  assert.equal(mobileLayout.actionOverflow, false);
  assert.ok(mobileLayout.explanationWidth <= 390);
  assert.equal(mobileLayout.visibleCode, 0);
  await writeFile('/tmp/review-focus-extension-mobile.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate("document.querySelector('.review-focus-file-progress').scrollIntoView({block:'start'})");
  await writeFile('/tmp/review-focus-extension-mobile-file.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await page('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1080, deviceScaleFactor: 1, mobile: false });
  await evaluate('window.scrollTo(0,0)');
  await evaluate(`(() => {
    const style = document.createElement('style');
    style.id = 'fixture-dark-theme';
    style.textContent = ':root{--bgColor-default:#0d1117;--bgColor-muted:#151b23;--fgColor-default:#f0f6fc;--fgColor-muted:#9198a1;--borderColor-default:#3d444d;--fgColor-accent:#4493f8;--diffBlob-additionLine-bgColor:#12261e;--diffBlob-deletionLine-bgColor:#331c1f}body{color:var(--fgColor-default);background:var(--bgColor-default)}.file{border-color:var(--borderColor-default)}.file-header{background:var(--bgColor-muted)}.blob-code-addition{background:var(--diffBlob-additionLine-bgColor)}.blob-code-hunk{background:#162536;color:var(--fgColor-muted)}a{color:var(--fgColor-accent)}';
    document.head.append(style);
  })()`);
  await writeFile('/tmp/review-focus-extension-dark.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate("document.querySelector('#fixture-dark-theme').remove()");
  console.log(`Compact review overview: ${initialLayout.height}px; explanations are visible beside the native diff.`);
  await click('Full diff');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden, .review-focus-native-fold").length'), 0);
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-result').checkVisibility()`), false);
  assert.equal(await evaluate(`${fileShadow}.querySelector('.rf-file-decisions')`), null, 'Full diff removes the review explanations beside files.');
  await click('Focused review');
  assert.ok(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length > 10'));

  const humanReviewInputs = `[...${shadow}.querySelectorAll('.rf-reviewed-toggle input')]`;
  assert.equal(await evaluate(`${fileShadow}.querySelector('input[type=checkbox]')`), null, 'The diff panel must not duplicate GitHub’s Viewed checkbox.');
  assert.deepEqual(await evaluate(`${humanReviewInputs}.map(input => [input.checked, input.indeterminate])`), [[false, false]], 'AI completion must not mark a file reviewed by the user.');
  assert.equal(await evaluate('window.fixtureViewedClicks'), 0);
  await evaluate(`(() => {
    const root = ${fileShadow};
    root.querySelector('.rf-evidence').open = true;
    window.savedReviewEvidence = root.querySelector('.rf-evidence');
    if (${shadow}.querySelector('.rf-file-progress').hidden) ${shadow}.querySelector('.rf-progress-toggle').click();
    const input = ${shadow}.querySelector('.rf-reviewed-toggle input');
    input.focus();
    input.click();
  })()`);
  await waitFor(() => evaluate(`${humanReviewInputs}.every(input => input.checked && input.getAttribute('aria-disabled') === 'false')`), 'file-list checkmark forwarded to GitHub');
  assert.equal(await evaluate('document.querySelector(".js-reviewed-checkbox").checked'), true);
  assert.equal(await evaluate('document.querySelectorAll(".file-header .review-focus-file-status").length'), 1, 'Replacing GitHub’s header must not duplicate the AI badge.');
  assert.ok(await evaluate(`${fileBadge}.querySelector('.rf-file-state').checkVisibility()`), 'The live badge survives a native header replacement.');
  assert.ok(await evaluate(`${shadow}.querySelector('.rf-progress-toggle').textContent.includes('Viewed 1/1')`));
  assert.ok(await evaluate(`window.savedReviewEvidence.isConnected && window.savedReviewEvidence.open && !${fileShadow}.querySelector('.rf-file-decisions').checkVisibility()`), 'Marking a file keeps its evidence state while compacting the reviewed file.');
  assert.equal(await evaluate(`${shadow}.activeElement?.type`), 'checkbox', 'The file-list checkbox retains keyboard focus after GitHub replaces its header.');
  await evaluate('document.querySelector(".js-reviewed-checkbox").click()');
  await waitFor(() => evaluate(`${humanReviewInputs}.every(input => !input.checked && input.getAttribute('aria-disabled') === 'false')`), 'native uncheck reflected in the file list');
  assert.ok(await evaluate('window.savedReviewEvidence.open && window.savedReviewEvidence.checkVisibility()'));
  await evaluate(`if (${shadow}.querySelector('.rf-file-progress').hidden) ${shadow}.querySelector('.rf-progress-toggle').click(); ${shadow}.querySelector('.rf-reviewed-toggle input').focus(); window.fixtureViewedRollback = true; window.fixtureViewedDelay = 80; ${shadow}.querySelector('.rf-reviewed-toggle input').click()`);
  await waitFor(() => evaluate(`window.fixtureViewedClicks === 3 && ${humanReviewInputs}.every(input => !input.checked && input.getAttribute('aria-disabled') === 'false')`), 'failed native save rolls back every checkmark');
  assert.equal(await evaluate(`${shadow}.activeElement?.type`), 'checkbox', 'The file-list checkbox retains keyboard focus through native pending and rollback states.');
  await evaluate('window.fixtureViewedDelay = 0; document.querySelector(".js-reviewed-checkbox").disabled = true');
  await waitFor(() => evaluate(`${humanReviewInputs}.every(input => input.getAttribute('aria-disabled') === 'true')`), 'disabled native control reflected safely');
  await evaluate(`${shadow}.querySelector('.rf-reviewed-toggle input').click()`);
  assert.equal(await evaluate('window.fixtureViewedClicks'), 3, 'An inactive native control must not be clicked.');
  await evaluate('document.querySelector(".js-reviewed-checkbox").disabled = false');
  await waitFor(() => evaluate(`${humanReviewInputs}.every(input => input.getAttribute('aria-disabled') === 'false')`), 'native control available again');
  await evaluate(`${shadow}.querySelector('.rf-reviewed-toggle input').click()`);
  await waitFor(() => evaluate(`${humanReviewInputs}.every(input => input.checked && input.getAttribute('aria-disabled') === 'false')`), 'review mark saved by the native fixture before reload');
  assert.equal((await modelRequests()).length, initialRequestCount, 'Human review actions must not invoke model analysis.');

  const staleContext = [...executionContexts.values()].find(context => context.sessionId === sessionId && context.origin === `chrome-extension://${extensionId}`);
  assert.ok(staleContext, 'The reload regression must run against an installed content script.');
  await evaluateExtension(`
    const sendBeforeReload = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function(message, ...args) {
      if (message.type === 'get-settings') return new Promise((resolve, reject) => { globalThis.rejectPendingSettings = reject; });
      return sendBeforeReload.call(this, message, ...args);
    };
    window.dispatchEvent(new Event('focus'));
  `);
  assert.equal(await evaluateExtension('typeof rejectPendingSettings'), 'function', 'A settings request must be pending when the extension reloads.');
  await send('Runtime.evaluate', { expression: 'setTimeout(() => chrome.runtime.reload(), 0)' }, workers.at(-1));
  await waitFor(async () => {
    const result = await page('Runtime.evaluate', { expression: 'chrome.runtime.id === undefined', contextId: staleContext.id, returnByValue: true });
    return result.result?.value;
  }, 'extension reload invalidates the old content script');
  await evaluate(`(() => {
    const file = document.querySelector('.file');
    const replacement = file.cloneNode(true);
    replacement.querySelectorAll('[data-review-focus-owned]').forEach(node => node.remove());
    replacement.querySelectorAll('.review-focus-native-hidden').forEach(row => row.classList.remove('review-focus-native-hidden'));
    window.fileBeforeExtensionReload = file;
    file.replaceWith(replacement);
    document.dispatchEvent(new Event('pjax:end'));
  })()`);
  await waitFor(() => evaluate('!document.querySelector("#review-focus-extension")'), 'invalidated UI removed after a diff replacement');
  assert.equal(await evaluate('document.querySelectorAll("[data-review-focus-owned], .review-focus-native-hidden").length'), 0, 'No stale panels or folded code may remain after extension invalidation.');
  assert.equal(await evaluate('window.fileBeforeExtensionReload.querySelectorAll("[data-review-focus-owned], .review-focus-native-hidden").length'), 0, 'Cleanup also restores rows retained from the previous file rendering.');
  await evaluate(`(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('popstate'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
    document.dispatchEvent(new Event('turbo:load'));
    document.dispatchEvent(new Event('visibilitychange'));
    document.querySelector('main').append(document.createElement('p'));
  })()`);
  const lateSettings = await page('Runtime.evaluate', { expression: 'Promise.resolve().then(() => rejectPendingSettings(new Error("Extension context invalidated.")))', contextId: staleContext.id, awaitPromise: true });
  assert.equal(lateSettings.exceptionDetails, undefined, 'A pending settings failure must be handled after shutdown.');
  assert.equal(await evaluate('document.querySelector("#review-focus-extension")'), null, 'Navigation and focus events must not restart an invalidated UI.');
  assert.deepEqual(exceptions, [], 'Reloading the extension and replacing a GitHub file must not throw from the old page script.');

  await page('Page.reload');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'saved review offered after reload');
  assert.equal((await modelRequests()).length, initialRequestCount);
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-cache-detail')?.textContent.includes('Opened saved review')`), 'exact-input cached review restored');
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-file-progress').hidden`), true, 'Restoring a completed review keeps file progress collapsed.');
  assert.equal((await modelRequests()).length, initialRequestCount, 'Opening the saved review must not invoke either CLI for analysis.');
  assert.deepEqual(await evaluate(`${humanReviewInputs}.map(input => input.checked)`), [true], 'Reload and cached AI restoration must read the native saved Viewed state.');
  await openFiles();
  await evaluate(`${shadow}.querySelector('.rf-reviewed-toggle input').click()`);
  await waitFor(() => evaluate(`${humanReviewInputs}.every(input => !input.checked && input.getAttribute('aria-disabled') === 'false')`), 'saved Viewed state can be undone after reload');

  assert.ok(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length > 10'));

  await evaluate(`(() => {
    window.originalViewedControl = document.querySelector('.js-reviewed-checkbox');
    window.propertyViewedControl = window.originalViewedControl.cloneNode(true);
    window.originalViewedControl.replaceWith(window.propertyViewedControl);
  })()`);
  await evaluate('new Promise(resolve => setTimeout(resolve, 400))');
  for (const checked of [true, false]) {
    await evaluate(`(() => {
      const input = window.propertyViewedControl;
      input.checked = ${checked};
      input.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await waitFor(() => evaluate(`${humanReviewInputs}.every(input => input.checked === ${checked})`), 'native checked-property change synchronized without an attribute mutation');
    assert.equal(await evaluate('window.propertyViewedControl.hasAttribute("checked")'), false, 'The native checkbox fixture must change only its checked property.');
    assert.equal(await evaluate(`${fileShadow}.querySelector('.rf-file-decisions').hidden`), checked);
  }
  await evaluate('window.propertyViewedControl.replaceWith(window.originalViewedControl)');

  const stableFolds = await evaluate(`(async () => {
    const toggle = document.querySelector('.review-focus-native-toggle');
    toggle.focus();
    const banner = document.createElement('div');
    banner.textContent = 'Unrelated GitHub page update';
    document.body.append(banner);
    await new Promise(resolve => setTimeout(resolve, 400));
    const retained = toggle.isConnected && document.activeElement === toggle;
    banner.remove();
    return retained;
  })()`);
  assert.equal(stableFolds, true, 'An unrelated page mutation must retain the existing Show lines button and keyboard focus.');

  await evaluate('window.reviewPanelBeforeNavigation = document.querySelector("#review-focus-extension")');
  for (const [away, back] of [['', '/files'], ['/checks', '/changes'], ['/commits', '/changes/abc123']]) {
    await evaluate(`(() => {
      window.diffMetadata = [...document.querySelectorAll('[data-url]')].map(node => [node, node.getAttribute('data-url')]);
      for (const [node, value] of window.diffMetadata) node.setAttribute('data-url', value.replaceAll(${JSON.stringify(baseSha)}, 'c'.repeat(40)).replaceAll(${JSON.stringify(headSha)}, 'd'.repeat(40)));
      history.pushState({}, '', ${JSON.stringify(prUrl)} + ${JSON.stringify(away)});
      window.dispatchEvent(new PopStateEvent('popstate'));
    })()`);
    await waitFor(() => evaluate('!document.querySelector("#review-focus-extension, .review-focus-file-progress, .review-focus-file-status, .review-focus-native-hidden, .review-focus-native-fold")'), `PRiorities hidden on ${away || 'Conversation'}`);
    await evaluate(`for (const [node,value] of window.diffMetadata) node.setAttribute('data-url',value); history.pushState({}, '', ${JSON.stringify(prUrl)} + ${JSON.stringify(back)}); window.dispatchEvent(new PopStateEvent('popstate'));`);
    await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-overview-title') && document.querySelector('.review-focus-file-progress') && document.querySelector('.review-focus-native-hidden')`), 'the same review restored on the diff tab');
    assert.equal(await evaluate('document.querySelector("#review-focus-extension") === window.reviewPanelBeforeNavigation'), true, 'GitHub subtab navigation must retain the existing review panel and its state.');
    assert.equal((await modelRequests()).length, initialRequestCount, 'Changing GitHub subtabs must not invoke another analysis.');
  }
  await evaluate(`history.replaceState({}, '', ${JSON.stringify(prUrl + '/files')}); window.dispatchEvent(new PopStateEvent('popstate'));`);

  for (const failure of ['issue', 'source']) {
    transientIssueFailure = failure === 'issue';
    transientSourceFailure = failure === 'source';
    await page('Page.reload');
    await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'saved review before a transient context failure');
    await click('Open saved review');
    await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('does not match')`), 'incomplete context refused without erasing the saved review');
    assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length'), 0);
    await evaluate(`(async () => {
      document.body.append(document.createElement('aside'));
      window.dispatchEvent(new Event('focus'));
      await new Promise(resolve => setTimeout(resolve, 400));
    })()`);
    assert.equal(await evaluate(`${shadow}.querySelector('.rf-analyze').textContent`), 'Run fresh review', 'The same mismatched saved entry must not return as the main action after page checks or focus refresh.');
    await evaluate(`${shadow}.querySelector('.rf-menu > summary').click()`);
    assert.equal(await evaluate(`[...${shadow}.querySelectorAll('button')].find(button => button.textContent === 'Retry saved review')?.checkVisibility()`), true);
    if (failure === 'issue') {
      await evaluate("document.querySelector('#review-focus-extension').scrollIntoView({block:'start'})");
      await writeFile('/tmp/review-focus-extension-cache-miss.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }
    transientIssueFailure = false;
    transientSourceFailure = false;
    await click('Retry saved review');
    await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-cache-detail')?.textContent.includes('Opened saved review')`), 'same review restored after the network recovers');
    assert.equal((await modelRequests()).length, initialRequestCount, 'A transient context failure must not lose paid review results or start a new model request.');
  }

  const beforeUnresolved = (await modelRequests()).length;
  await writeFile(modeFile, 'unresolved');
  await click('Run fresh review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-unresolved')?.textContent.includes('1 edit') && !${shadow}.querySelector('.rf-analyze').disabled`), 'unresolved classification visibility');
  const afterUnresolved = (await modelRequests()).length;
  assert.equal(afterUnresolved - beforeUnresolved, 2);
  assert.equal(await evaluate(`document.querySelector('[id$="R151"][data-line-number]').closest('tr').classList.contains('review-focus-native-hidden')`), false, 'An unresolved edit stays visible even when prioritization assigns it to supporting.');
  assert.ok(await evaluate(`${fileShadow}.querySelector('.rf-kept-visible').checkVisibility() && ${fileShadow}.querySelector('.rf-kept-visible').textContent.includes('cannot be established')`), 'Unresolved visible code must explain its missing evidence beside the file.');
  assert.equal(await evaluate(`${fileShadow}.querySelector('.rf-supporting').open`), false);
  await evaluate(`${shadow}.querySelector('.rf-review-index > summary').click(); ${shadow}.querySelector('.rf-supporting > summary').click(); ${shadow}.querySelector('.rf-supporting .rf-evidence > summary').click()`);
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-edit[data-edit-id="0-1-3"] .rf-change-kind')?.textContent === 'Change type: unknown'`), 'classification evidence disclosure');
  assert.ok(await evaluate(`${shadow}.querySelector('.rf-edit[data-edit-id="0-1-3"] .rf-uncertainty').textContent.includes('cannot be established')`));
  await writeFile(modeFile, 'normal');
  checkEvidence(await modelRequests());

  incomplete = true;
  await click('Run fresh review');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-error').textContent.includes('1 of 2 files')`), 'incomplete capture rejection');
  assert.equal((await modelRequests()).length, afterUnresolved, 'An incomplete diff must not be sent for analysis.');
  incomplete = false;
  modernMode = true;
  const moduleUrl = `chrome-extension://${extensionId}/github.js`;
  const modern = await evaluate(`(async()=>{
    const module=await import(${JSON.stringify(moduleUrl)});
    const doc=new DOMParser().parseFromString(${JSON.stringify(react)},'text/html');
    const files=module.findNativeFiles(doc);
    const snapshot=await module.capturePullRequest();
    const {createNativeFolding}=await import(${JSON.stringify(`chrome-extension://${extensionId}/review-ui.js`)});
    const editIds=snapshot.files.flatMap(file=>file.hunks.flatMap(hunk=>hunk.items.filter(item=>item.type==='edit').map(item=>item.id)));
    const folding=createNativeFolding(doc,snapshot,{topics:[{priority:'supporting',title:'Fixture changes',editIds,excerpts:[]}],classifications:editIds.map(editId=>({editId,kinds:['behavior'],reason:'Fixture label.',uncertainty:''}))});
    const folded=folding.apply();
    const toggle = doc.querySelector('.review-focus-native-toggle');
    const toggledRow = toggle.closest('.review-focus-native-fold').nextElementSibling;
    toggle.click();
    if (toggle.getAttribute('aria-expanded') !== 'true' || toggledRow.classList.contains('review-focus-native-hidden')) throw new Error('Show lines must expand the matching native rows.');
    toggle.click();
    if (toggle.getAttribute('aria-expanded') !== 'false' || !toggledRow.classList.contains('review-focus-native-hidden')) throw new Error('Collapse must hide the same rows again.');

    doc.querySelector('.review-focus-native-fold').remove();
    const repaired=folding.apply();
    if (doc.querySelectorAll('.review-focus-native-fold').length !== repaired.groups) throw new Error('Missing fold controls were not recreated.');
    const discussionRow = doc.querySelector('.review-focus-native-hidden');
    const discussionCell = discussionRow.querySelector('td') ?? discussionRow;
    for (const [tag, className] of [['form',''],['textarea',''],['div','review-thread-component'],['div','js-comment-container']]) {
      const discussion = doc.createElement(tag);
      discussion.className = className;
      discussionCell.append(discussion);
      folding.apply();
      if (discussionRow.classList.contains('review-focus-native-hidden')) throw new Error('A newly added discussion or form must reveal its row.');
      folding.apply();
      if (discussionRow.classList.contains('review-focus-native-hidden')) throw new Error('An unchanged layout must preserve visible discussion rows.');
      discussion.remove();
      folding.apply();
      if (!discussionRow.classList.contains('review-focus-native-hidden')) throw new Error('Removing discussion must allow the supporting row to fold again.');
    }
    folding.restore();
    return {files:files.map(file=>({path:file.path,rows:file.rows.map(({oldLine,newLine,type,text})=>({oldLine,newLine,type,text}))})), snapshot, folded, repaired, restored:doc.querySelectorAll('.review-focus-native-hidden, .review-focus-native-fold').length};
  })()`);
  assert.deepEqual(modern.files.map(file => file.path), ['.github/workflows/wait-for-checks.yml', '5854', 'play with this file, not readme']);
  assert.deepEqual(modern.files.map(file => file.rows.length), [5, 2, 2]);
  assert.equal(modern.files[0].rows[1].type, 'delete');
  assert.equal(modern.files[0].rows[1].oldLine, 2);
  assert.equal(modern.files[0].rows[1].newLine, null);
  assert.equal(modern.files[0].rows[1].text, '');
  assert.equal(modern.snapshot.files.length, 3);
  assert.equal(modern.snapshot.files.reduce((sum, file) => sum + file.additions + file.deletions, 0), 4);
  assert.equal(modern.snapshot.headSha, 'c28cc8e5271452b5b4c347d46a63f717c29417d6');
  assert.deepEqual(modern.folded, { hidden: 9, hiddenChanges: 4, matched: 9, unmatched: 0, groups: 3 });
  assert.deepEqual(modern.repaired, modern.folded);
  assert.equal(modern.restored, 0);
  assert.equal((await modelRequests()).length, afterUnresolved, 'Collecting issue context must not trigger additional model requests.');

  const captureFixture = () => evaluate(`(async()=>{
    const module=await import(${JSON.stringify(moduleUrl)});
    const progress=[];
    try {
      const snapshot=await module.capturePullRequest({onProgress:message=>progress.push(message)});
      return {snapshot,progress};
    } catch(error) { return {error:error.message,progress}; }
  })()`);
  const lifecycleRoute = structuredClone(changes.route);
  lifecycleRoute.diffContents = [
    { path: 'added.js', linesAdded: 1, linesDeleted: 0, diffLines: [{ type: 'HUNK', text: '@@ -0,0 +1 @@' }, { type: 'ADDITION', text: '+export const added = true;' }] },
    { path: 'deleted.js', linesAdded: 0, linesDeleted: 1, diffLines: [{ type: 'HUNK', text: '@@ -1 +0,0 @@' }, { type: 'DELETION', text: '-export const deleted = true;' }] },
    { path: 'modified.js', linesAdded: 1, linesDeleted: 1, diffLines: [{ type: 'HUNK', text: '@@ -1 +1 @@' }, { type: 'DELETION', text: '-export const value = false;' }, { type: 'ADDITION', text: '+export const value = true;' }] }
  ].map(entry => ({ ...entry, linesChanged: entry.linesAdded + entry.linesDeleted, oldCommitOid: baseSha, newCommitOid: headSha }));
  lifecycleRoute.diffSummaries = lifecycleRoute.diffContents;
  const lifecycleCapture = await evaluate(`(async () => {
    const {capturePullRequest} = await import(${JSON.stringify(moduleUrl)});
    const originalFetch = window.fetch;
    const requests = [];
    window.fetch = async url => {
      requests.push(url);
      if (url.includes('/files?')) return new Response(${JSON.stringify(changes.page(lifecycleRoute))});
      if (url.includes('/blob/')) {
        if (url.includes(${JSON.stringify('/' + headSha + '/modified.js')})) return new Response('Temporary error', {status:503});
        return new Response('<script type="application/json" data-target="react-app.embeddedData">{"rawLines":["export const value = true;"]}</script>');
      }
      return new Response('<div data-testid="issue-body-viewer">Add one file, remove another, and update a third.</div>');
    };
    try { return {snapshot:await capturePullRequest(),requests}; }
    finally { window.fetch = originalFetch; }
  })()`);
  assert.ok(!lifecycleCapture.requests.some(url => url.includes('/' + baseSha + '/added.js') || url.includes('/' + headSha + '/deleted.js')), 'Nonexistent sides of added/deleted files must not be fetched.');
  assert.deepEqual(lifecycleCapture.snapshot.context.filter(source => source.text === ''), [{path:'added.js',side:'before',text:''},{path:'deleted.js',side:'after',text:''}]);
  assert.deepEqual(lifecycleCapture.snapshot.warnings, ['Could not read after context for modified.js; only its diff was analyzed.'], 'Actual source fetch failures still report missing evidence.');
  deferredMode = 'missing';
  const missingDeferred = await captureFixture();
  assert.match(missingDeferred.error ?? '', /4 of 53 files/, 'A count in the deferred tabs must detect the missing 49 files before claiming the four placeholders are the complete diff.');
  assert.equal(missingDeferred.snapshot, undefined);
  assert.equal(missingDeferred.progress.some(message => message.includes('context for 4 changed files')), false);

  deferredMode = 'initial';
  deferredRequests.length = 0;
  const completeDeferred = await captureFixture();
  assert.equal(completeDeferred.error, undefined, 'Every deferred file must load before snapshot validation.');
  assert.deepEqual(completeDeferred.snapshot.files.map(file => file.path), deferred.paths);
  assert.equal(new Set(completeDeferred.snapshot.files.map(file => file.path)).size, 53);
  for (const file of completeDeferred.snapshot.files) {
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.deepEqual(file.hunks.flatMap(hunk => hunk.items).filter(item => item.type === 'edit').flatMap(item => item.rows.map(row => row.text)), [`before ${file.path}`, `after ${file.path}`]);
  }
  assert.ok(completeDeferred.progress.includes('Reading context for 53 changed files…'));
  assert.equal(completeDeferred.progress.some(message => message.includes('context for 4 changed files')), false);
  const fragments = deferredRequests.filter(url => url.includes('/deferred-') || url.includes('/partials/tabs?'));
  assert.deepEqual(new Set(fragments), new Set([...deferred.pages.keys()].map(path => `https://github.com${path}`)), 'Capture must fetch the tabs, pagination, and all 53 file diffs, including beyond the old 20-request limit.');
  assert.equal(fragments.length, deferred.pages.size, 'Each fragment is fetched once.');
  assert.ok(deferredRequests.every(url => url.startsWith('https://github.com/microsoft/vscode/')));

  deferredMode = 'unexpected';
  deferredRequests.length = 0;
  const unexpectedDeferred = await captureFixture();
  assert.match(unexpectedDeferred.error ?? '', /unexpected diff URL/);
  assert.equal(deferredRequests.some(url => url.includes('/other/repo/')), false, 'Reject a fragment outside the PR repository before fetching it.');
  assert.equal((await modelRequests()).length, afterUnresolved, 'Deferred capture and rejected incomplete captures must not invoke a model.');
  deferredMode = '';

  changesMode = 'complete';
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'the authenticated Changes route fixture');
  assert.equal(await evaluate('document.querySelectorAll("table[data-diff-anchor]").length'), 4, 'Only four split-view tables are rendered while the payload inventories 53 files.');
  changesRequests.length = 0;
  const completeChanges = await captureFixture();
  assert.equal(completeChanges.error, undefined, 'Capture must read the Changes route and load the 49 entries missing from the rendered split view.');
  const splitFolds = await evaluate(`(async () => {
    const {createNativeFolding} = await import(${JSON.stringify(`chrome-extension://${extensionId}/review-ui.js`)});
    const snapshot = ${JSON.stringify(completeChanges.snapshot)};
    const editIds = snapshot.files.flatMap(file=>file.hunks.flatMap(hunk=>hunk.items.filter(item=>item.type==='edit').map(item=>item.id)));
    const folding = createNativeFolding(document, snapshot, {topics:[{priority:'supporting',title:'Split fixture',editIds,excerpts:[]}],classifications:editIds.map(editId=>({editId,kinds:['behavior'],reason:'Fixture change.',uncertainty:''}))});
    const result = folding.apply();
    const splitRows = [...document.querySelectorAll('tr.diff-line-row')].filter(row=>row.querySelectorAll('.diff-text').length === 2);
    const visible = splitRows.every(row=>!row.classList.contains('review-focus-native-hidden') && row.checkVisibility());
    folding.restore();
    return {...result, splitRows:splitRows.length, visible};
  })()`);
  assert.equal(splitFolds.hidden, 0, 'Split rows must remain visible even when every edit is supporting.');
  assert.equal(splitFolds.splitRows, 4, 'The fixture must contain four split rows with code on both sides.');
  assert.equal(splitFolds.visible, true, 'Every split row must remain visible after applying focus.');

  assert.deepEqual(completeChanges.snapshot.files.map(file => file.path), changes.paths);
  assert.equal(completeChanges.snapshot.baseSha, changes.baseSha);
  assert.equal(completeChanges.snapshot.headSha, changes.headSha);
  assert.equal(JSON.stringify(completeChanges.snapshot).includes(changes.fetchNonce), false, 'GitHub request metadata must never enter model evidence.');
  for (const file of completeChanges.snapshot.files) {
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
    assert.deepEqual(file.hunks.flatMap(hunk => hunk.items).filter(item => item.type === 'edit').flatMap(item => item.rows.map(row => ({ type: row.type, text: row.text, oldLine: row.oldLine, newLine: row.newLine }))), [
      { type: 'delete', text: `before ${file.path}`, oldLine: 1, newLine: null },
      { type: 'add', text: `after ${file.path}`, oldLine: null, newLine: 1 }
    ]);
  }
  assert.ok(completeChanges.progress.includes('Reading context for 53 changed files…'));
  assert.equal(completeChanges.progress.some(message => message.includes('context for 4 changed files')), false);
  const lazyRequests = changesRequests.filter(request => new URL(request.url).pathname.endsWith('/page_data/diff_entries'));
  assert.deepEqual(lazyRequests.flatMap(request => new URL(request.url).searchParams.get('paths').split(',').map(decodeURIComponent)).sort(), changes.paths.slice(4).sort(), 'Fetch every missing path exactly once, preserving commas, spaces, percent signs, and Unicode.');
  for (const request of lazyRequests) {
    const url = new URL(request.url);
    assert.equal(url.searchParams.get('range'), changes.headSha);
    assert.equal(url.searchParams.get('w'), '0');
    const headers = new Map(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('github-is-react'), 'true');
    assert.equal(headers.get('github-verified-fetch'), 'true');
    assert.equal(headers.get('x-requested-with'), 'XMLHttpRequest');
    assert.equal(headers.get('x-fetch-nonce'), changes.fetchNonce);
    assert.equal(headers.get('x-github-client-version'), changes.release);
  }
  assert.ok(changesRequests.some(request => new URL(request.url).pathname.endsWith('/files')));
  for (const request of changesRequests.filter(request => new URL(request.url).pathname.endsWith('/files'))) {
    assert.equal(new URL(request.url).searchParams.get('w'), '0', 'Capture must explicitly include whitespace changes.');
  }
  assert.ok(changesRequests.some(request => new URL(request.url).pathname.endsWith('/changes')), 'The files URL redirects to the current Changes route even when unified view is requested.');

  changesMode = 'deferred-large';
  changesRequests.length = 0;
  const largeChanges = await captureFixture();
  assert.equal(largeChanges.error, undefined, 'GitHub defers large inline and batched diffs until each file is requested individually.');
  assert.deepEqual(largeChanges.snapshot.files, completeChanges.snapshot.files);
  const singleLoads = changesRequests.filter(request => new URL(request.url).pathname.endsWith('/page_data/diff_entries')).map(request => new URL(request.url).searchParams.get('paths').split(',').map(decodeURIComponent)).filter(paths => paths.length === 1).flat();
  assert.ok(singleLoads.includes(changes.paths[0]), 'Load the large inline placeholder individually.');
  assert.ok(singleLoads.includes(changes.paths[4]), 'Load the large batched placeholder individually.');

  changesMode = 'generated';
  changesRequests.length = 0;
  const generatedChanges = await captureFixture();
  assert.equal(generatedChanges.error, undefined, 'Generated files require GitHub’s Load diff endpoint even for a tiny change.');
  assert.deepEqual(generatedChanges.snapshot.files, completeChanges.snapshot.files.map((file, index) => index === 0 ? { ...file, isGenerated: true } : file));
  const generatedRequest = changesRequests.find(request => new URL(request.url).pathname.endsWith('/page_data/diff_entry_lines'));
  assert.ok(generatedRequest);
  assert.equal(new URL(generatedRequest.url).searchParams.get('path'), changes.paths[0]);
  assert.equal(new URL(generatedRequest.url).searchParams.get('range'), changes.headSha);
  assert.equal(new URL(generatedRequest.url).searchParams.get('w'), '0');

  for (const mode of ['missing', 'duplicate', 'wrong-path', 'wrong-revision', 'truncated', 'duplicate-summary', 'truncated-list', 'inline-revision', 'generated-missing', 'generated-incomplete']) {
    changesMode = mode;
    const rejected = await captureFixture();
    assert.equal(typeof rejected.error, 'string', `${mode} must reject the capture.`);
    assert.equal(rejected.snapshot, undefined, `${mode} must not expose a partial snapshot.`);
    assert.equal(rejected.progress.some(message => message.startsWith('Reading context for ')), false, `${mode} must fail before claiming capture is complete.`);
  }
  changesMode = 'missing';
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-error')?.textContent.length > 0`), 'incomplete Changes route rejection through Analyze PR');
  assert.equal((await modelRequests()).length, afterUnresolved, 'Reading complete diffs and rejecting incomplete or malformed Changes responses must not invoke Codex.');
  const beforeParallel = (await modelRequests()).length;
  changesMode = 'parallel';
  await writeFile(modeFile, 'parallel');
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'current unified Changes layout');
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-overview-title')?.textContent === '0 review decisions' && !${shadow}.querySelector('.rf-analyze').disabled`), 'three actual native helpers followed by a PR review');
  const parallelRequests = (await modelRequests()).slice(beforeParallel);
  assert.equal(parallelRequests.length, 4, 'Three file classifications, followed by one PR review.');
  assert.equal(parallelRequests.filter(request=>request.evidence.files.length===1).length,3);
  assert.equal(parallelRequests.at(-1).evidence.files.length,3);
  let active = 0;
  let peak = 0;
  for (const event of (await readFile(lifecycleLog,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line))) {
    active += event.type === 'start' ? 1 : -1;
    peak = Math.max(peak,active);
  }
  assert.equal(peak,3,'The installed extension runs exactly three independent native Codex processes in parallel.');
  assert.equal(active,0);
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length'),6,'Current GitHub unified rows use new-diff-line-number and must fold after a validated review.');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-file-progress[data-state=complete]").length'),3);
  await click('Full diff');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length'),0);

  const beforeGenerated = (await modelRequests()).length;
  changesMode = 'generated-review';
  await writeFile(modeFile, 'generated-review');
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'generated review fixture');
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-generated-notice')?.textContent.includes('1 generated file was skipped by AI') && !${shadow}.querySelector('.rf-analyze').disabled`), 'final result excluding generated file');
  const defaultRequests = (await modelRequests()).slice(beforeGenerated);
  assert.equal(defaultRequests.length, 3, 'Only the two ordinary files and their PR review invoke Codex.');
  assert.equal(defaultRequests.some(request => request.evidence.files.some(file => file.path === changes.paths[0])), false);
  assert.equal(JSON.stringify(defaultRequests).includes(`before ${changes.paths[0]}`), false, 'Generated source must not enter any default model request.');
  assert.equal(defaultRequests.at(-1).evidence.files.length, 2);
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-file-progress[data-state=excluded]").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-file-progress[data-state=complete]").length'), 2);
  assert.equal(await evaluate('document.querySelectorAll("section[role=region]")[0].querySelectorAll(".review-focus-native-hidden, .review-focus-native-fold").length'), 0, 'An excluded file must never be folded as if reviewed.');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length'), 4);
  await page('Page.reload');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'saved review with an excluded generated file');
  const restoreWorker = workers.at(-1);
  await send('Runtime.evaluate', {expression:`
    globalThis.originalRestoreDigest = crypto.subtle.digest;
    crypto.subtle.digest = (...args) => new Promise(resolve => {
      globalThis.releaseRestoreDigest = () => resolve(originalRestoreDigest.apply(crypto.subtle, args));
    });
  `}, restoreWorker);
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-phase')?.textContent === 'Opening saved review' && document.querySelector('.review-focus-file-progress[data-state=excluded]')`), 'saved-review lookup held while generated files are visible');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.review-focus-file-status')).flatMap(file=>[...file.shadowRoot.querySelectorAll('button')]).some(button=>button.textContent==='Review anyway') || Array.from(${shadow}.querySelectorAll('button')).some(button=>button.textContent==='Review anyway')`), false, 'File analysis controls must wait for saved-review restoration.');
  await waitFor(async () => (await send('Runtime.evaluate', {expression:'typeof releaseRestoreDigest === "function"',returnByValue:true}, restoreWorker)).result.value, 'cache fingerprint gate');
  await send('Runtime.evaluate', {expression:'releaseRestoreDigest(); crypto.subtle.digest = originalRestoreDigest; delete globalThis.releaseRestoreDigest; delete globalThis.originalRestoreDigest;'}, restoreWorker);
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-cache-detail')?.textContent.includes('Opened saved review')`), 'restore excluded-file controls');
  assert.equal((await modelRequests()).length, beforeGenerated + defaultRequests.length);
  const beforeOptIn = (await modelRequests()).length;
  await evaluate('[...document.querySelector(".review-focus-file-status[data-state=excluded]").shadowRoot.querySelectorAll("button")].find(button=>button.textContent==="Review anyway").click()');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-overview-title')?.textContent === '0 review decisions' && !${shadow}?.querySelector('.rf-generated-notice') && document.querySelectorAll('.review-focus-file-progress[data-state=complete]').length === 3 && !${shadow}?.querySelector('.rf-analyze')?.disabled`), 'forced generated file followed by an updated PR review');
  const forcedRequests = (await modelRequests()).slice(beforeOptIn);
  assert.equal(forcedRequests.length, 2, 'Opt-in runs only the chosen file’s classification and a new PR review.');
  assert.deepEqual(forcedRequests[0].evidence.files.map(file => file.path), [changes.paths[0]]);
  assert.equal(forcedRequests.at(-1).evidence.files.length, 3);
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length'), 6);
  await click('Full diff');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden, .review-focus-native-fold").length'), 0);
  await writeFile(modeFile,'normal');
  changesMode = '';
  const beforeProviderSettings = (await modelRequests()).length;

  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex") && !document.querySelector("#model").disabled'), 'saved settings');
  assert.equal(await evaluate('document.querySelector("#model").value'), 'fixture-model');
  await writeFile(modeFile, 'signed-out');
  await evaluate('document.querySelector("#check-connection").click()');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("codex login") && !document.querySelector("#check-connection").disabled'), 'signed-out guidance');
  await writeFile(modeFile, 'normal');
  await evaluate('document.querySelector("#check-connection").click()');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex") && !document.querySelector("#model").disabled'), 'reconnecting after login');
  assert.equal((await modelRequests()).length, beforeProviderSettings, 'Connection checks must not invoke a model.');

  await evaluate('document.querySelector("#provider").value="claude"; document.querySelector("#provider").dispatchEvent(new Event("change"))');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code") && !document.querySelector("#model").disabled'), 'Claude subscription connection');
  assert.equal(await evaluate('document.querySelector("#model").value'), 'claude-fixture-model', 'Claude picks its own catalog default rather than inheriting Codex.');
  assert.equal(await evaluate('document.querySelector("#login-command").textContent'), 'claude auth login');
  assert.ok(await evaluate('document.querySelector("#provider-privacy").textContent.includes("Anthropic")'));
  await evaluate('document.querySelector("#model").value="claude-fixture-model"; document.querySelector("#settings-form").requestSubmit()');
  await waitFor(() => evaluate('document.querySelector("#status")?.textContent.includes("Settings saved")'), 'saving Claude selection');
  await evaluate('document.querySelector("#provider").value="codex"; document.querySelector("#provider").dispatchEvent(new Event("change"))');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex") && !document.querySelector("#model").disabled'), 'preview Codex without switching the saved provider');
  assert.equal(await evaluate('document.querySelector("#model").value'), 'fixture-model');
  assert.equal(await evaluate('chrome.storage.local.get("reviewProvider").then(value=>value.reviewProvider)'), 'claude');
  await evaluate('for(const value of ["claude","codex","claude"]) { document.querySelector("#provider").value=value; document.querySelector("#provider").dispatchEvent(new Event("change")); }');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code") && !document.querySelector("#model").disabled'), 'latest selection wins during rapid switching');
  assert.equal(await evaluate('document.querySelector("#model").value'), 'claude-fixture-model');
  await writeFile(modeFile, 'signed-out');
  await evaluate('document.querySelector("#check-connection").click()');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("claude auth login") && !document.querySelector("#model").disabled'), 'Claude signed-out guidance');
  await writeFile(modeFile, 'normal');
  await evaluate('document.querySelector("#model").value="__custom__"; document.querySelector("#model").dispatchEvent(new Event("change")); document.querySelector("#custom-model").value="draft-model"; document.querySelector("#check-connection").click()');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code") && !document.querySelector("#model").disabled'), 'Claude reconnected');
  assert.equal(await evaluate('document.querySelector("#custom-model").value'), 'draft-model', 'Checking the connection must preserve unsaved model edits.');
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code") && !document.querySelector("#model").disabled'), 'restoring saved Claude settings');
  assert.equal(await evaluate('document.querySelector("#provider").value'), 'claude');
  assert.equal(await evaluate('document.querySelector("#model").value'), 'claude-fixture-model');
  await evaluate('document.querySelector("#model").value="claude-fixture-older"; document.querySelector("#model").dispatchEvent(new Event("change"))');
  assert.deepEqual(await evaluate('Array.from(document.querySelector("#effort").options,option=>option.value)'), ['low','high'], 'Changing models must update supported effort choices.');
  await evaluate('document.querySelector("#model").value="claude-fixture-model"; document.querySelector("#model").dispatchEvent(new Event("change"))');
  assert.equal(await evaluate('document.querySelector("#effort").value'), 'medium');
  await writeFile('/tmp/review-focus-extension-claude-settings.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  modernMode = false;
  deferredMode = '';
  incomplete = false;
  await page('Page.navigate', { url: prUrl + '/files' });
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('with Claude Code')`), 'Claude-ready PR');
  assert.equal((await modelRequests()).length, beforeProviderSettings, 'Selecting Claude and opening a PR must not start analysis.');
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-overview-title')?.textContent === '1 review decision' && !${shadow}?.querySelector('.rf-analyze')?.disabled`), 'Claude classification followed by the PR review');
  const claudeRequests = (await modelRequests()).slice(beforeProviderSettings);
  assert.equal(claudeRequests.length, 2);
  const afterClaude = (await modelRequests()).length;
  assert.ok(claudeRequests.every(request => request.provider === 'claude' && request.args[request.args.indexOf('--model')+1] === 'claude-fixture-model' && request.args[request.args.indexOf('--effort')+1] === 'medium'));
  assert.equal(claudeRequests[0].evidence.classifications, undefined);
  assert.deepEqual(claudeRequests[1].evidence.classifications, classifications);
  assert.ok(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length') > 0);
  await click('Full diff');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden, .review-focus-native-fold").length'), 0);
  await page('Page.reload');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'Claude review saved for the same input');
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-cache-detail')?.textContent.includes('Opened saved review')`), 'Claude cached review restored');
  assert.equal((await modelRequests()).length, afterClaude);
  const { targetId: modelSettingsTarget } = await send('Target.createTarget', { url: `chrome-extension://${extensionId}/options.html` });
  const { sessionId: modelSettingsSession } = await send('Target.attachToTarget', { targetId: modelSettingsTarget, flatten: true });
  await waitFor(() => evaluate('document.querySelector("#provider")?.value === "claude" && !document.querySelector("#model").disabled', modelSettingsSession), 'model settings in a separate tab');
  async function saveModelChoice(provider, model, effort) {
    await send('Page.bringToFront', {}, modelSettingsSession);
    await evaluate(`(() => {
      const provider = document.querySelector('#provider');
      if (provider.value === ${JSON.stringify(provider)}) return;
      provider.value = ${JSON.stringify(provider)};
      provider.dispatchEvent(new Event('change'));
    })()`, modelSettingsSession);
    await waitFor(() => evaluate('!document.querySelector("#model").disabled', modelSettingsSession), 'selected provider model catalog');
    await evaluate(`(() => {
      const picker = document.querySelector('#model');
      picker.value = Array.from(picker.options).some(option => option.value === ${JSON.stringify(model)}) ? ${JSON.stringify(model)} : '__custom__';
      picker.dispatchEvent(new Event('change'));
      if (picker.value === '__custom__') document.querySelector('#custom-model').value = ${JSON.stringify(model)};
      document.querySelector('#effort').value = ${JSON.stringify(effort)};
      document.querySelector('#status').textContent = '';
      document.querySelector('#settings-form').requestSubmit();
    })()`, modelSettingsSession);
    await waitFor(() => evaluate('document.querySelector("#status").textContent.includes("Settings saved") && !document.querySelector("#save").disabled', modelSettingsSession), 'model and effort saved');
    await page('Page.bringToFront');
    await evaluate("window.dispatchEvent(new Event('focus'))");
  }
  await evaluate(`window.reviewBeforeSettings = document.querySelector('#review-focus-extension'); window.explanationBeforeSettings = ${fileShadow}.querySelector('.rf-change-explanation')`);
  const originalRunLabel = await evaluate(`${shadow}.querySelector('.rf-run-settings').textContent`);
  const originalHiddenLines = await evaluate('document.querySelectorAll(".review-focus-native-hidden").length');
  for (const choice of [
    { provider:'claude', model:'claude-custom-older', effort:'medium' },
    { provider:'claude', model:'claude-fixture-model', effort:'high' },
    { provider:'codex', model:'claude-fixture-model', effort:'medium' }
  ]) {
    await saveModelChoice(choice.provider, choice.model, choice.effort);
    await waitFor(() => evaluate(`${shadow}.querySelector('.rf-actions > .rf-analyze')?.textContent === 'Analyze PR' && ${shadow}.querySelector('.rf-analyze').checkVisibility()`), 'Analyze PR promoted without GitHub navigation after changing analysis settings');
    const status = await evaluate(`({text:${shadow}.querySelector('.rf-status').textContent, visible:!${shadow}.querySelector('.rf-status').classList.contains('rf-visually-hidden') && ${shadow}.querySelector('.rf-status').checkVisibility()})`);
    const providerLabel = choice.provider === 'claude' ? 'Claude Code' : 'Codex';
    assert.ok(status.visible && status.text.includes('Settings changed') && status.text.includes(providerLabel) && status.text.includes(choice.model) && status.text.includes(choice.effort), 'The visible notice identifies the settings for the next analysis.');
    assert.equal(await evaluate(`${shadow}.querySelector('.rf-run-settings').textContent`), originalRunLabel, 'Existing results retain their original provider, model and effort label.');
    assert.ok(await evaluate(`window.reviewBeforeSettings === document.querySelector('#review-focus-extension') && window.explanationBeforeSettings.isConnected`), 'Returning from Settings preserves the mounted PR and its existing explanations.');
    assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length'), originalHiddenLines, 'Changing future settings must not alter current folding.');
    assert.equal((await modelRequests()).length, afterClaude, 'Saving settings and returning to the PR must not invoke a model.');
    await saveModelChoice('claude', 'claude-fixture-model', 'medium');
    await waitFor(() => evaluate(`${shadow}.querySelector('.rf-menu .rf-analyze')?.textContent === 'Run fresh review' && !${shadow}.querySelector('.rf-status').textContent.includes('Settings changed')`), 'returning to the review settings removes the mismatch action');
  }
  await saveModelChoice('claude', 'claude-custom-older', 'high');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-actions > .rf-analyze')?.textContent === 'Analyze PR'`), 'custom model analysis ready in the existing PR document');
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-run-settings').textContent.includes('claude-custom-older · Effort: high') && !${shadow}.querySelector('.rf-analyze').disabled && ${shadow}.querySelector('.rf-overview-title')?.textContent === '1 review decision'`), 'explicit analysis uses the custom model and effort');
  const changedModelRequests = (await modelRequests()).slice(afterClaude);
  assert.equal(changedModelRequests.length, 2);
  assert.ok(changedModelRequests.every(request => request.provider === 'claude' && request.args[request.args.indexOf('--model')+1] === 'claude-custom-older' && request.args[request.args.indexOf('--effort')+1] === 'high'));
  await saveModelChoice('claude', 'claude-fixture-model', 'medium');
  await page('Page.reload');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'original saved review remains available after changing model');
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-cache-detail')?.textContent.includes('Opened saved review')`), 'original Claude model review restored');
  const afterModelSettings = afterClaude + changedModelRequests.length;
  assert.equal((await modelRequests()).length, afterModelSettings, 'Returning to the original model reuses its saved review.');
  descriptionSuffix = ' Additional acceptance criteria added without a commit.';
  await page('Page.reload');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'cached commit pair available before verifying changed intent');
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('does not match')`), 'changed description invalidates cached assessment');
  assert.equal((await modelRequests()).length, afterModelSettings, 'A stale saved-review action must not silently start a paid analysis.');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length'), 0);
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-analyze').textContent`), 'Run fresh review');
  await click('Run fresh review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-overview-title')?.textContent === '1 review decision' && !${shadow}?.querySelector('.rf-analyze')?.disabled`), 'explicit fresh analysis after changed intent');
  const afterChangedIntent = (await modelRequests()).length;
  assert.equal(afterChangedIntent - afterModelSettings, 2);

  const lastSnapshot = (await captureFixture()).snapshot;
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('!document.querySelector("#cache-limit").disabled'), 'cache ready for invalid stored-result regression');
  const invalidRecord = await evaluate(`(async () => {
    const cache = await import('./review-cache.js');
    const identity = await cache.reviewCacheKey(${JSON.stringify(lastSnapshot)},{provider:'claude',model:'claude-fixture-model',effort:'medium'});
    const original = await cache.readReview(identity.key);
    if (!original) throw new Error('Expected a saved review for this exact capture.');
    await cache.saveReview(identity,{analysis:original.analysis,paths:[]});
    return {identity,original};
  })()`);
  await page('Page.navigate', { url: prUrl + '/files' });
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'invalid saved result offered for validation');
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-error')?.textContent.includes('saved') && ${shadow}.querySelector('.rf-status').textContent === 'The saved review could not be opened.'`), 'invalid saved result rejected as an error without deletion');
  assert.equal(await evaluate(`${shadow}.textContent.includes('does not match')`), false, 'Invalid saved data must not be described as a context mismatch.');
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-analyze').textContent`), 'Run fresh review');
  assert.equal((await modelRequests()).length, afterChangedIntent);
  const { targetId: cacheTarget } = await send('Target.createTarget', { url: `chrome-extension://${extensionId}/options.html`, background: true });
  const { sessionId: cacheSession } = await send('Target.attachToTarget', { targetId: cacheTarget, flatten: true });
  await waitFor(async () => (await send('Runtime.evaluate', { expression: 'location.protocol === "chrome-extension:" && document.readyState === "complete"', returnByValue: true }, cacheSession)).result.value, 'separate cache document ready');
  const replacement = await send('Runtime.evaluate', {
    expression: `(async () => {
      const cache = await import('./review-cache.js');
      const retained = await cache.readReview(${JSON.stringify(invalidRecord.identity.key)});
      const replaced = await cache.saveReview(${JSON.stringify(invalidRecord.identity)}, ${JSON.stringify(invalidRecord.original)});
      return {retainedPaths:retained.paths.length,saved:replaced.saved};
    })()`, awaitPromise: true, returnByValue: true
  }, cacheSession);
  assert.equal(replacement.exceptionDetails, undefined);
  assert.equal(replacement.result.value.retainedPaths, 0, 'Failed restoration must not delete a stored result.');
  assert.equal(replacement.result.value.saved, true);
  await send('Target.closeTarget', { targetId: cacheTarget });
  await page('Page.bringToFront');
  await evaluate("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-analyze').textContent === 'Open saved review'`), 'a replaced saved result with the same fingerprint and a new save time is offered again');
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-cache-detail')?.textContent.includes('Opened saved review')`), 'replacement saved result restored');
  assert.equal((await modelRequests()).length, afterChangedIntent);
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('!document.querySelector("#cache-limit").disabled && document.querySelector("#cache-usage").textContent.includes("MB used")'), 'cache settings and usage');
  assert.equal(await evaluate('document.querySelector("#cache-limit").value'), '100');
  await evaluate(`(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = message => {
      if (message.type !== 'clear-cache') return original(message);
      chrome.runtime.sendMessage = original;
      return Promise.resolve({error:'Temporary cache failure'});
    };
    document.querySelector('#clear-cache').click();
  })()`);
  await waitFor(() => evaluate('document.querySelector("#cache-status").textContent === "Temporary cache failure"'), 'cache request failure shown');
  assert.equal(await evaluate('document.querySelector("#clear-cache").disabled'), false, 'A failed cache request must leave Clear available to retry.');
  await evaluate('document.querySelector("#clear-cache").click()');
  await waitFor(() => evaluate('document.querySelector("#cache-status").textContent.includes("Saved reviews cleared")'), 'clearing saved reviews');
  await evaluate('document.querySelector("#cache-limit").value="1"; document.querySelector("#cache-form").requestSubmit()');
  await waitFor(() => evaluate('document.querySelector("#cache-status").textContent === "Cache limit saved."'), 'custom cache size');
  const cacheChecks = await evaluate(`(async () => {
    const cache = await import('./review-cache.js');
    await cache.saveReview({key:'previous',lookup:'cancel-test'},{text:'Paid review'});
    const cancelled = new AbortController();
    cancelled.abort();
    let preAborted = false;
    try { await cache.saveReview({key:'never-started',lookup:'cancel-test'},{text:'Replacement'},cancelled.signal); }
    catch (error) { preAborted = error.name === 'AbortError'; }
    const cancelling = new AbortController();
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value,...args) {
      const request = originalPut.call(this,value,...args);
      if (this.name === 'reviews' && value.key === 'uncommitted') cancelling.abort();
      return request;
    };
    let abortedWrite = false;
    try { await cache.saveReview({key:'uncommitted',lookup:'cancel-test'},{text:'Replacement'},cancelling.signal); }
    catch (error) { abortedWrite = error.name === 'AbortError'; }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const cancellation = {preAborted,abortedWrite,previous:await cache.readReview('previous'),replacement:await cache.readReview('uncommitted'),unstarted:await cache.readReview('never-started')};
    await cache.clearCache();
    const settings = {provider:'claude',model:'fixture'};
    const input = {url:${JSON.stringify(prUrl)},baseSha:${JSON.stringify(baseSha)},headSha:${JSON.stringify(headSha)},description:'first',context:[]};
    const original = await cache.reviewCacheKey(input,settings);
    const variants = await Promise.all([
      cache.reviewCacheKey({...input,headSha:'c'.repeat(40)},settings),
      cache.reviewCacheKey({...input,baseSha:'d'.repeat(40)},settings),
      cache.reviewCacheKey({...input,description:'second'},settings),
      cache.reviewCacheKey({...input,context:[{text:'different source'}]},settings),
      cache.reviewCacheKey(input,{...settings,provider:'codex'}),
      cache.reviewCacheKey(input,{...settings,model:'other'}),
      cache.reviewCacheKey(input,{...settings,effort:'high'}),
      cache.reviewCacheKey(input,{...settings,review:{focus:'thorough',alwaysShow:[],classificationPrompt:'',prioritizationPrompt:''}})
    ]);
    const value = {text:'x'.repeat(360000)};
    await cache.saveReview({key:'a',lookup:'a'},value);
    await cache.saveReview({key:'b',lookup:'b'},value);
    await cache.readReview('a');
    await cache.saveReview({key:'c',lookup:'c'},value);
    const lru = {a:Boolean(await cache.readReview('a')),b:Boolean(await cache.readReview('b')),c:Boolean(await cache.readReview('c')),info:await cache.cacheInfo()};
    const tooLarge = await cache.saveReview({key:'huge',lookup:'huge'},{text:'x'.repeat(1100000)});
    await cache.setCacheLimit(2);
    await Promise.all(['d','e','f','g'].map(key=>cache.saveReview({key,lookup:key},value)));
    const parallel = await cache.cacheInfo();
    const shrunk = await cache.setCacheLimit(1);
    await cache.clearCache();
    return {cancellation,keys:new Set([original,...variants].map(entry=>entry.key)).size,lru,tooLarge,parallel,shrunk,cleared:await cache.cacheInfo()};
  })()`);
  assert.equal(cacheChecks.cancellation.preAborted, true);
  assert.equal(cacheChecks.cancellation.abortedWrite, true, 'Cancelling an uncommitted IndexedDB write must abort the transaction.');
  assert.equal(cacheChecks.cancellation.previous.text, 'Paid review', 'Aborting a replacement must roll back deletion of the earlier review.');
  assert.equal(cacheChecks.cancellation.replacement, null);
  assert.equal(cacheChecks.cancellation.unstarted, null);
  assert.equal(cacheChecks.keys, 9, 'Commits, intent, source context, provider, model, effort and review preferences each change the cache key.');
  assert.deepEqual([cacheChecks.lru.a, cacheChecks.lru.b, cacheChecks.lru.c], [true, false, true], 'Reading A keeps it while the older B is evicted.');
  assert.equal(cacheChecks.lru.info.count, 2);
  assert.ok(cacheChecks.lru.info.usedBytes <= 1024 * 1024);
  assert.equal(cacheChecks.tooLarge.saved, false);
  assert.ok(cacheChecks.parallel.usedBytes <= 2 * 1024 * 1024, 'Concurrent saves must respect one shared budget.');
  assert.ok(cacheChecks.shrunk.usedBytes <= 1024 * 1024 && cacheChecks.shrunk.count < cacheChecks.parallel.count);
  assert.deepEqual(cacheChecks.cleared, {limitMB:1,usedBytes:0,count:0});
  await page('Page.reload');
  await waitFor(() => evaluate('!document.querySelector("#cache-limit").disabled'), 'saved cache limit restored');
  assert.equal(await evaluate('document.querySelector("#cache-limit").value'), '1');
  assert.equal(await evaluate('document.querySelector("#clear-cache").disabled'), true);
  await waitFor(() => evaluate('!document.querySelector("#save").disabled'), 'provider settings also ready for screenshot');
  await evaluate('document.querySelector("#cache-form").scrollIntoView({block:"center"})');
  await writeFile('/tmp/review-focus-cache-settings.png', Buffer.from((await page('Page.captureScreenshot', {format:'png'})).data,'base64'));
  const worker = workers.at(-1);
  await send('Runtime.evaluate', {expression:`globalThis.originalInterval = globalThis.setInterval; globalThis.setInterval = (callback,delay,...args) => originalInterval(callback,delay === 20000 ? 40 : delay,...args);`}, worker);
  for (const state of ['failed', 'excluded']) {
    await writeFile(modeFile, state === 'failed' ? 'analysis-failed' : 'normal');
    changesMode = state === 'excluded' ? 'all-generated' : '';
    await page('Page.navigate', {url:prUrl + (changesMode ? '/changes' : '/files')});
    await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'idle review fixture ready');
    await evaluateExtension(`(() => {
      const connect = chrome.runtime.connect;
      window.fixturePendingActions = [];
      chrome.runtime.connect = (...args) => {
        const connection = connect(...args);
        const post = connection.postMessage.bind(connection);
        connection.postMessage = message => {
          if (['cancel', 'retry-file', 'review-file'].includes(message.type)) window.fixturePendingActions.push(() => post(message));
          else post(message);
        };
        const add = connection.onMessage.addListener.bind(connection.onMessage);
        connection.onMessage.addListener = listener => {
          window.fixtureReviewMessage = listener;
          add(message => {
            listener(message);
            if (window.fixtureAwaitAcknowledgement === message.path && message.type === 'file-progress' && message.state === 'queued') {
              window.fixtureActionAcknowledged = document.querySelector('#review-focus-extension').shadowRoot.querySelector('.rf-status').classList.contains('rf-visually-hidden');
            }
          });
        };
        return connection;
      };
    })()`);
    await click('Analyze PR');
    await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-file-progress-row[data-state="${state}"]') && !${shadow}.querySelector('.rf-analyze').disabled`), 'review idle with an available file action');
    const action = state === 'failed' ? 'Retry file' : 'Review anyway';
    if (state === 'excluded') assert.ok(await evaluate(`${shadow}.querySelector('.rf-progress-toggle').textContent.toLowerCase().includes('skipped')`), 'A generated-only PR must not claim that files were analyzed.');
    const headerAction = await evaluate(`(async () => {
      const badge = document.querySelector('.review-focus-file-status').shadowRoot;
      const action = [...badge.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(action)});
      action.focus();
      const trigger = document.querySelector('input.js-reviewed-checkbox, .diff-file-header button[aria-pressed]');
      if (trigger) trigger.setAttribute('aria-disabled','true');
      await new Promise(resolve=>setTimeout(resolve,240));
      const result = {connected:action.isConnected,focused:badge.activeElement===action};
      if (trigger) trigger.removeAttribute('aria-disabled');
      return result;
    })()`);
    assert.deepEqual(headerAction,{connected:true,focused:true}, 'Header actions retain keyboard focus through page updates and idle heartbeats.');
    await waitFor(() => evaluate(`${shadow}.querySelector('.rf-reviewed-toggle input')?.getAttribute('aria-disabled') === 'false'`), 'native review control restored before measuring idle heartbeats');
    const idle = await evaluate(`(async () => {
      const root = ${shadow};
      if (root.querySelector('.rf-file-progress').hidden) root.querySelector('.rf-progress-toggle').click();
      const button = [...root.querySelectorAll('.rf-file-progress-row button')].find(button=>button.textContent===${JSON.stringify(action)});
      button.focus();
      let announcements = 0;
      const observer = new MutationObserver(records=>announcements+=records.length);
      observer.observe(root.querySelector('.rf-status'),{childList:true,subtree:true,characterData:true});
      await new Promise(resolve=>setTimeout(resolve,240));
      observer.disconnect();
      return {sameButton:button.isConnected,focused:root.activeElement===button,announcements};
    })()`);
    assert.deepEqual(idle,{sameButton:true,focused:true,announcements:0}, 'Idle heartbeats must preserve file-action focus and leave the live status unchanged.');
    await click('AI needs retry');
    assert.equal(await evaluate(`${shadow}.querySelectorAll('.rf-file-progress-row').length`), state === 'failed' ? 1 : 0, 'Only failed or cancelled AI jobs belong in the retry filter.');
    await click('All files');
    const actionPath = await evaluate(`${shadow}.querySelector('.rf-file-progress-row[data-state="${state}"]').dataset.path`);
    await evaluateExtension(`window.fixtureAwaitAcknowledgement = ${JSON.stringify(actionPath)}`);
    const immediateFeedback = await evaluate(`(() => {
      const root = ${shadow};
      [...root.querySelectorAll('.rf-file-progress-row button')].find(button => button.textContent === ${JSON.stringify(action)}).click();
      const status = root.querySelector('.rf-status');
      return {text:status.textContent, visible:!status.classList.contains('rf-visually-hidden') && status.checkVisibility(), role:status.getAttribute('role')};
    })()`);
    const actionMessage = `${state === 'failed' ? 'Retrying' : 'Analyzing'} ${actionPath}…`;
    assert.deepEqual(immediateFeedback, {text:actionMessage,visible:true,role:'status'}, 'File actions must provide visible accessible feedback synchronously, before worker acknowledgement.');
    await evaluateExtension(`window.fixtureReviewMessage({type:'progress',stage:'files',message:'An unrelated progress update.'})`);
    await evaluate('new Promise(resolve => setTimeout(resolve, 200))');
    assert.equal(await evaluate(`${shadow}.querySelector('.rf-status').textContent`), actionMessage, 'Unrelated progress must not erase pending file-action feedback.');
    if (state === 'excluded') await writeFile(modeFile, 'generated-review');
    await evaluateExtension('window.fixturePendingActions.splice(0).forEach(send => send())');
    await waitFor(() => evaluateExtension('window.fixtureActionAcknowledged === true'), 'the requested file acknowledgement returns status to regular progress');
    await waitFor(() => evaluate(`!${shadow}.querySelector('.rf-analyze').disabled`), 'the requested file finishes or reports failure');
    if (state === 'failed') {
      await click('Retry file');
      const stopping = await evaluate(`(() => {
        const root = ${shadow};
        [...root.querySelectorAll('button')].find(button => button.textContent === 'Cancel').click();
        const status = root.querySelector('.rf-status');
        return {text:status.textContent,visible:!status.classList.contains('rf-visually-hidden') && status.checkVisibility(),role:status.getAttribute('role')};
      })()`);
      assert.deepEqual(stopping,{text:'Stopping active analyses…',visible:true,role:'status'}, 'Cancel must confirm the request synchronously before the worker stops.');
      await evaluateExtension(`window.fixtureReviewMessage({type:'file-progress',path:${JSON.stringify(actionPath)},state:'classifying',message:'A file update in flight.'})`);
      await evaluate('new Promise(resolve => setTimeout(resolve, 200))');
      assert.equal(await evaluate(`${shadow}.querySelector('.rf-status').textContent`), 'Stopping active analyses…', 'File progress in flight must not replace the cancellation confirmation.');
      await evaluate("document.querySelector('#review-focus-extension').scrollIntoView({block:'start'})");
      await writeFile('/tmp/review-focus-extension-cancelling.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      await evaluateExtension('window.fixturePendingActions.splice(0).forEach(send => send())');
      await waitFor(() => evaluate(`!${shadow}.querySelector('.rf-analyze').disabled && ${shadow}.querySelector('.rf-status').textContent.includes('Analysis cancelled')`), 'worker cancellation replaces pending feedback with the settled state');
      assert.ok(await evaluate(`${shadow}.querySelector('.rf-progress-toggle').textContent.includes('Cancelled')`), 'The toolbar distinguishes a cancelled analysis from AI ready.');
    }
    await evaluateExtension(`new Promise(resolve => {
      const connection = chrome.runtime.connect({name:'review-focus'});
      connection.postMessage({type:'resume',baseSha:${JSON.stringify(baseSha)},headSha:${JSON.stringify(headSha)}});
      connection.onMessage.addListener(message => {
        if (message.type !== 'resumed' && message.type !== 'no-session') return;
        connection.postMessage({type:'discard'});
        connection.disconnect();
        resolve();
      });
    })`);
  }
  await page('Page.navigate', {url:'about:blank'});
  await send('Runtime.evaluate', {expression:'globalThis.setInterval = globalThis.originalInterval; delete globalThis.originalInterval;'}, worker);
  changesMode = 'many-decisions';
  await writeFile(modeFile, 'many-decisions');
  await writeFile(uxGate, 'waiting');
  const beforeMany = (await modelRequests()).length;
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'multiple review decisions fixture ready');
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-file-progress-row[data-state=classified]') && ${shadow}.querySelector('.rf-analyze').disabled`), 'first file classified while other files run');
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-file-progress').hidden`), true, 'Live analysis does not open the file list automatically.');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-file-progress-row[data-state=queued]') && ${shadow}.querySelectorAll('.rf-file-progress-row[data-state=classifying]').length === 3`), 'classified, classifying and waiting files at the same time');
  const beforeNavigation = (await modelRequests()).length;
  await page('Page.navigate', {url:prUrl + '/checks'});
  await waitFor(() => evaluateExtension('location.pathname.endsWith("/checks")').catch(() => false), 'Checks document with the extension loaded');
  assert.equal(await evaluate('Boolean(document.querySelector("#review-focus-extension, .review-focus-file-progress, .review-focus-file-status"))'), false, 'A newly loaded Checks page must have no review UI.');
  await page('Page.navigate', {url:prUrl + '/changes'});
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-file-progress-row[data-state=classified]') && ${shadow}.querySelector('.rf-file-progress-row[data-state=classifying]') && ${shadow}.querySelector('.rf-analyze').disabled`), 'active file analysis reconnected after Checks');
  assert.equal((await modelRequests()).length, beforeNavigation, 'Reconnecting must not rerun completed file passes.');
  await page('Page.reload');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-file-progress-row[data-state=classified]') && ${shadow}.querySelector('.rf-file-progress-row[data-state=classifying]') && ${shadow}.querySelector('.rf-analyze').disabled`), 'active file analysis reconnected after reload');
  assert.equal((await modelRequests()).length, beforeNavigation, 'Reloading must reuse the same file jobs.');
  await evaluate(`window.fileRowBeforeHistory = ${shadow}.querySelector('.rf-file-progress-row'); window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})); window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));`);
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-file-progress-row[data-state=classified]') && ${shadow}.querySelector('.rf-file-progress-row[data-state=classifying]') && ${shadow}.querySelector('.rf-analyze').disabled && !window.fileRowBeforeHistory.isConnected`), 'analysis reconnected after a back-forward cache restore');
  assert.equal((await modelRequests()).length, beforeNavigation, 'Restoring a cached page must not repeat completed analysis.');
  await openFiles();
  const visibleStates = await evaluate(`Array.from(${shadow}.querySelectorAll('.rf-file-progress-row'), row => ({state:row.dataset.state, label:row.querySelector('.rf-file-state').textContent, visible:row.checkVisibility()}))`);
  assert.ok(visibleStates.some(row => row.state === 'classified' && row.label.startsWith('AI classified') && row.visible));
  assert.ok(visibleStates.some(row => row.state === 'classifying' && row.label === 'AI classifying' && row.visible));
  assert.ok(visibleStates.some(row => row.state === 'queued' && row.label === 'AI waiting' && row.visible));
  assert.ok(await evaluate(`document.querySelector(".review-focus-file-status[data-state=classified]").shadowRoot.querySelector('.rf-file-state').textContent.startsWith('AI classified')`));
  await evaluate(`(() => {
    document.head.insertAdjacentHTML('beforeend', ${JSON.stringify(fixtureStyle)});
    document.querySelector('#review-focus-extension').scrollIntoView({block:'start'});
  })()`);
  await writeFile('/tmp/review-focus-extension-progress.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await evaluate(`${shadow}.querySelector('.rf-progress-toggle').click()`);
  assert.ok(await evaluate(`${shadow}.querySelector('.rf-status').textContent.includes('1 of 5 files classified')`), 'Live progress describes classified files without duplicate visible status.');
  await writeFile(uxGate, 'continue');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-progress-detail').textContent.includes('Every file is classified')`), 'every file classified before the PR review');
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-file-progress').hidden`), true, 'Progress updates must not reopen a list the user collapsed.');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-file-progress[data-state=classified]").length'), 3, 'The fixture only mounts three of the five classified files.');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden, .review-focus-native-fold").length'), 0, 'No code folds before the whole-PR review decisions arrive.');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.review-focus-file-progress'), file => file.shadowRoot.querySelectorAll('.rf-review').length).reduce((sum, count) => sum + count, 0) + ${shadow}.querySelectorAll('.rf-review').length`), 0, 'Classified files show progress only, without review decisions.');
  await page('Page.navigate', {url:prUrl + '/checks'});
  await waitFor(() => evaluateExtension('location.pathname.endsWith("/checks")').catch(() => false), 'Checks while the PR review runs');
  await page('Page.navigate', {url:prUrl + '/changes'});
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-phase')?.textContent === 'Choosing review decisions' && ${shadow}.querySelectorAll('.rf-file-progress-row[data-state=classified]').length === 5`), 'the same PR review reconnected with classified files');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden, .review-focus-native-fold").length'), 0, 'Reconnecting before the PR review finishes must not fold code.');
  await page('Page.navigate', {url:prUrl});
  await waitFor(() => evaluateExtension('location.pathname === new URL(' + JSON.stringify(prUrl) + ').pathname').catch(() => false), 'Conversation while analysis remains in the background');
  assert.equal(await evaluate('Boolean(document.querySelector("#review-focus-extension"))'), false);
  await writeFile(uxGate, 'finish');
  await waitFor(async () => (await modelRequests()).length - beforeMany === 6, 'the PR review completes while away from the diff');
  await page('Page.navigate', {url:prUrl + '/changes'});
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-overview-title')?.textContent === '5 review decisions' && !${shadow}.querySelector('.rf-analyze').disabled`), 'all five final decisions restored on return');
  assert.equal((await modelRequests()).length - beforeMany, 6);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.review-focus-file-progress'), file => [...file.shadowRoot.querySelectorAll('.rf-review > .rf-topic-body')].filter(body => body.checkVisibility()).length).reduce((sum, count) => sum + count, 0)`), 3);
  const beforeExpansion = (await modelRequests()).length;
  for (const expanded of [true, false, true, false]) {
    await evaluate(`(() => {
      const file = document.querySelector('section[id^="diff-"][role="region"]');
      window.fileBeforeExpansion = file;
      file.querySelector('.js-expand-all-difflines-button').click();
    })()`);
    await waitFor(() => evaluate(`!window.fileBeforeExpansion.isConnected && document.querySelector('section[id^="diff-"][role="region"]')?.querySelector('.review-focus-file-progress[data-state="complete"]')`), 'file analysis reattached after native expand/collapse replaces the region');
    const expandedLayout = await evaluate(`(() => {
      const file = document.querySelector('section[id^="diff-"][role="region"]');
      const header = file.querySelector('[data-diff-header-wrapper]');
      const panel = file.querySelector('.review-focus-file-progress');
      file.scrollIntoView({block:'start',behavior:'instant'});
      if (${expanded}) window.scrollBy({top:600,behavior:'instant'});
      return {
        insideStickyHeader: header.contains(panel),
        badgeCount: header.querySelectorAll('.review-focus-file-status').length,
        panelCount: file.querySelectorAll('.review-focus-file-progress').length,
        explanation: panel.shadowRoot.querySelector('.rf-change-explanation').textContent,
        contextRows: file.querySelectorAll('[data-fixture-context]').length,
        visibleContext: [...file.querySelectorAll('[data-fixture-context]')].every(row => row.checkVisibility()),
        headerHeight: header.getBoundingClientRect().height,
        panelBottom: panel.getBoundingClientRect().bottom
      };
    })()`);
    assert.equal(expandedLayout.insideStickyHeader, false, 'File explanations must scroll with the diff instead of covering expanded lines inside GitHub’s sticky header.');
    assert.equal(expandedLayout.badgeCount, 1);
    assert.equal(expandedLayout.panelCount, 1);
    assert.equal(expandedLayout.explanation, 'The fixture returns the replacement value.');
    assert.equal(expandedLayout.contextRows, expanded ? 201 : 0);
    assert.equal(expandedLayout.visibleContext, true, 'Newly expanded native context must remain accessible.');
    if (expanded) {
      assert.ok(expandedLayout.headerHeight < 80, 'Only the compact native header should remain sticky.');
      assert.ok(expandedLayout.panelBottom < 0, 'The explanation must scroll out of view while reading expanded code.');
      await writeFile('/tmp/priorities-native-expand-all.png', Buffer.from((await page('Page.captureScreenshot', {format:'png'})).data,'base64'));
    }
  }
  assert.equal((await modelRequests()).length, beforeExpansion, 'Native expansion must reuse the existing analysis.');
  await evaluate('window.scrollTo({top:0,behavior:"instant"})');
  await evaluate(`${shadow}.querySelector('.rf-review-index > summary').click(); [...${shadow}.querySelectorAll('.rf-review-index > .rf-review > summary')].at(-1).click()`);
  assert.ok(await evaluate(`[...${shadow}.querySelectorAll('.rf-review-index > .rf-review')].at(-1).querySelector('.rf-change-explanation').checkVisibility()`), 'The fifth decision must be readable even though its file is unloaded.');
  assert.ok(await evaluate(`[...${shadow}.querySelectorAll('.rf-review-index > .rf-review')].at(-1).querySelector('.rf-reason').checkVisibility()`));
  await evaluate(`[...${shadow}.querySelectorAll('.rf-review-index > .rf-review')].at(-1).querySelector('.rf-evidence > summary').click()`);
  await waitFor(() => evaluate(`[...${shadow}.querySelectorAll('.rf-review-index > .rf-review')].at(-1).querySelector('.rf-code')?.checkVisibility()`), 'unloaded file source evidence available from the saved review');
  const beforeHumanReview = (await modelRequests()).length;
  const firstModernFile = `document.querySelector('section[id^="diff-"][role="region"]')`;
  const firstModernPanel = `${firstModernFile}.querySelector('.review-focus-file-progress').shadowRoot`;
  const firstModernRow = `${shadow}.querySelector('.rf-file-progress-row[data-path="tests/change-1.ts"]')`;
  await openFiles();
  assert.ok(await evaluate(`(${shadow}.querySelector('.rf-progress-toggle').textContent + ${shadow}.querySelector('.rf-progress-toggle').title).includes('2 unknown')`), 'Unloaded native review statuses must be identified in the summary.');
  assert.equal(await evaluate(`${shadow}.querySelectorAll('.rf-reviewed-toggle input:indeterminate:disabled').length`), 2);
  assert.equal(await evaluate('window.fixtureViewedClicks'), 0, 'Parallel AI completion never marks the native files viewed.');
  await click('AI needs retry');
  assert.equal(await evaluate(`${shadow}.querySelectorAll('.rf-file-progress-row').length`), 0, 'Important decisions must not appear in the AI retry filter after successful analysis.');
  await click('Reviewed');
  assert.equal(await evaluate(`${shadow}.querySelectorAll('.rf-file-progress-row').length`), 0);
  await click('To review');
  assert.equal(await evaluate(`${shadow}.querySelectorAll('.rf-file-progress-row').length`), 5);
  await evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').focus(); ${firstModernRow}.querySelector('.rf-reviewed-toggle input').click()`);
  await waitFor(() => evaluate(`${shadow}.querySelectorAll('.rf-file-progress-row').length === 4 && ${firstModernFile}.querySelector('button[aria-pressed]').getAttribute('aria-pressed') === 'true'`), 'marking a file removes it from the to-review list');
  assert.equal(await evaluate(`${shadow}.activeElement.textContent`), 'To review', 'When the reviewed row leaves the active filter, focus returns to that filter.');
  await click('Reviewed');
  assert.equal(await evaluate(`${shadow}.querySelectorAll('.rf-file-progress-row').length`), 1);
  assert.equal(await evaluate(`${firstModernFile}.querySelectorAll('.diff-file-header .review-focus-file-status').length`), 1, 'A replaced React header retains a single AI badge.');
  assert.ok(await evaluate(`${firstModernFile}.querySelector('.review-focus-file-status').shadowRoot.querySelector('.rf-file-state').checkVisibility()`));
  assert.equal(await evaluate(`${firstModernPanel}.querySelector('input[type=checkbox]')`), null, 'The modern diff panel also leaves Viewed to GitHub.');
  await evaluate(`window.collapsedDiffTable = ${firstModernFile}.querySelector('table'); window.collapsedDiffTable.remove()`);
  await waitFor(() => evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').checked && !${firstModernPanel}.querySelector('.rf-file-decisions').checkVisibility()`), 'reviewed modern file remains compact when its native diff collapses');
  await evaluate(`${firstModernFile}.querySelector('button[aria-pressed]').click()`);
  await waitFor(() => evaluate(`${shadow}.querySelectorAll('.rf-file-progress-row').length === 0 && ${firstModernPanel}.querySelector('.rf-file-decisions').checkVisibility()`), 'native modern uncheck reflected in file and filter');
  await evaluate(`${firstModernFile}.append(window.collapsedDiffTable)`);
  await click('All files');
  await evaluate(`${firstModernFile}.querySelector('button[aria-pressed]').setAttribute('aria-disabled', 'true')`);
  await waitFor(() => evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').getAttribute('aria-disabled') === 'true'`), 'modern aria-disabled control respected');
  await evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').click()`);
  assert.equal(await evaluate('window.fixtureViewedClicks'), 2);
  await evaluate(`${firstModernFile}.querySelector('button[aria-pressed]').removeAttribute('aria-disabled')`);
  await waitFor(() => evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').getAttribute('aria-disabled') === 'false'`), 'modern review control active again');
  await evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').click()`);
  await waitFor(() => evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').checked`), 'modern reviewed state ready for virtualization');
  await evaluate(`window.unmountedReviewFile = ${firstModernFile}; window.unmountedReviewFile.remove()`);
  await waitFor(() => evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').disabled`), 'unmounted file retains its last observed state without pretending its control is available');
  assert.ok(await evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').checked && !${firstModernRow}.querySelector('.rf-reviewed-toggle input').indeterminate`));
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-overview-title').textContent`), '5 review decisions');
  await evaluate(`document.querySelector('main').append(window.unmountedReviewFile)`);
  await waitFor(() => evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').checked && !${firstModernRow}.querySelector('.rf-reviewed-toggle input').disabled`), 'remounted native file can be updated again');
  assert.equal((await modelRequests()).length, beforeHumanReview, 'Native human-review changes, filtering, collapse and remount must not trigger model calls.');
  await evaluate(`document.querySelector('#review-focus-extension').scrollIntoView({block:'start'})`);
  await writeFile('/tmp/review-focus-extension-reviewed-files.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-file-list').scrollWidth > ${shadow}.querySelector('.rf-file-list').clientWidth`), false, 'Human controls and AI states must fit a narrow viewport.');
  await writeFile('/tmp/review-focus-extension-reviewed-mobile.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await page('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1080, deviceScaleFactor: 1, mobile: false });
  const savingWorker = workers.at(-1);
  const savingFault = await send('Runtime.evaluate', {expression:`
    globalThis.originalReviewPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === 'reviews') throw new Error('Simulated local cache write failure.');
      return originalReviewPut.call(this, value, ...args);
    };
  `}, savingWorker);
  assert.equal(savingFault.exceptionDetails, undefined);
  await writeFile(uxGate, 'waiting');
  await click('Run fresh review');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-file-progress-row[data-state=classified]') && ${shadow}.querySelector('.rf-file-progress-row[data-state=queued]') && ${shadow}.querySelectorAll('.rf-file-progress-row[data-state=classifying]').length === 3`), 'first file classified and remaining analyses waiting before a settings change');
  const beforeActiveSettings = (await modelRequests()).length;
  const activeRunLabel = await evaluate(`${shadow}.querySelector('.rf-run-settings').textContent`);
  await saveModelChoice('claude', 'claude-custom-older', 'high');
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-run-settings').textContent`), activeRunLabel, 'A running analysis retains its captured model and effort after returning from Settings.');
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-analyze').disabled`), true, 'Changing future settings must not make a second analysis available while the original is running.');
  assert.equal((await modelRequests()).length, beforeActiveSettings, 'Returning from Settings must not restart active model calls.');
  await writeFile(uxGate, 'finish');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-overview-title')?.textContent === '5 review decisions' && !${shadow}.querySelector('.rf-analyze').disabled`), 'fresh AI analysis preserving native human progress');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-actions > .rf-analyze')?.textContent === 'Analyze PR' && ${shadow}.querySelector('.rf-analyze').checkVisibility() && ${shadow}.querySelector('.rf-status').textContent.includes('claude-custom-older')`), 'settings changed during analysis become available on completion without navigation');
  assert.ok((await modelRequests()).slice(beforeHumanReview).every(request => request.provider === 'claude' && request.args[request.args.indexOf('--model')+1] === 'claude-fixture-model' && request.args[request.args.indexOf('--effort')+1] === 'medium'), 'Remaining classifications and the PR review use the original model and effort.');
  await saveModelChoice('claude', 'claude-fixture-model', 'medium');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-menu .rf-analyze')?.textContent === 'Run fresh review'`), 'original settings restored after active-analysis regression');
  await send('Target.closeTarget', { targetId: modelSettingsTarget });
  await send('Runtime.evaluate', {expression:'IDBObjectStore.prototype.put = globalThis.originalReviewPut; delete globalThis.originalReviewPut;'}, savingWorker);
  assert.equal(await evaluate(`${shadow}.querySelector('.rf-cache-notice').checkVisibility() && ${shadow}.querySelector('.rf-cache-notice').textContent.includes('could not be saved locally')`), true, 'A failed cache save must leave the completed analysis usable and its warning visible.');
  assert.equal((await modelRequests()).length, beforeHumanReview + 6);
  assert.equal(await evaluate('window.fixtureViewedClicks'), 3, 'Fresh AI analysis must not change human review progress.');
  assert.ok(await evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').checked`));
  await evaluate(`(() => {
    const staleCheckbox = ${firstModernRow}.querySelector('.rf-reviewed-toggle input');
    const script = document.querySelector('script[data-target="react-app.embeddedData"]');
    script.textContent = script.textContent.replaceAll(${JSON.stringify(headSha)}, '1'.repeat(40));
    staleCheckbox.click();
    window.unmountedReviewFile.remove();
  })()`);
  assert.equal(await evaluate('window.fixtureViewedClicks'), 3, 'An old extension checkbox must not toggle native state after the PR revision changes, even before the page observer runs.');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-status').textContent.includes('PR revision changed') && !${shadow}.querySelector('.rf-status').classList.contains('rf-visually-hidden') && ${shadow}.querySelector('.rf-status').checkVisibility()`), 'revision change invalidates the AI view with visible guidance');
  await evaluate(`(() => {
    const script = document.querySelector('script[data-target="react-app.embeddedData"]');
    script.textContent = script.textContent.replaceAll('1'.repeat(40), ${JSON.stringify(headSha)});
  })()`);
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-analyze').textContent === 'Open saved review'`), 'saved AI review available after returning to its revision');
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-cache-detail')?.textContent.includes('Opened saved review')`), 'cached result after a revision switch');
  assert.ok(await evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').indeterminate && ${firstModernRow}.querySelector('.rf-reviewed-toggle input').disabled`), 'A revision change clears observations for absent native controls instead of reusing old checked state.');
  await evaluate('document.querySelector("main").append(window.unmountedReviewFile)');
  await waitFor(() => evaluate(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').checked && !${firstModernRow}.querySelector('.rf-reviewed-toggle input').disabled`), 'current native state re-read when its file is loaded');
  assert.equal((await modelRequests()).length, beforeHumanReview + 6, 'Revision-safe cache restoration must not trigger extra model calls.');
  changesMode = '';
  modernMode = false;
  await writeFile(modeFile, 'normal');
  await page('Page.navigate', {url:`chrome-extension://${extensionId}/options.html`});
  await waitFor(() => evaluate('!document.querySelector("#save-review-preferences").disabled && document.querySelector("#classification-prompt").value.length > 100'), 'review preference controls loaded');
  assert.equal(await evaluate('document.querySelector(".prompt-settings").open'), false, 'Advanced prompts start collapsed.');
  await evaluate(`(() => {
    document.querySelector('#review-focus').value = 'thorough';
    document.querySelector('#change-types input[value=behavior]').checked = true;
    document.querySelector('#classification-prompt').value = 'Classify every supplied edit. Explain missing evidence.';
    document.querySelector('#prioritization-prompt').value = 'Prioritize concrete changes to behavior and contracts.';
    document.querySelector('#review-preferences-form').requestSubmit();
  })()`);
  await waitFor(() => evaluate('document.querySelector("#review-preferences-status").textContent.includes("Preferences saved")'), 'custom review preferences saved');
  await page('Page.reload');
  await waitFor(() => evaluate('!document.querySelector("#save-review-preferences").disabled && document.querySelector("#review-focus").value === "thorough"'), 'review preferences survive reload');
  assert.equal(await evaluate('document.querySelector("#classification-prompt").value'), 'Classify every supplied edit. Explain missing evidence.');
  await evaluate('document.querySelector(".prompt-settings").open=true; document.querySelector("#review-preferences-form").scrollIntoView({block:"start"})');
  await writeFile('/tmp/priorities-review-preferences.png', Buffer.from((await page('Page.captureScreenshot', {format:'png'})).data,'base64'));
  const beforeCustomReview = (await modelRequests()).length;
  await page('Page.navigate', {url:prUrl+'/files'});
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Analyze PR'`), 'changed review preferences require fresh analysis');
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-overview-title') && !${shadow}.querySelector('.rf-analyze').disabled`), 'analysis with custom visibility preferences');
  assert.equal((await modelRequests()).length, beforeCustomReview + 2);
  assert.ok(await evaluate(`${shadow}.querySelector('.rf-run-settings').textContent.includes('Effort: medium · Focus: thorough')`));
  assert.ok(await evaluate(`${fileShadow}.querySelector('.rf-kept-visible').textContent.includes('settings keep behavior')`));
  assert.equal(await evaluate(`import(${JSON.stringify(moduleUrl)}).then(module => module.findNativeFiles(document).flatMap(file=>file.rows).filter(row=>['add','delete'].includes(row.type)).every(row=>!row.element.classList.contains('review-focus-native-hidden')))`), true, 'Always-visible change types must remain expanded regardless of model excerpt selection.');
  await page('Page.reload');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'custom preferences have their own reusable cache identity');
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-cache-detail')?.textContent.includes('Opened saved review')`), 'custom-preference saved analysis restored');
  assert.equal((await modelRequests()).length, beforeCustomReview + 2);
  assert.ok(await evaluate(`${shadow}.querySelector('.rf-run-settings').textContent.includes('Focus: thorough')`));
  await page('Page.navigate', {url:`chrome-extension://${extensionId}/options.html`});
  await waitFor(() => evaluate('!document.querySelector("#save-review-preferences").disabled'), 'reset prompt controls ready');
  await evaluate('document.querySelector("#reset-classification").click(); document.querySelector("#reset-prioritization").click(); document.querySelector("#review-preferences-form").requestSubmit()');
  await waitFor(() => evaluate('document.querySelector("#review-preferences-status").textContent.includes("Preferences saved")'), 'default prompts restored');
  const restoredPrompts = await evaluate('chrome.storage.local.get("reviewPreferences").then(value=>value.reviewPreferences)');
  assert.equal(restoredPrompts.classificationPrompt, '');
  assert.equal(restoredPrompts.prioritizationPrompt, '');
  await waitFor(() => evaluate('!document.querySelector("#model").disabled'), 'custom model controls ready');
  await evaluate(`(() => {
    document.querySelector('#model').value = '__custom__';
    document.querySelector('#model').dispatchEvent(new Event('change'));
    document.querySelector('#custom-model').value = 'claude-specific-older-release';
    document.querySelector('#custom-model').dispatchEvent(new Event('input'));
    document.querySelector('#effort').value = 'high';
    document.querySelector('#settings-form').requestSubmit();
  })()`);
  await waitFor(() => evaluate('document.querySelector("#status").textContent.includes("Settings saved")'), 'custom model saved');
  await page('Page.reload');
  await waitFor(() => evaluate('!document.querySelector("#model").disabled'), 'custom model restored');
  assert.equal(await evaluate('document.querySelector("#model").value'), '__custom__');
  assert.equal(await evaluate('document.querySelector("#custom-model").value'), 'claude-specific-older-release');
  assert.equal(await evaluate('document.querySelector("#effort").value'), 'high');
  assert.ok(workers.length > 0);
  assert.deepEqual(eventErrors, []);
  assert.deepEqual(exceptions, []);
  console.log('Installed extension passed: Codex connection/model settings, complete GitHub capture, 53 deferred files and deferred total count, 53-file Changes route with four split-view entries and validated lazy loading, bounded linked issue intent and local failures, classic/React source fixtures, per-file Codex classification + PR review → focused diff → full restore, unresolved edit visibility, incomplete diff rejection. A fake Codex process supplied results through the real native host; no live model calls.');
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  chrome.kill('SIGTERM');
  await new Promise(resolve => { chrome.once('exit', resolve); setTimeout(resolve, 1500); });
  await rm(profile, { recursive: true, force: true });
}
