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
const fixtureStyle = '<style>body{margin:24px;font:14px system-ui;color:#1f2328;background:#fff}main{max-width:1300px;margin:auto}.file{border:1px solid #d1d9e0;border-radius:6px;margin:16px 0}.file-header{background:#f6f8fa;padding:12px}table{border-collapse:collapse;width:100%}.blob-code-inner{white-space:pre;font:12px monospace}.blob-num{width:45px;color:#59636e}.blob-code-addition{background:#dafbe1}.blob-code-hunk{background:#ddf4ff}.sr-only,template{display:none}button{cursor:pointer}</style>';
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
  topics: [{ id: 'font-settings', priority: 'review', title: 'Check both suggestion rendering paths', reason: 'Both rendering paths now apply variation settings.', before: 'The widget did not set font variation settings.', after: 'Each path applies the configured variation settings.', question: 'Do both paths receive the intended font setting?', uncertainty: 'No application tests were run.', evidenceSummary: 'Two assignments update the suggestion widget.', editIds: ['0-0-3', '0-1-3'], excerpts: [{ path: sourcePath, side: 'after', startLine: 137, endLine: 137 }] }]
};
const classifications = ['0-0-3', '0-1-3'].map(editId => ({ editId, kinds: ['behavior'], reason: 'The assignment applies a font variation setting.', uncertainty: '' }));
const profile = await mkdtemp(join(tmpdir(), 'review-focus-extension-'));
const requestLog = join(profile, 'codex-requests.jsonl');
const lifecycleLog = join(profile, 'codex-lifecycle.jsonl');
const modeFile = join(profile, 'codex-mode');
const fakeCodex = join(profile, 'fake-codex.mjs');
await writeFile(requestLog, '');
await writeFile(lifecycleLog, '');
await writeFile(modeFile, 'normal');
await writeFile(fakeCodex, `#!${process.execPath}
import { readFile, writeFile, appendFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const isClaude = args.includes('--safe-mode');
const mode = await readFile(${JSON.stringify(modeFile)}, 'utf8');
if (args.includes('auth')) {
  process.stdout.write(JSON.stringify({loggedIn:mode!=='signed-out',authMethod:mode==='signed-out'?'none':'claude.ai',apiProvider:'firstParty'}));
  process.exit(0);
}
if (args.includes('login')) {
  process.stderr.write(mode === 'signed-out' ? 'Not logged in\\n' : 'Logged in using ChatGPT\\n');
  process.exit(mode === 'signed-out' ? 1 : 0);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const schema = isClaude ? JSON.parse(args[args.indexOf('--json-schema')+1]) : JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
const evidence = JSON.parse(input);
let labels = ${JSON.stringify(classifications)};
let review = ${JSON.stringify(assessment)};
if (mode === 'parallel' || mode === 'generated-review') {
  labels = evidence.files.flatMap(file => file.hunks.flatMap(hunk => hunk.items.filter(item => !Array.isArray(item)).map(item => ({editId:item.id,kinds:['behavior'],reason:'Synthetic change.',uncertainty:''}))));
  review = { summary:'Synthetic parallel review.', topics:[{...review.topics[0],id:'parallel-change',priority:'supporting',title:'Synthetic supporting changes',editIds:labels.map(entry=>entry.editId),excerpts:[]}] };
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
const issueRequests = [];
let extensionId;
let incomplete = false;
let modernMode = false;
let deferredMode = '';
const deferredRequests = [];
let changesMode = '';
let descriptionSuffix = '';
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
      if (changesMode === 'parallel' || changesMode === 'generated-review') {
        route.diffSummaries = route.diffSummaries.slice(0,3);
        route.diffContents = route.diffContents.slice(0,3);
      }
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
      body = changes.page(route, changesMode === 'parallel' || changesMode === 'generated-review');
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
    } else if (url.pathname.includes('/issues/')) {
      if (url.pathname === '/microsoft/vscode/issues/901') body = issuePage;
      else if (url.pathname === '/microsoft/vscode/issues/903') {
        status = 302;
        headers.push({ name: 'Location', value: 'https://github.com/other/repo/issues/903' });
        body = '';
      } else { status = 404; body = '<main>Issue unavailable in this fixture.</main>'; }
    } else if (url.pathname.includes(`/blob/${headSha}/`)) body = sourcePage;
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
  const evaluate = async expression => {
    const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await page('Page.enable');
  await page('Runtime.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1080, deviceScaleFactor: 1, mobile: false });
  const staleWorker = await page('Page.addScriptToEvaluateOnNewDocument', { source: `chrome.runtime.sendMessage = async () => ({ configured: false, provider: 'anthropic', model: 'claude-opus-5', hasKey: false });` });
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent !== "Checking the local helper…" && Boolean(document.querySelector("#connection-status"))'), 'stale worker reproduction');
  assert.match(await evaluate('document.querySelector("#connection-status").textContent'), /Reload PRiorities/, 'An old provider response must request an extension reload instead of blaming the Codex login.');
  assert.equal(await evaluate('document.querySelector("#model").value'), '', 'A stale worker must not restore an Anthropic model into Codex settings.');
  await page('Page.removeScriptToEvaluateOnNewDocument', { identifier: staleWorker.identifier });
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex")'), 'native Codex connection');
  assert.equal(await evaluate('document.querySelector("#api-key")'), null);
  await evaluate('document.querySelector("#model").value="fixture-model"; document.querySelector("#settings-form").requestSubmit()');
  await waitFor(() => evaluate('document.querySelector("#status")?.textContent.includes("Settings saved")'), 'saving the model');
  await writeFile('/tmp/review-focus-extension-settings.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await page('Fetch.enable', { patterns: [{ urlPattern: 'https://github.com/*' }, { urlPattern: 'https://example.com/*' }] });
  await page('Page.navigate', { url: prUrl + '/files' });
  const shadow = 'document.querySelector("#review-focus-extension")?.shadowRoot';
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'the installed content script');
  assert.equal((await modelRequests()).length, 0, 'Opening a PR must not start a model analysis.');
  const click = label => evaluate(`(() => { const buttons = [...${shadow}.querySelectorAll('button')]; const target = buttons.find(button => button.textContent === ${JSON.stringify(label)}) ?? (${JSON.stringify(label)} === 'Analyze PR' ? buttons.find(button => button.textContent === 'Run fresh review' && !button.hidden) : null); target.click(); })()`);
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}?.querySelectorAll('.rf-review').length === 1`), 'capture → native helper → Codex → validated review');
  assert.equal((await modelRequests()).length, 3);
  checkEvidence(await modelRequests());
  assert.deepEqual(issueRequests, [901, 902, 903].map(number => `https://github.com/microsoft/vscode/issues/${number}`), 'Read bounded, unique same-repository issue references only; never comments, external links, or redirects.');
  assert.ok(await evaluate(`${shadow}.textContent.includes('Could not read linked issue #902')`));
  assert.equal(await evaluate(`${shadow}.querySelectorAll('.rf-code tr').length`), 1);
  assert.ok(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length > 10'));
  await writeFile('/tmp/review-focus-extension-installed.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await click('Full diff');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden, .review-focus-native-fold").length'), 0);
  await click('Focused review');
  assert.ok(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length > 10'));

  await page('Page.reload');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'saved review offered after reload');
  assert.equal((await modelRequests()).length, 3);
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-cache-notice')?.textContent.includes('Opened saved review')`), 'exact-input cached review restored');
  assert.equal((await modelRequests()).length, 3, 'Opening the saved review must not invoke either CLI for analysis.');
  assert.ok(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length > 10'));

  await writeFile(modeFile, 'unresolved');
  await click('Run fresh review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-unresolved')?.textContent.includes('1 edit')`), 'unresolved classification visibility');
  assert.equal((await modelRequests()).length, 6);
  assert.equal(await evaluate(`document.querySelector('[id$="R151"][data-line-number]').closest('tr').classList.contains('review-focus-native-hidden')`), false, 'An unresolved edit stays visible even when prioritization assigns it to supporting.');
  await evaluate(`${shadow}.querySelector('.rf-supporting > summary').click(); ${shadow}.querySelector('.rf-supporting .rf-evidence > summary').click(); ${shadow}.querySelector('.rf-edit[data-edit-id="0-1-3"] > summary').click()`);
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-edit[data-edit-id="0-1-3"] .rf-change-kind')?.textContent === 'Change type: unknown'`), 'classification evidence disclosure');
  assert.ok(await evaluate(`${shadow}.querySelector('.rf-edit[data-edit-id="0-1-3"] .rf-uncertainty').textContent.includes('cannot be established')`));
  await writeFile(modeFile, 'normal');
  checkEvidence(await modelRequests());

  incomplete = true;
  await click('Run fresh review');
  await waitFor(() => evaluate(`${shadow}.querySelector('.rf-error').textContent.includes('1 of 2 files')`), 'incomplete capture rejection');
  assert.equal((await modelRequests()).length, 6, 'An incomplete diff must not be sent for analysis.');
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
    folding.restore();
    return {files:files.map(file=>({path:file.path,rows:file.rows.map(({oldLine,newLine,type,text})=>({oldLine,newLine,type,text}))})), snapshot, folded, restored:doc.querySelectorAll('.review-focus-native-hidden, .review-focus-native-fold').length};
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
  assert.equal(modern.restored, 0);
  assert.equal((await modelRequests()).length, 6, 'Collecting issue context must not trigger additional model requests.');

  const captureFixture = () => evaluate(`(async()=>{
    const module=await import(${JSON.stringify(moduleUrl)});
    const progress=[];
    try {
      const snapshot=await module.capturePullRequest({onProgress:message=>progress.push(message)});
      return {snapshot,progress};
    } catch(error) { return {error:error.message,progress}; }
  })()`);
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
  assert.equal((await modelRequests()).length, 6, 'Deferred capture and rejected incomplete captures must not invoke a model.');
  deferredMode = '';

  changesMode = 'complete';
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'the authenticated Changes route fixture');
  assert.equal(await evaluate('document.querySelectorAll("table[data-diff-anchor]").length'), 4, 'Only four split-view tables are rendered while the payload inventories 53 files.');
  changesRequests.length = 0;
  const completeChanges = await captureFixture();
  assert.equal(completeChanges.error, undefined, 'Capture must read the Changes route and load the 49 entries missing from the rendered split view.');
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
  assert.equal((await modelRequests()).length, 6, 'Reading complete diffs and rejecting incomplete or malformed Changes responses must not invoke Codex.');
  changesMode = 'parallel';
  await writeFile(modeFile, 'parallel');
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'current unified Changes layout');
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-overview-title')?.textContent === '0 review decisions'`), 'three actual native helpers followed by a cross-file check');
  const parallelRequests = (await modelRequests()).slice(6);
  assert.equal(parallelRequests.length, 7, 'Three file pipelines take two calls each, followed by one final check.');
  assert.equal(parallelRequests.filter(request=>request.evidence.files.length===1).length,6);
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

  changesMode = 'generated-review';
  await writeFile(modeFile, 'generated-review');
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'generated review fixture');
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-generated-notice')?.textContent.includes('1 generated file was not reviewed')`), 'final result excluding generated file');
  const defaultRequests = (await modelRequests()).slice(13);
  assert.equal(defaultRequests.length, 5, 'Only the two ordinary files and their final check invoke Codex.');
  assert.equal(defaultRequests.some(request => request.evidence.files.some(file => file.path === changes.paths[0])), false);
  assert.equal(JSON.stringify(defaultRequests).includes(`before ${changes.paths[0]}`), false, 'Generated source must not enter any default model request.');
  assert.equal(defaultRequests.at(-1).evidence.files.length, 2);
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-file-progress[data-state=excluded]").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-file-progress[data-state=complete]").length'), 2);
  assert.equal(await evaluate('document.querySelectorAll("section[role=region]")[0].querySelectorAll(".review-focus-native-hidden, .review-focus-native-fold").length'), 0, 'An excluded file must never be folded as if reviewed.');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length'), 4);
  await page('Page.reload');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'saved review with an excluded generated file');
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-cache-notice')?.textContent.includes('Opened saved review')`), 'restore excluded-file controls');
  assert.equal((await modelRequests()).length, 18);
  await evaluate('[...document.querySelector(".review-focus-file-progress[data-state=excluded]").shadowRoot.querySelectorAll("button")].find(button=>button.textContent==="Review anyway").click()');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-overview-title')?.textContent === '0 review decisions' && !${shadow}?.querySelector('.rf-generated-notice') && document.querySelectorAll('.review-focus-file-progress[data-state=complete]').length === 3 && !${shadow}?.querySelector('.rf-analyze')?.disabled`), 'forced generated file followed by an updated final check');
  const forcedRequests = (await modelRequests()).slice(18);
  assert.equal(forcedRequests.length, 3, 'Opt-in runs only the chosen file’s two passes and a new cross-file check.');
  assert.deepEqual(forcedRequests.slice(0, 2).map(request => request.evidence.files.map(file => file.path)), [[changes.paths[0]], [changes.paths[0]]]);
  assert.equal(forcedRequests.at(-1).evidence.files.length, 3);
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length'), 6);
  await click('Full diff');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden, .review-focus-native-fold").length'), 0);
  await writeFile(modeFile,'normal');
  changesMode = '';

  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex")'), 'saved settings');
  assert.equal(await evaluate('document.querySelector("#model").value'), 'fixture-model');
  await writeFile(modeFile, 'signed-out');
  await evaluate('document.querySelector("#check-connection").click()');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("codex login")'), 'signed-out guidance');
  await writeFile(modeFile, 'normal');
  await evaluate('document.querySelector("#check-connection").click()');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex")'), 'reconnecting after login');
  assert.equal((await modelRequests()).length, 21, 'Connection checks must not invoke a model.');

  await evaluate('document.querySelector("#provider").value="claude"; document.querySelector("#provider").dispatchEvent(new Event("change"))');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code")'), 'Claude subscription connection');
  assert.equal(await evaluate('document.querySelector("#model").value'), '', 'Claude must not inherit the Codex model.');
  assert.equal(await evaluate('document.querySelector("#login-command").textContent'), 'claude auth login');
  assert.ok(await evaluate('document.querySelector("#provider-privacy").textContent.includes("Anthropic")'));
  await evaluate('document.querySelector("#model").value="claude-fixture-model"; document.querySelector("#settings-form").requestSubmit()');
  await waitFor(() => evaluate('document.querySelector("#status")?.textContent.includes("Settings saved")'), 'saving Claude selection');
  await evaluate('document.querySelector("#provider").value="codex"; document.querySelector("#provider").dispatchEvent(new Event("change"))');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex")'), 'preview Codex without switching the saved provider');
  assert.equal(await evaluate('document.querySelector("#model").value'), 'fixture-model');
  assert.equal(await evaluate('chrome.storage.local.get("reviewProvider").then(value=>value.reviewProvider)'), 'claude');
  await evaluate('for(const value of ["claude","codex","claude"]) { document.querySelector("#provider").value=value; document.querySelector("#provider").dispatchEvent(new Event("change")); }');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code") && !document.querySelector("#model").disabled'), 'latest selection wins during rapid switching');
  assert.equal(await evaluate('document.querySelector("#model").value'), 'claude-fixture-model');
  await writeFile(modeFile, 'signed-out');
  await evaluate('document.querySelector("#check-connection").click()');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("claude auth login")'), 'Claude signed-out guidance');
  await writeFile(modeFile, 'normal');
  await evaluate('document.querySelector("#model").value="draft-model"; document.querySelector("#check-connection").click()');
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code")'), 'Claude reconnected');
  assert.equal(await evaluate('document.querySelector("#model").value'), 'draft-model', 'Checking the connection must preserve unsaved model edits.');
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code")'), 'restoring saved Claude settings');
  assert.equal(await evaluate('document.querySelector("#provider").value'), 'claude');
  assert.equal(await evaluate('document.querySelector("#model").value'), 'claude-fixture-model');
  await writeFile('/tmp/review-focus-extension-claude-settings.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  modernMode = false;
  deferredMode = '';
  incomplete = false;
  await page('Page.navigate', { url: prUrl + '/files' });
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('with Claude Code')`), 'Claude-ready PR');
  assert.equal((await modelRequests()).length, 21, 'Selecting Claude and opening a PR must not start analysis.');
  await click('Analyze PR');
  await waitFor(() => evaluate(`${shadow}?.querySelectorAll('.rf-review').length === 1`), 'Claude classification, prioritization and final cross-file check');
  const claudeRequests = (await modelRequests()).slice(21);
  assert.equal(claudeRequests.length, 3);
  assert.ok(claudeRequests.every(request => request.provider === 'claude' && request.args[request.args.indexOf('--model')+1] === 'claude-fixture-model'));
  assert.equal(claudeRequests[0].evidence.classifications, undefined);
  assert.deepEqual(claudeRequests[1].evidence.classifications, classifications);
  assert.ok(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length') > 0);
  await click('Full diff');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden, .review-focus-native-fold").length'), 0);
  await page('Page.reload');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'Claude review saved for the same input');
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-cache-notice')?.textContent.includes('Opened saved review')`), 'Claude cached review restored');
  assert.equal((await modelRequests()).length, 24);
  descriptionSuffix = ' Additional acceptance criteria added without a commit.';
  await page('Page.reload');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'cached commit pair available before verifying changed intent');
  await click('Open saved review');
  await waitFor(() => evaluate(`${shadow}?.querySelector('.rf-status')?.textContent.includes('no longer matches')`), 'changed description invalidates cached assessment');
  assert.equal((await modelRequests()).length, 24, 'A stale saved-review action must not silently start a paid analysis.');
  assert.equal(await evaluate('document.querySelectorAll(".review-focus-native-hidden").length'), 0);
  await click('Run fresh review');
  await waitFor(() => evaluate(`${shadow}?.querySelectorAll('.rf-review').length === 1`), 'explicit fresh analysis after changed intent');
  assert.equal((await modelRequests()).length, 27);

  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('!document.querySelector("#cache-limit").disabled && document.querySelector("#cache-usage").textContent.includes("MB used")'), 'cache settings and usage');
  assert.equal(await evaluate('document.querySelector("#cache-limit").value'), '100');
  await evaluate('document.querySelector("#clear-cache").click()');
  await waitFor(() => evaluate('document.querySelector("#cache-status").textContent.includes("Saved reviews cleared")'), 'clearing saved reviews');
  await evaluate('document.querySelector("#cache-limit").value="1"; document.querySelector("#cache-form").requestSubmit()');
  await waitFor(() => evaluate('document.querySelector("#cache-status").textContent === "Cache limit saved."'), 'custom cache size');
  const cacheChecks = await evaluate(`(async () => {
    const cache = await import('./review-cache.js');
    const settings = {provider:'claude',model:'fixture'};
    const input = {url:${JSON.stringify(prUrl)},baseSha:${JSON.stringify(baseSha)},headSha:${JSON.stringify(headSha)},description:'first',context:[]};
    const original = await cache.reviewCacheKey(input,settings);
    const variants = await Promise.all([
      cache.reviewCacheKey({...input,headSha:'c'.repeat(40)},settings),
      cache.reviewCacheKey({...input,baseSha:'d'.repeat(40)},settings),
      cache.reviewCacheKey({...input,description:'second'},settings),
      cache.reviewCacheKey({...input,context:[{text:'different source'}]},settings),
      cache.reviewCacheKey(input,{...settings,provider:'codex'}),
      cache.reviewCacheKey(input,{...settings,model:'other'})
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
    return {keys:new Set([original,...variants].map(entry=>entry.key)).size,lru,tooLarge,parallel,shrunk,cleared:await cache.cacheInfo()};
  })()`);
  assert.equal(cacheChecks.keys, 7, 'Commits, intent, source context, model and provider each change the cache key.');
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
  assert.ok(workers.length > 0);
  assert.deepEqual(eventErrors, []);
  assert.deepEqual(exceptions, []);
  console.log('Installed extension passed: Codex connection/model settings, complete GitHub capture, 53 deferred files and deferred total count, 53-file Changes route with four split-view entries and validated lazy loading, bounded linked issue intent and local failures, classic/React source fixtures, per-file Codex passes + cross-file check → focused diff → full restore, unresolved edit visibility, incomplete diff rejection. A fake Codex process supplied results through the real native host; no live model calls.');
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  chrome.kill('SIGTERM');
  await new Promise(resolve => { chrome.once('exit', resolve); setTimeout(resolve, 1500); });
  await rm(profile, { recursive: true, force: true });
}
