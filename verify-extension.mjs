import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, cp, symlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installNativeHost } from './install-native-host.mjs';
import { deferred } from './test-fixtures/github-deferred.mjs';
import { changes } from './test-fixtures/github-changes.mjs';

const baseSha = '998fb692680cc20d70a805df8fa59cb1443bc897';
const headSha = '9ed10330f92962e92c6b121fd0cf6588268e89a8';
const rangeBase = 'a'.repeat(40);
const rangeHead = 'c'.repeat(40);
const selectedRange = `${rangeBase}..${rangeHead}`;
const rangeEntries = changes.entries.slice(0, 5).map(entry => ({ ...entry, oldCommitOid: rangeBase, newCommitOid: rangeHead }));
const prUrl = 'https://github.com/microsoft/vscode/pull/200000';
const sourcePath = 'src/vs/editor/contrib/suggest/browser/suggestWidgetRenderer.ts';
const classic = await readFile(new URL('test-fixtures/github-classic.html', import.meta.url), 'utf8');
const react = await readFile(new URL('test-fixtures/github-react.html', import.meta.url), 'utf8');
const blob = JSON.parse(await readFile(new URL('test-fixtures/github-source.json', import.meta.url), 'utf8'));
const sourcePage = `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { blob } }).replace(/</g, '\\u003c')}</script>`;
const fixtureStyle = '<style>:root{--color-prettylights-syntax-keyword:#cf222e;--color-prettylights-syntax-constant:#0550ae;--color-prettylights-syntax-string:#0a3069;--color-prettylights-syntax-entity:#6639ba;--color-prettylights-syntax-comment:#59636e;--bgColor-default:#fff;--bgColor-muted:#f6f8fa;--fgColor-default:#1f2328;--fgColor-muted:#59636e;--borderColor-default:#d1d9e0;--fgColor-accent:#0969da;--diffBlob-additionLine-bgColor:#dafbe1;--diffBlob-deletionLine-bgColor:#ffebe9}body{margin:24px;font:14px system-ui;color:#1f2328;background:#fff}main{max-width:1300px;margin:auto}.file{border:1px solid #d1d9e0;border-radius:6px;margin:16px 0}.file-header{background:#f6f8fa;padding:12px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;display:block;overflow-x:auto}.blob-code-inner{white-space:pre;font:12px monospace}.blob-num{width:45px;color:#59636e}.blob-code-addition{background:#dafbe1}.blob-code-hunk{background:#ddf4ff}.sr-only,template{display:none}button{cursor:pointer}</style>';
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
  summary: 'Confirm the suggestion widget follows editor font variation settings.\n- Applies `fontVariationSettings` to **both** rendering paths.\n- Keeps <img src=x onerror=alert(1)> and a `dangling **marker as text.',
  topics: [{ id: 'font-settings', priority: 'review', title: 'Check both suggestion rendering paths', gist: 'Where labels apply `fontVariationSettings` <img src=x onerror="window.injectedGist=1">', reason: 'Both rendering paths must match the editor typography; missing one leaves suggestions inconsistent.', before: 'The widget did not set font variation settings.', after: 'Each path applies the configured variation settings.', questions: ['Do both paths receive the intended font setting?', 'Should **other** widgets apply `fontVariationSettings` too?'], uncertainty: 'No application tests were run.', editIds: ['0-0-3', '0-1-3'], excerpts: [{ path: sourcePath, side: 'after', startLine: 137, endLine: 137, note: 'The label element receives `fontVariationSettings`.' }] }]
};
const classifications = [
  { editId: '0-0-3', kinds: ['behavior'], reason: 'The assignment applies a font variation setting.', uncertainty: '', defines: ['fontVariationSettings'], uses: ['fontInfo'] },
  { editId: '0-1-3', kinds: ['behavior'], reason: 'The assignment applies a font variation setting.', uncertainty: '', defines: [], uses: ['main', 'fontVariationSettings'] }
];
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
if (mode === 'generated-final-failed' && !schema.required.includes('edits')) process.exit(1);
const evidence = JSON.parse(input);
let labels = ${JSON.stringify(classifications)};
let review = ${JSON.stringify(assessment)};
if (mode === 'parallel' || mode === 'generated-review' || mode === 'generated-final-failed' || mode === 'many-decisions' || mode === 'guide-sections' || mode === 'deleted-files') {
  labels = evidence.files.flatMap(file => file.hunks.flatMap(hunk => hunk.items.filter(item => !Array.isArray(item)).map(item => ({editId:item.id,kinds:['behavior'],reason:'Synthetic change.',uncertainty:'',defines:[],uses:[]}))));
  review = { summary:'Synthetic parallel review.', topics:[{...review.topics[0],id:'parallel-change',priority:'supporting',title:'Synthetic supporting changes',editIds:labels.map(entry=>entry.editId),excerpts:[]}] };
}
if (mode === 'guide-sections') {
  const idsFor = file => file.hunks.flatMap(hunk => hunk.items.filter(item => !Array.isArray(item)).map(item => item.id));
  const unknown = new Set(evidence.files.flatMap(file => file.path === 'tests/change-2.ts' ? idsFor(file) : file.path === 'tests/change-3.ts' ? idsFor(file).slice(2) : []));
  labels = labels.map(label => unknown.has(label.editId) ? {...label, kinds:['unknown'], uncertainty:'The external caller contract is unavailable.'} : label);
  // The supporting section's edits also carry test, and one carries interface, so the card must sort its tags by count.
  const tested = new Set(evidence.files.flatMap(file => ['tests/change-1.ts', 'tests/space, comma % and ü.ts'].includes(file.path) ? idsFor(file) : file.path === 'tests/change-3.ts' ? idsFor(file).slice(0, 1) : []));
  const interfaces = new Set(evidence.files.flatMap(file => file.path === 'tests/change-1.ts' ? idsFor(file) : []));
  labels = labels.map(label => ({...label, kinds:[...label.kinds, ...interfaces.has(label.editId) ? ['interface'] : [], ...tested.has(label.editId) ? ['test'] : []]}));
  const contractSymbols = ['contractValue', '<b>Contract</b>'];
  const definers = new Set(evidence.files.filter(file => file.path === 'tests/change-3.ts').map(file => idsFor(file)[1]));
  const users = new Set(evidence.files.flatMap(file => file.path === 'tests/change-4.ts' ? idsFor(file) : []));
  labels = labels.map(label => ({...label, defines: definers.has(label.editId) ? contractSymbols : [], uses: users.has(label.editId) ? contractSymbols : []}));
  if (!schema.required.includes('edits')) {
    const ids = index => idsFor(evidence.files[index]);
    const topic = (id, title, priority, editIds, excerpts = []) => ({...review.topics[0], id, title, gist: 'Gist for ' + title.toLowerCase() + '.', priority, editIds, excerpts});
    // Review anyway on the machine-maintained sixth file also makes the validation section cite a line it did not cite before.
    const reviewedAnyway = evidence.files.length > 5;
    review.topics = [
      topic('supporting', 'Supporting setup', 'supporting', [...ids(0), ...ids(4), ids(2)[0], ...reviewedAnyway ? ids(5) : []]),
      topic('contract', 'Check the contract and its implementation', 'review', [ids(2)[1]], [{path:evidence.files[2].path,side:'after',startLine:4,endLine:4,note:'The contract changes here.'},{path:evidence.files[4].path,side:'before',startLine:1,endLine:1,note:'The implementation read the old contract.'},{path:evidence.files[2].path,side:'after',startLine:3,endLine:5,note:'Surrounding context keeps the contract readable.'}]),
      topic('validation', 'Check the separate validation path', 'review', ids(3), [{path:evidence.files[3].path,side:'after',startLine:1,endLine:1,note:'Validation reads the new value.'}, ...reviewedAnyway ? [{path:evidence.files[3].path,side:'before',startLine:1,endLine:1,note:'Validation read the old value.'}] : []]),
      {...topic('unknown', 'External caller contract', 'supporting', [...ids(1), ids(2)[2]], [{path:evidence.files[2].path,side:'after',startLine:4,endLine:4,note:'External callers read the new contract.'}]), uncertainty:'The external caller contract is unavailable.'}
    ];
  }
}
if (mode === 'many-decisions') {
  review = {
    summary: 'Five separate behavior decisions remain available across loaded and unloaded files.',
    topics: evidence.files.flatMap(file => file.hunks.flatMap(hunk => hunk.items.filter(item => !Array.isArray(item)).map(item => ({
      id: item.id, priority: 'review', title: 'Check ' + file.path, gist: 'The replacement value in ' + file.path + '.',
      reason: 'Verify the replacement value before consumers receive the changed content.',
      before: 'The fixture returned its previous value.', after: 'The fixture returns the replacement value.',
      questions: ['Does the replacement match the intended change?'], uncertainty: '',
      editIds: [item.id], excerpts: [{path:file.path,side:'after',startLine:1,endLine:1,note:'The replacement value.'}]
    }))))
  };
  const initialFile = evidence.files.length === 1 && evidence.files[0].path === 'tests/change-1.ts';
  const final = !schema.required.includes('edits');
  if (isClaude && !initialFile) {
    const text = JSON.stringify(final ? { ...review, classifications: labels } : { edits: labels });
    let cut = text.indexOf('"classifications"');
    for (let count = 0; count < 3; count++) cut = text.indexOf('"editId"', cut + 1);
    const partial = final ? text.slice(0, cut) : text.slice(0, -2);
    const events = [{type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'tool_use',name:'StructuredOutput',input:{}}}}];
    for (let offset = 0; offset < partial.length; offset += 10) events.push({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:partial.slice(offset, offset + 10)}}});
    process.stdout.write(events.map(event => JSON.stringify(event) + '\\n').join(''));
  }
  const started = Date.now();
  while (!initialFile) {
    const gate = await readFile(${JSON.stringify(uxGate)}, 'utf8');
    if (final ? gate === 'finish' : gate !== 'waiting') break;
    if (Date.now() - started > 60000) throw new Error('The incremental review fixture did not continue.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
if (mode === 'guide-sections' && schema.required.includes('edits') && evidence.files[0].path === 'tests/change-3.ts') {
  while (await readFile(${JSON.stringify(uxGate)}, 'utf8') === 'waiting') await new Promise(resolve => setTimeout(resolve, 20));
}
if (mode === 'parallel' && !schema.required.includes('edits')) {
  process.stdout.write(JSON.stringify({type:'item.completed',item:{id:'reasoning_0',type:'reasoning',text:'**Comparing the three files**\\n\\nEach file changes one value.'}}) + '\\n');
  while (['waiting', 'labelled'].includes(await readFile(${JSON.stringify(uxGate)}, 'utf8'))) await new Promise(resolve => setTimeout(resolve, 20));
}
if (mode === 'parallel') {
  await appendFile(${JSON.stringify(lifecycleLog)}, JSON.stringify({type:'start',pid:process.pid})+'\\n');
  if (schema.required.includes('edits')) {
    const start = Date.now();
    while ((await readFile(${JSON.stringify(lifecycleLog)},'utf8')).split('\\n').filter(Boolean).map(line=>JSON.parse(line)).filter(event=>event.type==='start').length < 3) {
      if(Date.now()-start>5000) throw new Error('Three independent Codex helpers did not start concurrently.');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if (evidence.files[0].path === 'tests/change-1.ts') {
      process.stdout.write(JSON.stringify({type:'item.completed',item:{id:'reasoning_0',type:'reasoning',text:'**Checking the first file**\\n\\nIt changes one value.'}}) + '\\n');
      while (await readFile(${JSON.stringify(uxGate)}, 'utf8') === 'waiting') await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
}
if (mode === 'unresolved') {
  labels[1].kinds = ['unknown'];
  labels[1].uncertainty = 'The second rendering path cannot be established from this fixture.';
  review.topics[0].editIds = ['0-0-3'];
  review.topics.push({ ...review.topics[0], id: 'second-path', priority: 'supporting', title: 'The other rendering path', editIds: ['0-1-3'], excerpts: [], uncertainty: labels[1].uncertainty });
}
if (mode === 'reconciled') {
  labels = labels.map(label => ({ ...label, kinds: ['behavior', 'unknown'], uncertainty: 'The rendering implementation and its caller contract are missing from this file pass.' }));
  review.classifications = labels.map((label, index) => index === 0
    ? { ...label, kinds: ['behavior'], reason: 'The supplied source establishes how the first rendering path applies the font setting.', uncertainty: '' }
    : { ...label, uncertainty: 'Only the external caller contract remains unavailable.' });
  review.topics = [{ ...review.topics[0], priority: 'supporting', excerpts: [], uncertainty: 'Only the external caller contract remains unavailable.' }];
}
await appendFile(${JSON.stringify(requestLog)}, JSON.stringify({ provider:isClaude?'claude':'codex', schema, evidence: JSON.parse(input), labels, args }) + '\\n');
const result = schema.required.includes('edits') ? { edits: labels } : { ...review, classifications: review.classifications ?? labels };
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
    assert.deepEqual(evidence.context, [{ path: sourcePath, side: 'after', text: blob.rawLines.join('\n') + '\n' }], 'Both analysis passes receive the exact pinned source context.');
    if (schema.required.includes('edits')) assert.equal(evidence.description, undefined, 'Classification must not receive the PR description or linked issues.');
    else {
      assert.ok(evidence.description.startsWith(description));
      assert.ok(evidence.description.includes('Linked issue #901: https://github.com/microsoft/vscode/issues/901\nTitle: Suggestion font parity'));
      assert.ok(evidence.description.includes('The widget must match the editor when font variations change.'));
      assert.equal(evidence.description.split('Linked issue #901:').length, 2);
      assert.equal(evidence.description.length - evidence.description.indexOf('\n\nLinked issue #901:'), 4000);
      assert.ok(!evidence.description.includes('NOT_INCLUDED_'));
    }
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
const cancelledRequests = new Set();
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
let entryRequestsInFlight = 0;
let entryRequestsPeak = 0;
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
  if (message.method === 'Network.loadingFailed' && message.params.canceled) cancelledRequests.add(`${message.sessionId}:${message.params.requestId}`);
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
    if (changesMode === 'classic-range' && [changes.root + '/files/' + selectedRange, changes.root + '/commits/' + rangeHead].includes(url.pathname)) {
      body = fixture.replaceAll(baseSha, rangeBase).replaceAll(headSha, rangeHead).replace('class="Counter">1', 'class="Counter">53') + '<span class="js-file-type-count" data-all-file-count-markup="(1)">(1)</span>';
    } else if (changesMode && url.pathname === changes.root + '/files') {
      status = 302;
      headers.push({ name: 'Location', value: `https://github.com${changes.root}/changes${url.search}` });
      body = '';
    } else if (changesMode && (url.pathname === changes.root + '/changes' || url.pathname === changes.root + '/changes/' + selectedRange)) {
      const route = structuredClone(changes.route);
      if (url.pathname.endsWith('/' + selectedRange)) {
        route.comparison.selectedRange = { baseOid: rangeBase, headOid: rangeHead };
        route.comparison.viewing = 'RANGE';
        route.diffSummaries = route.diffSummaries.slice(0, 5);
        route.diffContents = structuredClone(rangeEntries.slice(0, 3));
        route.diffContents[0].isTooBig = true;
        route.diffContents[0].diffLines = [];
        if (changesMode === 'range-wrong-revision') route.diffContents[1].oldCommitOid = baseSha;
      }
      if (changesMode === 'parallel' || changesMode === 'generated-review' || changesMode === 'all-generated') {
        route.diffSummaries = route.diffSummaries.slice(0,3);
        route.diffContents = route.diffContents.slice(0,3);
      }
      if (changesMode === 'many-decisions') route.diffSummaries = route.diffSummaries.slice(0,5);
      if (changesMode === 'deleted-files') {
        route.diffSummaries = [...route.diffSummaries.slice(0,3), ...changes.removed.map(({ path, pathDigest, linesAdded, linesDeleted, linesChanged }) => ({ path, pathDigest, linesAdded, linesDeleted, linesChanged, changeType: 'REMOVED' }))];
        route.diffContents = [...route.diffContents.slice(0,3), structuredClone(changes.removed[0])];
      }
      if (changesMode === 'guide-sections') {
        route.diffSummaries = route.diffSummaries.slice(0,6);
        const file = route.diffContents[2];
        file.linesAdded = 4;
        file.linesDeleted = 4;
        file.linesChanged = 8;
        file.diffLines = [{type:'HUNK',text:'@@ -1,8 +1,8 @@'},
          {type:'DELETION',text:'-before prerequisite',left:1,right:0}, {type:'DELETION',text:'-before prerequisite detail',left:2,right:0},
          {type:'ADDITION',text:'+after prerequisite',left:2,right:1}, {type:'ADDITION',text:'+after prerequisite detail',left:2,right:2},
          {type:'CONTEXT',text:' unchanged context',left:3,right:3},
          {type:'DELETION',text:'-before contract',left:4,right:3}, {type:'ADDITION',text:'+after contract',html:'+<span class="pl-s">after <span class="pl-s1">contract</span></span>',left:4,right:4},
          {type:'CONTEXT',text:' unchanged context',left:5,right:5},
          {type:'DELETION',text:'-before external caller',left:6,right:5}, {type:'ADDITION',text:'+after external caller',left:6,right:6},
          {type:'CONTEXT',text:' trailing context',left:7,right:7}, {type:'CONTEXT',text:' trailing context',left:8,right:8}];
        Object.assign(route.diffSummaries[2], {linesAdded:4, linesDeleted:4, linesChanged:8});
        const [, deletion, addition] = route.diffContents[3].diffLines;
        deletion.html = `-<img src=x onerror="window.injectedHighlight=1">before ${changes.paths[3]}`;
        addition.html = `+<a href="https://example.com/">after</a> ${changes.paths[3]}`;
      }
      if (changesMode === 'all-generated') for (const entry of route.diffContents) entry.newTreeEntry = { isGenerated: true };
      if (changesMode === 'plain') for (const entry of route.diffContents) for (const line of entry.diffLines) delete line.html;
      if (changesMode === 'duplicate-summary') route.diffSummaries[4] = route.diffSummaries[0];
      if (changesMode === 'truncated-list') route.pageLimits.filesLimitExceeded = true;
      if (changesMode === 'inline-revision') route.diffContents[0].newCommitOid = '1'.repeat(40);
      if (changesMode === 'inline-base-revision') route.diffContents[1].oldCommitOid = '1'.repeat(40);
      if (changesMode === 'merge-base-context') {
        route.diffContents = [{ ...route.diffContents[0], path: 'src/merge-base.ts' }];
        route.diffSummaries = [{ ...route.diffSummaries[0], path: 'src/merge-base.ts' }];
      }
      if (changesMode === 'deferred-large') {
        route.diffContents[0].isTooBig = true;
        route.diffContents[0].diffLines = [];
      }
      if (changesMode.startsWith('generated')) {
        route.diffContents[0].newTreeEntry = { isGenerated: true };
        route.diffContents[0].diffLines = [];
      }
      body = changes.page(route, ['parallel', 'generated-review', 'all-generated', 'many-decisions', 'commit-range', 'collapsed-first', 'guide-sections', 'deleted-files'].includes(changesMode), changesMode === 'deleted-files');
      if (changesMode === 'guide-sections') {
        const file = route.diffContents[2];
        const rows = file.diffLines.filter(line => line.type !== 'HUNK').map(line => {
          const before = line.type === 'ADDITION' ? '' : line.left;
          const after = line.type === 'DELETION' ? '' : line.right;
          const kind = line.type === 'CONTEXT' ? '' : line.type.toLowerCase();
          const text = line.text.slice(1).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
          return `<tr class="diff-line-row"><td class="new-diff-line-number${before ? '' : ' empty-diff-line'}">${before}</td><td class="new-diff-line-number${after ? '' : ' empty-diff-line'}">${after}</td><td class="diff-text-cell"><code class="diff-text ${kind}"><span class="diff-text-inner">${text}</span></code></td></tr>`;
        }).join('');
        const table = new RegExp(`(<table data-diff-anchor="diff-${file.pathDigest}"><tbody>)[\\s\\S]*?(</tbody>)`);
        body = body.replace(table, (_, start, end) => start + rows + end);
      }
      if (changesMode === 'collapsed-first') {
        let index = 0;
        body = body.replace(/<table\b[^>]*>.*?<\/table>/gs, table => index++ < 2 ? '' : table);
      }
    } else if (changesMode && url.pathname === changes.root + '/page_data/diff_entries') {
      const paths = url.searchParams.get('paths').split(',').map(decodeURIComponent);
      const isRange = url.searchParams.get('range') === selectedRange;
      const entries = structuredClone((isRange ? rangeEntries : [...changes.entries, ...changes.removed]).filter(entry => paths.includes(entry.path)));
      if (changesMode === 'guide-sections') for (const entry of entries) {
        if (entry.path === changes.paths[5]) entry.newTreeEntry = { isGenerated: true };
        if (entry.path !== changes.paths[4]) continue;
        entry.diffLines[1].html = `-<span class="pl-k x-evil">before</span> ${entry.path}`;
        entry.diffLines[2].html = `+<span class="pl-k">AFTER</span> ${entry.path}`;
      }
      if (changesMode === 'plain') for (const entry of entries) for (const line of entry.diffLines) delete line.html;
      if (isRange && paths.includes(changes.paths[0])) {
        entries[0].isTooBig = true;
        entries[0].diffLines = [];
      }
      if (changesMode.startsWith('generated') && paths.includes(changes.paths[0])) {
        entries[0].newTreeEntry = { isGenerated: true };
        entries[0].diffLines = [];
      }
      if (paths.includes(changes.paths[4])) {
        if (changesMode === 'missing') entries.shift();
        if (changesMode === 'duplicate') entries.push(entries[0]);
        if (changesMode === 'wrong-path') entries[0].path = 'tests/unrequested.ts';
        if (changesMode === 'wrong-revision') entries[0].newCommitOid = '1'.repeat(40);
        if (changesMode === 'wrong-base-revision') entries[0].oldCommitOid = '1'.repeat(40);
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
      body = JSON.stringify({ diffEntryLines: url.searchParams.get('range') === selectedRange || ['generated', 'generated-review'].includes(changesMode) ? entry?.diffLines : changesMode === 'generated-incomplete' ? entry?.diffLines.slice(0, -1) : [] });
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
    } else if (url.pathname.includes(`/blob/${headSha}/`) || url.pathname.includes(`/blob/${rangeHead}/`) || url.pathname.includes(`/blob/${rangeBase}/`)) {
      status = transientSourceFailure ? 503 : 200;
      body = transientSourceFailure ? 'Temporary error' : sourcePage;
    }
    else { status = 404; body = '<main>Source unavailable in this fixture.</main>'; }
  } else {
    await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, message.sessionId).catch(error => { throw new Error(`${request.url}: ${error.message}`); });
    return;
  }
  if (changesMode && url.pathname === changes.root + '/page_data/diff_entries') {
    entryRequestsPeak = Math.max(entryRequestsPeak, ++entryRequestsInFlight);
    await new Promise(resolve => setTimeout(resolve, 20));
    entryRequestsInFlight--;
  }
  try {
    await send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: contentType }, ...headers], body: Buffer.from(body).toString('base64') }, message.sessionId);
  } catch (error) {
    // Chrome withdraws paused interceptions when capture cancellation aborts their fetch.
    const cancelled = cancelledRequests.has(`${message.sessionId}:${message.params.networkId}`);
    if (!cancelled || error.message !== 'Invalid InterceptionId. (-32602)') throw new Error(`${request.url}: ${error.message}`, { cause: error });
  }
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (eventErrors.length) throw new Error(`While waiting for ${label}: ${eventErrors[0].message}`, { cause: eventErrors[0] });
    try { if (await check()) return; } catch (error) {
      if (!/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

try {
  const spacedCheckout = join(profile, 'checkout with spaces');
  await cp(new URL('extension/', import.meta.url), join(spacedCheckout, 'extension'), { recursive: true });
  await cp(new URL('build-extension.mjs', import.meta.url), join(spacedCheckout, 'build-extension.mjs'));
  await symlink(fileURLToPath(new URL('node_modules/', import.meta.url)), join(spacedCheckout, 'node_modules'));
  await rm(join(spacedCheckout, 'extension', 'background.bundle.js'));
  await promisify(execFile)(process.execPath, ['build-extension.mjs'], { cwd: spacedCheckout });
  assert.ok((await readFile(join(spacedCheckout, 'extension', 'background.bundle.js'), 'utf8')).length > 0, 'A checkout path containing spaces must produce the extension bundle.');
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'service_worker' }, { exclude: true }] });
  ({ id: extensionId } = await send('Extensions.loadUnpacked', { path: fileURLToPath(new URL('extension/', import.meta.url)) }));
  assert.equal(extensionId, 'bjmajanmepopjciklnijlfbdpafokfpe');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  let panelSession;
  let panelTarget;
  const defaultContext = session => [...executionContexts.values()].find(context => context.sessionId === session && context.auxData?.isDefault)?.uniqueId;
  const page = async (method, params = {}) => {
    const navigating = method === 'Page.navigate' || method === 'Page.reload';
    const previousContext = navigating ? defaultContext(sessionId) : undefined;
    const previousPanelContext = navigating && panelSession ? defaultContext(panelSession) : undefined;
    const connectedPanel = navigating && panelSession && await inPanel('Boolean(document.querySelector(".rf-panel:not(.rf-waiting)"))');
    const result = await send(method, params, sessionId);
    if (navigating) {
      await waitFor(async () => defaultContext(sessionId) !== previousContext && await inPage('document.readyState === "complete"'), 'new page document');
      if (connectedPanel) await waitFor(() => defaultContext(panelSession) !== previousPanelContext, 'panel reload after its page agent disconnects');
    }
    return result;
  };
  const inPage = async (expression, evaluationSessionId = sessionId) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, evaluationSessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const inAgent = async (expression, evaluationSessionId = sessionId) => {
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
  const reviewFixtureSource = `
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
        const saveViewed = () => {
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
        };
        if (window.fixtureHoldViewedPath === path) window.fixtureReleaseViewed = () => {
          delete window.fixtureHoldViewedPath;
          delete window.fixtureReleaseViewed;
          saveViewed();
        };
        else setTimeout(saveViewed, window.fixtureViewedDelay || 0);
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
          window.fixtureInstallReviewControl(replacement, path, true);
          mounted.replaceWith(replacement);
          mounted = replacement;
        };
        document.addEventListener('click', event => {
          const toggle = event.target.closest('.js-expand-all-difflines-button');
          if (toggle && mounted.contains(toggle)) renderExpandedFile(toggle.textContent === 'Expand all');
        });
        window.fixtureInstallReviewControl(file, path, true);
      }
    });
  `;
  await page('Page.addScriptToEvaluateOnNewDocument', {source:reviewFixtureSource});
  await page('Page.enable');
  await page('Runtime.enable');
  await page('Network.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: 1512, height: 1080, deviceScaleFactor: 1, mobile: false });
  await page('Page.navigate', { url: 'chrome://extensions/' });
  await waitFor(() => inPage('Boolean(chrome.developerPrivate?.updateProfileConfiguration)'), 'extension developer controls');
  await inPage('new Promise(resolve => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}, resolve))');
  const invalidSettings = await page('Page.addScriptToEvaluateOnNewDocument', { source: `chrome.runtime.sendMessage = async () => ({ configured: true, provider: 'invalid-provider', model: 'invalid-model' });` });
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent !== "Checking the local helper…" && Boolean(document.querySelector("#connection-status"))'), 'invalid settings rejected');
  assert.match(await inPage('document.querySelector("#connection-status").textContent'), /invalid provider settings/, 'Malformed provider settings must be rejected.');
  assert.equal(await inPage('document.querySelector("#model").value'), '', 'Invalid settings must not populate the model input.');
  await page('Page.removeScriptToEvaluateOnNewDocument', { identifier: invalidSettings.identifier });
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex") && !document.querySelector("#model").disabled'), 'native Codex connection');
  assert.equal(await inPage('document.querySelector("#api-key")'), null);
  assert.equal(await inPage('document.querySelector("#concurrency").value'), '6', 'Six files are classified at once by default.');
  assert.equal(await inPage('document.querySelector("#file-limit").value'), '100', 'PRs of up to 100 changed files are analyzed by default.');
  assert.equal(await inPage('document.querySelector("#list-deleted-files").checked'), false, 'Deleted files are analyzed like other files by default.');
  await inPage('document.querySelector("#model").value="fixture-model"; document.querySelector("#settings-form").requestSubmit()');
  await waitFor(() => inPage('document.querySelector("#status")?.textContent.includes("Settings saved")'), 'saving the model');
  assert.equal(await inPage('document.querySelector("#model").tagName'), 'SELECT');
  assert.deepEqual(await inPage('Array.from(document.querySelector("#effort").options,option=>option.value)'), ['low','medium','high']);
  assert.equal(await inPage('document.querySelector("#effort").value'), 'high');
  await writeFile('/tmp/review-focus-extension-settings.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await page('Fetch.enable', { patterns: [{ urlPattern: 'https://github.com/*' }, { urlPattern: 'https://example.com/*' }] });
  const fixtureTabId = await inPage('chrome.tabs.getCurrent().then(tab => tab.id)');
  changesMode = 'collapsed-first';
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => inPage('document.querySelectorAll("section[role=region]").length === 3'), 'initially collapsed files');
  assert.equal(await inPage('document.querySelectorAll("[data-review-focus-owned]").length'), 0, 'Opening a PR leaves GitHub untouched until the side panel connects.');
  const panelPage = (method, params = {}) => send(method, params, panelSession);
  const inPanel = expression => inPage(expression, panelSession);
  // A real mouse click, which the page sees as trusted, unlike element.click().
  const clickInPage = async element => {
    const point = await inPage(`(() => {
      const target = ${element};
      target.scrollIntoView({ block: 'center' });
      const rect = target.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  };
  // A finished review is on screen, with no warning that it could not be saved.
  const reviewReady = "document.querySelector('.rf-overview-title') && document.querySelector('.rf-cache-notice').hidden && !document.querySelector('.rf-analyze').disabled";
  async function openPanel() {
    const helper = await send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html` });
    const { sessionId: helperSession } = await send('Target.attachToTarget', { targetId: helper.targetId, flatten: true });
    await waitFor(() => inPage('document.readyState === "complete" && typeof chrome.tabs?.getCurrent === "function"', helperSession), 'side-panel opener');

    const result = await send('Runtime.evaluate', { userGesture: true, awaitPromise: true, expression: `(async () => {
      const tabId = ${fixtureTabId};
      await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html?tab=' + tabId, enabled: true });
      await chrome.sidePanel.open({ tabId });
    })()` }, helperSession);
    assert.equal(result.exceptionDetails, undefined, 'The installed extension must open Chrome’s real side panel.');
    await send('Target.closeTarget', { targetId: helper.targetId });
    await send('Target.activateTarget', { targetId });
    await attachPanel();
  }
  async function attachPanel() {
    await waitFor(async () => {
      const target = (await send('Target.getTargets')).targetInfos.find(info => info.url.includes('/sidepanel.html'));
      if (!target) return false;
      panelTarget = target.targetId;
      ({ sessionId: panelSession } = await send('Target.attachToTarget', { targetId: panelTarget, flatten: true }));
      await panelPage('Runtime.enable');
      return true;
    }, 'side-panel target');
  }
  async function analyzeFromPopup() {
    await send('Target.activateTarget', { targetId });
    const url = await inPage('location.href');
    const tabTarget = (await send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] })).targetInfos.find(info => info.url === url);
    assert.ok(tabTarget, 'The active PR has a Chrome tab target.');
    await send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget.targetId });
    let popupTarget;
    await waitFor(async () => {
      popupTarget = (await send('Target.getTargets')).targetInfos.find(info => info.url === `chrome-extension://${extensionId}/popup.html`);
      return popupTarget;
    }, 'toolbar popup target');
    const { sessionId: popupSession } = await send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true });
    await send('Runtime.enable', {}, popupSession);
    await waitFor(() => inPage('document.querySelector("#analyze")?.disabled === false', popupSession), 'popup recognizes the active PR');
    const point = await inPage(`(() => {
      const rect = document.querySelector('#analyze').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`, popupSession);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }, popupSession);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }, popupSession);
    await waitFor(async () => !(await send('Target.getTargets')).targetInfos.some(info => info.targetId === popupTarget.targetId), 'Analyze closes the toolbar popup');
    await attachPanel();
  }
  await openPanel();
  await waitFor(() => inPanel("document.querySelector('.rf-status')?.textContent.includes('Ready to analyze')"), 'connected side panel beside collapsed files');
  await inPage(`document.querySelector('[data-testid="progressive-diffs-list"] table').remove()`);
  assert.equal(await inPage('document.querySelectorAll("section[role=region] table").length'), 0);
  assert.equal(await inPanel('document.querySelectorAll(".rf-panel").length'), 1, 'GitHub collapse and remount never duplicate the separate panel.');
  changesMode = '';
  await page('Page.navigate', { url: prUrl + '/files' });
  await waitFor(() => inPanel("document.querySelector('.rf-status')?.textContent.includes('Ready to analyze')"), 'the panel reconnecting to the classic diff');
  assert.equal((await modelRequests()).length, 0, 'Opening a PR must not start a model analysis.');
  await inAgent(`
    globalThis.pendingSettingsMessages = [];
    globalThis.originalSettingsSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function(message, ...args) {
      const response = originalSettingsSend.call(this, message, ...args);
      if (message?.type === 'get-settings') pendingSettingsMessages.push(response);
      return response;
    };
  `);
  const statusBeforeFocus = await readFile(statusLog, 'utf8');
  await inPanel(`(async () => {
    for (let index = 0; index < 4; index++) window.dispatchEvent(new Event('focus'));

  })()`);
  await inAgent('Promise.all(pendingSettingsMessages.splice(0))');
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
  await page('Page.bringToFront');
  await waitFor(() => inAgent('chrome.runtime.sendMessage({type:"get-settings"}).then(value=>value.configured)'), 'idle-check cleanup');
  const statusAfterIdle = await readFile(statusLog, 'utf8');
  await writeFile(modeFile, 'signed-out');
  await expireConnection();
  await inPanel("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => inPanel(`document.querySelector('.rf-status')?.textContent.includes('Connect your local Codex')`), 'automatic login refresh after the cooldown');
  assert.equal((await readFile(statusLog, 'utf8')).split('\n').length, statusAfterIdle.split('\n').length + 1);
  await writeFile(modeFile, 'normal');
  await inPanel(`(async () => {
    for (let index = 0; index < 4; index++) window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));

  })()`);
  await inAgent('Promise.all(pendingSettingsMessages.splice(0))');
  assert.equal((await readFile(statusLog, 'utf8')).split('\n').length, statusAfterIdle.split('\n').length + 1, 'Signed-out results also share the cooldown.');
  assert.ok(await inPanel(`document.querySelector('.rf-status').textContent.includes('Connect your local Codex')`));
  const cacheProbeWorker = workers.at(-1);
  const probeFault = await send('Runtime.evaluate', {expression:`
    globalThis.originalCacheProbe = IDBIndex.prototype.getAll;
    IDBIndex.prototype.getAll = function(...args) {
      if (this.name === 'lookup') throw new Error('Synthetic saved-review lookup failure.');
      return originalCacheProbe.call(this, ...args);
    };
  `}, cacheProbeWorker);
  assert.equal(probeFault.exceptionDetails, undefined);
  await inPanel("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => inPanel(`document.querySelector('.rf-cache-notice').textContent.includes('Could not check saved reviews') && document.querySelector('.rf-analyze').textContent === 'Run fresh review'`), 'cache lookup failure is visible before any paid analysis');
  assert.equal((await modelRequests()).length, 0);
  await send('Runtime.evaluate', {expression:'IDBIndex.prototype.getAll = globalThis.originalCacheProbe; delete globalThis.originalCacheProbe;'}, cacheProbeWorker);
  await inPanel("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => inPanel(`document.querySelector('.rf-cache-notice').hidden && document.querySelector('.rf-analyze').textContent === 'Analyze PR'`), 'returning to the tab retries the cache lookup');
  const click = label => inPanel(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const target = buttons.find(button => button.textContent === ${JSON.stringify(label)}) ?? (${JSON.stringify(label)} === 'Analyze PR' ? buttons.find(button => button.textContent === 'Run fresh review' && !button.hidden) : null);
    if (!target) throw new Error('Missing action: ' + ${JSON.stringify(label)});
    const menu = target.closest('.rf-menu');
    if (menu && !menu.open) menu.querySelector('summary').click();
    if (!target.checkVisibility()) throw new Error('Action is not visible: ' + ${JSON.stringify(label)});
    target.click();
  })()`);
  const openFiles = () => inPanel(`(() => {
    if (document.querySelector('.rf-file-progress').hidden) document.querySelector('.rf-progress-toggle').click();
  })()`);
  await inAgent(`
    globalThis.failSettingsRead = true;
    globalThis.settingsRecoverySend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function(message, ...args) {
      if (message.type === 'get-settings' && failSettingsRead) return Promise.reject(new Error('Temporary settings failure.'));
      if (message.type === 'open-settings') return Promise.resolve({error:'Temporary options failure.'});
      return settingsRecoverySend.call(this, message, ...args);
    };
  `);
  await inPanel("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => inPanel(`document.querySelector('.rf-error').textContent.includes('Temporary settings failure.') && !document.querySelector('.rf-error').hidden`), 'settings read failure shown');
  await inAgent('failSettingsRead = false');
  await inPanel("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => inPanel(`document.querySelector('.rf-error').hidden && document.querySelector('.rf-error').textContent === ''`), 'successful settings refresh clears its earlier error');
  await inPanel('globalThis.originalOpenOptions = chrome.runtime.openOptionsPage; chrome.runtime.openOptionsPage = undefined');
  await click('Settings');
  await waitFor(() => inPanel(`document.querySelector('.rf-error').textContent.includes('Settings could not open.')`), 'unrelated options error shown');
  const optionsError = await inPanel(`document.querySelector('.rf-error').textContent`);
  await inAgent('failSettingsRead = true');
  await inPanel("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => inPanel(`document.querySelector('.rf-error').textContent.includes('Temporary settings failure.') && document.querySelector('.rf-error').textContent.includes('Settings could not open.')`), 'settings and options errors remain visible together');
  await inAgent('failSettingsRead = false');
  await inPanel("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => inPanel(`document.querySelector('.rf-error').textContent === ${JSON.stringify(optionsError)} && !document.querySelector('.rf-error').hidden`), 'settings recovery preserves the unrelated options error');
  await inAgent('chrome.runtime.sendMessage = settingsRecoverySend');
  await inPanel('chrome.runtime.openOptionsPage = originalOpenOptions');
  await inPage(`(() => {
    window.readingFocus = document.createElement('button');
    window.readingFocus.textContent = 'Continue reading GitHub';
    document.querySelector('main').prepend(window.readingFocus);
    window.readingFocus.focus();
  })()`);
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelector('.rf-overview-title')?.textContent === '1 review decision' && !document.querySelector('.rf-analyze')?.disabled`), 'capture → native helper → Codex → validated review');
  assert.equal((await readFile(statusLog, 'utf8')).split('\n').length, statusAfterIdle.split('\n').length + 4, 'Analyze PR must refresh the cached login before the two analysis passes, each of which also verifies authentication.');
  assert.equal(await inPage('document.activeElement === window.readingFocus'), true, 'The side panel must not steal focus from GitHub while analysis finishes.');
  await inPage('window.readingFocus.remove()');
  const initialRequestCount = (await modelRequests()).length;
  assert.equal(initialRequestCount, 2);
  checkEvidence(await modelRequests());
  assert.ok(await inPanel("document.querySelector('.rf-run-settings').textContent.includes('fixture-model · Effort: high')"));
  assert.ok((await modelRequests()).every(request => request.args.includes('model_reasoning_effort="high"')));
  assert.deepEqual(issueRequests, [901, 902, 903].map(number => `https://github.com/microsoft/vscode/issues/${number}`), 'Read bounded, unique same-repository issue references only.');
  assert.ok(await inPanel("[...document.querySelectorAll('.rf-context-limits li')].some(item => item.textContent.includes('Could not read linked issue #902')) && document.querySelector('.rf-context-limits').checkVisibility()"), 'Missing linked-issue context is shown in the overview.');
  const layout = await inPanel(`(() => {
    const topic = document.querySelector('.rf-topic');
    const gist = topic.querySelector('.rf-gist');
    return {
      result: document.querySelector('.rf-result').checkVisibility(),
      filesOpen: !document.querySelector('.rf-file-progress').hidden,
      sections: document.querySelectorAll('.rf-topic').length,
      open: topic.open,
      gist: [gist.textContent, gist.title, gist.querySelector('code').textContent],
      injected: [typeof window.injectedGist, document.querySelectorAll('.rf-gist img').length],
      before: topic.querySelector('.rf-before').textContent,
      after: topic.querySelector('.rf-change-explanation').textContent,
      reason: topic.querySelector('.rf-reason').textContent,
      headings: [...topic.querySelectorAll('.rf-topic-body > h3, .rf-compare h3')].map(node => node.textContent),
      limits: [topic.querySelector('.rf-limits').open, topic.querySelector('.rf-evidence').open],
      questions: [...topic.querySelectorAll('.rf-questions > li')].map(node => node.textContent),
      questionMarkup: [...topic.querySelectorAll('.rf-questions code, .rf-questions strong')].map(node => [node.tagName, node.textContent]),
      summary: [...document.querySelectorAll('.rf-summary li')].map(node => node.textContent),
      summaryElements: [...document.querySelectorAll('.rf-summary *')].map(node => node.tagName),
      note: topic.querySelector('.rf-code-note').textContent,
      files: [...topic.querySelectorAll('.rf-section-file')].map(row => [row.querySelector('button').getAttribute('aria-label'), row.querySelector('.rf-file-delta').textContent]),
      reference: topic.querySelector('.rf-code-quote > .rf-ref').textContent
    };
  })()`);
  const shownGist = 'Where labels apply fontVariationSettings <img src=x onerror="window.injectedGist=1">';
  assert.deepEqual([layout.result, layout.filesOpen, layout.sections, layout.open], [true, false, 1, true]);
  assert.deepEqual(layout.gist, [shownGist, shownGist, 'fontVariationSettings']);
  assert.deepEqual(layout.injected, ['undefined', 0], 'Model markup remains literal text.');
  assert.deepEqual([layout.before, layout.after, layout.reason], [assessment.topics[0].before, assessment.topics[0].after, assessment.topics[0].reason]);
  assert.deepEqual(layout.headings, ['Before', 'After', 'Why it matters', 'Review questions', 'In the code']);
  assert.deepEqual(layout.limits, [false, false]);
  assert.deepEqual(layout.questions, ['Do both paths receive the intended font setting?', 'Should other widgets apply fontVariationSettings too?']);
  assert.deepEqual(layout.questionMarkup, [['STRONG', 'other'], ['CODE', 'fontVariationSettings']]);
  assert.deepEqual(layout.summary, ['Applies fontVariationSettings to both rendering paths.', 'Keeps <img src=x onerror=alert(1)> and a `dangling **marker as text.']);
  assert.deepEqual(layout.summaryElements, ['P', 'UL', 'LI', 'CODE', 'STRONG', 'LI']);
  assert.equal(layout.note, 'The label element receives fontVariationSettings.');
  assert.deepEqual(layout.files, [[sourcePath, '+2 −0']]);
  assert.equal(layout.reference, 'L137');
  assert.equal(await inPage('document.querySelectorAll("#review-focus-extension, .review-focus-file-status, .review-focus-file-progress").length'), 0, 'Explanations and progress live only in the side panel.');
  await waitFor(() => inPage('document.querySelectorAll(".review-focus-native-fold").length > 0'), 'native unchanged context folded');
  assert.ok(await inPanel("document.querySelector('.rf-fold-summary').textContent.includes('closed in the loaded files')"));
  assert.equal(await inPage('document.querySelectorAll(".review-focus-native-reviewed").length'), 0, 'Nothing is marked reviewed before a section is done.');
  await inPanel("document.querySelector('.rf-code-quote > .rf-ref').click()");
  await waitFor(() => inPage(`Boolean(document.querySelector('.review-focus-native-target td[data-line-number="137"]'))`), 'cited line revealed in GitHub');
  assert.equal(await inPanel("document.querySelector('.rf-result').checkVisibility()"), true, 'Following a reference keeps the explanation available.');
  const beforeFolding = (await modelRequests()).length;
  await inPanel("document.querySelector('.rf-fold-toggle input').click()");
  await waitFor(() => inPage('document.querySelectorAll(".review-focus-native-fold, .review-focus-native-hidden").length === 0'), 'native folding disabled');
  await inPanel("document.querySelector('.rf-fold-toggle input').click()");
  await waitFor(() => inPage('document.querySelectorAll(".review-focus-native-fold").length > 0'), 'native folding restored');
  await inPage(`(() => {
    window.foldToggle = document.querySelector('.review-focus-native-toggle');
    window.foldToggle.focus();
    window.foldToggle.click();
    document.body.append(document.createElement('aside'));
  })()`);
  await waitFor(() => inPage('window.foldToggle.getAttribute("aria-expanded") === "true" && document.querySelectorAll(".review-focus-native-unfolded").length > 0'), 'individual native fold opened');
  await inPage('new Promise(resolve => setTimeout(resolve, 400))');
  assert.equal(await inPage('window.foldToggle.isConnected && document.activeElement === window.foldToggle'), true, 'Unrelated mutations preserve native fold controls and keyboard focus.');
  await inPage(`(() => {
    window.commentedLine = document.querySelector('.review-focus-native-hidden');
    window.nativeThread = document.createElement('tr');
    window.nativeThread.className = 'inline-comments';
    window.nativeThread.innerHTML = '<td colspan="3"><div class="review-thread-component">Existing discussion</div><form><textarea>Unsubmitted review comment</textarea></form></td>';
    window.commentedLine.after(window.nativeThread);
  })()`);
  await waitFor(() => inPage('window.commentedLine.checkVisibility() && window.nativeThread.checkVisibility()'), 'native discussion keeps its code row visible');
  await inPanel("document.querySelector('.rf-fold-toggle input').click()");
  await waitFor(() => inPage('document.querySelectorAll(".review-focus-native-hidden").length === 0'), 'turning folding off restores native context');
  await inPanel("document.querySelector('.rf-fold-toggle input').click()");
  await waitFor(() => inPage('document.querySelectorAll(".review-focus-native-fold").length > 0'), 'folding returns around native discussion');
  assert.equal(await inPage('window.commentedLine.checkVisibility() && window.nativeThread.checkVisibility() && window.nativeThread.querySelector("textarea").value === "Unsubmitted review comment"'), true, 'Folding preserves GitHub discussions and unsubmitted drafts.');
  await inPage('window.nativeThread.remove()');
  assert.equal((await modelRequests()).length, beforeFolding);
  await inPanel("document.querySelector('.rf-menu > summary').focus()");
  await panelPage('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await panelPage('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await waitFor(() => inPanel("document.querySelector('.rf-menu').open"), 'keyboard menu');
  await panelPage('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await panelPage('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  assert.equal(await inPanel("!document.querySelector('.rf-menu').open && document.activeElement === document.querySelector('.rf-menu > summary')"), true);
  await inPanel("document.querySelector('.rf-menu > summary').click(); document.querySelector('.rf-brand').dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))");
  assert.equal(await inPanel("document.querySelector('.rf-menu').open"), false);
  await openFiles();
  assert.equal(await inPanel("document.querySelector('.rf-progress-toggle').getAttribute('aria-expanded')"), 'true');
  const humanReviewInputs = `[...document.querySelectorAll('.rf-reviewed-toggle input')]`;
  assert.deepEqual(await inPanel(`[...document.querySelectorAll('.rf-section-done input, .rf-reviewed-toggle input')].map(input => [input.checked, input.indeterminate])`), [[false, false], [false, false]], 'AI completion never marks a section done or checks the file-list Reviewed control.');
  assert.equal(await inPage('window.fixtureViewedClicks'), 0);
  await inPanel(`document.querySelector('.rf-evidence').open = true; window.savedReviewEvidence = document.querySelector('.rf-evidence'); document.querySelector('.rf-file-list input').focus(); document.querySelector('.rf-file-list input').click()`);
  await waitFor(() => inPanel(`${humanReviewInputs}.every(input => input.checked && input.getAttribute('aria-disabled') === 'false')`), 'Viewed mirrored after native header replacement');
  assert.equal(await inPage('document.querySelector(".js-reviewed-checkbox").checked'), true);
  assert.equal(await inPanel('window.savedReviewEvidence.isConnected && window.savedReviewEvidence.open && document.activeElement.type === "checkbox"'), true);
  assert.equal(await inPanel("document.querySelector('.rf-section-done input').checked"), true, 'Ticking the file in the panel marks its only section done.');
  await clickInPage('document.querySelector(".js-reviewed-checkbox")');
  await waitFor(async () => await inPage('!document.querySelector(".js-reviewed-checkbox").disabled') && await inPanel(`${humanReviewInputs}.every(input => !input.checked) && !document.querySelector('.rf-section-done input').checked`), 'native Viewed uncheck mirrored and clears the section');
  await inPage('window.fixtureViewedRollback = true; window.fixtureViewedDelay = 80');
  await inPanel("document.querySelector('.rf-file-list input').focus(); document.querySelector('.rf-file-list input').click()");
  await waitFor(async () => await inPage('window.fixtureViewedClicks === 3 && !document.querySelector(".js-reviewed-checkbox").disabled') && await inPanel(`${humanReviewInputs}.every(input => !input.checked)`), 'native save rollback mirrored');
  await inPage('window.fixtureViewedDelay = 0; document.querySelector(".js-reviewed-checkbox").disabled = true');
  await waitFor(() => inPanel(`${humanReviewInputs}.every(input => input.getAttribute('aria-disabled') === 'true')`), 'disabled native Viewed control');
  await inPanel("document.querySelector('.rf-file-list input').click()");
  assert.equal(await inPage('window.fixtureViewedClicks'), 3);
  await inPage('document.querySelector(".js-reviewed-checkbox").disabled = false');
  await waitFor(() => inPanel(`${humanReviewInputs}.every(input => input.getAttribute('aria-disabled') === 'false')`), 'Viewed control available');
  assert.equal(await inPanel("document.querySelector('.rf-section-done input').checked"), true, 'A Viewed save GitHub rolls back keeps the section the reviewer ticked through the file.');
  await inPanel("document.querySelector('.rf-section-done input').click()");
  assert.equal(await inPage('window.fixtureViewedClicks'), 3, 'Unticking the section of a file that is not Viewed clicks nothing.');
  await inPanel("document.querySelector('.rf-section-done input').click()");
  await waitFor(() => inPanel(`${humanReviewInputs}.every(input => input.checked)`), 'marking the only section listing a file done marks it Viewed');
  assert.equal((await modelRequests()).length, initialRequestCount);
  const closedPanelTarget = panelTarget;
  const closedPanel = await send('Runtime.evaluate', {expression:`chrome.sidePanel.close({tabId:${fixtureTabId}})`,awaitPromise:true}, workers.at(-1));
  assert.equal(closedPanel.exceptionDetails, undefined, 'Chrome closes the panel through its native API.');
  await waitFor(() => inPage('document.querySelectorAll(".review-focus-native-fold, .review-focus-native-hidden, .review-focus-native-unfolded").length === 0'), 'closing panel restores GitHub rows');
  await openPanel();
  assert.notEqual(panelTarget, closedPanelTarget, 'Reopening through Chrome creates a new panel document.');
  await waitFor(() => inPanel("document.querySelector('.rf-analyze')?.textContent === 'Open saved review'"), 'saved review offered in reopened panel');
  await click('Open saved review');
  await waitFor(() => inPanel(reviewReady), 'reopened panel restores saved review');
  assert.deepEqual(await inPanel(`[...document.querySelectorAll('.rf-section-done input, .rf-reviewed-toggle input')].map(input => input.checked)`), [true, true], 'A reopened panel restores the section marked done and GitHub’s Viewed mark.');
  assert.equal((await modelRequests()).length, initialRequestCount);
  await send('Runtime.evaluate', { expression: 'setTimeout(() => chrome.runtime.reload(), 0)' }, workers.at(-1));
  await waitFor(() => inPage('document.querySelectorAll(".review-focus-native-fold, .review-focus-native-hidden").length === 0'), 'extension reload restores native rows');
  panelSession = undefined;
  await page('Page.reload');
  await openPanel();
  await waitFor(() => inPanel("document.querySelector('.rf-analyze')?.textContent === 'Open saved review'"), 'saved review after extension reload');
  await click('Open saved review');
  await waitFor(() => inPanel(reviewReady), 'saved review restored after extension reload');
  assert.equal((await modelRequests()).length, initialRequestCount);
  for (const checked of [false, true]) {
    await inPage(`{ const control = document.querySelector('.js-reviewed-checkbox'); control.checked = ${checked}; control.dispatchEvent(new Event('change', {bubbles:true})); }`);
    await waitFor(() => inPanel(`${humanReviewInputs}.every(input => input.checked === ${checked})`), 'native checked-property changes mirrored');
  }
  await inPanel('window.reviewBeforeNavigation = document.querySelector(".rf-result")');
  for (const [away, back] of [['', '/files'], ['/checks', '/changes'], ['/commits', '/changes/abc123']]) {
    await inPage(`history.pushState({}, '', ${JSON.stringify(prUrl)} + ${JSON.stringify(away)}); window.dispatchEvent(new PopStateEvent('popstate'))`);
    await waitFor(() => inPanel("document.querySelector('.rf-analyze').disabled && document.querySelector('.rf-status').textContent.includes('Files changed')"), 'off-diff navigation guidance');
    await waitFor(() => inPage('document.querySelectorAll(".review-focus-native-fold, .review-focus-native-hidden").length === 0'), 'off-diff navigation restores rows');
    await inPage(`history.pushState({}, '', ${JSON.stringify(prUrl)} + ${JSON.stringify(back)}); window.dispatchEvent(new PopStateEvent('popstate'))`);
    await waitFor(() => inPanel("!document.querySelector('.rf-analyze').disabled && document.querySelector('.rf-overview-title')"), 'same review retained on return');
    assert.equal(await inPanel('window.reviewBeforeNavigation === document.querySelector(".rf-result")'), true);
    assert.equal((await modelRequests()).length, initialRequestCount);
  }
  await inPage(`history.replaceState({}, '', ${JSON.stringify(prUrl + '/files')}); window.dispatchEvent(new PopStateEvent('popstate'))`);
  for (const failure of ['issue', 'source']) {
    transientIssueFailure = failure === 'issue';
    transientSourceFailure = failure === 'source';
    await page('Page.reload');
    await waitFor(() => inPanel("document.querySelector('.rf-analyze')?.textContent === 'Open saved review'"), 'saved review before context failure');
    await click('Open saved review');
    await waitFor(() => inPanel("document.querySelector('.rf-status')?.textContent.includes('does not match')"), 'incomplete context refuses cached review');
    await inPanel("window.dispatchEvent(new Event('focus'))");
    assert.equal(await inPanel("document.querySelector('.rf-analyze').textContent"), 'Run fresh review');
    assert.equal(await inPage('document.querySelectorAll(".review-focus-native-hidden").length'), 0);
    transientIssueFailure = false;
    transientSourceFailure = false;
    await click('Retry saved review');
    await waitFor(() => inPanel(reviewReady), 'saved review retry after context recovery');
    assert.equal((await modelRequests()).length, initialRequestCount);
  }

  const beforeUnresolved = (await modelRequests()).length;
  await writeFile(modeFile, 'unresolved');
  await click('Run fresh review');
  await waitFor(() => inPanel(`document.querySelector('.rf-unresolved')?.textContent.includes('1 change could not be fully checked') && !document.querySelector('.rf-analyze').disabled`), 'unresolved classification visibility');
  let afterUnresolved = (await modelRequests()).length;
  assert.equal(afterUnresolved - beforeUnresolved, 2);
  assert.equal(await inPage(`document.querySelector('td[data-line-number="151"]').closest('tr').classList.contains('review-focus-native-hidden')`), false, 'Unresolved changes stay visible in GitHub.');
  await inPanel("document.querySelector('.rf-unresolved .rf-ref').click()");
  await waitFor(() => inPage(`Boolean(document.querySelector('.review-focus-native-target td[data-line-number="151"]'))`), 'unresolved change revealed in GitHub');
  assert.ok(await inPanel(`document.querySelector('.rf-unresolved .rf-ref').title.includes('cannot be established')`), 'The code link names the missing evidence.');
  await inPanel("document.querySelector('.rf-unresolved .rf-link-button').click(); document.querySelector('.rf-topic[data-topic-id=second-path] .rf-evidence').open = true");
  assert.equal(await inPanel(`document.querySelector('.rf-edit[data-edit-id="0-1-3"] .rf-change-kind').textContent`), 'Change type: unknown');
  assert.ok(await inPanel(`document.querySelector('.rf-edit[data-edit-id="0-1-3"] .rf-uncertainty').textContent.includes('cannot be established')`));

  await writeFile(modeFile, 'reconciled');
  await click('Run fresh review');
  await waitFor(() => inPanel(`document.querySelector('.rf-unresolved')?.textContent.includes('1 change could not be fully checked') && !document.querySelector('.rf-analyze').disabled`), 'revised classification replaces both first-pass uncertainties');
  assert.equal((await modelRequests()).length - afterUnresolved, 2, 'Reconciling classifications must not add a model call.');
  afterUnresolved = (await modelRequests()).length;
  for (const restored of [false, true]) {
    if (restored) {
      await page('Page.reload');
      await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'revised classifications saved');
      await click('Open saved review');
      await waitFor(() => inPanel(reviewReady), 'revised classifications restored');
      assert.equal((await modelRequests()).length, afterUnresolved, 'Restoring revised classifications must not invoke the model.');
    }
    assert.equal(await inPanel("document.querySelectorAll('.rf-edit').length"), 2);
    assert.ok(await inPanel(`document.querySelector('.rf-unresolved').textContent.includes('1 change could not be fully checked')`));
    assert.equal(await inPanel(`document.querySelector('.rf-topic').textContent.includes('missing from this file pass')`), false, 'First-pass evidence gaps must not reappear after reconciliation.');
    assert.ok(await inPanel(`document.querySelector('.rf-topic').textContent.includes('Only the external caller contract remains unavailable.')`));
  }
  await writeFile(modeFile, 'normal');
  checkEvidence(await modelRequests());

  incomplete = true;
  await click('Run fresh review');
  await waitFor(() => inPanel(`document.querySelector('.rf-error').textContent.includes('1 of 2 files')`), 'incomplete capture rejection');
  assert.equal((await modelRequests()).length, afterUnresolved, 'An incomplete diff must not be sent for analysis.');
  const captureError = await inPanel(`document.querySelector('.rf-error').textContent`);
  await inAgent(`
    globalThis.captureErrorSettingsRefresh = null;
    const originalSend = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function(message, ...args) {
      const response = originalSend.call(this, message, ...args);
      if (message.type === 'get-settings') {
        captureErrorSettingsRefresh = response;
        chrome.runtime.sendMessage = originalSend;
      }
      return response;
    };
  `);
  await inPanel("window.dispatchEvent(new Event('focus'))");
  assert.equal((await inAgent('captureErrorSettingsRefresh')).provider, 'codex', 'The settings refresh must finish successfully before checking the analysis error.');
  assert.equal(await inPanel(`document.querySelector('.rf-error').textContent`), captureError, 'Successful settings refresh must preserve an analysis error.');
  incomplete = false;
  changesMode = 'complete';
  await page('Page.navigate', {url:prUrl + '/changes'});
  await waitFor(() => inPanel(`document.querySelector('.rf-status')?.textContent.includes('Ready to analyze') || document.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'parallel capture failure fixture ready');
  await inAgent(`(() => {
    const originalFetch = globalThis.fetch;
    let entryRequests = 0;
    globalThis.fetch = (input, options) => {
      if (new URL(input).pathname !== ${JSON.stringify(changes.root + '/page_data/diff_entries')} || ++entryRequests <= 2) return originalFetch(input, options);
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true}));
    };
    window.restoreEntryFetch = () => { globalThis.fetch = originalFetch; };
  })()`);
  await inPanel(`document.querySelector('.rf-analyze').click()`);
  await waitFor(() => inPanel(`(() => {
    const read = document.querySelector('.rf-progress-detail').textContent.match(/^Reading changed files: (\\d+) of 53…$/);
    const bar = document.querySelector('.rf-progress-bar');
    return read && bar.value === Number(read[1]) && bar.max === 53;
  })()`), 'the file count of a held capture in the progress line and bar');
  const captureStatus = await inPanel(`({text:document.querySelector('.rf-status').textContent, hidden:document.querySelector('.rf-status').classList.contains('rf-visually-hidden'), detail:document.querySelector('.rf-progress-detail').textContent})`);
  assert.ok(captureStatus.hidden && captureStatus.text.endsWith(`. ${captureStatus.detail}`), 'Capture progress is announced once, without a second visible status or doubled punctuation.');
  await click('Cancel');
  await waitFor(() => inPanel(`!document.querySelector('.rf-analyze').disabled && !document.querySelector('.rf-progress-panel').checkVisibility()`), 'capture cancelled while diff reads are held');
  await inAgent('restoreEntryFetch()');
  const beforeCaptureFailure = (await modelRequests()).length;
  await inAgent(`(() => {
    const originalFetch = globalThis.fetch;
    let batchesStarted;
    const ready = new Promise(resolve => { batchesStarted = resolve; });
    window.failedCaptureRequests = [];
    globalThis.fetch = async (input, options) => {
      const url = new URL(input);
      if (url.pathname === ${JSON.stringify(changes.root + '/page_data/diff_entries')}) {
        return new Promise((resolve, reject) => {
          const {signal} = options;
          signal.addEventListener('abort', () => reject(signal.reason), {once:true});
          failedCaptureRequests.push({signal, release:() => originalFetch(input, options).then(resolve, reject)});
          if (failedCaptureRequests.length === 6) batchesStarted();
        });
      }
      if (url.pathname === ${JSON.stringify(changes.root)}) {
        await ready;
        return new Response('', {status:503});
      }
      return originalFetch(input, options);
    };
    window.restoreCaptureFetch = () => { globalThis.fetch = originalFetch; };
  })()`);
  await inPanel(`document.querySelector('.rf-analyze').click()`);
  await waitFor(() => inPanel(`document.querySelector('.rf-error').textContent.includes('(503)')`), 'description failure while six diff batches are pending');
  assert.deepEqual(await inAgent('failedCaptureRequests.map(request => request.signal.aborted)'), Array(6).fill(true), 'A failed capture aborts every outstanding diff request before enabling another analysis.');
  const failedCaptureStatus = await inPanel(`document.querySelector('.rf-status').textContent`);
  await inAgent('Promise.all(failedCaptureRequests.map(request => request.release()))');
  assert.equal(await inPanel(`document.querySelector('.rf-status').textContent`), failedCaptureStatus, 'Late diff responses must not replace the failure announcement.');
  assert.equal(await inAgent('failedCaptureRequests.length'), 6, 'A failed capture must not start another batch of GitHub reads.');
  assert.equal((await modelRequests()).length, beforeCaptureFailure, 'A failed capture must not reach the model.');
  await inAgent('restoreCaptureFetch()');
  changesMode = '';
  modernMode = true;
  const moduleUrl = `chrome-extension://${extensionId}/github.js`;
  await page('Page.navigate', {url:prUrl + '/files'});
  await waitFor(() => inPage(`import(${JSON.stringify(moduleUrl)}).then(module => module.readPageIdentity()?.headSha === 'c28cc8e5271452b5b4c347d46a63f717c29417d6')`), 'React capture fixture displayed');
  const modern = await inPage(`(async()=>{
    const module=await import(${JSON.stringify(moduleUrl)});
    const doc=new DOMParser().parseFromString(${JSON.stringify(react)},'text/html');
    const files=module.findNativeFiles(doc);
    const {snapshot}=await module.capturePullRequest();
    return {files:files.map(file=>({path:file.path,rows:file.rows.map(({oldLine,newLine,type,text})=>({oldLine,newLine,type,text}))})), snapshot};
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
  assert.equal((await modelRequests()).length, afterUnresolved, 'Collecting issue context must not trigger additional model requests.');
  modernMode = false;
  await page('Page.reload');
  await waitFor(() => inPage(`import(${JSON.stringify(moduleUrl)}).then(module => module.readPageIdentity()?.headSha === ${JSON.stringify(headSha)})`), 'classic capture revision restored');

  const captureFixture = (options = {}) => inPage(`(async()=>{
    const module=await import(${JSON.stringify(moduleUrl)});
    const progress=[];
    const fileCounts=[];
    try {
      const {snapshot,highlights}=await module.capturePullRequest({...${JSON.stringify(options)},onProgress:(message,files)=>{progress.push(message);if(files)fileCounts.push(files);}});
      return {snapshot,highlights,progress,fileCounts};
    } catch(error) { return {error:error.message,progress,fileCounts}; }
  })()`);
  const lifecycleRoute = structuredClone(changes.route);
  lifecycleRoute.diffContents = [
    { path: 'added.js', linesAdded: 2, linesDeleted: 0, diffLines: [{ type: 'HUNK', text: '@@ -0,0 +1,2 @@' }, { type: 'ADDITION', text: '+++ b/content' }, { type: 'ADDITION', text: '+export const added = true;' }] },
    { path: 'deleted.js', linesAdded: 0, linesDeleted: 1, diffLines: [{ type: 'HUNK', text: '@@ -1 +0,0 @@' }, { type: 'DELETION', text: '-export const deleted = true;' }] },
    { path: 'modified.js', linesAdded: 1, linesDeleted: 1, diffLines: [{ type: 'HUNK', text: '@@ -1 +1 @@' }, { type: 'DELETION', text: '-export const value = false;' }, { type: 'ADDITION', text: '+export const value = true;' }] }
  ].map(entry => ({ ...entry, linesChanged: entry.linesAdded + entry.linesDeleted, oldCommitOid: baseSha, newCommitOid: headSha }));
  lifecycleRoute.diffSummaries = lifecycleRoute.diffContents;
  const lifecycleCapture = await inPage(`(async () => {
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
    try { return {snapshot:(await capturePullRequest()).snapshot,requests}; }
    finally { window.fetch = originalFetch; }
  })()`);
  assert.deepEqual(lifecycleCapture.snapshot.files.map(file => [file.path, file.additions, file.deletions]), [['added.js', 2, 0], ['deleted.js', 0, 1], ['modified.js', 1, 1]], 'Added content resembling a file header must preserve complete hunks and subsequent file headers.');
  assert.deepEqual(lifecycleCapture.snapshot.files[0].hunks[0].items[0].rows.map(row => row.text), ['++ b/content', 'export const added = true;']);
  assert.ok(!lifecycleCapture.requests.some(url => url.includes('/' + baseSha + '/added.js') || url.includes('/' + headSha + '/deleted.js')), 'Nonexistent sides of added/deleted files must not be fetched.');
  assert.deepEqual(lifecycleCapture.snapshot.context.filter(source => source.text === ''), [{path:'added.js',side:'before',text:''},{path:'deleted.js',side:'after',text:''}]);
  assert.deepEqual(lifecycleCapture.snapshot.warnings, ['Could not read after context for modified.js; only its diff was analyzed.'], 'Actual source fetch failures still report missing evidence.');
  const reactEntries = [
    { path: 'modified.js', linesAdded: 1, linesDeleted: 1, diffLines: [{ type: 'HUNK', text: '@@ -1 +1 @@' }, { type: 'DELETION', text: '-export const value = false;' }, { type: 'ADDITION', text: '+export const value = true;' }] },
    { path: 'deleted.js', linesAdded: 0, linesDeleted: 2, diffLines: [{ type: 'HUNK', text: '@@ -1,2 +0,0 @@ export' }, { type: 'DELETION', text: '-DELETED_REACT_CONTENT', html: '-<span class="pl-k">DELETED_REACT_CONTENT</span>' }, { type: 'DELETION', text: '-export const deleted = true;' }] }
  ].map(entry => ({ ...entry, oldOid: baseSha, newOid: headSha }));
  const reactDeletion = await inPage(`(async () => {
    const {capturePullRequest} = await import(${JSON.stringify(moduleUrl)});
    const originalFetch = window.fetch;
    window.fetch = async url => {
      if (url.includes('/files?')) return new Response(${JSON.stringify(`<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { diffEntryData: reactEntries } })}</script>`)});
      if (url.includes('/blob/')) return new Response('<script type="application/json" data-target="react-app.embeddedData">{"rawLines":["export const value = true;"]}</script>');
      return new Response('<div data-testid="issue-body-viewer">Update one file and delete another.</div>');
    };
    const capture = options => capturePullRequest(options).then(({snapshot,highlights}) => ({snapshot,highlightedPaths:Object.keys(highlights)}), error => ({error:error.message}));
    try { return {listed:await capture({fileLimit:1,listDeletedFiles:true}),analyzed:await capture({fileLimit:1})}; }
    finally { window.fetch = originalFetch; }
  })()`);
  assert.equal(reactDeletion.listed.error, undefined, 'A deleted file recognized by its diff does not count toward the file limit.');
  assert.deepEqual(reactDeletion.listed.snapshot.files.map(file => file.path), ['modified.js']);
  assert.deepEqual(reactDeletion.listed.snapshot.deletedFiles, [{ path: 'deleted.js', deletions: 2 }]);
  assert.ok(!JSON.stringify(reactDeletion.listed).includes('DELETED_REACT_CONTENT'), 'Listed deleted files keep their rows and highlighting out of the capture.');
  assert.ok(!reactDeletion.listed.highlightedPaths.includes('deleted.js'));
  assert.equal(reactDeletion.analyzed.error, 'This PR changes 2 files; PRiorities analyzes up to 1 (change this in Settings). Use Full diff to review it. No analysis was sent.');

  const beforeHighlightingCapture = (await modelRequests()).length;
  const batchedHighlighting = await inPage(`(async () => {
    const {capturePullRequest} = await import(${JSON.stringify(moduleUrl)});
    const lineCount = 12000;
    const paths = ['tests/highlighting.ts', 'src/highlighting-1.ts', 'src/highlighting-2.ts', 'src/highlighting-3.ts'];
    const route = ${JSON.stringify(changes.route)};
    route.diffContents = paths.map((path, index) => ({
      path, oldCommitOid:${JSON.stringify(baseSha)}, newCommitOid:${JSON.stringify(headSha)},
      linesAdded:index === 0 ? lineCount : 1, linesDeleted:index === 0 ? 0 : 1, linesChanged:index === 0 ? lineCount : 2,
      diffLines:index === 0 ? [
        {type:'HUNK',text:'@@ -0,0 +1,' + lineCount + ' @@'},
        ...Array.from({length:lineCount}, (_, index) => ({type:'ADDITION',text:'+x',html:index % 2 ? '+x' : '+<span class="pl-k">x</span>'}))
      ] : [
        {type:'HUNK',text:'@@ -1 +1 @@'},
        {type:'DELETION',text:'-x',html:'-<span class="pl-k">x</span>'},
        {type:'ADDITION',text:'+y',html:'+<span class="pl-k">y</span>'}
      ]
    }));
    route.diffSummaries = route.diffContents;
    const embedded = data => '<script type="application/json" data-target="react-app.embeddedData">' + JSON.stringify(data) + '</script>';
    const diffPage = embedded({payload:{pullRequestsChangesRoute:route}});
    const sourcePages = Object.fromEntries(['x','y'].map(text => [text, embedded({rawLines:Array(lineCount).fill(text),colorizedLines:Array.from({length:lineCount}, (_, index) => index % 2 ? text : '<span class="pl-k">' + text + '</span>')})]));
    const originalFetch = window.fetch;
    const originalParse = DOMParser.prototype.parseFromString;
    const runs = [];
    try {
      for (const abortPhase of [null, 'diff', 'source']) {
        const controller = new AbortController();
        const counts = {diff:0,source:0};
        const observed = {};
        const tasks = [];
        let phase = 'diff';
        let finished = false;
        let countsAtAbort;
        let checkedRevision = false;
        window.fetch = async url => {
          if (url.includes('/files?')) return new Response(diffPage);
          if (url.includes('/blob/')) return new Response(sourcePages[url.includes(${JSON.stringify('/' + headSha + '/')}) ? 'y' : 'x']);
          return new Response('<div data-testid="issue-body-viewer">Exercise cooperative highlighting.</div>');
        };
        DOMParser.prototype.parseFromString = function(html, type) {
          if (html.startsWith('<body>')) {
            const currentPhase = phase;
            counts[currentPhase]++;
            if (counts[currentPhase] === 1) tasks.push(scheduler.postTask(() => {
              observed[currentPhase] = {count:counts[currentPhase],finished};
              if (abortPhase === currentPhase) {
                countsAtAbort = {...counts};
                controller.abort();
              }
            }, {priority:'user-blocking'}));
          }
          return originalParse.call(this, html, type);
        };
        let result;
        try {
          const {snapshot,highlights} = await capturePullRequest({signal:controller.signal,onProgress:message => {
            if (message.startsWith('Reading context for ')) phase = 'source';
            if (message.startsWith('Checking that the PR')) checkedRevision = true;
          }});
          const rows = snapshot.files[0].hunks[0].items[0].rows;
          const validTokens = (lines, text) => Object.keys(lines).length === lineCount / 2 && Array.from({length:lineCount}, (_, index) => index % 2 ? !Object.hasOwn(lines,index + 1) : JSON.stringify(lines[index + 1]) === JSON.stringify([[text,'pl-k']])).every(Boolean);
          result = {
            diffRows:rows.length === lineCount && rows.every((row,index) => row.text === 'x' && row.newLine === index + 1),
            diffTokens:validTokens(highlights[paths[0]].after,'x'),
            sourceCount:snapshot.context.length,
            sourceText:snapshot.context.every(source => source.text === ((source.side === 'before' ? 'x' : 'y') + '\\n').repeat(lineCount)),
            sourceTokens:paths.slice(1).every(path => validTokens(highlights[path].before,'x') && validTokens(highlights[path].after,'y')),
            warnings:snapshot.warnings
          };
        } catch (error) { result = {error:error.name}; }
        finished = true;
        await Promise.all(tasks);
        await scheduler.yield();
        runs.push({abortPhase,counts,countsAtAbort,observed,checkedRevision,result});
      }
      return runs;
    } finally {
      window.fetch = originalFetch;
      DOMParser.prototype.parseFromString = originalParse;
    }
  })()`);
  const [highlightedCapture, ...cancelledHighlights] = batchedHighlighting;
  assert.deepEqual(highlightedCapture.counts, {diff:12006,source:72000});
  for (const phase of ['diff', 'source']) {
    assert.equal(highlightedCapture.observed[phase].finished, false, `A browser task runs while ${phase} highlighting is pending.`);
    assert.ok(highlightedCapture.observed[phase].count < 12000, `The ${phase} capture yields within the first large file.`);
  }
  assert.deepEqual(highlightedCapture.result, {diffRows:true,diffTokens:true,sourceCount:6,sourceText:true,sourceTokens:true,warnings:[]}, 'Yielding preserves every diff row, syntax token, and complete before/after source across six concurrent readers.');
  for (const run of cancelledHighlights) {
    assert.deepEqual(run.result, {error:'AbortError'}, `Cancelling during ${run.abortPhase} highlighting rejects the capture without a snapshot.`);
    assert.deepEqual(run.counts, run.countsAtAbort, 'No additional line is parsed after cancellation during a yield.');
    assert.equal(run.checkedRevision, false, 'An aborted capture stops before the final revision check.');
  }
  assert.equal((await modelRequests()).length, beforeHighlightingCapture, 'Capturing and cancelling yielded highlighting do not start analysis.');
  deferredMode = 'missing';
  const missingDeferred = await captureFixture();
  assert.match(missingDeferred.error ?? '', /4 of 53 files/, 'A count in the deferred tabs must detect the missing 49 files before claiming the four placeholders are the complete diff.');
  assert.equal(missingDeferred.snapshot, undefined);
  assert.equal(missingDeferred.progress.some(message => message.includes('context for 4 changed files')), false);

  deferredMode = 'initial';
  deferredRequests.length = 0;
  const overLimitDeferred = await captureFixture({ fileLimit: 50 });
  assert.equal(overLimitDeferred.error, 'This PR changes 53 files; PRiorities analyzes up to 50 (change this in Settings). Use Full diff to review it. No analysis was sent.');
  assert.equal(deferredRequests.some(url => url.includes('/deferred-')), false, 'The classic file count stops an over-limit PR before its diffs are fetched.');
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
  await waitFor(() => inPanel(`document.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'the authenticated Changes route fixture');
  assert.equal(await inPage('document.querySelectorAll("table[data-diff-anchor]").length'), 4, 'Only four split-view tables are rendered while the payload inventories 53 files.');
  changesRequests.length = 0;
  entryRequestsPeak = 0;
  const completeChanges = await captureFixture();
  assert.equal(entryRequestsPeak, 6, 'Missing file diffs load six requests at a time, not one after another.');
  assert.equal(completeChanges.error, undefined, 'Capture must read the Changes route and load the 49 entries missing from the rendered split view.');
  const splitRows = await inPage(`[...document.querySelectorAll('tr.diff-line-row')].filter(row=>row.querySelectorAll('.diff-text').length === 2).map(row=>row.checkVisibility())`);
  assert.deepEqual(splitRows, [true, true, true, true], 'Capture leaves every native split row visible and unchanged.');

  assert.deepEqual(completeChanges.snapshot.files.map(file => file.path), changes.paths);
  assert.equal(completeChanges.snapshot.baseSha, changes.baseSha);
  assert.notEqual(completeChanges.snapshot.baseSha, changes.route.comparison.fullDiff.baseOid, 'Full-PR capture must use the file diff merge base, not the target branch tip.');
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
  assert.deepEqual(completeChanges.fileCounts.at(-1), { done: 53, total: 53 }, 'Reading missing diffs reports how many of the changed files are read.');
  assert.ok(completeChanges.fileCounts.every((count, index, counts) => count.total === 53 && count.done >= (counts[index - 1]?.done ?? 0)), 'Read counts only grow.');
  assert.deepEqual(completeChanges.highlights[changes.paths[0]], {
    before: {1: [['before', 'pl-k'], [` ${changes.paths[0]}`]]},
    after: {1: [['after', 'pl-k'], [` ${changes.paths[0]}`]]}
  }, 'GitHub’s row markup becomes text tokens keyed by line, without the diff marker or its changed-word wrapper.');
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
  const comparisonRequests = changesRequests.filter(request => new URL(request.url).pathname.endsWith('/changes'));
  assert.equal(comparisonRequests.length, 2, 'Capture and its final revision check must fetch the displayed comparison route.');
  for (const request of comparisonRequests) {
    assert.equal(new URL(request.url).searchParams.get('w'), '0', 'Capture must explicitly include whitespace changes.');
  }
  changesMode = 'plain';
  const plainChanges = await captureFixture();
  assert.deepEqual(plainChanges.snapshot, completeChanges.snapshot, 'Highlighting stays outside the snapshot used for model requests and saved-review keys.');
  assert.ok(Object.values(plainChanges.highlights).every(sides => !Object.keys(sides.before).length && !Object.keys(sides.after).length));

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

  changesMode = 'merge-base-context';
  changesRequests.length = 0;
  const mergeBaseContext = await captureFixture();
  assert.equal(mergeBaseContext.error, undefined);
  assert.equal(mergeBaseContext.snapshot.baseSha, changes.baseSha);
  const mergeBaseSources = changesRequests.map(request => new URL(request.url).pathname).filter(path => path.includes('/blob/'));
  assert.deepEqual(mergeBaseSources.sort(), [`/microsoft/vscode/blob/${changes.baseSha}/src/merge-base.ts`, `/microsoft/vscode/blob/${changes.headSha}/src/merge-base.ts`].sort(), 'Captured before/after context must use the same commits as the diff rows.');

  for (const mode of ['missing', 'duplicate', 'wrong-path', 'wrong-revision', 'wrong-base-revision', 'truncated', 'duplicate-summary', 'truncated-list', 'inline-revision', 'inline-base-revision', 'generated-missing', 'generated-incomplete']) {
    changesMode = mode;
    const rejected = await captureFixture();
    assert.equal(typeof rejected.error, 'string', `${mode} must reject the capture.`);
    assert.equal(rejected.snapshot, undefined, `${mode} must not expose a partial snapshot.`);
    assert.equal(rejected.progress.some(message => message.startsWith('Reading context for ')), false, `${mode} must fail before claiming capture is complete.`);
  }
  changesMode = 'missing';
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelector('.rf-error')?.textContent.length > 0`), 'incomplete Changes route rejection through Analyze PR');
  assert.equal((await modelRequests()).length, afterUnresolved, 'Reading complete diffs and rejecting incomplete or malformed Changes responses must not invoke Codex.');
  const beforeParallel = (await modelRequests()).length;
  changesMode = 'parallel';
  await writeFile(modeFile, 'parallel');
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => inPanel(`document.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'current unified Changes layout');
  await writeFile(uxGate, 'waiting');
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelector('.rf-file-progress-row[data-path="tests/change-1.ts"][data-state=classifying] .rf-file-thought')?.textContent === 'Checking the first file'`), 'the latest Codex reasoning headline in its running file row');
  await writeFile(uxGate, 'labelled');
  await waitFor(() => inPanel(`document.querySelector('.rf-steps li[aria-current=step]')?.firstChild.textContent === 'Write review' && document.querySelector('.rf-progress-detail').textContent === 'Comparing the three files'`), 'the latest Codex reasoning headline while the PR review is written');
  assert.equal(await inPanel(`document.querySelectorAll('.rf-file-thought').length`), 0, 'A finished file drops its reasoning headline.');
  await writeFile(uxGate, 'continue');
  await waitFor(() => inPanel(`document.querySelector('.rf-overview-title')?.textContent === '0 review decisions' && !document.querySelector('.rf-analyze').disabled`), 'three actual native helpers followed by a PR review');
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
  assert.equal(await inPanel("document.querySelectorAll('.rf-section-file').length"), 3, 'Supporting sections link every captured file.');
  assert.equal(await inPanel("document.querySelectorAll('.rf-file-progress-row[data-state=complete]').length"), 3);
  assert.equal(await inPage('document.querySelectorAll(".review-focus-native-hidden").length'),0);

  const beforeGenerated = (await modelRequests()).length;
  changesMode = 'generated-review';
  await writeFile(modeFile, 'generated-review');
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => inPanel(`document.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'generated review fixture');
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelector('.rf-coverage')?.textContent.includes('1 machine-maintained file not analyzed (open the file list') && !document.querySelector('.rf-analyze').disabled`), 'final result excluding generated file');
  const defaultRequests = (await modelRequests()).slice(beforeGenerated);
  assert.equal(defaultRequests.length, 3, 'Only the two ordinary files and their PR review invoke Codex.');
  assert.equal(defaultRequests.some(request => request.evidence.files.some(file => file.path === changes.paths[0])), false);
  assert.equal(JSON.stringify(defaultRequests).includes(`before ${changes.paths[0]}`), false, 'Generated source must not enter any default model request.');
  assert.equal(defaultRequests.at(-1).evidence.files.length, 2);
  assert.equal(await inPanel('document.querySelectorAll(".rf-file-progress-row[data-state=excluded]").length'), 1);
  assert.equal(await inPanel('document.querySelectorAll(".rf-file-progress-row[data-state=complete]").length'), 2);
  assert.equal(await inPage(`document.getElementById('diff-${changes.entries[0].pathDigest}').querySelectorAll('.review-focus-native-hidden, .review-focus-native-fold').length`), 0, 'An excluded file must never be folded as if reviewed.');
  assert.equal(await inPanel(`document.querySelectorAll('.rf-section-file').length`), 2);
  await page('Page.reload');
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'saved review with an excluded generated file');
  const restoreWorker = workers.at(-1);
  await send('Runtime.evaluate', {expression:`
    globalThis.originalRestoreDigest = crypto.subtle.digest;
    crypto.subtle.digest = (...args) => new Promise(resolve => {
      globalThis.releaseRestoreDigest = () => resolve(originalRestoreDigest.apply(crypto.subtle, args));
    });
  `}, restoreWorker);
  await inAgent(`(() => {
    const originalFetch = globalThis.fetch;
    let releaseDescription;
    const description = new Promise(resolve => { releaseDescription = resolve; });
    globalThis.fetch = async (input, options) => {
      if (new URL(input).pathname === ${JSON.stringify(changes.root)}) await description;
      return originalFetch(input, options);
    };
    window.releaseRestoreCapture = () => { globalThis.fetch = originalFetch; releaseDescription(); };
  })()`);
  await click('Open saved review');
  await waitFor(() => inPanel(`document.querySelector('.rf-phase')?.textContent === 'Opening saved review' && /^(?:Reading|Loading) .+…$/.test(document.querySelector('.rf-progress-detail').textContent)`), 'capture progress while a saved review opens');
  const restoreStatus = await inPanel(`({text:document.querySelector('.rf-status').textContent, hidden:document.querySelector('.rf-status').classList.contains('rf-visually-hidden'), detail:document.querySelector('.rf-progress-detail').textContent})`);
  assert.ok(restoreStatus.hidden && restoreStatus.text === `Opening saved review. ${restoreStatus.detail}`, 'Opening a saved review shows capture progress in the progress line, not a stale visible status.');
  await inAgent('releaseRestoreCapture()');
  await waitFor(() => inPanel(`document.querySelector('.rf-phase')?.textContent === 'Opening saved review' && document.querySelector('.rf-file-progress-row[data-state=excluded]')`), 'saved-review lookup held while generated files are visible');
  assert.equal(await inPanel(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='Review anyway')`), false, 'File analysis controls must wait for saved-review restoration.');
  await waitFor(async () => (await send('Runtime.evaluate', {expression:'typeof releaseRestoreDigest === "function"',returnByValue:true}, restoreWorker)).result.value, 'cache fingerprint gate');
  await send('Runtime.evaluate', {expression:'releaseRestoreDigest(); crypto.subtle.digest = originalRestoreDigest; delete globalThis.releaseRestoreDigest; delete globalThis.originalRestoreDigest;'}, restoreWorker);
  await waitFor(() => inPanel(reviewReady), 'restore excluded-file controls');
  assert.equal((await modelRequests()).length, beforeGenerated + defaultRequests.length);
  await openFiles();
  await inPanel(`document.querySelector('.rf-file-progress-row[data-path="${changes.paths[0]}"] .rf-file-path').click()`);
  await waitFor(() => inPage('Boolean(document.querySelector(".review-focus-native-target"))'), 'excluded file remains readable in GitHub');
  const beforeOptIn = (await modelRequests()).length;
  await writeFile(modeFile, 'generated-final-failed');
  await inPanel(`[...document.querySelector('.rf-file-progress-row[data-path="${changes.paths[0]}"]').querySelectorAll('button')].find(button=>button.textContent==='Review anyway').click()`);
  assert.equal(await inPage('document.querySelectorAll(".review-focus-native-hidden").length'), 0, 'Opting in a file must immediately restore the native diff while replacing the assessment.');
  await waitFor(() => inPanel(`document.querySelector('.rf-error').textContent.length > 0 && !document.querySelector('.rf-analyze').disabled`), 'opt-in PR review failure');
  assert.equal(await inPage('document.querySelectorAll(".review-focus-native-hidden").length'), 0, 'A failed replacement restores native diff access.');
  assert.equal(await inPanel(`document.querySelector('.rf-result').checkVisibility()`), false, 'The failed replacement must not present the old summary as current.');
  await writeFile(modeFile, 'generated-review');
  await click('Retry review decisions');
  await waitFor(() => inPanel(`document.querySelector('.rf-overview-title')?.textContent === '0 review decisions' && !document.querySelector('.rf-coverage').textContent.includes('machine-maintained') && document.querySelectorAll('.rf-file-progress-row[data-state=complete]').length === 3 && !document.querySelector('.rf-analyze')?.disabled`), 'forced generated file followed by an updated PR review');
  const forcedRequests = (await modelRequests()).slice(beforeOptIn);
  assert.equal(forcedRequests.length, 2, 'Opt-in runs only the chosen file’s classification and a new PR review.');
  assert.deepEqual(forcedRequests[0].evidence.files.map(file => file.path), [changes.paths[0]]);
  assert.equal(forcedRequests.at(-1).evidence.files.length, 3);
  assert.equal(await inPanel(`document.querySelectorAll('.rf-section-file').length`), 3);
  await inPanel("document.querySelector('.rf-fold-toggle input').click()");
  await waitFor(() => inPage('document.querySelectorAll(".review-focus-native-fold").length === 0'), 'native folding disabled after generated-file review');
  assert.equal(await inPage('document.querySelectorAll(".review-focus-native-hidden, .review-focus-native-fold").length'), 0);
  await writeFile(modeFile,'normal');

  const saveChangedFileSettings = async (fileLimit, listDeletedFiles) => {
    await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
    await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex") && !document.querySelector("#file-limit").disabled'), 'changed-file settings');
    await inPage(`document.querySelector("#file-limit").value = "${fileLimit}"; document.querySelector("#list-deleted-files").checked = ${listDeletedFiles}; document.querySelector("#settings-form").requestSubmit()`);
    await waitFor(() => inPage('document.querySelector("#status")?.textContent.includes("Settings saved")'), 'saving changed-file settings');
  };
  const openDeletedFilesPR = async () => {
    await page('Page.navigate', { url: prUrl + '/changes' });
    await waitFor(() => inPanel(`document.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'PR with deleted files');
  };
  const removedPaths = changes.removed.map(entry => entry.path);
  await saveChangedFileSettings(3, false);
  changesMode = 'deleted-files';
  await writeFile(modeFile, 'deleted-files');
  await openDeletedFilesPR();
  const beforeOverLimit = (await modelRequests()).length;
  changesRequests.length = 0;
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelector('.rf-error')?.textContent.includes('This PR changes 5 files; PRiorities analyzes up to 3 (change this in Settings). Use Full diff to review it. No analysis was sent.') && !document.querySelector('.rf-analyze').disabled`), 'over-limit PR stopped during capture');
  assert.equal(changesRequests.some(request => new URL(request.url).pathname.includes('/page_data/')), false, 'An over-limit PR fails before fetching any lazy diffs.');
  assert.equal((await modelRequests()).length, beforeOverLimit);

  await saveChangedFileSettings(5, false);
  await openDeletedFilesPR();
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelector('.rf-overview-title')?.textContent === '0 review decisions' && document.querySelector('.rf-cache-notice').hidden && !document.querySelector('.rf-analyze').disabled`), 'raised limit analyzes deleted files as before');
  const unlistedRequests = (await modelRequests()).slice(beforeOverLimit);
  assert.equal(unlistedRequests.length, 6, 'With the option off, deleted files are classified like any other file.');
  assert.ok(unlistedRequests.at(-1).evidence.files.some(file => file.path === removedPaths[1]) && JSON.stringify(unlistedRequests).includes('DELETED_CONTENT'));
  assert.equal(await inPanel(`document.querySelector('.rf-deleted-files')`), null);

  await saveChangedFileSettings(3, true);
  await page('Page.reload');
  await waitFor(() => inPage('!document.querySelector("#file-limit").disabled'), 'reloaded changed-file settings');
  assert.deepEqual(await inPage('[document.querySelector("#file-limit").value, document.querySelector("#list-deleted-files").checked]'), ['3', true], 'Both changed-file settings survive reopening Settings.');
  await openDeletedFilesPR();
  changesRequests.length = 0;
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelector('.rf-overview-title')?.textContent === '0 review decisions' && document.querySelector('.rf-cache-notice').hidden && !document.querySelector('.rf-analyze').disabled`), 'PR analyzed with deleted files listed');
  assert.deepEqual(changesRequests.filter(request => new URL(request.url).pathname.includes('/page_data/')), [], 'Listed deleted files are neither batch-loaded nor deferred-loaded.');
  const listedRequests = (await modelRequests()).slice(beforeOverLimit + unlistedRequests.length);
  assert.equal(listedRequests.length, 4, 'Only the three changed files are classified before the PR review.');
  assert.ok(!JSON.stringify(listedRequests).includes('DELETED_CONTENT'), 'Deleted contents never reach the model.');
  assert.ok(listedRequests.slice(0, -1).every(request => !JSON.stringify(request.evidence).includes('removed/')), 'Classification receives no deleted-file information.');
  assert.ok(listedRequests.at(-1).evidence.evidenceLimits.some(limit => removedPaths.every(path => limit.includes(`${path} (2 lines)`))), 'The PR review receives deleted paths and line counts.');
  assert.equal(await inPanel(`document.querySelector('.rf-coverage').textContent`), 'Sections cover 3 of 3 files. 2 deleted files listed, not analyzed.');
  assert.deepEqual(await inPanel(`(() => {
    const group = document.querySelector('.rf-deleted-files');
    return { open: group.open, summary: group.querySelector('summary').textContent, items: [...group.querySelectorAll('li')].map(item => item.textContent) };
  })()`), { open: false, summary: '2 deleted files listed, not analyzed · −4 lines', items: removedPaths.map(path => `${path}−2`) }, 'The panel lists deleted files in one collapsed group.');
  assert.deepEqual(await inPanel(`[...document.querySelectorAll('.rf-file-progress-row[data-state=deleted]')].map(row => [row.dataset.path, row.querySelector('.rf-file-state').textContent])`), removedPaths.map(path => [path, 'AI skipped · deleted']));
  assert.ok((await inPanel(`document.querySelector('.rf-analysis-count').textContent`)).includes('2 deleted files listed, not analyzed'));
  const listedCapture = await captureFixture({ fileLimit: 3, listDeletedFiles: true });
  assert.deepEqual(listedCapture.snapshot.files.map(file => file.path), changes.paths.slice(0, 3));
  assert.deepEqual(listedCapture.snapshot.deletedFiles, removedPaths.map(path => ({ path, deletions: 2 })));
  assert.ok(!JSON.stringify(listedCapture).includes('DELETED_CONTENT'), 'Deleted rows and highlighting stay out of the capture.');

  const beforeSavedDeleted = (await modelRequests()).length;
  await page('Page.reload');
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'saved review made with deleted files listed');
  await click('Open saved review');
  await waitFor(() => inPanel(`${reviewReady} && document.querySelector('.rf-deleted-files')`), 'restored review with deleted files listed');
  await saveChangedFileSettings(5, false);
  await openDeletedFilesPR();
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'the earlier review made without listing deleted files');
  await click('Open saved review');
  await waitFor(() => inPanel(reviewReady), 'review saved without listing deleted files survives the other mode');
  assert.equal(await inPanel(`document.querySelector('.rf-coverage').textContent`), 'Sections cover 5 of 5 files.');
  assert.equal((await modelRequests()).length, beforeSavedDeleted, 'Reviews saved with and without listing deleted files reopen separately without model calls.');
  await saveChangedFileSettings(100, false);
  await writeFile(modeFile,'normal');
  changesMode = '';
  const beforeProviderSettings = (await modelRequests()).length;

  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex") && !document.querySelector("#model").disabled'), 'saved settings');
  assert.equal(await inPage('document.querySelector("#model").value'), 'fixture-model');
  await writeFile(modeFile, 'signed-out');
  await inPage('document.querySelector("#check-connection").click()');
  await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent.includes("codex login") && !document.querySelector("#check-connection").disabled'), 'signed-out guidance');
  await writeFile(modeFile, 'normal');
  await inPage('document.querySelector("#check-connection").click()');
  await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex") && !document.querySelector("#model").disabled'), 'reconnecting after login');
  assert.equal((await modelRequests()).length, beforeProviderSettings, 'Connection checks must not invoke a model.');

  await inPage('document.querySelector("#provider").value="claude"; document.querySelector("#provider").dispatchEvent(new Event("change"))');
  await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code") && !document.querySelector("#model").disabled'), 'Claude subscription connection');
  assert.equal(await inPage('document.querySelector("#model").value'), 'claude-fixture-model', 'Claude picks its own catalog default rather than inheriting Codex.');
  assert.equal(await inPage('document.querySelector("#login-command").textContent'), 'claude auth login');
  assert.ok(await inPage('document.querySelector("#provider-privacy").textContent.includes("Anthropic")'));
  await inPage('document.querySelector("#model").value="claude-fixture-model"; document.querySelector("#concurrency").value="4"; document.querySelector("#settings-form").requestSubmit()');
  await waitFor(() => inPage('document.querySelector("#status")?.textContent.includes("Settings saved")'), 'saving Claude selection');
  assert.equal(await inPage('chrome.storage.local.get("classificationConcurrency").then(value=>value.classificationConcurrency)'), 4);
  await inPage('document.querySelector("#provider").value="codex"; document.querySelector("#provider").dispatchEvent(new Event("change"))');
  await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent.includes("Connected to Codex") && !document.querySelector("#model").disabled'), 'preview Codex without switching the saved provider');
  assert.equal(await inPage('document.querySelector("#model").value'), 'fixture-model');
  assert.equal(await inPage('chrome.storage.local.get("reviewProvider").then(value=>value.reviewProvider)'), 'claude');
  await inPage('for(const value of ["claude","codex","claude"]) { document.querySelector("#provider").value=value; document.querySelector("#provider").dispatchEvent(new Event("change")); }');
  await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code") && !document.querySelector("#model").disabled'), 'latest selection wins during rapid switching');
  assert.equal(await inPage('document.querySelector("#model").value'), 'claude-fixture-model');
  await writeFile(modeFile, 'signed-out');
  await inPage('document.querySelector("#check-connection").click()');
  await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent.includes("claude auth login") && !document.querySelector("#model").disabled'), 'Claude signed-out guidance');
  await writeFile(modeFile, 'normal');
  await inPage('document.querySelector("#model").value="__custom__"; document.querySelector("#model").dispatchEvent(new Event("change")); document.querySelector("#custom-model").value="draft-model"; document.querySelector("#check-connection").click()');
  await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code") && !document.querySelector("#model").disabled'), 'Claude reconnected');
  assert.equal(await inPage('document.querySelector("#custom-model").value'), 'draft-model', 'Checking the connection must preserve unsaved model edits.');
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => inPage('document.querySelector("#connection-status")?.textContent.includes("Connected to Claude Code") && !document.querySelector("#model").disabled'), 'restoring saved Claude settings');
  assert.equal(await inPage('document.querySelector("#provider").value'), 'claude');
  assert.equal(await inPage('document.querySelector("#concurrency").value'), '4', 'The saved concurrency survives reopening Settings.');
  await inPage('chrome.storage.local.remove("classificationConcurrency")');
  assert.equal(await inPage('document.querySelector("#model").value'), 'claude-fixture-model');
  await inPage('document.querySelector("#model").value="claude-fixture-older"; document.querySelector("#model").dispatchEvent(new Event("change"))');
  assert.deepEqual(await inPage('Array.from(document.querySelector("#effort").options,option=>option.value)'), ['low','high'], 'Changing models must update supported effort choices.');
  await inPage('document.querySelector("#model").value="claude-fixture-model"; document.querySelector("#model").dispatchEvent(new Event("change"))');
  assert.equal(await inPage('document.querySelector("#effort").value'), 'medium');
  await writeFile('/tmp/review-focus-extension-claude-settings.png', Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  modernMode = false;
  deferredMode = '';
  incomplete = false;
  await page('Page.navigate', { url: prUrl + '/files' });
  await waitFor(() => inPanel(`document.querySelector('.rf-status')?.textContent.includes('with Claude Code')`), 'Claude-ready PR');
  assert.equal((await modelRequests()).length, beforeProviderSettings, 'Selecting Claude and opening a PR must not start analysis.');
  const pageTitle = 'Apply font variation settings · Pull Request #200000';
  await inPage(`document.title = ${JSON.stringify(pageTitle)}`);
  await inAgent(`Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })`);
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelector('.rf-overview-title')?.textContent === '1 review decision' && !document.querySelector('.rf-analyze')?.disabled`), 'Claude classification followed by the PR review');
  await waitFor(() => inPage(`document.title === ${JSON.stringify(`✓ Ready · ${pageTitle}`)}`), 'a review finished in a hidden tab marks the tab title');
  await inPage(`document.title = 'Changed by GitHub navigation'`);
  await waitFor(() => inPage(`document.title === '✓ Ready · Changed by GitHub navigation'`), 'the ready mark following GitHub’s own title change once');
  await inAgent('delete document.hidden');
  await inPage(`document.dispatchEvent(new Event('visibilitychange'))`);
  await waitFor(() => inPage(`document.title === 'Changed by GitHub navigation'`), 'the ready mark cleared when the tab is visible');
  await inPage(`document.title = ${JSON.stringify(pageTitle)}`);
  const claudeRequests = (await modelRequests()).slice(beforeProviderSettings);
  assert.equal(claudeRequests.length, 2);
  const afterClaude = (await modelRequests()).length;
  assert.ok(claudeRequests.every(request => request.provider === 'claude' && request.args[request.args.indexOf('--model')+1] === 'claude-fixture-model' && request.args[request.args.indexOf('--effort')+1] === 'medium'));
  assert.equal(claudeRequests[0].evidence.classifications, undefined);
  assert.deepEqual(claudeRequests[1].evidence.classifications, classifications);
  assert.equal(await inPanel("document.querySelector('.rf-result').checkVisibility()"), true);
  await page('Page.reload');
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'Claude review saved for the same input');
  await click('Open saved review');
  await waitFor(() => inPanel(reviewReady), 'Claude cached review restored');
  assert.equal((await modelRequests()).length, afterClaude);
  const { targetId: modelSettingsTarget } = await send('Target.createTarget', { url: `chrome-extension://${extensionId}/options.html` });
  const { sessionId: modelSettingsSession } = await send('Target.attachToTarget', { targetId: modelSettingsTarget, flatten: true });
  await waitFor(() => inPage('document.querySelector("#provider")?.value === "claude" && !document.querySelector("#model").disabled', modelSettingsSession), 'model settings in a separate tab');
  async function saveModelChoice(provider, model, effort) {
    await send('Page.bringToFront', {}, modelSettingsSession);
    await inPage(`(() => {
      const provider = document.querySelector('#provider');
      if (provider.value === ${JSON.stringify(provider)}) return;
      provider.value = ${JSON.stringify(provider)};
      provider.dispatchEvent(new Event('change'));
    })()`, modelSettingsSession);
    await waitFor(() => inPage('!document.querySelector("#model").disabled', modelSettingsSession), 'selected provider model catalog');
    await inPage(`(() => {
      const picker = document.querySelector('#model');
      picker.value = Array.from(picker.options).some(option => option.value === ${JSON.stringify(model)}) ? ${JSON.stringify(model)} : '__custom__';
      picker.dispatchEvent(new Event('change'));
      if (picker.value === '__custom__') document.querySelector('#custom-model').value = ${JSON.stringify(model)};
      document.querySelector('#effort').value = ${JSON.stringify(effort)};
      document.querySelector('#status').textContent = '';
      document.querySelector('#settings-form').requestSubmit();
    })()`, modelSettingsSession);
    await waitFor(() => inPage('document.querySelector("#status").textContent.includes("Settings saved") && !document.querySelector("#save").disabled', modelSettingsSession), 'model and effort saved');
    await page('Page.bringToFront');
    await inPanel("window.dispatchEvent(new Event('focus'))");
  }
  await inPanel(`window.reviewBeforeSettings = document.querySelector('.rf-panel'); window.explanationBeforeSettings = document.querySelector('.rf-change-explanation')`);
  const originalRunLabel = await inPanel(`document.querySelector('.rf-run-settings').textContent`);
  const originalHiddenLines = await inPanel(`document.querySelectorAll('.rf-topic:not([open])').length`);
  for (const choice of [
    { provider:'claude', model:'claude-custom-older', effort:'medium' },
    { provider:'claude', model:'claude-fixture-model', effort:'high' },
    { provider:'codex', model:'claude-fixture-model', effort:'medium' }
  ]) {
    await saveModelChoice(choice.provider, choice.model, choice.effort);
    await waitFor(() => inPanel(`document.querySelector('.rf-actions > .rf-analyze')?.textContent === 'Analyze PR' && document.querySelector('.rf-analyze').checkVisibility()`), 'Analyze PR promoted without GitHub navigation after changing analysis settings');
    const status = await inPanel(`({text:document.querySelector('.rf-status').textContent, visible:!document.querySelector('.rf-status').classList.contains('rf-visually-hidden') && document.querySelector('.rf-status').checkVisibility()})`);
    const providerLabel = choice.provider === 'claude' ? 'Claude Code' : 'Codex';
    assert.ok(status.visible && status.text.includes('Settings changed') && status.text.includes(providerLabel) && status.text.includes(choice.model) && status.text.includes(choice.effort), 'The visible notice identifies the settings for the next analysis.');
    assert.equal(await inPanel(`document.querySelector('.rf-run-settings').textContent`), originalRunLabel, 'Existing results retain their original provider, model and effort label.');
    assert.ok(await inPanel(`window.reviewBeforeSettings === document.querySelector('.rf-panel') && window.explanationBeforeSettings.isConnected`), 'Returning from Settings preserves the mounted PR and its existing explanations.');
    assert.equal(await inPanel(`document.querySelectorAll('.rf-topic:not([open])').length`), originalHiddenLines, 'Changing future settings must not alter current folding.');
    assert.equal((await modelRequests()).length, afterClaude, 'Saving settings and returning to the PR must not invoke a model.');
    await saveModelChoice('claude', 'claude-fixture-model', 'medium');
    await waitFor(() => inPanel(`document.querySelector('.rf-menu .rf-analyze')?.textContent === 'Run fresh review' && !document.querySelector('.rf-status').textContent.includes('Settings changed')`), 'returning to the review settings removes the mismatch action');
  }
  await saveModelChoice('claude', 'claude-custom-older', 'high');
  await waitFor(() => inPanel(`document.querySelector('.rf-actions > .rf-analyze')?.textContent === 'Analyze PR'`), 'custom model analysis ready in the existing PR document');
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelector('.rf-run-settings').textContent.includes('claude-custom-older · Effort: high') && !document.querySelector('.rf-analyze').disabled && document.querySelector('.rf-overview-title')?.textContent === '1 review decision'`), 'explicit analysis uses the custom model and effort');
  const changedModelRequests = (await modelRequests()).slice(afterClaude);
  assert.equal(changedModelRequests.length, 2);
  assert.ok(changedModelRequests.every(request => request.provider === 'claude' && request.args[request.args.indexOf('--model')+1] === 'claude-custom-older' && request.args[request.args.indexOf('--effort')+1] === 'high'));
  await saveModelChoice('claude', 'claude-fixture-model', 'medium');
  await page('Page.reload');
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'original saved review remains available after changing model');
  await click('Open saved review');
  await waitFor(() => inPanel(reviewReady), 'original Claude model review restored');
  const afterModelSettings = afterClaude + changedModelRequests.length;
  assert.equal((await modelRequests()).length, afterModelSettings, 'Returning to the original model reuses its saved review.');
  descriptionSuffix = ' Additional acceptance criteria added without a commit.';
  await page('Page.reload');
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'cached commit pair available before verifying changed intent');
  await click('Open saved review');
  await waitFor(() => inPanel(`document.querySelector('.rf-status')?.textContent.includes('does not match')`), 'changed description invalidates cached assessment');
  assert.equal((await modelRequests()).length, afterModelSettings, 'A stale saved-review action must not silently start a paid analysis.');
  assert.equal(await inPage('document.querySelectorAll(".review-focus-native-hidden").length'), 0);
  assert.equal(await inPanel(`document.querySelector('.rf-analyze').textContent`), 'Run fresh review');
  await click('Run fresh review');
  await waitFor(() => inPanel(`document.querySelector('.rf-overview-title')?.textContent === '1 review decision' && !document.querySelector('.rf-analyze')?.disabled`), 'explicit fresh analysis after changed intent');
  const afterChangedIntent = (await modelRequests()).length;
  assert.equal(afterChangedIntent - afterModelSettings, 2);

  const lastSnapshot = (await captureFixture()).snapshot;
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => inPage('!document.querySelector("#cache-limit").disabled'), 'cache ready for invalid stored-result regression');
  const invalidRecord = await inPage(`(async () => {
    const cache = await import('./review-cache.js');
    const identity = await cache.reviewCacheKey(${JSON.stringify(lastSnapshot)},{provider:'claude',model:'claude-fixture-model',effort:'medium',listDeletedFiles:false});
    const original = await cache.readReview(identity.key);
    if (!original) throw new Error('Expected a saved review for this exact capture.');
    await cache.saveReview(identity,{analysis:original.analysis,paths:[]});
    return {identity,original};
  })()`);
  await page('Page.navigate', { url: prUrl + '/files' });
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'invalid saved result offered for validation');
  await click('Open saved review');
  await waitFor(() => inPanel(`document.querySelector('.rf-error')?.textContent.includes('saved') && document.querySelector('.rf-status').textContent === 'The saved review could not be opened.'`), 'invalid saved result rejected as an error without deletion');
  assert.equal(await inPanel(`document.body.textContent.includes('does not match')`), false, 'Invalid saved data must not be described as a context mismatch.');
  assert.equal(await inPanel(`document.querySelector('.rf-analyze').textContent`), 'Run fresh review');
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
  await inPanel("window.dispatchEvent(new Event('focus'))");
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze').textContent === 'Open saved review'`), 'a replaced saved result with the same fingerprint and a new save time is offered again');
  await click('Open saved review');
  await waitFor(() => inPanel(reviewReady), 'replacement saved result restored');
  assert.equal((await modelRequests()).length, afterChangedIntent);
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => inPage('!document.querySelector("#cache-limit").disabled && document.querySelector("#cache-usage").textContent.includes("MB used")'), 'cache settings and usage');
  assert.equal(await inPage('document.querySelector("#cache-limit").value'), '100');
  await inPage(`(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = message => {
      if (message.type !== 'clear-cache') return original(message);
      chrome.runtime.sendMessage = original;
      return Promise.resolve({error:'Temporary cache failure'});
    };
    document.querySelector('#clear-cache').click();
  })()`);
  await waitFor(() => inPage('document.querySelector("#cache-status").textContent === "Temporary cache failure"'), 'cache request failure shown');
  assert.equal(await inPage('document.querySelector("#clear-cache").disabled'), false, 'A failed cache request must leave Clear available to retry.');
  await inPage('document.querySelector("#clear-cache").click()');
  await waitFor(() => inPage('document.querySelector("#cache-status").textContent.includes("Saved reviews cleared")'), 'clearing saved reviews');
  await inPage('document.querySelector("#cache-limit").value="1"; document.querySelector("#cache-form").requestSubmit()');
  await waitFor(() => inPage('document.querySelector("#cache-status").textContent === "Cache limit saved."'), 'custom cache size');
  const cacheChecks = await inPage(`(async () => {
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
    const tick = {topicId:'section',path:'file.js'};
    const otherTick = {topicId:'other-section',path:'file.js'};
    const savedTicks = async key => (await cache.readReview(key)).ticks;
    const opened = await cache.saveReview({key:'ticked',lookup:'ticks'},{text:'Ticked review'});
    await Promise.all([cache.saveSectionTicks('ticked',opened.savedAt,tick,true), cache.saveSectionTicks('ticked',opened.savedAt,otherTick,true)]);
    const ticks = {saved:await savedTicks('ticked')};
    await cache.saveSectionTicks('ticked',opened.savedAt,otherTick,false);
    ticks.unticked = await savedTicks('ticked');
    const rerun = await cache.saveReview({key:'ticked',lookup:'ticks'},{text:'Rerun keeping its ticks'},undefined,[otherTick]);
    ticks.carried = await savedTicks('ticked');
    await cache.saveSectionTicks('ticked',opened.savedAt,tick,true);
    ticks.staleSession = await savedTicks('ticked');
    await cache.saveSectionTicks('ticked',rerun.savedAt,tick,true);
    ticks.currentSession = await savedTicks('ticked');
    const fresh = await cache.saveReview({key:'ticked',lookup:'ticks'},{text:'Fresh review with the same fingerprint'});
    ticks.sameKey = await savedTicks('ticked');
    await cache.saveSectionTicks('ticked',rerun.savedAt,tick,true);
    ticks.replacedSession = await savedTicks('ticked');
    const replacing = await cache.saveReview({key:'replacement',lookup:'ticks'},{text:'Fresh review of the same lookup'});
    await cache.saveSectionTicks('ticked',fresh.savedAt,tick,true);
    ticks.replaced = {review:await cache.readReview('ticked'),count:(await cache.cacheInfo()).count};
    await cache.saveSectionTicks('replacement',replacing.savedAt,tick,true);
    await cache.clearCache();
    await cache.saveReview({key:'replacement',lookup:'ticks'},{text:'Saved again after clearing'});
    ticks.cleared = (await cache.readReview('replacement')).ticks;
    await cache.clearCache();
    const settings = {provider:'claude',model:'fixture'};
    const input = {url:${JSON.stringify(prUrl)},baseSha:${JSON.stringify(baseSha)},headSha:${JSON.stringify(headSha)},description:'first',context:[]};
    const original = await cache.reviewCacheKey(input,settings);
    const earlierLookup = JSON.parse(original.lookup);
    earlierLookup[0] = 4;
    await cache.saveReview({key:'folding-review',lookup:JSON.stringify(earlierLookup)},{text:'Consequence-ordered folding assessment'});
    const earlierReview = {offered:(await cache.peekReview(original.lookup)).available,retained:Boolean(await cache.readReview('folding-review'))};
    await cache.clearCache();
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
    const highlightKeys = new Set((await Promise.all([${JSON.stringify(completeChanges.snapshot)},${JSON.stringify(plainChanges.snapshot)}].map(snapshot=>cache.reviewCacheKey(snapshot,settings)))).map(entry=>entry.key)).size;
    return {cancellation,ticks,earlierReview,keys:new Set([original,...variants].map(entry=>entry.key)).size,highlightKeys,lru,tooLarge,parallel,shrunk,cleared:await cache.cacheInfo()};
  })()`);
  assert.equal(cacheChecks.cancellation.preAborted, true);
  assert.equal(cacheChecks.cancellation.abortedWrite, true, 'Cancelling an uncommitted IndexedDB write must abort the transaction.');
  assert.equal(cacheChecks.cancellation.previous.text, 'Paid review', 'Aborting a replacement must roll back deletion of the earlier review.');
  assert.equal(cacheChecks.cancellation.replacement, null);
  assert.equal(cacheChecks.cancellation.unstarted, null);
  const [savedTick, otherSavedTick] = [{topicId:'section',path:'file.js'}, {topicId:'other-section',path:'file.js'}];
  assert.deepEqual(cacheChecks.ticks.saved, [savedTick, otherSavedTick], 'Two sessions ticking different sections of one review keep both ticks.');
  assert.deepEqual(cacheChecks.ticks.unticked, [savedTick], 'Unticking removes only that tick.');
  assert.deepEqual(cacheChecks.ticks.carried, [otherSavedTick], 'A rerun saves the ticks it carries with its new review.');
  assert.deepEqual(cacheChecks.ticks.staleSession, [otherSavedTick], 'A session that opened an earlier save of the same key cannot change the newer review’s ticks.');
  assert.deepEqual(cacheChecks.ticks.currentSession, [otherSavedTick, savedTick]);
  assert.deepEqual([cacheChecks.ticks.sameKey, cacheChecks.ticks.replacedSession], [[], []], 'A fresh review under the same key starts without ticks, and the replaced session’s ticks stay out of it.');
  assert.deepEqual([cacheChecks.ticks.replaced, cacheChecks.ticks.cleared], [{review:null,count:1}, []], 'Ticks are deleted with their review when a fresh review of the same lookup replaces it or the cache is cleared; a tick never recreates a deleted review.');
  assert.deepEqual(cacheChecks.earlierReview, {offered:false,retained:true}, 'Reviews from the old folding prompt require fresh analysis without deleting their records.');
  assert.equal(cacheChecks.keys, 9, 'Commits, intent, source context, provider, model, effort and review preferences each change the cache key.');
  assert.equal(cacheChecks.highlightKeys, 1, 'Captures with and without highlighting share one saved-review key.');
  assert.deepEqual([cacheChecks.lru.a, cacheChecks.lru.b, cacheChecks.lru.c], [true, false, true], 'Reading A keeps it while the older B is evicted.');
  assert.equal(cacheChecks.lru.info.count, 2);
  assert.ok(cacheChecks.lru.info.usedBytes <= 1024 * 1024);
  assert.equal(cacheChecks.tooLarge.saved, false);
  assert.ok(cacheChecks.parallel.usedBytes <= 2 * 1024 * 1024, 'Concurrent saves must respect one shared budget.');
  assert.ok(cacheChecks.shrunk.usedBytes <= 1024 * 1024 && cacheChecks.shrunk.count < cacheChecks.parallel.count);
  assert.deepEqual(cacheChecks.cleared, {limitMB:1,usedBytes:0,count:0});
  await page('Page.reload');
  await waitFor(() => inPage('!document.querySelector("#cache-limit").disabled'), 'saved cache limit restored');
  assert.equal(await inPage('document.querySelector("#cache-limit").value'), '1');
  assert.equal(await inPage('document.querySelector("#clear-cache").disabled'), true);
  await waitFor(() => inPage('!document.querySelector("#save").disabled'), 'provider settings also ready for screenshot');
  await inPage('document.querySelector("#cache-form").scrollIntoView({block:"center"})');
  await writeFile('/tmp/review-focus-cache-settings.png', Buffer.from((await page('Page.captureScreenshot', {format:'png'})).data,'base64'));
  const worker = workers.at(-1);
  await send('Runtime.evaluate', {expression:`globalThis.originalInterval = globalThis.setInterval; globalThis.setInterval = (callback,delay,...args) => originalInterval(callback,delay === 20000 ? 40 : delay,...args);`}, worker);
  for (const state of ['failed', 'excluded']) {
    await writeFile(modeFile, state === 'failed' ? 'analysis-failed' : 'normal');
    changesMode = state === 'excluded' ? 'all-generated' : '';
    await page('Page.navigate', {url:prUrl + (changesMode ? '/changes' : '/files')});
    await waitFor(() => inPanel(`document.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'idle review fixture ready');
    await inAgent(`(() => {
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
              window.fixtureActionAcknowledged = true;
            }
          });
        };
        return connection;
      };
    })()`);
    await click('Analyze PR');
    await waitFor(() => inPanel(`document.querySelector('.rf-file-progress-row[data-state="${state}"]') && !document.querySelector('.rf-analyze').disabled`), 'review idle with an available file action');
    const action = state === 'failed' ? 'Retry file' : 'Review anyway';
    if (state === 'excluded') {
      assert.ok(await inPanel(`document.querySelector('.rf-progress-toggle').textContent.toLowerCase().includes('skipped')`), 'A generated-only PR must not claim that files were analyzed.');
      assert.equal(await inPanel(`document.querySelectorAll('.rf-topic').length`), 0);
      assert.equal(await inPage('document.querySelectorAll(".review-focus-native-hidden").length'), 0, 'A fully excluded PR keeps GitHub’s diff available before any file is included.');
    }
    await waitFor(() => inPanel(`document.querySelector('.rf-reviewed-toggle input')?.getAttribute('aria-disabled') === 'false'`), 'native review control restored before measuring idle heartbeats');
    const idle = await inPanel(`(async () => {
      const root = document;
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
    assert.equal(await inPanel(`document.querySelectorAll('.rf-file-progress-row').length`), state === 'failed' ? 1 : 0, 'Only failed or cancelled AI jobs belong in the retry filter.');
    await click('All files');
    const actionPath = await inPanel(`document.querySelector('.rf-file-progress-row[data-state="${state}"]').dataset.path`);
    await inAgent(`window.fixtureAwaitAcknowledgement = ${JSON.stringify(actionPath)}`);
    await inAgent(`window.fixtureReviewMessage({type:'progress',stage:'checking',phase:'writing',startedAt:Date.now()-125000,kinds:[['behavior',5]]})`);
    await waitFor(() => inPanel("document.querySelectorAll('.rf-steps li')[1]?.title === 'Labelled blocks: 5 behavior'"), 'labelled blocks relayed to panel');
    assert.match(await inPanel("document.querySelector('.rf-elapsed').textContent"), /^2:0[5-9]$/);
    await inAgent(`window.fixtureReviewMessage({type:'progress',stage:'checking',phase:'checking',startedAt:Date.now(),kinds:[['behavior',5]]})`);
    await waitFor(() => inPanel("document.querySelector('.rf-steps li[aria-current=step]')?.firstChild.textContent === 'Check'"), 'checking phase relayed to panel');
    assert.equal(await inPanel(`document.querySelector('.rf-elapsed').textContent`), '0:00', 'Check measures time from its own phase start.');
    const immediateFeedback = await inPanel(`(() => {
      const root = document;
      [...root.querySelectorAll('.rf-file-progress-row button')].find(button => button.textContent === ${JSON.stringify(action)}).click();
      const status = root.querySelector('.rf-status');
      return {text:status.textContent, visible:!status.classList.contains('rf-visually-hidden') && status.checkVisibility(), role:status.getAttribute('role')};
    })()`);
    const actionMessage = `${state === 'failed' ? 'Retrying' : 'Analyzing'} ${actionPath}…`;
    assert.deepEqual(immediateFeedback, {text:actionMessage,visible:true,role:'status'}, 'File actions must provide visible accessible feedback synchronously, before worker acknowledgement.');
    assert.equal(await inPanel(`document.querySelectorAll('.rf-steps li')[1].title`), '', 'File retries and Review anyway clear the previous review’s labelled blocks before worker acknowledgement.');
    await inAgent(`window.fixtureReviewMessage({type:'progress',stage:'files',message:'An unrelated progress update.'})`);
    await inPage('new Promise(resolve => setTimeout(resolve, 200))');
    assert.equal(await inPanel(`document.querySelector('.rf-status').textContent`), actionMessage, 'Unrelated progress must not erase pending file-action feedback.');
    if (state === 'excluded') await writeFile(modeFile, 'generated-review');
    await inAgent('window.fixturePendingActions.splice(0).forEach(send => send())');
    await waitFor(async () => await inAgent('window.fixtureActionAcknowledged === true') && await inPanel("document.querySelector('.rf-status').textContent !== " + JSON.stringify(actionMessage)), 'the requested file acknowledgement replaces pending feedback');
    await waitFor(() => inPanel(`!document.querySelector('.rf-analyze').disabled`), 'the requested file finishes or reports failure');
    if (state === 'failed') {
      await click('Retry file');
      const stopping = await inPanel(`(() => {
        const root = document;
        [...root.querySelectorAll('button')].find(button => button.textContent === 'Cancel').click();
        const status = root.querySelector('.rf-status');
        return {text:status.textContent,visible:!status.classList.contains('rf-visually-hidden') && status.checkVisibility(),role:status.getAttribute('role')};
      })()`);
      assert.deepEqual(stopping,{text:'Stopping active analyses…',visible:true,role:'status'}, 'Cancel must confirm the request synchronously before the worker stops.');
      await inAgent(`window.fixtureReviewMessage({type:'file-progress',path:${JSON.stringify(actionPath)},state:'classifying',message:'A file update in flight.'})`);
      await inPage('new Promise(resolve => setTimeout(resolve, 200))');
      assert.equal(await inPanel(`document.querySelector('.rf-status').textContent`), 'Stopping active analyses…', 'File progress in flight must not replace the cancellation confirmation.');
      await inPanel("document.querySelector('.rf-toolbar').scrollIntoView({block:'start'})");
      await writeFile('/tmp/review-focus-extension-cancelling.png', Buffer.from((await panelPage('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
      await inAgent('window.fixturePendingActions.splice(0).forEach(send => send())');
      await waitFor(() => inPanel(`!document.querySelector('.rf-analyze').disabled && document.querySelector('.rf-status').textContent.includes('Analysis cancelled')`), 'worker cancellation replaces pending feedback with the settled state');
      assert.ok(await inPanel(`document.querySelector('.rf-progress-toggle').textContent.includes('Cancelled')`), 'The toolbar distinguishes a cancelled analysis from AI ready.');
    }
    await inAgent(`new Promise(resolve => {
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
  // Waiting-file states need fewer classification slots than the five fixture files.
  await send('Runtime.evaluate', {expression:'chrome.storage.local.set({classificationConcurrency:3, analysisDurations:[1, 2, 3].map(seconds => ({provider:"claude", model:"claude-fixture-model", effort:"medium", seconds:seconds * 20, lines:10}))})', awaitPromise:true}, worker);
  changesMode = 'many-decisions';
  await writeFile(modeFile, 'many-decisions');
  await writeFile(uxGate, 'waiting');
  const beforeMany = (await modelRequests()).length;
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => inPanel(`document.querySelector('.rf-status')?.textContent.includes('Ready to analyze')`), 'multiple review decisions fixture ready');
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelector('.rf-file-progress-row[data-state=classified]') && document.querySelector('.rf-analyze').disabled`), 'first file classified while other files run');
  assert.equal(await inPanel(`document.querySelector('.rf-file-progress').hidden`), true, 'Live analysis does not open the file list automatically.');
  await waitFor(() => inPanel(`document.querySelector('.rf-file-progress-row[data-state=queued]') && document.querySelectorAll('.rf-file-progress-row[data-state=classifying]').length === 3`), 'classified, classifying and waiting files at the same time');
  const beforeNavigation = (await modelRequests()).length;
  await page('Page.navigate', {url:prUrl + '/checks'});
  await waitFor(() => inAgent('location.pathname.endsWith("/checks")').catch(() => false), 'Checks document with the extension loaded');
  assert.equal(await inPage('Boolean(document.querySelector("#review-focus-extension, .review-focus-file-progress, .review-focus-file-status"))'), false, 'A newly loaded Checks page must have no review UI.');
  await page('Page.navigate', {url:prUrl + '/changes'});
  await waitFor(() => inPanel(`document.querySelector('.rf-file-progress-row[data-state=classified]') && document.querySelector('.rf-file-progress-row[data-state=classifying]') && document.querySelector('.rf-analyze').disabled`), 'active file analysis reconnected after Checks');
  assert.equal((await modelRequests()).length, beforeNavigation, 'Reconnecting must not rerun completed file passes.');
  await page('Page.reload');
  await waitFor(() => inPanel(`document.querySelector('.rf-file-progress-row[data-state=classified]') && document.querySelector('.rf-file-progress-row[data-state=classifying]') && document.querySelector('.rf-analyze').disabled`), 'active file analysis reconnected after reload');
  assert.equal((await modelRequests()).length, beforeNavigation, 'Reloading must reuse the same file jobs.');
  await openFiles();
  const visibleStates = await inPanel(`Array.from(document.querySelectorAll('.rf-file-progress-row'), row => ({state:row.dataset.state, label:row.querySelector('.rf-file-state').textContent, visible:row.checkVisibility()}))`);
  assert.ok(visibleStates.some(row => row.state === 'classified' && row.label.startsWith('AI classified') && row.visible));
  assert.ok(visibleStates.some(row => row.state === 'classifying' && /^AI classifying(?: · 1\/1 blocks)?$/.test(row.label) && row.visible));
  assert.ok(visibleStates.some(row => row.state === 'queued' && row.label === 'AI waiting' && row.visible));
  await inPage(`(() => {
    document.head.insertAdjacentHTML('beforeend', ${JSON.stringify(fixtureStyle)});
  })()`);
  await writeFile('/tmp/review-focus-extension-progress.png', Buffer.from((await panelPage('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await inPanel(`document.querySelector('.rf-progress-toggle').click()`);
  assert.ok(await inPanel(`document.querySelector('.rf-status').textContent.includes('1 of 5 files classified')`), 'Live progress describes classified files without duplicate visible status.');
  const progressSteps = `Array.from(document.querySelectorAll('.rf-steps li'), step => [step.firstChild.textContent, step.dataset.state])`;
  assert.deepEqual(await inPanel(progressSteps), [['Copy', 'done'], ['Label 1/5', 'current'], ['Write review', 'pending'], ['Check', 'pending']], 'The step tracker marks labelling as current.');
  await waitFor(() => inPanel(`document.querySelector('.rf-progress-detail').textContent === '3 labelling · 1 waiting · 4/5 blocks'`), 'running, waiting and labelled totals in the progress line');
  assert.deepEqual(await inPanel(`Array.from(document.querySelectorAll('.rf-file-progress-row[data-state=classifying] .rf-file-state'), label => label.textContent)`), Array(3).fill('AI classifying · 1/1 blocks'), 'Each running file shows its own labelled blocks in its row.');
  assert.ok(await inPanel("document.querySelector('.rf-progress-panel').checkVisibility() && document.querySelector('.rf-steps').checkVisibility()"), 'The panel displays the current analysis steps.');
  assert.deepEqual(await inPanel(`[document.querySelector('.rf-progress-bar').value, document.querySelector('.rf-progress-bar').max]`), [4, 5], 'The bar counts labelled blocks, including those in files still running.');
  await writeFile(uxGate, 'continue');
  const sectionProgress = `2/5 blocks · Section 5: Check ${changes.paths[4]}`;
  await waitFor(() => inPanel(`document.querySelector('.rf-progress-detail').textContent === ${JSON.stringify(sectionProgress)}`), 'section titles reported while the PR review is written');
  assert.deepEqual(await inPanel(progressSteps), [['Copy', 'done'], ['Label 5/5', 'done'], ['Write review', 'current'], ['Check', 'pending']]);
  assert.equal(await inPanel(`document.querySelector('.rf-progress-detail').childElementCount`), 0, 'Model text is rendered as text only.');
  assert.equal(await inPanel(`document.querySelector('.rf-progress-detail').title`), ['2/5 blocks labelled in the answer', ...changes.paths.slice(0, 5).map((path, index) => `${index + 1}. Check ${path}`)].join('\n'), 'Every section written so far stays available in full.');
  assert.equal(await inPanel(`document.querySelectorAll('.rf-steps li')[1].title`), 'Labelled blocks: 5 behavior', 'The labelling summary stays in the step tooltip.');
  assert.match(await inPanel(`document.querySelector('.rf-estimate')?.textContent ?? ''`), /^ \/ ~\d+ (?:s|min)$/, 'Three earlier reviews with this model ground an estimate.');
  assert.match(await inPanel(`document.querySelectorAll('.rf-steps li')[2].title`), /^Usually about \d+ (?:s|min) with these settings/);
  await inPanel('window.realNow = Date.now; Date.now = () => window.realNow() + 125000');
  await waitFor(() => inPanel(`/^2:[01]\\d$/.test(document.querySelector('.rf-elapsed').textContent)`), 'the step timer counting from the background start time');
  await inPanel('Date.now = window.realNow');
  assert.equal(await inPanel(`document.querySelector('.rf-file-progress').hidden`), true, 'Progress updates must not reopen a list the user collapsed.');
  assert.equal(await inPanel('document.querySelectorAll(".rf-file-progress-row[data-state=classified]").length'), 5, 'The panel includes classified files whose native diffs have not mounted.');
  assert.equal(await inPage('document.querySelectorAll(".review-focus-native-hidden").length'), 0, 'Native code stays available before the whole-PR review decisions arrive.');
  assert.equal(await inPanel("document.querySelectorAll('.rf-topic').length"), 0, 'Classified files show progress only, without review decisions.');
  await page('Page.navigate', {url:prUrl + '/checks'});
  await waitFor(() => inAgent('location.pathname.endsWith("/checks")').catch(() => false), 'Checks while the PR review runs');
  await page('Page.navigate', {url:prUrl + '/changes'});
  await waitFor(() => inPanel(`document.querySelector('.rf-steps li[aria-current=step]')?.firstChild.textContent === 'Write review' && document.querySelector('.rf-progress-detail').textContent === ${JSON.stringify(sectionProgress)} && document.querySelectorAll('.rf-file-progress-row[data-state=classified]').length === 5`), 'the same PR review reconnected with classified files');
  assert.equal(await inPage('document.querySelectorAll(".review-focus-native-hidden").length'), 0, 'Reconnecting before the PR review finishes must leave native code available.');
  await page('Page.navigate', {url:prUrl});
  await waitFor(() => inAgent('location.pathname === new URL(' + JSON.stringify(prUrl) + ').pathname').catch(() => false), 'Conversation while analysis remains in the background');
  assert.equal(await inPage('Boolean(document.querySelector("#review-focus-extension"))'), false);
  await writeFile(uxGate, 'finish');
  await waitFor(async () => (await modelRequests()).length - beforeMany === 6, 'the PR review completes while away from the diff');
  await page('Page.navigate', {url:prUrl + '/changes'});
  await waitFor(() => inPanel(`document.querySelector('.rf-overview-title')?.textContent === '5 review decisions' && !document.querySelector('.rf-analyze').disabled`), 'all five final decisions restored on return');
  assert.equal((await modelRequests()).length - beforeMany, 6);
  assert.equal(await inPanel(`document.querySelectorAll('.rf-topic').length`), 5, 'The overview includes all sections, including unloaded native files.');
  assert.equal(await inPanel("document.querySelector('.rf-result').checkVisibility()"), true, 'A completed review opens in the reconnected panel.');
  const beforeExpansion = (await modelRequests()).length;
  for (const expanded of [true, false, true, false]) {
    await inPage(`window.fileBeforeExpansion = document.querySelector('section[id^="diff-"][role="region"]'); window.fileBeforeExpansion.querySelector('.js-expand-all-difflines-button').click()`);
    await waitFor(() => inPage(`!window.fileBeforeExpansion.isConnected && document.querySelectorAll('[data-fixture-context]').length === ${expanded ? 201 : 0}`), 'native context expand/collapse');
    assert.equal(await inPage('[...document.querySelectorAll("[data-fixture-context]")].every(row => row.checkVisibility())'), true);
    assert.equal(await inPanel("document.querySelectorAll('.rf-topic').length"), 5);
  }
  assert.equal((await modelRequests()).length, beforeExpansion);
  await inPanel(`document.querySelectorAll('.rf-topic')[4].open = true; document.querySelectorAll('.rf-topic')[4].querySelector('.rf-code-quote > .rf-ref').click()`);
  await waitFor(() => inPanel("document.querySelector('.rf-navigation-notice').textContent.includes('has not loaded')"), 'unloaded native file guidance');
  assert.ok(await inPanel(`document.querySelector('.rf-navigation-notice a').href.includes('/blob/${headSha}/')`), 'The source fallback is pinned to the captured commit.');
  const beforeHumanReview = (await modelRequests()).length;
  const firstModernFile = `document.querySelector('section[id^="diff-"][role="region"]')`;
  const firstModernRow = `document.querySelector('.rf-file-progress-row[data-path="tests/change-1.ts"]')`;
  await openFiles();
  assert.ok(await inPanel(`(document.querySelector('.rf-progress-toggle').textContent + document.querySelector('.rf-progress-toggle').title).includes('2 unknown')`), 'Unloaded native review statuses must be identified in the summary.');
  assert.equal(await inPanel(`document.querySelectorAll('.rf-file-list .rf-reviewed-toggle input:indeterminate:disabled').length`), 2);
  assert.equal(await inPage('window.fixtureViewedClicks'), 0, 'Parallel AI completion never marks the native files viewed.');
  await click('AI needs retry');
  assert.equal(await inPanel(`document.querySelectorAll('.rf-file-progress-row').length`), 0, 'Important decisions must not appear in the AI retry filter after successful analysis.');
  await click('Reviewed');
  assert.equal(await inPanel(`document.querySelectorAll('.rf-file-progress-row').length`), 0);
  await click('To review');
  assert.equal(await inPanel(`document.querySelectorAll('.rf-file-progress-row').length`), 5);
  await inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').focus(); ${firstModernRow}.querySelector('.rf-reviewed-toggle input').click()`);
  await waitFor(async () => await inPanel(`document.querySelectorAll('.rf-file-progress-row').length === 4`) && await inPage(`${firstModernFile}.querySelector('button[aria-pressed]').getAttribute('aria-pressed') === 'true'`), 'marking a file removes it from the to-review list');
  assert.equal(await inPanel(`document.activeElement.textContent`), 'To review', 'When the reviewed row leaves the active filter, focus returns to that filter.');
  await click('Reviewed');
  assert.equal(await inPanel(`document.querySelectorAll('.rf-file-progress-row').length`), 1);
  await inPage(`window.collapsedDiffTable = ${firstModernFile}.querySelector('table'); window.collapsedDiffTable.remove()`);
  await waitFor(() => inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').checked`), 'reviewed modern file remains compact when its native diff collapses');
  await inPage(`${firstModernFile}.querySelector('button[aria-pressed]').click()`);
  await waitFor(() => inPanel(`document.querySelectorAll('.rf-file-progress-row').length === 0`), 'native modern uncheck reflected in file and filter');
  await inPage(`${firstModernFile}.append(window.collapsedDiffTable)`);
  await click('All files');
  await inPage(`${firstModernFile}.querySelector('button[aria-pressed]').setAttribute('aria-disabled', 'true')`);
  await waitFor(() => inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').getAttribute('aria-disabled') === 'true'`), 'modern aria-disabled control respected');
  await inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').click()`);
  assert.equal(await inPage('window.fixtureViewedClicks'), 2);
  await inPage(`${firstModernFile}.querySelector('button[aria-pressed]').removeAttribute('aria-disabled')`);
  await waitFor(() => inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').getAttribute('aria-disabled') === 'false'`), 'modern review control active again');
  await inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').click()`);
  await waitFor(async () => await inPanel(`document.querySelector('.rf-reviewed-toggle[data-path="tests/change-1.ts"]').dataset.reviewed === 'true'`) && await inPage(`${firstModernFile}.querySelector('button[aria-pressed]').getAttribute('aria-pressed') === 'true' && !${firstModernFile}.querySelector('button[aria-pressed]').disabled`), 'native Reviewed save finishes before virtualization');
  await inPage(`window.unmountedReviewFile = ${firstModernFile}; window.unmountedReviewFile.remove()`);
  await waitFor(() => inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').disabled`), 'unmounted file retains its last observed state without pretending its control is available');
  assert.ok(await inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').checked && !${firstModernRow}.querySelector('.rf-reviewed-toggle input').indeterminate`));
  assert.equal(await inPanel(`document.querySelector('.rf-overview-title').textContent`), '5 review decisions');
  await inPage(`document.querySelector('main').append(window.unmountedReviewFile)`);
  await waitFor(() => inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').checked && !${firstModernRow}.querySelector('.rf-reviewed-toggle input').disabled`), 'remounted native file can be updated again');
  assert.equal((await modelRequests()).length, beforeHumanReview, 'Native human-review changes, filtering, collapse and remount must not trigger model calls.');
  await inPanel("document.querySelector('.rf-toolbar').scrollIntoView({block:'start'})");
  await writeFile('/tmp/review-focus-extension-reviewed-files.png', Buffer.from((await panelPage('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await panelPage('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  assert.equal(await inPanel(`document.querySelector('.rf-file-list').scrollWidth > document.querySelector('.rf-file-list').clientWidth`), false, 'Human controls and AI states must fit a narrow viewport.');
  await writeFile('/tmp/review-focus-extension-reviewed-mobile.png', Buffer.from((await panelPage('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await panelPage('Emulation.setDeviceMetricsOverride', { width: 600, height: 1080, deviceScaleFactor: 1, mobile: false });
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
  await waitFor(() => inPanel(`document.querySelector('.rf-file-progress-row[data-state=classified]') && document.querySelector('.rf-file-progress-row[data-state=queued]') && document.querySelectorAll('.rf-file-progress-row[data-state=classifying]').length === 3`), 'first file classified and remaining analyses waiting before a settings change');
  const beforeActiveSettings = (await modelRequests()).length;
  const activeRunLabel = await inPanel(`document.querySelector('.rf-run-settings').textContent`);
  await saveModelChoice('claude', 'claude-custom-older', 'high');
  assert.equal(await inPanel(`document.querySelector('.rf-run-settings').textContent`), activeRunLabel, 'A running analysis retains its captured model and effort after returning from Settings.');
  assert.equal(await inPanel(`document.querySelector('.rf-analyze').disabled`), true, 'Changing future settings must not make a second analysis available while the original is running.');
  assert.equal((await modelRequests()).length, beforeActiveSettings, 'Returning from Settings must not restart active model calls.');
  await writeFile(uxGate, 'finish');
  await waitFor(() => inPanel(`document.querySelector('.rf-overview-title')?.textContent === '5 review decisions' && !document.querySelector('.rf-analyze').disabled`), 'fresh AI analysis preserving native human progress');
  await waitFor(() => inPanel(`document.querySelector('.rf-actions > .rf-analyze')?.textContent === 'Analyze PR' && document.querySelector('.rf-analyze').checkVisibility() && document.querySelector('.rf-status').textContent.includes('claude-custom-older')`), 'settings changed during analysis become available on completion without navigation');
  assert.ok((await modelRequests()).slice(beforeHumanReview).every(request => request.provider === 'claude' && request.args[request.args.indexOf('--model')+1] === 'claude-fixture-model' && request.args[request.args.indexOf('--effort')+1] === 'medium'), 'Remaining classifications and the PR review use the original model and effort.');
  await saveModelChoice('claude', 'claude-fixture-model', 'medium');
  await waitFor(() => inPanel(`document.querySelector('.rf-menu .rf-analyze')?.textContent === 'Run fresh review'`), 'original settings restored after active-analysis regression');
  await send('Target.closeTarget', { targetId: modelSettingsTarget });
  await send('Runtime.evaluate', {expression:'IDBObjectStore.prototype.put = globalThis.originalReviewPut; delete globalThis.originalReviewPut;'}, savingWorker);
  assert.equal(await inPanel(`document.querySelector('.rf-cache-notice').checkVisibility() && document.querySelector('.rf-cache-notice').textContent.includes('could not be saved locally')`), true, 'A failed cache save must leave the completed analysis usable and its warning visible.');
  assert.equal((await modelRequests()).length, beforeHumanReview + 6);
  assert.equal(await inPage('window.fixtureViewedClicks'), 3, 'Fresh AI analysis must not change human review progress.');
  assert.ok(await inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').checked`));
  await inPanel(`window.staleCheckbox = ${firstModernRow}.querySelector('.rf-reviewed-toggle input')`);
  await inPage(`(() => {
    const script = document.querySelector('script[data-target="react-app.embeddedData"]');
    script.textContent = script.textContent.replaceAll(${JSON.stringify(headSha)}, '1'.repeat(40));
  })()`);
  assert.equal(await inPanel("window.staleCheckbox.isConnected && !document.querySelector('.rf-status').textContent.includes('PR revision changed')"), true, 'The stale control is still mounted before the page observer reports the changed revision.');
  await inPanel('window.staleCheckbox.click()');
  await waitFor(() => inPanel(`document.querySelector('.rf-status').textContent.includes('PR revision changed') && !document.querySelector('.rf-status').classList.contains('rf-visually-hidden') && document.querySelector('.rf-status').checkVisibility()`), 'revision change invalidates the AI view with visible guidance');
  assert.equal(await inPage('window.fixtureViewedClicks'), 3, 'A stale panel checkbox must not change the still-mounted native control after the PR revision changes.');
  await inPage('window.unmountedReviewFile.remove()');
  await inPage(`(() => {
    const script = document.querySelector('script[data-target="react-app.embeddedData"]');
    script.textContent = script.textContent.replaceAll('1'.repeat(40), ${JSON.stringify(headSha)});
  })()`);
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze').textContent === 'Open saved review'`), 'saved AI review available after returning to its revision');
  await click('Open saved review');
  await waitFor(() => inPanel(reviewReady), 'cached result after a revision switch');
  assert.ok(await inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').indeterminate && ${firstModernRow}.querySelector('.rf-reviewed-toggle input').disabled`), 'A revision change clears observations for absent native controls instead of reusing old checked state.');
  await inPage('document.querySelector("main").append(window.unmountedReviewFile)');
  await waitFor(() => inPanel(`${firstModernRow}.querySelector('.rf-reviewed-toggle input').checked && !${firstModernRow}.querySelector('.rf-reviewed-toggle input').disabled`), 'current native state re-read when its file is loaded');
  assert.equal((await modelRequests()).length, beforeHumanReview + 6, 'Revision-safe cache restoration must not trigger extra model calls.');
  changesMode = '';
  modernMode = false;
  await writeFile(modeFile, 'normal');
  await page('Page.navigate', {url:`chrome-extension://${extensionId}/options.html`});
  await waitFor(() => inPage('!document.querySelector("#save-review-preferences").disabled && document.querySelector("#classification-prompt").value.length > 100'), 'review preference controls loaded');
  assert.equal(await inPage('document.querySelector(".prompt-settings").open'), false, 'Advanced prompts start collapsed.');
  await inPage(`(() => {
    document.querySelector('#review-focus').value = 'thorough';
    document.querySelector('#change-types input[value=behavior]').checked = true;
    document.querySelector('#classification-prompt').value = 'Classify every supplied edit. Explain missing evidence.';
    document.querySelector('#prioritization-prompt').value = 'Prioritize concrete changes to behavior and contracts.';
    document.querySelector('#review-preferences-form').requestSubmit();
  })()`);
  await waitFor(() => inPage('document.querySelector("#review-preferences-status").textContent.includes("Preferences saved")'), 'custom review preferences saved');
  await page('Page.reload');
  await waitFor(() => inPage('!document.querySelector("#save-review-preferences").disabled && document.querySelector("#review-focus").value === "thorough"'), 'review preferences survive reload');
  assert.equal(await inPage('document.querySelector("#classification-prompt").value'), 'Classify every supplied edit. Explain missing evidence.');
  assert.match(await inPage('document.querySelector("#protected-paths").value'), /^package\.json\ngo\.mod\n[\s\S]*\nmigrations\/$/, 'Saving other preferences must keep the default protected paths.');
  await inPage('document.querySelector(".prompt-settings").open=true; document.querySelector("#review-preferences-form").scrollIntoView({block:"start"})');
  await writeFile('/tmp/priorities-review-preferences.png', Buffer.from((await page('Page.captureScreenshot', {format:'png'})).data,'base64'));
  const beforeCustomReview = (await modelRequests()).length;
  await page('Page.navigate', {url:prUrl+'/files'});
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Analyze PR'`), 'changed review preferences require fresh analysis');
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelector('.rf-overview-title') && !document.querySelector('.rf-analyze').disabled`), 'analysis with custom visibility preferences');
  assert.equal((await modelRequests()).length, beforeCustomReview + 2);
  assert.ok(await inPanel(`document.querySelector('.rf-run-settings').textContent.includes('Effort: medium · Focus: thorough')`));
  assert.equal(await inPage(`import(${JSON.stringify(moduleUrl)}).then(module => module.findNativeFiles(document).flatMap(file=>file.rows).filter(row=>['add','delete'].includes(row.type)).every(row=>!row.element.classList.contains('review-focus-native-hidden')))`), true, 'Always-visible change types must remain expanded regardless of model excerpt selection.');
  await page('Page.reload');
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'custom preferences have their own reusable cache identity');
  await click('Open saved review');
  await waitFor(() => inPanel(reviewReady), 'custom-preference saved analysis restored');
  assert.equal((await modelRequests()).length, beforeCustomReview + 2);
  assert.ok(await inPanel(`document.querySelector('.rf-run-settings').textContent.includes('Focus: thorough')`));
  await page('Page.navigate', {url:`chrome-extension://${extensionId}/options.html`});
  await waitFor(() => inPage('!document.querySelector("#save-review-preferences").disabled'), 'reset prompt controls ready');
  await inPage('document.querySelector("#reset-classification").click(); document.querySelector("#reset-prioritization").click(); document.querySelector("#review-preferences-form").requestSubmit()');
  await waitFor(() => inPage('document.querySelector("#review-preferences-status").textContent.includes("Preferences saved")'), 'default prompts restored');
  const restoredPrompts = await inPage('chrome.storage.local.get("reviewPreferences").then(value=>value.reviewPreferences)');
  assert.equal(restoredPrompts.classificationPrompt, '');
  assert.equal(restoredPrompts.prioritizationPrompt, '');
  await waitFor(() => inPage('!document.querySelector("#model").disabled'), 'custom model controls ready');
  await inPage(`(() => {
    document.querySelector('#model').value = '__custom__';
    document.querySelector('#model').dispatchEvent(new Event('change'));
    document.querySelector('#custom-model').value = 'claude-specific-older-release';
    document.querySelector('#custom-model').dispatchEvent(new Event('input'));
    document.querySelector('#effort').value = 'high';
    document.querySelector('#settings-form').requestSubmit();
  })()`);
  await waitFor(() => inPage('document.querySelector("#status").textContent.includes("Settings saved")'), 'custom model saved');
  await page('Page.reload');
  await waitFor(() => inPage('!document.querySelector("#model").disabled'), 'custom model restored');
  assert.equal(await inPage('document.querySelector("#model").value'), '__custom__');
  assert.equal(await inPage('document.querySelector("#custom-model").value'), 'claude-specific-older-release');
  assert.equal(await inPage('document.querySelector("#effort").value'), 'high');
  const beforeRange = (await modelRequests()).length;
  changesMode = 'classic-range';
  await page('Page.navigate', { url: prUrl + '/files/' + selectedRange });
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Analyze range' && !document.querySelector('.rf-analyze').disabled`), 'classic commit range ready');
  const classicRange = await captureFixture();
  assert.equal(classicRange.snapshot.baseSha, rangeBase);
  assert.equal(classicRange.snapshot.headSha, rangeHead);
  assert.equal(classicRange.snapshot.files.length, 1, 'Classic capture uses the selected comparison’s file inventory, not the full PR tab count.');
  const rangeSourceRequests = changesRequests.map(request => request.url).filter(url => url.includes('/blob/'));
  assert.ok(rangeSourceRequests.some(url => url.includes(`/blob/${rangeBase}/`)) && rangeSourceRequests.some(url => url.includes(`/blob/${rangeHead}/`)), 'Before and after source must use the selected commits.');
  await page('Page.navigate', { url: prUrl + '/commits/' + rangeHead });
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Analyze range' && !document.querySelector('.rf-analyze').disabled`), 'classic single-commit diff ready');
  assert.deepEqual((await captureFixture()).snapshot.files, classicRange.snapshot.files);
  changesMode = 'commit-range';
  const rangeUrl = prUrl + '/changes/' + selectedRange;
  await page('Page.navigate', { url: rangeUrl });
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Analyze range' && !document.querySelector('.rf-analyze').disabled`), 'modern commit range ready');
  changesRequests.length = 0;
  const capturedRange = await captureFixture();
  assert.equal(capturedRange.snapshot.baseSha, rangeBase);
  assert.equal(capturedRange.snapshot.headSha, rangeHead);
  assert.deepEqual(capturedRange.snapshot.files.map(file => file.path), changes.paths.slice(0, 5));
  const rangeFetches = changesRequests.filter(request => request.url.includes('/page_data/')).map(request => new URL(request.url));
  assert.ok(rangeFetches.some(url => url.pathname.endsWith('/diff_entries')) && rangeFetches.some(url => url.pathname.endsWith('/diff_entry_lines')));
  assert.ok(rangeFetches.every(url => url.searchParams.get('range') === selectedRange), 'Every deferred file and Load diff request must retain the selected base and head.');
  changesMode = 'range-wrong-revision';
  assert.match((await captureFixture()).error, /changed while reading its diffs/, 'A full-PR file returned for a range must be rejected.');
  changesMode = 'commit-range';
  const changedDuringCapture = await inPage(`(async () => {
    const { capturePullRequest } = await import(${JSON.stringify(moduleUrl)});
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (args[0] === ${JSON.stringify(prUrl)}) history.replaceState(null, '', ${JSON.stringify(prUrl + '/changes')});
      return response;
    };
    try { await capturePullRequest(); return ''; }
    catch (error) { return error.message; }
    finally { window.fetch = originalFetch; history.replaceState(null, '', ${JSON.stringify(rangeUrl)}); }
  })()`);
  assert.match(changedDuringCapture, /comparison changed while reading/);
  assert.equal((await modelRequests()).length, beforeRange, 'Range capture and rejected comparisons must not start model calls.');
  await writeFile(modeFile, 'many-decisions');
  await writeFile(uxGate, 'waiting');
  await click('Analyze range');
  await waitFor(() => inPanel(`document.querySelector('.rf-file-progress-row[data-state=classified]') && document.querySelector('.rf-file-progress-row[data-state=classifying]')`), 'range analysis stays active after its first file');
  assert.equal(await inPanel(`document.querySelectorAll('.rf-file-progress-row').length`), 5);
  assert.ok(await inPanel(`document.querySelector('.rf-run-settings').textContent.includes('Range: aaaaaaaa…cccccccc')`));
  const classifiedBeforeRangeReload = (await modelRequests()).length;
  await page('Page.navigate', { url: prUrl + '/checks' });
  await waitFor(() => inPage('document.querySelector("h1")?.textContent === "Checks"'), 'Checks while a range is analyzing');
  await page('Page.navigate', { url: rangeUrl });
  await waitFor(() => inPanel(`document.querySelector('.rf-file-progress-row[data-state=classified]') && document.querySelector('.rf-file-progress-row[data-state=classifying]')`), 'range analysis reconnects after Checks');
  await page('Page.reload');
  await waitFor(() => inPanel(`document.querySelector('.rf-file-progress-row[data-state=classified]') && document.querySelector('.rf-file-progress-row[data-state=classifying]')`), 'range analysis reconnects after reload');
  assert.equal((await modelRequests()).length, classifiedBeforeRangeReload, 'Resuming a range must reuse completed classifications.');
  await writeFile(uxGate, 'finish');
  await waitFor(() => inPanel(`document.querySelector('.rf-overview-title') && !document.querySelector('.rf-analyze').disabled`), 'range review finishes');
  assert.equal(await inPanel("document.querySelectorAll('.rf-topic').length"), 5, 'Every resumed range section remains available.');
  const rangeRequests = (await modelRequests()).slice(beforeRange);
  assert.equal(rangeRequests.length, 6);
  assert.ok(rangeRequests.every(request => request.evidence.baseSha === rangeBase && request.evidence.headSha === rangeHead && request.evidence.files.every(file => changes.paths.slice(0, 5).includes(file.path))), 'All classifications and the final check must use only the selected comparison.');
  await page('Page.reload');
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Open saved review'`), 'saved range review available');
  await click('Open saved review');
  await waitFor(() => inPanel(reviewReady), 'saved range review restored');
  assert.equal((await modelRequests()).length, beforeRange + 6);
  await page('Page.navigate', { url: prUrl + '/changes' });
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Analyze PR' && !document.querySelector('.rf-analyze').disabled`), 'range result is not offered as a full PR review');
  assert.equal(await inPage('document.querySelectorAll(".review-focus-native-hidden").length'), 0, 'Range decisions must not fold the full PR.');
  assert.equal((await modelRequests()).length, beforeRange + 6);
  await inPage(`history.replaceState(null, '', '/changes/files/pull/200000/changes'); window.dispatchEvent(new PopStateEvent('popstate'));`);
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Analyze PR' && !document.querySelector('.rf-analyze').disabled && !document.querySelector('.rf-run-settings').textContent.includes('Range:')`), 'repository names must not be mistaken for a selected range');
  changesMode = 'guide-sections';
  await writeFile(modeFile, 'guide-sections');
  await page('Page.navigate', {url:`chrome-extension://${extensionId}/options.html`});
  await waitFor(() => inPage('!document.querySelector("#save-review-preferences").disabled'), 'reset visibility preferences for the section fixture');
  await inPage(`(async () => {
    const {preferences} = await chrome.runtime.sendMessage({type:'get-review-preferences'});
    const saved = await chrome.runtime.sendMessage({type:'save-review-preferences',preferences:{...preferences,alwaysShow:[]}});
    if (saved.error) throw new Error(saved.error);
    const cleared = await chrome.runtime.sendMessage({type:'clear-cache'});
    if (cleared.error) throw new Error(cleared.error);
  })()`);
  await page('Page.navigate', { url: prUrl + '/changes' });
  await inPage('localStorage.removeItem("fixture-viewed-files")');
  await page('Page.reload');
  await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Analyze PR' && !document.querySelector('.rf-analyze').disabled`), 'section fixture ready');
  const sharedPath = changes.paths[2];
  const beforeSections = (await modelRequests()).length;
  // Lets the check below close the review connection the way a background restart would.
  await inAgent(`(() => {
    const connect = chrome.runtime.connect;
    chrome.runtime.connect = (...args) => {
      const connection = connect(...args);
      const add = connection.onDisconnect.addListener.bind(connection.onDisconnect);
      connection.onDisconnect.addListener = listener => {
        window.fixtureCloseReview = () => {
          connection.disconnect();
          listener();
        };
        add(listener);
      };
      return connection;
    };
  })()`);
  await writeFile(uxGate, 'waiting');
  await click('Analyze PR');
  await waitFor(() => inPanel(`document.querySelectorAll('.rf-file-progress-row[data-state=classified]').length === 4`), 'every file but the three-block one labelled');
  assert.deepEqual(await inPanel(`[document.querySelector('.rf-progress-bar').value, document.querySelector('.rf-progress-bar').max]`), [4, 7], 'The bar weighs files by their blocks and leaves the machine-maintained file out.');
  await writeFile(uxGate, 'continue');
  await waitFor(() => inPanel("document.querySelector('.rf-overview-title')?.textContent === '2 review decisions' && !document.querySelector('.rf-analyze').disabled"), 'four-section panel review');
  const sectionGists = ['Gist for supporting setup.', 'Gist for check the contract and its implementation.', 'Gist for check the separate validation path.', 'Gist for external caller contract.'];
  assert.deepEqual(await inPanel(`[...document.querySelectorAll('.rf-topic')].map(node => [node.dataset.topicId, node.querySelector('.rf-priority').textContent, node.open])`), [['supporting', 'Supporting', true], ['contract', 'Review', false], ['validation', 'Review', false], ['unknown', 'Supporting', false]]);
  assert.deepEqual(await inPanel(`[...document.querySelectorAll('.rf-topic-summary .rf-gist')].map(node => node.textContent)`), sectionGists);
  assert.deepEqual(await inPanel(`[...document.querySelectorAll('.rf-topic-summary .rf-topic-kinds')].map(node => [...node.querySelectorAll('.rf-topic-kind')].map(tag => [tag.textContent, tag.dataset.kind]))`), [
    [['3 behavior', 'behavior'], ['3 test', 'test'], ['1 interface', 'interface']], [['1 behavior', 'behavior']], [['1 behavior', 'behavior']], [['2 unknown', 'unknown']]
  ], 'Each section card counts its edits by change type, most common first.');
  await waitFor(() => inPage(`document.getElementById('diff-${changes.entries[2].pathDigest}').querySelectorAll('.review-focus-native-hidden').length === 4`), 'supporting changes folded beside cited and unresolved changes');
  assert.deepEqual(await inPage(`(() => {
    const file = document.getElementById('diff-${changes.entries[2].pathDigest}');
    return [...file.querySelectorAll('.diff-line-row')].map(row => [row.querySelector('.diff-text-inner').textContent, row.classList.contains('review-focus-native-hidden')]);
  })()`), [['before prerequisite', true], ['before prerequisite detail', true], ['after prerequisite', true], ['after prerequisite detail', true], ['unchanged context', false], ['before contract', false], ['after contract', false], ['unchanged context', false], ['before external caller', false], ['after external caller', false], ['trailing context', false], ['trailing context', false]], 'Native folding keeps review decisions, their context and unresolved changes visible.');
  assert.equal(await inPanel("document.querySelector('.rf-coverage').textContent"), 'Sections cover 5 of 6 files. 1 machine-maintained file not analyzed (open the file list to choose Review anyway).');
  assert.deepEqual(await inPage(`[...document.querySelectorAll('.diff-file-header code')].map(node => node.textContent)`), changes.paths.slice(0, 3), 'Analysis preserves GitHub’s native file order.');
  await openFiles();
  assert.deepEqual(await inPanel(`[...document.querySelectorAll('.rf-file-progress-row')].map(row => row.dataset.path)`), changes.paths.slice(0, 6));
  await inPanel(`document.querySelector('.rf-topic[data-topic-id=contract] > summary').focus()`);
  await panelPage('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await panelPage('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await waitFor(() => inPanel("document.querySelector('.rf-topic[data-topic-id=contract]').open"), 'native section disclosure keyboard interaction');
  const contract = `document.querySelector('.rf-topic[data-topic-id=contract]')`;
  assert.deepEqual(await inPanel(`[getComputedStyle(${contract}.querySelector('.rf-topic-summary')).position, getComputedStyle(${contract}.querySelector('.rf-gist')).webkitLineClamp, getComputedStyle(document.querySelector('.rf-topic[data-topic-id=validation] .rf-gist')).webkitLineClamp]`), ['sticky', 'none', '2'], 'Open section headings stay pinned and expand their gist while collapsed sections show two lines.');
  assert.deepEqual(await inPanel(`[...${contract}.querySelectorAll('.rf-section-file')].map(row => [row.querySelector('button').getAttribute('aria-label'), row.querySelector('.rf-file-delta').textContent])`), [[sharedPath, '+1 −1'], [changes.paths[4], 'cited evidence']], 'Cited and changed files appear once, with deltas belonging to this section.');
  assert.equal(await inPanel(`${contract}.querySelectorAll('.rf-code-quote').length`), 3, 'Multiple excerpts stay grouped under their file.');
  const relatedSections = () => inPanel(`Object.fromEntries([...document.querySelectorAll('.rf-topic')].map(card => [card.dataset.topicId, [...card.querySelectorAll('.rf-section-links li')].map(item => item.textContent)]))`);
  const expectedRelated = {supporting: [], contract: ['contractValue is used in section 3', '<b>Contract</b> is used in section 3'], validation: ['contractValue is changed in section 2', '<b>Contract</b> is changed in section 2'], unknown: []};
  assert.deepEqual(await relatedSections(), expectedRelated, 'A symbol defined in one section and used in another links both cards; sections without such symbols show none.');
  assert.deepEqual(await inPanel(`[...document.querySelectorAll('.rf-topic')].map(card => [...card.querySelectorAll('h3')].some(heading => heading.textContent === 'Related sections'))`), [false, true, true, false]);
  assert.equal(await inPanel(`document.querySelectorAll('.rf-section-links b, .rf-section-links img').length`), 0, 'Symbol names from the model render as text, never markup.');
  await inPanel(`${contract}.querySelector('.rf-section-links button').click()`);
  await waitFor(() => inPanel(`document.querySelector('.rf-topic[data-topic-id=validation]').open && document.activeElement === document.querySelector('.rf-topic[data-topic-id=validation] > summary')`), 'related-section link opens the section using the symbol');
  await inPanel(`document.querySelector('.rf-topic[data-topic-id=validation] .rf-section-links button').click()`);
  await waitFor(() => inPanel(`document.activeElement === ${contract}.querySelector('summary') && ${contract}.open`), 'related-section link returns to the section defining the symbol');
  await inPanel(`${contract}.querySelector('.rf-code-quote > .rf-ref').click()`);
  await waitFor(() => inPage('Boolean(document.querySelector(".review-focus-native-target"))'), 'panel excerpt reveals native code');
  assert.equal(await inPage('document.querySelector(".review-focus-native-target").textContent.includes("contract")'), true);
  await inPage(`(() => {
    const file = document.getElementById('diff-${changes.entries[2].pathDigest}');
    window.citedRow = [...file.querySelectorAll('tr')].find(row => row.textContent.includes('after contract'));
    window.citedNext = window.citedRow.nextSibling;
    window.citedParent = window.citedRow.parentNode;
    window.citedRow.remove();
  })()`);
  await inPanel(`${contract}.querySelector('.rf-code-quote > .rf-ref').click()`);
  await waitFor(() => inPanel("document.querySelector('.rf-navigation-notice').textContent.includes('outside the lines GitHub shows')"), 'loaded file with an absent cited row gets source guidance');
  assert.ok(await inPanel(`document.querySelector('.rf-navigation-notice a').href.endsWith('/${sharedPath}#L4-L4')`));
  await inPage('window.citedParent.insertBefore(window.citedRow, window.citedNext)');
  await inPanel(`${contract}.querySelectorAll('.rf-section-file button')[1].click()`);
  await waitFor(() => inPanel("document.querySelector('.rf-navigation-notice').textContent.includes('has not loaded')"), 'missing cited file guidance');
  assert.ok(await inPanel(`document.querySelector('.rf-navigation-notice a').href.includes('/blob/${headSha}/')`), 'A cited-only file has no section-owned edit, so its file link opens the captured head.');
  await inPanel(`${contract}.querySelectorAll('.rf-code-refs > li')[1].querySelector('.rf-code-quote > .rf-ref').click()`);
  await waitFor(() => inPanel(`document.querySelector('.rf-navigation-notice a')?.href.includes('/blob/${baseSha}/')`), 'before-side source fallback uses base commit');
  const sharedFile = `document.getElementById('diff-${changes.entries[2].pathDigest}')`;
  const sharedHidden = () => inPage(`[...${sharedFile}.querySelectorAll('.diff-line-row')].map(row => row.classList.contains('review-focus-native-hidden'))`);
  const sharedFolds = () => inPage(`[...${sharedFile}.querySelectorAll('.review-focus-native-toggle')].map(toggle => [toggle.textContent, toggle.getAttribute('aria-label')])`);
  const sharedViewed = () => inPage(`${sharedFile}.querySelector('button[aria-pressed]').getAttribute('aria-pressed') === 'true'`);
  const sectionDone = (id, path = sharedPath) => `[...document.querySelectorAll('.rf-topic[data-topic-id=${id}] .rf-section-file')].find(row => row.querySelector('button').getAttribute('aria-label') === ${JSON.stringify(path)}).querySelector('.rf-section-done input')`;
  const sharedDone = () => inPanel(`[${['supporting', 'contract', 'unknown'].map(id => `${sectionDone(id)}.checked`).join(', ')}]`);
  // The page agent runs the panel's calls in order, so once a later reveal answers, every call an earlier tick sent has run.
  const earlierPageCallsHandled = async () => {
    await inPanel(`${contract}.querySelectorAll('.rf-section-file button')[1].click()`);
    await waitFor(() => inPanel("!document.querySelector('.rf-navigation-notice').hidden && document.querySelector('.rf-navigation-notice').textContent.includes('has not loaded')"), 'a later page call answered');
  };
  assert.deepEqual(await inPanel(`[...document.querySelectorAll('.rf-section-done input')].filter(input => input.getAttribute('aria-label').includes(${JSON.stringify(sharedPath)})).length`), 3, 'Each of the three sections listing the shared file has its own done checkbox.');
  assert.equal(await inPanel(`${sectionDone('contract')}.getAttribute('aria-label')`), `Done with this section in ${sharedPath}: folds its lines in GitHub’s diff`);
  let clicksBeforeTicks = await inPage('window.fixtureViewedClicks');
  const folded = [true, true, true, true];
  const open = [false, false];
  // Two context rows after the external caller rows: too few for an AI fold, so they stay open even beside reviewed rows.
  const trailing = [false, false];
  // The contract section owns and cites rows 5–8; the unresolved section also cites its added row 7.
  const contractDone = [true, true, false, true];
  const contractReason = 'You marked “Check the contract and its implementation” done.';
  await inPanel(`${sectionDone('contract')}.click()`);
  await waitFor(async () => JSON.stringify(await sharedHidden()) === JSON.stringify([...folded, ...contractDone, ...open, ...trailing]), 'a done review section folds its changed and cited rows beside the supporting fold');
  assert.deepEqual(await sharedFolds(), [['4 lines folded', 'Show 4 lines folded by PRiorities. Supporting changes from “Supporting setup”.'], ['2 lines reviewed', `Show 2 lines you reviewed. ${contractReason}`], ['1 line reviewed', `Show 1 line you reviewed. ${contractReason}`]], 'The done section folds behind its own reviewed markers, apart from the adjacent AI fold; its own edit stays open where a section not yet done cites it.');
  assert.deepEqual(await inPage(`[...${sharedFile}.querySelectorAll('.review-focus-native-fold')].map(marker => marker.classList.contains('review-focus-native-reviewed'))`), [false, true, true], 'Only the done section’s markers are marked reviewed.');
  const contractNotesShown = () => inPanel(`(() => {
    const wasOpen = ${contract}.open;
    ${contract}.open = true;
    const shown = [...${contract}.querySelectorAll('.rf-code-refs > li')].map(item => [...item.querySelectorAll('.rf-code-quote')].map(quote => quote.checkVisibility()));
    ${contract}.open = wasOpen;
    return shown;
  })()`);
  assert.deepEqual(await contractNotesShown(), [[false, false], [true]], 'Marking the contract section done in the shared file collapses its notes there, not in the file it is not done in.');
  await inPage(`${sharedFile}.querySelectorAll('.review-focus-native-toggle')[1].click()`);
  assert.deepEqual((await sharedFolds())[1], ['Fold 2 lines', `Fold again 2 lines you reviewed. ${contractReason}`], 'An expanded reviewed fold offers to fold again and still says you reviewed it.');
  await inPage(`${sharedFile}.querySelectorAll('.review-focus-native-toggle')[1].click()`);
  assert.deepEqual((await sharedFolds())[1], ['2 lines reviewed', `Show 2 lines you reviewed. ${contractReason}`], 'Folding it again restores the reviewed label.');
  assert.equal(await sharedViewed(), false, 'Another section listing the file is not done, so GitHub Viewed stays off.');
  await inPanel("document.querySelector('.rf-fold-toggle input').click()");
  await waitFor(async () => JSON.stringify(await sharedHidden()) === JSON.stringify([false, false, false, false, ...contractDone, ...open, ...trailing]), 'a done section stays folded when folding less important code is off');
  assert.match(await inPanel("document.querySelector('.rf-fold-summary').textContent"), /^Only sections you marked done are folded/);
  await inPanel("document.querySelector('.rf-fold-toggle input').click()");
  await waitFor(async () => JSON.stringify(await sharedHidden()) === JSON.stringify([...folded, ...contractDone, ...open, ...trailing]), 'AI folding returns beside the done section');
  await inPanel(`${sectionDone('supporting')}.click()`);
  await waitFor(async () => (await sharedFolds())[0]?.[1] === 'Show 6 lines you reviewed. You marked “Supporting setup”, “Check the contract and its implementation” done.', 'once the supporting section is done too, its rows join the adjacent reviewed fold');
  await earlierPageCallsHandled();
  assert.equal(await sharedViewed(), false, 'Two of three sections done leaves GitHub Viewed off.');
  assert.equal(await inPage('window.fixtureViewedClicks'), clicksBeforeTicks, 'The second of three ticks never clicks GitHub Viewed.');
  await inPanel(`${sectionDone('unknown')}.click()`);
  await waitFor(async () => await sharedViewed() && JSON.stringify(await sharedHidden()) === JSON.stringify([...Array(10).fill(true), ...trailing]), 'marking every section listing a file done folds its shared and unresolved rows and marks it Viewed');
  await waitFor(() => inPanel(`document.querySelector('.rf-file-list .rf-reviewed-toggle[data-path="${sharedPath}"] input').checked`), 'file list mirrors the Viewed mark set by the last done section');
  await inPanel(`${sectionDone('unknown')}.click()`);
  await waitFor(async () => !await sharedViewed() && JSON.stringify(await sharedHidden()) === JSON.stringify([...folded, ...contractDone, ...open, ...trailing]), 'unticking a section of a fully done file unfolds its rows and clears Viewed');
  assert.equal(await inPage('window.fixtureViewedClicks') - clicksBeforeTicks, 2, 'Only crossing into and out of all-done changes GitHub Viewed.');
  await inPanel(`${sectionDone('supporting')}.click()`);
  await inPanel(`${sectionDone('contract')}.click()`);
  await waitFor(async () => JSON.stringify(await sharedHidden()) === JSON.stringify([...folded, false, false, false, false, ...open, ...trailing]), 'unticking every section leaves only the AI fold');
  await inPanel(`${sectionDone('unknown')}.click()`);
  await waitFor(async () => JSON.stringify(await sharedHidden()) === JSON.stringify([...folded, false, false, false, false, true, true, ...trailing]), 'a done section folds its two isolated rows');
  assert.deepEqual(await inPage(`[...${sharedFile}.querySelectorAll('.review-focus-native-toggle')].map(toggle => toggle.textContent)`), ['4 lines folded', '2 lines reviewed'], 'A done section folds fewer rows than the three-row minimum for AI folds, and not the contract line it cites while the contract section is not done. The two context rows after it are too few for an AI fold and do not join the reviewed marker.');
  await inPanel(`${sectionDone('unknown')}.click()`);
  await waitFor(async () => JSON.stringify(await sharedHidden()) === JSON.stringify([...folded, false, false, false, false, ...open, ...trailing]), 'unticking the isolated section unfolds its rows');
  await inPanel(`${sectionDone('supporting')}.click()`);
  await inPanel(`${sectionDone('contract')}.click()`);
  await waitFor(async () => JSON.stringify(await sharedHidden()) === JSON.stringify([...folded, ...contractDone, ...open, ...trailing]), 'the supporting and contract sections are done again for the saved-review checks');
  assert.equal(await inPage('window.fixtureViewedClicks') - clicksBeforeTicks, 2, 'Ticks that never complete the file leave GitHub Viewed alone.');
  // Ticking the file, in the panel or in GitHub, ticks or unticks every section listing it there.
  const sharedReviewed = `document.querySelector('.rf-file-list .rf-reviewed-toggle[data-path="${sharedPath}"] input')`;
  const sharedControl = `${sharedFile}.querySelector('button[aria-pressed]')`;
  // The panel's Reviewed box mirrors GitHub's Viewed a moment later; each click waits for it to catch up.
  const fileState = async () => [await sharedViewed(), await inPanel(`${sharedReviewed}.checked`), await sharedDone(), await sharedHidden(), await inPage(`${sharedControl}.disabled`)];
  const allDone = [true, true, [true, true, true], [...Array(10).fill(true), ...trailing], false];
  const noneDone = [false, false, [false, false, false], [...folded, false, false, false, false, ...open, ...trailing], false];
  await waitFor(async () => !await sharedViewed() && await inPanel(`!${sharedReviewed}.checked && ${sharedReviewed}.getAttribute('aria-disabled') === 'false'`), 'the file list shows the shared file not yet Viewed');
  const beforeFileTicks = await inPage('window.fixtureViewedClicks');
  await inPanel(`${sharedReviewed}.click()`);
  await waitFor(async () => JSON.stringify(await fileState()) === JSON.stringify(allDone), 'ticking the file in the panel marks every section listing it done');
  assert.deepEqual(await contractNotesShown(), [[false, false], [true]], 'A section ticked through its file collapses its notes there.');
  await inPanel(`${sharedReviewed}.click()`);
  await waitFor(async () => JSON.stringify(await fileState()) === JSON.stringify(noneDone), 'unticking the file in the panel clears every section listing it');
  assert.deepEqual(await contractNotesShown(), [[true, true], [true]], 'Unticking shows the notes again.');
  await clickInPage(sharedControl);
  await waitFor(async () => JSON.stringify(await fileState()) === JSON.stringify(allDone), 'clicking Viewed in GitHub marks every section listing the file done');
  await clickInPage(sharedControl);
  await waitFor(async () => JSON.stringify(await fileState()) === JSON.stringify(noneDone), 'clicking Viewed off in GitHub clears every section listing the file');
  assert.equal(await inPage('window.fixtureViewedClicks') - beforeFileTicks, 4, 'Each file tick changes GitHub Viewed once; marking its sections clicks nothing more.');
  clicksBeforeTicks += 4;
  await inPanel(`${sectionDone('supporting')}.click()`);
  await inPanel(`${sectionDone('contract')}.click()`);
  await waitFor(async () => JSON.stringify(await sharedHidden()) === JSON.stringify([...folded, ...contractDone, ...open, ...trailing]), 'the supporting and contract sections are done again after the file ticks');
  const missingInput = `document.querySelector('.rf-file-list .rf-reviewed-toggle[data-path="${changes.paths[4]}"] input')`;
  assert.deepEqual(await inPanel(`[${missingInput}.indeterminate, ${missingInput}.disabled]`), [true, true]);
  await inPanel(`${sectionDone('supporting', changes.paths[4])}.click()`);
  await inPanel(`${sectionDone('contract', changes.paths[4])}.click()`);
  await earlierPageCallsHandled();
  assert.equal(await inPage('window.fixtureViewedClicks') - clicksBeforeTicks, 2, 'Completing a file whose GitHub Viewed control is not loaded clicks nothing yet.');
  await inPage(`(() => {
    const list = document.querySelector('[data-testid=progressive-diffs-list]');
    const first = list.querySelector('.fixture-diff-entry');
    const html = first.outerHTML.replaceAll(${JSON.stringify(changes.paths[0])}, ${JSON.stringify(changes.paths[4])}).replaceAll(${JSON.stringify(changes.entries[0].pathDigest)}, ${JSON.stringify(changes.entries[4].pathDigest)});
    list.insertAdjacentHTML('beforeend', html);
    const file = list.lastElementChild;
    file.querySelectorAll('button[aria-pressed], [data-review-focus-owned]').forEach(node => node.remove());
    window.fixtureInstallReviewControl(file, ${JSON.stringify(changes.paths[4])}, true);
    window.reviewDraft = document.createElement('textarea');
    window.reviewDraft.value = 'Unsubmitted review comment';
    file.append(window.reviewDraft);
  })()`);
  await waitFor(() => inPanel(`${missingInput}.checked && !${missingInput}.indeterminate && !${missingInput}.disabled`), 'the Viewed change the last tick asked for applies once GitHub loads the file');
  assert.equal(await inPage('window.fixtureViewedClicks') - clicksBeforeTicks, 3, 'Loading the file clicks GitHub Viewed exactly once.');
  assert.equal(await inPage('window.reviewDraft.checkVisibility() && window.reviewDraft.value === "Unsubmitted review comment"'), true);
  await inPanel(`${contract}.querySelectorAll('.rf-section-file button')[1].click()`);
  await waitFor(() => inPage(`document.getElementById('diff-${changes.entries[4].pathDigest}').classList.contains('review-focus-native-target')`), 'newly loaded cited file revealed');
  assert.equal(await inPanel("document.querySelector('.rf-navigation-notice').hidden"), true);
  await inPanel("document.querySelector('.rf-unresolved .rf-link-button').click()");
  assert.equal(await inPanel("document.querySelector('.rf-topic[data-topic-id=unknown]').open"), true, 'Unresolved evidence opens its own explanation.');
  const cacheWarning = `document.querySelector('.rf-cache-notice').checkVisibility() && document.querySelector('.rf-cache-notice').textContent`;
  await send('Runtime.evaluate', {expression:`(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () {
      IDBObjectStore.prototype.put = put;
      throw new DOMException('Synthetic tick write failure.', 'UnknownError');
    };
  })()`}, workers.at(-1));
  await inPanel(`${sectionDone('validation', changes.paths[3])}.click()`);
  await waitFor(async () => (await inPanel(cacheWarning) || '').includes('could not be saved locally'), 'a tick that fails to save warns beside the review');
  assert.equal(await inPanel("document.querySelector('.rf-navigation-notice').hidden"), true);
  await inPanel(`document.querySelector('.rf-topic[data-topic-id=validation] .rf-section-file button').click()`);
  await waitFor(() => inPanel("!document.querySelector('.rf-navigation-notice').hidden && document.querySelector('.rf-navigation-notice').textContent.includes('has not loaded')"), 'a page call after the tick answered');
  assert.equal(await inPage('window.fixtureViewedClicks') - clicksBeforeTicks, 3, 'The only section listing an unloaded file is done, so its Viewed change waits for the file.');
  await inPanel(`[...document.querySelector('.rf-file-progress-row[data-path="${changes.paths[5]}"]').querySelectorAll('button')].find(button => button.textContent === 'Review anyway').click()`);
  await waitFor(() => inPanel(`!${sectionDone('validation', changes.paths[3])}.checked && ${reviewReady}`), 'Review anyway reruns the review and drops the tick of a section that now cites more of that file');
  assert.deepEqual(await sharedDone(), [true, true, false], 'Ticks of sections that add nothing in their file carry over.');
  assert.equal(await inPanel("document.querySelector('.rf-cache-notice').hidden"), true, 'The rerun saves its ticks, so the failed-save warning goes.');
  const validationInput = `document.querySelector('.rf-file-list .rf-reviewed-toggle[data-path="${changes.paths[3]}"] input')`;
  await inPage(`(() => {
    const list = document.querySelector('[data-testid=progressive-diffs-list]');
    const first = list.querySelector('.fixture-diff-entry');
    list.insertAdjacentHTML('beforeend', first.outerHTML.replaceAll(${JSON.stringify(changes.paths[0])}, ${JSON.stringify(changes.paths[3])}).replaceAll(${JSON.stringify(changes.entries[0].pathDigest)}, ${JSON.stringify(changes.entries[3].pathDigest)}));
    const file = list.lastElementChild;
    file.querySelectorAll('button[aria-pressed], [data-review-focus-owned]').forEach(node => node.remove());
    window.fixtureInstallReviewControl(file, ${JSON.stringify(changes.paths[3])}, true);
  })()`);
  await waitFor(() => inPanel(`!${validationInput}.indeterminate && !${validationInput}.disabled`), 'GitHub loads the file whose tick the rerun dropped');
  assert.equal(await inPanel(`${validationInput}.checked`), false);
  assert.equal(await inPage('window.fixtureViewedClicks') - clicksBeforeTicks, 3, 'A Viewed change that a dropped tick asked for never applies.');
  await inAgent('window.fixtureCloseReview()');
  await waitFor(async () => (await inPanel(cacheWarning) || '').includes('lost its connection'), 'a review connection closed by the background warns that ticks are no longer saved');
  await panelPage('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:false});
  assert.equal(await inPanel("document.querySelector('.rf-panel').scrollWidth > document.querySelector('.rf-panel').clientWidth"), false, 'Sections, references, file names and Reviewed controls fit the panel.');
  await writeFile('/tmp/priorities-panel-sections.png', Buffer.from((await panelPage('Page.captureScreenshot', {format:'png'})).data,'base64'));
  await panelPage('Emulation.setDeviceMetricsOverride', {width:600,height:1080,deviceScaleFactor:1,mobile:false});
  assert.equal((await modelRequests()).length - beforeSections, 8, 'Panel navigation and Viewed controls add no model calls; Review anyway adds one classification and one PR review.');
  await page('Page.reload');
  await waitFor(() => inPanel("document.querySelector('.rf-analyze')?.textContent === 'Open saved review'"), 'saved multi-section review');
  await click('Open saved review');
  await waitFor(() => inPanel(reviewReady), 'saved sections restored');
  assert.deepEqual(await relatedSections(), expectedRelated, 'A saved review keeps the symbol relations behind its section links.');
  assert.deepEqual(await sharedDone(), [true, true, false], 'A reopened saved review restores the sections marked done.');
  await waitFor(async () => JSON.stringify(await sharedHidden()) === JSON.stringify([...folded, ...contractDone, ...open, ...trailing]), 'restored done sections fold again');
  assert.equal(await inPage('window.fixtureViewedClicks'), 0, 'Restoring a saved review never changes Viewed.');
  assert.equal((await modelRequests()).length - beforeSections, 8);
  for (const override of ['always-visible', 'protected']) {
    await page('Page.navigate', {url:`chrome-extension://${extensionId}/options.html`});
    await waitFor(() => inPage('!document.querySelector("#save-review-preferences").disabled'), 'visibility override preferences');
    await inPage(`(async () => {
      const {preferences} = await chrome.runtime.sendMessage({type:'get-review-preferences'});
      const result = await chrome.runtime.sendMessage({type:'save-review-preferences',preferences:{...preferences,alwaysShow:${JSON.stringify(override === 'always-visible' ? ['behavior'] : [])},protectedPaths:${JSON.stringify(override === 'protected' ? [sharedPath] : [])}}});
      if (result.error) throw new Error(result.error);
    })()`);
    const beforeOverride = (await modelRequests()).length;
    await page('Page.navigate', {url:prUrl+'/changes'});
    await waitFor(() => inPanel("document.querySelector('.rf-analyze')?.textContent === 'Analyze PR' && !document.querySelector('.rf-analyze').disabled"), 'fresh visibility override');
    await click('Analyze PR');
    await waitFor(() => inPanel("document.querySelector('.rf-overview-title')?.textContent === '2 review decisions' && !document.querySelector('.rf-analyze').disabled"), 'visibility override complete');
    assert.equal(await inPage(`import(${JSON.stringify(moduleUrl)}).then(module => module.findNativeFiles(document).filter(file => ${override === 'protected' ? `file.path === ${JSON.stringify(sharedPath)}` : 'true'}).flatMap(file => file.rows).filter(row => ['add', 'delete'].includes(row.type)).every(row => !row.element.classList.contains('review-focus-native-hidden')))`), true, 'User visibility rules preserve native changed rows.');
    assert.equal((await modelRequests()).length - beforeOverride, 6);
  }
  changesMode = '';
  await writeFile(modeFile, 'normal');
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => inPage('document.querySelector("#clear-cache")?.disabled === false'), 'cache controls before popup launch');
  await inPage('document.querySelector("#clear-cache").click()');
  await waitFor(() => inPage('document.querySelector("#cache-status").textContent.includes("Saved reviews cleared")'), 'earlier fixture reviews cleared before popup launch');
  const beforePopup = (await modelRequests()).length;
  for (const route of ['', '/files']) {
    const closed = await send('Runtime.evaluate', { expression: `chrome.sidePanel.close({tabId:${fixtureTabId}})`, awaitPromise: true }, workers.at(-1));
    assert.equal(closed.exceptionDetails, undefined);
    panelSession = undefined;
    await page('Page.navigate', { url: prUrl + route });
    assert.equal(await inPage('document.querySelectorAll("[data-review-focus-owned]").length'), 0, 'Navigating with the panel closed leaves GitHub untouched.');
    const beforeLaunch = (await modelRequests()).length;
    const previousDocument = defaultContext(sessionId);
    await analyzeFromPopup();
    await waitFor(() => inPage(`location.href === ${JSON.stringify(prUrl + '/files')} && document.readyState === 'complete'`), 'popup opens Files changed');
    if (route) assert.equal(defaultContext(sessionId), previousDocument, 'Analyze on Files changed keeps the current GitHub document.');
    else assert.notEqual(defaultContext(sessionId), previousDocument, 'Analyze navigates from Conversation to Files changed.');
    await waitFor(() => inPanel(`document.querySelector('.rf-overview-title')?.textContent === '1 review decision' && !document.querySelector('.rf-analyze').disabled`), 'popup automatically opens the review');
    assert.equal(await inPanel(`new URLSearchParams(location.search).has('start')`), false, 'Automatic analysis consumes the popup launch request.');
    assert.equal(await inPanel(`new URLSearchParams(location.search).get('tab')`), String(fixtureTabId), 'The popup binds the review to the active PR tab.');
    assert.equal((await modelRequests()).length - beforeLaunch, route ? 0 : 2, 'The first popup launch classifies and reviews once; reopening uses the saved review.');
    if (route) {
      continue;
    }
    const popupRequests = (await modelRequests()).slice(beforePopup);
    assert.deepEqual(popupRequests.map(request => request.schema.required.includes('edits')), [true, false]);
    assert.ok(popupRequests.every(request => request.evidence.files.length === 1 && request.evidence.files[0].path === sourcePath));
    const previousPanelDocument = defaultContext(panelSession);
    await panelPage('Page.reload');
    await waitFor(() => defaultContext(panelSession) !== previousPanelDocument, 'reloaded panel document');
    await waitFor(() => inPanel(`document.querySelector('.rf-analyze')?.textContent === 'Open saved review' && !document.querySelector('.rf-analyze').disabled`), 'reloading does not repeat popup autostart');
    assert.equal(await inPanel(`document.querySelector('.rf-result').hidden`), true, 'The consumed launch request does not reopen the review after reload.');
    assert.equal((await modelRequests()).length, beforePopup + 2, 'Reloading the panel makes no duplicate model calls.');
  }
  const idleStatus = await readFile(statusLog, 'utf8');
  await new Promise(resolve => setTimeout(resolve, 65000));
  assert.equal(await readFile(statusLog, 'utf8'), idleStatus, 'An idle panel must not poll the local CLI after a full minute.');
  assert.equal((await modelRequests()).length, beforePopup + 2, 'An idle popup-launched review never repeats analysis.');
  await inPage("history.pushState({}, '', '/microsoft/vscode/issues/1'); window.dispatchEvent(new PopStateEvent('popstate'))");
  await waitFor(() => inPanel("document.querySelector('.rf-analyze').disabled && document.querySelector('.rf-status').textContent.includes('Open a GitHub pull request')"), 'non-PR navigation clears the panel');
  assert.equal(await inPanel("document.querySelectorAll('.rf-topic').length"), 0);
  await waitFor(() => inPage('document.querySelectorAll(".review-focus-native-fold, .review-focus-native-hidden").length === 0'), 'non-PR navigation restores native rows');
  assert.equal(/\bpl-[a-z0-9]+|<span/.test(JSON.stringify(await modelRequests())), false, 'Highlighting never reaches a model request.');
  assert.ok(workers.length > 0);
  assert.deepEqual(eventErrors, []);
  assert.deepEqual(exceptions, []);
  console.log('Installed extension passed: real toolbar popup, Conversation-to-diff navigation and one-time autostart, real Chrome side panel and page-agent relay, native folding and code references, per-section done ticks, their saved folds and rerun carry-over, warnings when ticks cannot be saved, Viewed synchronization, options and authentication, complete classic/React/Changes captures and selected ranges, 53 deferred files, bounded issue/source context, capture cancellation, generated/deleted files and limits, cache validation and eviction, retries, live progress, reload and navigation reconnects. Fake Codex and Claude CLIs used the real native host; no live model calls.');
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  chrome.kill('SIGTERM');
  await new Promise(resolve => { chrome.once('exit', resolve); setTimeout(resolve, 1500); });
  await rm(profile, { recursive: true, force: true });
}
