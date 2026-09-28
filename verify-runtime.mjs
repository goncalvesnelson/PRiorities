import assert from 'node:assert/strict';
import { analyzeWithCLI, getCLIStatus } from './extension/cli-client.js';
import { analysisSchema, classificationSchema, makePrompt, validateSnapshot } from './extension/review-data.js';

const snapshot = validateSnapshot({
  url: 'https://github.com/example/repository/pull/7',
  title: 'Reject a missing account',
  description: 'Return early when the account does not exist.',
  baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), context: [], warnings: [],
  files: [{ path: 'account.js', hunks: [{ header: '@@ -1 +1,2 @@', items: [{
    type: 'edit', id: '1-1-1', rows: [
      { type: 'delete', text: 'return account.balance;', oldLine: 1, newLine: null },
      { type: 'add', text: 'if (!account) return null;', oldLine: null, newLine: 1 },
      { type: 'add', text: 'return account.balance;', oldLine: null, newLine: 2 }
    ]
  }] }] }]
});
const assessment = {
  summary: 'Confirm how callers handle a missing account.',
  topics: [{
    id: 'missing-account', priority: 'review', title: 'Handle the new null return',
    reason: 'The guard changes the missing-account result.', before: 'Missing account throws.',
    after: 'Missing account returns null.', question: 'Do callers accept null?',
    uncertainty: 'Caller source is not provided.', evidenceSummary: 'The new guard introduces a null return.',
    editIds: ['1-1-1'], excerpts: [{ path: 'account.js', side: 'after', startLine: 1, endLine: 1 }]
  }]
};
const classifications = { edits: [{
  editId: '1-1-1', kinds: ['behavior', 'interface'],
  reason: 'The new guard returns null instead of throwing for a missing account.',
  uncertainty: 'Caller handling of null is not supplied.'
}] };
const retiredCredential = 'retired-anthropic-test-key';
const savedFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('The Codex extension must never make an HTTP request.'); };
let nativeHandler;
const requests = [];
const nativePorts = [];

function stagedResponses(inventory, review) {
  return request => {
    assert.equal(request.type, 'analyze');
    const evidence = JSON.parse(request.prompt.user);
    const editIds = new Set(evidence.files.flatMap(file => file.hunks.flatMap(hunk => hunk.items.filter(item => !Array.isArray(item)).map(item => item.id))));
    if (request.schema.properties.edits) {
      assert.deepEqual(request.schema, classificationSchema);
      return { type: 'result', result: { edits: inventory.edits.filter(edit => editIds.has(edit.editId)) } };
    }
    assert.deepEqual(request.schema, analysisSchema);
    const topics = review.topics.filter(topic => topic.editIds.some(id => editIds.has(id))).map(topic => ({
      ...topic, editIds: topic.editIds.filter(id => editIds.has(id)),
      excerpts: topic.excerpts.filter(excerpt => evidence.files.some(file => file.path === excerpt.path))
    }));
    return { type: 'result', result: { ...review, topics } };
  };
}

async function until(predicate, description) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), description);
}

async function beginReview(input = snapshot) {
  const reviewPort = port();
  await onConnect.emit(reviewPort);
  await reviewPort.onMessage.emit({ type: 'analyze', snapshot: input });
  return reviewPort;
}

function waitForSettlement(reviewPort, after = 0) {
  return until(() => reviewPort.messages.slice(after).some(message => ['result', 'settled', 'error'].includes(message.type)), 'The review should settle.');
}

function fileStates(reviewPort, path) {
  return reviewPort.messages.filter(message => message.type === 'file-progress' && message.path === path).map(message => message.state);
}

function fakeClock() {
  const original = {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, now: Date.now
  };
  const timers = new Map();
  let now = 0;
  let nextId = 0;
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, at: now + delay, interval: 0 });
    return id;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.setInterval = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, at: now + delay, interval: delay });
    return id;
  };
  globalThis.clearInterval = id => timers.delete(id);
  return {
    timers,
    tick(milliseconds) {
      const end = now + milliseconds;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort(([, left], [, right]) => left.at - right.at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval;
        else timers.delete(id);
        timer.callback();
      }
      now = end;
    },
    restore() {
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
      globalThis.setInterval = original.setInterval;
      globalThis.clearInterval = original.clearInterval;
      Date.now = original.now;
    }
  };
}

function event() {
  const listeners = new Set();
  return {
    addListener: listener => listeners.add(listener),
    removeListener: listener => listeners.delete(listener),
    emit: (...args) => Promise.all([...listeners].map(listener => listener(...args)))
  };
}

const extensionId = 'bjmajanmepopjciklnijlfbdpafokfpe';
const contentSender = { id: extensionId, frameId: 0, tab: { id: 42 }, url: `${snapshot.url}/files` };
const optionsSender = { id: extensionId, url: `chrome-extension://${extensionId}/options.html` };
let storage = { settings: { apiKey: retiredCredential, model: 'claude-opus-5' } };
const storageReads = [];
let accessLevel;
let optionsOpened = 0;
const onMessage = event();
const onConnect = event();
const onClicked = event();
globalThis.chrome = {
  runtime: {
    id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`,
    onMessage, onConnect, openOptionsPage: async () => { optionsOpened++; },
    connectNative: name => {
      assert.ok(['com.review_focus.codex', 'com.review_focus.claude'].includes(name));
      const nativePort = {
        name,
        onMessage: event(), onDisconnect: event(), disconnected: false,
        postMessage: request => {
          nativePort.request = structuredClone(request);
          requests.push(structuredClone(request));
          queueMicrotask(() => {
            if (nativePort.disconnected) return;
            const response = nativeHandler(structuredClone(request), nativePort);
            if (response) void nativePort.onMessage.emit(structuredClone(response));
          });
        },
        disconnect: () => { nativePort.disconnected = true; },
        hostDisconnect: message => {
          chrome.runtime.lastError = message ? { message } : undefined;
          void nativePort.onDisconnect.emit();
          delete chrome.runtime.lastError;
        }
      };
      nativePorts.push(nativePort);
      return nativePort;
    }
  },
  action: { onClicked },
  storage: { local: {
    setAccessLevel: async value => { accessLevel = value.accessLevel; },
    get: async key => {
      storageReads.push(key);
      return { [key]: structuredClone(storage[key]) };
    },
    set: async value => { storage = { ...storage, ...structuredClone(value) }; },
    remove: async key => {
      assert.equal(accessLevel, 'TRUSTED_CONTEXTS', 'Legacy credentials must be removed only after storage is restricted.');
      delete storage[key];
    }
  } }
};

function sendMessage(message, sender = optionsSender) {
  return new Promise(resolve => onMessage.emit(message, sender, resolve));
}

const reviewPorts = [];
let nextTabId = 42;
function port(sender = { ...contentSender, tab: { id: nextTabId++ } }) {
  const messages = [];
  const reviewPort = {
    name: 'review-focus', sender, messages, disconnected: false,
    onMessage: event(), onDisconnect: event(),
    postMessage: message => messages.push(structuredClone(message)),
    disconnect() { this.disconnected = true; return this.onDisconnect.emit(); }
  };
  reviewPorts.push(reviewPort);
  return reviewPort;
}

try {
  nativeHandler = () => ({ type: 'result', result: assessment });
  const codexInput = { provider: 'codex', model: '', prompt: makePrompt(snapshot, classifications.edits), schema: analysisSchema, signal: new AbortController().signal };
  assert.deepEqual(await analyzeWithCLI(codexInput), assessment);
  assert.deepEqual(requests.at(-1), { type: 'analyze', model: '', prompt: codexInput.prompt, schema: analysisSchema });
  assert.equal(nativePorts.at(-1).disconnected, true, 'Successful requests must close the helper.');

  nativeHandler = (_request, helper) => helper.hostDisconnect('Specified native messaging host not found.');
  await assert.rejects(getCLIStatus('codex'), /helper is not installed/);
  assert.equal(nativePorts.at(-1).disconnected, true);
  nativeHandler = () => ({ type: 'status', authenticated: false, message: 'Sign in with codex login.' });
  assert.deepEqual(await getCLIStatus('codex'), { authenticated: false, message: 'Sign in with codex login.' });
  nativeHandler = () => ({ type: 'status', authenticated: 'yes' });
  await assert.rejects(getCLIStatus('codex'), /unreadable response/);
  for (const response of [null, [], 'not JSON', { type: 'status', authenticated: true }, { type: 'error' }]) {
    nativeHandler = () => response && !Array.isArray(response) && typeof response === 'object' ? response : { type: 'result', result: response };
    await assert.rejects(analyzeWithCLI(codexInput), /unreadable response/);
    assert.equal(nativePorts.at(-1).disconnected, true);
  }
  nativeHandler = () => ({ type: 'error', message: 'Codex is not logged in. Run codex login.' });
  await assert.rejects(analyzeWithCLI(codexInput), /Run codex login/);
  nativeHandler = (_request, helper) => helper.hostDisconnect('Native host has exited.');
  await assert.rejects(analyzeWithCLI(codexInput), /helper disconnected/);
  const aborted = new AbortController();
  aborted.abort();
  const beforeAborted = nativePorts.length;
  await assert.rejects(analyzeWithCLI({ ...codexInput, signal: aborted.signal }), /cancelled/);
  assert.equal(nativePorts.length, beforeAborted, 'A cancelled request must not start a helper.');
  await assert.rejects(getCLIStatus('other'), /Choose Codex or Claude Code/);
  assert.equal(nativePorts.length, beforeAborted, 'An invalid provider must never choose a native host.');

  await import('./extension/background.js');
  assert.equal(accessLevel, 'TRUSTED_CONTEXTS');
  nativeHandler = () => ({ type: 'status', authenticated: true });
  assert.deepEqual(await sendMessage({ type: 'get-settings' }, contentSender), { configured: true, provider: 'codex', model: '' });
  assert.equal(storage.settings, undefined, 'Migration must delete the retired credential.');
  assert.ok(storageReads.every(key => ['reviewProvider', 'codexSettings'].includes(key)), 'Legacy providerless settings must never be read.');
  assert.match((await sendMessage({ type: 'save-settings', provider: 'codex', model: '' }, contentSender)).error, /Only the settings page/);
  assert.match((await sendMessage({ type: 'get-settings' }, { ...contentSender, frameId: 1 })).error, /cannot use PRiorities/);
  assert.match((await sendMessage({ type: 'get-settings' }, { ...contentSender, url: 'https://github.com.attacker.example/example/repository/pull/7' })).error, /cannot use PRiorities/);
  assert.match((await sendMessage({ type: 'save-settings', provider: 'codex', apiKey: 'rejected-credential', model: '' })).error, /Only provider and model preferences/);
  assert.match((await sendMessage({ type: 'save-settings', provider: 'codex', model: 'model; echo bad' })).error, /valid model/);
  assert.match((await sendMessage({ type: 'delete-key' })).error, /Unknown/);
  assert.equal((await sendMessage({ type: 'save-settings', provider: 'codex', model: 'codex-test-model' })).configured, true);
  assert.deepEqual(storage.codexSettings, { model: 'codex-test-model' });
  assert.equal((await sendMessage({ type: 'save-settings', provider: 'codex', model: '' })).configured, true);
  assert.deepEqual(storage, { reviewProvider: 'codex', codexSettings: { model: '' } });
  assert.match((await sendMessage({ type: 'get-settings', provider: 'claude' }, contentSender)).error, /Only the settings page/);
  for (const invalid of ['', 'anthropic', '../claude', null]) {
    assert.match((await sendMessage({ type: 'get-settings', provider: invalid })).error, /Choose Codex or Claude Code/);
    assert.match((await sendMessage({ type: 'save-settings', provider: invalid, model: '' })).error, /Choose Codex or Claude Code/);
  }
  const preview = await sendMessage({ type: 'get-settings', provider: 'claude' });
  assert.deepEqual(preview, { configured: true, provider: 'claude', model: '' });
  assert.equal(storage.reviewProvider, 'codex', 'Previewing a connection must not switch new reviews.');
  assert.equal(nativePorts.at(-1).name, 'com.review_focus.claude');
  assert.ok(!JSON.stringify(await sendMessage({ type: 'get-settings' }, contentSender)).includes(retiredCredential));
  assert.ok(!JSON.stringify(await sendMessage({ type: 'get-settings' })).includes(retiredCredential));
  nativeHandler = (_request, helper) => helper.hostDisconnect('Specified native messaging host not found.');
  const missingHelper = await sendMessage({ type: 'get-settings' });
  assert.equal(missingHelper.configured, false);
  assert.match(missingHelper.connectionError, /helper is not installed/);
  nativeHandler = () => ({ type: 'status', authenticated: false, message: 'Run codex login.' });
  assert.deepEqual(await sendMessage({ type: 'get-settings' }), { configured: false, provider: 'codex', model: '', connectionError: 'Run codex login.' });
  await sendMessage({ type: 'open-settings' }, contentSender);
  await onClicked.emit();
  assert.equal(optionsOpened, 2);

  nativeHandler = stagedResponses(classifications, assessment);
  const beforeReview = requests.length;
  const reviewPort = await beginReview();
  await waitForSettlement(reviewPort);
  const result = reviewPort.messages.find(message => message.type === 'result');
  const stageRequests = requests.slice(beforeReview);
  assert.equal(stageRequests.length, 3, 'A file classification and prioritization must precede the final check.');
  assert.deepEqual(stageRequests[0].schema, classificationSchema);
  assert.deepEqual(stageRequests[1].schema, analysisSchema);
  const classificationEvidence = JSON.parse(stageRequests[0].prompt.user);
  assert.deepEqual(classificationEvidence.changedPaths, ['account.js']);
  const { classifications: sentClassifications, ...prioritizationEvidence } = JSON.parse(stageRequests[1].prompt.user);
  assert.deepEqual(sentClassifications, classifications.edits);
  assert.deepEqual(prioritizationEvidence, classificationEvidence, 'Per-file prioritization must retain its source and classification evidence.');
  assert.deepEqual(fileStates(reviewPort, 'account.js'), ['queued', 'classifying', 'prioritizing', 'complete']);
  const completedFile = reviewPort.messages.find(message => message.state === 'complete');
  const finalCheck = reviewPort.messages.findIndex(message => message.stage === 'checking');
  assert.ok(reviewPort.messages.indexOf(completedFile) < finalCheck, 'Publish each file before the cross-file check.');
  assert.deepEqual(completedFile.analysis.classifications, classifications.edits);
  assert.deepEqual(result.analysis.classifications, classifications.edits, 'Mixed and unknown classifications must survive the final check.');
  assert.equal(result.analysis.headSha, snapshot.headSha);
  assert.equal(result.analysis.topics[0].excerpts[0].rows[0].text, 'if (!account) return null;');
  assert.equal(result.analysis.topics[0].changedLines, 3);
  const finalEvidence = JSON.parse(stageRequests[2].prompt.user);
  assert.equal(finalEvidence.provisionalReviews[0].path, 'account.js');
  assert.equal(finalEvidence.provisionalReviews[0].topics[0].priority, 'review');
  assert.equal(finalEvidence.provisionalReviews[0].topics[0].excerpts, undefined, 'Hydrated source rows must not be repeated in provisional notes.');
  assert.equal(finalEvidence.changedPaths, undefined);
  assert.ok(!JSON.stringify(reviewPort.messages).includes(retiredCredential));

  const consequentialChanges = [
    ['authorization.js', 'return allow(role);', 'return true;', 'Who is now authorized?'],
    ['payments.js', 'debit(amount);', 'debit(amount * 100);', 'Which currency unit does debit accept?'],
    ['tokens.js', 'save(hash(token));', 'save(token);', 'Must persisted tokens be hashed?'],
    ['retry.js', 'sendOnce();', 'retryForever(send);', 'What stops retries after a permanent failure?'],
    ['consent.js', 'syncConsent();', 'enqueueSync();', 'What happens if queuing fails?']
  ];
  const manyDecisions = { ...snapshot, files: consequentialChanges.map(([path, before, after], index) => ({
    path, hunks: [{ header: '@@ -1 +1 @@', items: [{ type: 'edit', id: `${index}-0-0`, rows: [
      { type: 'delete', text: before, oldLine: 1, newLine: null },
      { type: 'add', text: after, oldLine: null, newLine: 1 }
    ] }] }]
  })) };
  manyDecisions.context = consequentialChanges.map(([path, , after]) => ({ path, side: 'after', text: `${after}\n` }));
  manyDecisions.files.push({ path: 'logo.png', hunks: [] });
  const completeReview = { summary: 'Five independent contracts need attention.', topics: consequentialChanges.map(([path, before, after, question], index) => ({
    ...assessment.topics[0], id: `decision-${index}`, title: question, before, after, question,
    editIds: [`${index}-0-0`], excerpts: [{ path, side: 'after', startLine: 1, endLine: 1 }]
  })) };
  const manyClassifications = { edits: consequentialChanges.map(([_path, before, after], index) => ({
    editId: `${index}-0-0`, kinds: ['behavior'], reason: `${before} becomes ${after}`, uncertainty: ''
  })) };
  const normalResponse = stagedResponses(manyClassifications, completeReview);
  const pending = [];
  nativeHandler = (request, helper) => { pending.push({ request, helper }); };
  const beforeParallel = requests.length;
  const parallel = await beginReview(manyDecisions);
  await until(() => pending.length === 3, 'Three independent helpers should start concurrently.');
  assert.deepEqual(parallel.messages.slice(0, 6).map(message => message.state), ['queued', 'queued', 'queued', 'queued', 'queued', 'skipped']);
  assert.equal(nativePorts.filter(helper => !helper.disconnected).length, 3);
  assert.equal(requests.length - beforeParallel, 3, 'Only three file pipelines may be active.');
  for (const { request } of pending) {
    const evidence = JSON.parse(request.prompt.user);
    assert.equal(evidence.files.length, 1, 'File prompts must not repeat the entire PR.');
    assert.deepEqual(evidence.changedPaths, manyDecisions.files.map(file => file.path));
    assert.equal(evidence.context.length, 1);
    assert.equal(evidence.context[0].path, evidence.files[0].path);
    assert.equal(evidence.title, manyDecisions.title);
    assert.equal(evidence.description, manyDecisions.description);
    assert.equal(evidence.baseSha, manyDecisions.baseSha);
    assert.equal(evidence.headSha, manyDecisions.headSha);
  }
  const second = pending[1];
  await second.helper.onMessage.emit(normalResponse(second.request));
  await until(() => pending.length === 4, 'A classification must be followed by prioritization for the same file.');
  assert.equal(JSON.parse(pending[3].request.prompt.user).files[0].path, 'payments.js');
  assert.equal(nativePorts.filter(helper => !helper.disconnected).length, 3);
  await pending[3].helper.onMessage.emit(normalResponse(pending[3].request));
  await until(() => pending.length === 5, 'A completed file must release a queue slot.');
  assert.equal(JSON.parse(pending[4].request.prompt.user).files[0].path, 'retry.js');
  assert.deepEqual(parallel.messages.filter(message => message.state === 'complete').map(message => message.path), ['payments.js'], 'An out-of-order result must be published immediately.');
  assert.equal(fileStates(parallel, 'authorization.js').at(-1), 'classifying');
  assert.equal(fileStates(parallel, 'consent.js').at(-1), 'queued');
  nativeHandler = normalResponse;
  for (const held of pending.filter(item => !item.helper.disconnected)) await held.helper.onMessage.emit(normalResponse(held.request));
  await waitForSettlement(parallel);
  assert.equal(parallel.messages.at(-1).type, 'result');
  assert.equal(parallel.messages.at(-1).analysis.topics.filter(topic => topic.priority === 'review').length, 5, 'The display budget must not demote a fifth concern.');
  assert.equal(requests.length - beforeParallel, 11, 'Five files require two requests each and one final check; no-text files require none.');
  assert.deepEqual(fileStates(parallel, 'logo.png'), ['skipped']);
  assert.equal(JSON.parse(requests.at(-1).prompt.user).files.length, 6, 'The final check must receive the full captured inventory.');
  assert.equal(JSON.parse(requests.at(-1).prompt.user).provisionalReviews.length, 5);

  const generatedPaths = ['authorization.js', 'package-lock.json', 'generated/client.js'];
  const generatedSnapshot = {
    ...manyDecisions,
    files: manyDecisions.files.slice(0, 3).map((file, index) => ({
      ...structuredClone(file), path: generatedPaths[index], ...(index === 2 ? { isGenerated: true } : {})
    })),
    context: manyDecisions.context.slice(0, 3).map((source, index) => ({
      ...source, path: generatedPaths[index], text: index ? `GENERATED_SOURCE_${index}\n` : source.text
    }))
  };
  for (const [index, file] of generatedSnapshot.files.entries()) {
    if (index) file.hunks[0].items[0].rows[1].text = `GENERATED_DIFF_${index}`;
  }
  generatedSnapshot.files.push({ path: 'generated/data.bin', isGenerated: true, hunks: [] });
  generatedSnapshot.context.push({ path: 'generated/data.bin', side: 'after', text: 'GENERATED_BINARY_CONTEXT' });
  const generatedAssessment = {
    ...completeReview,
    topics: completeReview.topics.slice(0, 3).map((topic, index) => ({
      ...topic, excerpts: topic.excerpts.map(excerpt => ({ ...excerpt, path: generatedPaths[index] }))
    }))
  };
  const generatedResponse = stagedResponses({ edits: manyClassifications.edits.slice(0, 3) }, generatedAssessment);

  const twoEdits = structuredClone(snapshot);
  twoEdits.files[0].hunks[0].items.push({ type: 'edit', id: '1-1-2', rows: [
    { type: 'delete', text: 'return undefined;', oldLine: 2, newLine: null },
    { type: 'add', text: 'return null;', oldLine: null, newLine: 3 }
  ] });
  const twoClassifications = { edits: [classifications.edits[0], { ...classifications.edits[0], editId: '1-1-2' }] };
  for (const [name, mutate, error] of [
    ['omitted edit', inventory => { inventory.edits.pop(); }, /account for every edit/],
    ['duplicate edit', inventory => { inventory.edits[1] = inventory.edits[0]; }, /each edit exactly once/],
    ['invented edit', inventory => { inventory.edits[0].editId = 'invented-edit'; }, /each edit exactly once/],
    ['empty kinds', inventory => { inventory.edits[0].kinds = []; }, /invalid change kinds/],
    ['unrecognized kind', inventory => { inventory.edits[0].kinds = ['generated']; }, /invalid change kinds/],
    ['duplicate kind', inventory => { inventory.edits[0].kinds = ['rename', 'rename']; }, /invalid change kinds/],
    ['empty reason', inventory => { inventory.edits[0].reason = ' '; }, /did not explain a change/],
    ['unbounded reason', inventory => { inventory.edits[0].reason = 'x'.repeat(2001); }, /did not explain a change/],
    ['invalid uncertainty', inventory => { inventory.edits[0].uncertainty = null; }, /did not explain a change/],
    ['unknown without evidence gap', inventory => { inventory.edits[0].kinds = ['behavior', 'unknown']; inventory.edits[0].uncertainty = ''; }, /missing evidence/]
  ]) {
    const invalidInventory = structuredClone(twoClassifications);
    mutate(invalidInventory);
    nativeHandler = () => ({ type: 'result', result: invalidInventory });
    const before = requests.length;
    const rejected = await beginReview(twoEdits);
    await waitForSettlement(rejected);
    assert.equal(requests.length - before, 1, `${name} must stop before prioritization.`);
    assert.equal(rejected.messages.at(-1).state, 'incomplete', name);
    assert.match(rejected.messages.find(message => message.state === 'failed').message, error, name);
    assert.ok(!rejected.messages.some(message => message.state === 'prioritizing' || message.analysis || message.type === 'result'), name);
  }

  const unresolved = { edits: [{ ...classifications.edits[0], kinds: ['interface', 'unknown'] }] };
  const deferred = { ...assessment, topics: [{ ...assessment.topics[0], priority: 'supporting', excerpts: [] }] };
  nativeHandler = stagedResponses(unresolved, deferred);
  const unknown = await beginReview();
  await waitForSettlement(unknown);
  for (const message of unknown.messages.filter(message => message.analysis)) {
    assert.equal(message.analysis.topics[0].priority, 'supporting');
    assert.deepEqual(message.analysis.classifications, unresolved.edits, 'Provisional and final results must retain unknown labels so those edits remain visible.');
  }

  for (const [name, mutate, error] of [
    ['missing evidence', review => { review.topics[0].excerpts = []; }, /does not cite its changed code/],
    ['unread source', review => { review.topics[0].excerpts[0].startLine = 99; review.topics[0].excerpts[0].endLine = 99; }, /source that was not read/],
    ['unexplained deferral', review => { review.topics[0].priority = 'supporting'; review.topics[0].reason = ' '; }, /did not explain/],
    ['invented edit', review => { review.topics[0].editIds = ['invented-edit']; }, /map each edit exactly once/]
  ]) {
    const invalidReview = structuredClone(assessment);
    mutate(invalidReview);
    nativeHandler = request => ({ type: 'result', result: request.schema.properties.edits ? classifications : invalidReview });
    const rejected = await beginReview();
    await waitForSettlement(rejected);
    assert.equal(rejected.messages.at(-1).state, 'incomplete', name);
    assert.match(rejected.messages.find(message => message.state === 'failed').message, error, name);
    assert.ok(!rejected.messages.some(message => message.analysis || message.type === 'result'), `${name} must not reach the folding UI.`);
  }

  const requestCount = requests.length;
  const mismatched = await beginReview({ ...snapshot, url: 'https://github.com/another/repo/pull/9' });
  assert.equal(mismatched.messages.at(-1).type, 'error');
  assert.match(mismatched.messages.at(-1).message, /does not match this pull request/);
  assert.equal(requests.length, requestCount);
  const untrusted = port({ ...contentSender, frameId: 1 });
  await onConnect.emit(untrusted);
  assert.equal(untrusted.disconnected, true);

  let failPayment = true;
  nativeHandler = request => {
    const evidence = JSON.parse(request.prompt.user);
    if (failPayment && evidence.files.length === 1 && evidence.files[0].path === 'payments.js' && !request.schema.properties.edits) {
      return { type: 'error', message: 'Codex usage limit reached. Try again later.' };
    }
    return normalResponse(request);
  };
  const beforeFailure = requests.length;
  const isolated = await beginReview(manyDecisions);
  await waitForSettlement(isolated);
  assert.equal(isolated.messages.at(-1).state, 'incomplete');
  assert.equal(isolated.messages.filter(message => message.state === 'complete').length, 4);
  assert.match(isolated.messages.find(message => message.state === 'failed').message, /usage limit/);
  assert.ok(!isolated.messages.some(message => message.stage === 'checking'), 'The final check must wait for every text file to succeed.');
  assert.equal(requests.length - beforeFailure, 10);
  const beforeRetry = requests.length;
  let retryAfter = isolated.messages.length;
  failPayment = false;
  await isolated.onMessage.emit({ type: 'retry-file', path: 'payments.js', snapshot: { ...snapshot, headSha: 'c'.repeat(40) } });
  await waitForSettlement(isolated, retryAfter);
  assert.equal(isolated.messages.at(-1).type, 'result');
  assert.equal(requests.length - beforeRetry, 3, 'Retry only the failed file, then run the final check.');
  assert.equal(isolated.messages.filter(message => message.state === 'complete' && message.path === 'authorization.js').length, 1);
  for (const request of requests.slice(beforeRetry)) assert.equal(JSON.parse(request.prompt.user).headSha, manyDecisions.headSha, 'Retries must use the original pinned snapshot.');
  const afterSuccess = requests.length;
  await isolated.onMessage.emit({ type: 'retry-file', path: 'payments.js' });
  await isolated.onMessage.emit({ type: 'retry-file', path: '../unknown' });
  await isolated.onMessage.emit({ type: 'retry-final' });
  assert.equal(requests.length, afterSuccess, 'Only failed or cancelled work can be retried.');

  let failFinal = true;
  nativeHandler = request => JSON.parse(request.prompt.user).provisionalReviews && failFinal
    ? { type: 'error', message: 'The final check could not finish.' }
    : normalResponse(request);
  const finalFailure = await beginReview(manyDecisions);
  await waitForSettlement(finalFailure);
  assert.equal(finalFailure.messages.at(-1).state, 'check-failed');
  assert.equal(finalFailure.messages.filter(message => message.state === 'complete').length, 5);
  assert.ok(!finalFailure.messages.some(message => message.state === 'failed'), 'A failed final check must not discard completed files.');
  const beforeFinalRetry = requests.length;
  retryAfter = finalFailure.messages.length;
  failFinal = false;
  await finalFailure.onMessage.emit({ type: 'retry-final' });
  await waitForSettlement(finalFailure, retryAfter);
  assert.equal(finalFailure.messages.at(-1).type, 'result');
  assert.equal(requests.length - beforeFinalRetry, 1, 'Retry the final check without repeating file analyses.');

  nativeHandler = stagedResponses(classifications, assessment);
  const betweenStages = port();
  const postMessage = betweenStages.postMessage;
  betweenStages.postMessage = message => {
    postMessage(message);
    if (message.state === 'prioritizing') void betweenStages.onMessage.emit({ type: 'cancel' });
  };
  await onConnect.emit(betweenStages);
  const beforeCancellation = requests.length;
  await betweenStages.onMessage.emit({ type: 'analyze', snapshot });
  await waitForSettlement(betweenStages);
  assert.equal(requests.length - beforeCancellation, 1, 'Cancellation between stages must prevent the second request.');
  assert.equal(betweenStages.messages.at(-1).state, 'cancelled');
  assert.ok(!betweenStages.messages.some(message => message.analysis));

  for (const stage of ['classifying', 'prioritizing']) {
    let started = false;
    nativeHandler = request => {
      if (stage === 'prioritizing' && request.schema.properties.edits) return { type: 'result', result: classifications };
      started = true;
    };
    const before = requests.length;
    const cancellable = await beginReview();
    await until(() => started, 'The selected stage should start.');
    const duplicate = port(cancellable.sender);
    await onConnect.emit(duplicate);
    await duplicate.onMessage.emit({ type: 'analyze', snapshot });
    assert.match(duplicate.messages.at(-1).message, /already has an analysis/);
    await cancellable.onMessage.emit({ type: 'cancel' });
    await waitForSettlement(cancellable);
    assert.equal(cancellable.messages.at(-1).state, 'cancelled', stage);
    assert.equal(nativePorts.at(-1).disconnected, true, 'Cancellation must close the running helper.');
    assert.equal(requests.length - before, stage === 'classifying' ? 1 : 2);
    assert.ok(!cancellable.messages.some(message => message.analysis), stage);
    await duplicate.onMessage.emit({ type: 'analyze', snapshot });
    assert.match(duplicate.messages.at(-1).message, /already has an analysis/, 'Cancelled sessions retain their pinned results until disconnected.');
    await cancellable.disconnect();
    nativeHandler = stagedResponses(classifications, assessment);
    const duplicateAfter = duplicate.messages.length;
    await duplicate.onMessage.emit({ type: 'analyze', snapshot });
    await waitForSettlement(duplicate, duplicateAfter);
    assert.equal(duplicate.messages.at(-1).type, 'result', 'Disconnecting must release the tab session.');
  }

  const heldForCancellation = [];
  nativeHandler = (request, helper) => {
    if (JSON.parse(request.prompt.user).files[0].path === 'authorization.js') return normalResponse(request);
    heldForCancellation.push(helper);
  };
  const cancelledQueue = await beginReview(manyDecisions);
  await until(() => heldForCancellation.length === 3 && cancelledQueue.messages.some(message => message.state === 'complete'), 'One file should complete while three others run.');
  assert.equal(fileStates(cancelledQueue, 'consent.js').at(-1), 'queued');
  const beforeCancel = requests.length;
  await cancelledQueue.onMessage.emit({ type: 'cancel' });
  await waitForSettlement(cancelledQueue);
  assert.equal(cancelledQueue.messages.at(-1).state, 'cancelled');
  assert.ok(heldForCancellation.every(helper => helper.disconnected));
  assert.equal(requests.length, beforeCancel, 'Cancellation must not start queued work.');
  assert.equal(cancelledQueue.messages.filter(message => message.state === 'complete').length, 1);
  assert.equal(fileStates(cancelledQueue, 'consent.js').at(-1), 'cancelled');
  nativeHandler = normalResponse;
  retryAfter = cancelledQueue.messages.length;
  for (const [path] of consequentialChanges.slice(1)) await cancelledQueue.onMessage.emit({ type: 'retry-file', path });
  await waitForSettlement(cancelledQueue, retryAfter);
  assert.equal(cancelledQueue.messages.at(-1).type, 'result');
  assert.equal(cancelledQueue.messages.filter(message => message.state === 'complete' && message.path === 'authorization.js').length, 1);

  let finalHeld;
  nativeHandler = (request, helper) => {
    if (JSON.parse(request.prompt.user).provisionalReviews) { finalHeld = helper; return; }
    return stagedResponses(classifications, assessment)(request);
  };
  const cancelledFinal = await beginReview();
  await until(() => finalHeld, 'The final check should start.');
  await cancelledFinal.onMessage.emit({ type: 'cancel' });
  await waitForSettlement(cancelledFinal);
  assert.equal(finalHeld.disconnected, true);
  assert.equal(cancelledFinal.messages.at(-1).state, 'cancelled');
  assert.equal(cancelledFinal.messages.filter(message => message.state === 'complete').length, 1);
  nativeHandler = stagedResponses(classifications, assessment);
  const beforeCancelledFinalRetry = requests.length;
  retryAfter = cancelledFinal.messages.length;
  await cancelledFinal.onMessage.emit({ type: 'retry-final' });
  await waitForSettlement(cancelledFinal, retryAfter);
  assert.equal(cancelledFinal.messages.at(-1).type, 'result');
  assert.equal(requests.length - beforeCancelledFinalRetry, 1);

  const clock = fakeClock();
  const clockPortsStart = reviewPorts.length;
  try {
    const delayed = [];
    nativeHandler = (request, helper) => {
      if (request.schema.properties.edits) { delayed.push({ request, helper }); return; }
      return normalResponse(request);
    };
    const longReview = await beginReview(manyDecisions);
    await until(() => delayed.length === 3, 'The first batch should run.');
    assert.equal([...clock.timers.values()].filter(timer => !timer.interval).length, 3, 'Timeouts belong to file pipelines, not the entire PR.');
    clock.tick(400_000);
    for (const held of delayed.slice(0, 3)) await held.helper.onMessage.emit(normalResponse(held.request));
    await until(() => delayed.length === 5, 'The second batch should run.');
    clock.tick(300_000);
    assert.ok(!longReview.messages.some(message => ['failed', 'cancelled'].includes(message.state)), 'A PR lasting longer than 10 minutes must not cancel younger file jobs.');
    for (const held of delayed.slice(3)) await held.helper.onMessage.emit(normalResponse(held.request));
    await waitForSettlement(longReview);
    assert.equal(longReview.messages.at(-1).type, 'result');
    assert.equal(clock.timers.size, 0);

    const twoFiles = { ...manyDecisions, files: manyDecisions.files.slice(0, 2), context: manyDecisions.context.slice(0, 2) };
    let timedOutHelper;
    nativeHandler = (request, helper) => {
      if (JSON.parse(request.prompt.user).files[0].path === 'payments.js') { timedOutHelper = helper; return; }
      return normalResponse(request);
    };
    const timeoutReview = await beginReview(twoFiles);
    await until(() => timedOutHelper && timeoutReview.messages.some(message => message.state === 'complete'), 'One file should finish before its sibling times out.');
    clock.tick(600_001);
    await waitForSettlement(timeoutReview);
    assert.equal(timedOutHelper.disconnected, true);
    assert.equal(timeoutReview.messages.at(-1).state, 'incomplete');
    assert.match(timeoutReview.messages.find(message => message.state === 'failed').message, /This file timed out after 10 minutes/);
    assert.equal(timeoutReview.messages.filter(message => message.state === 'complete').length, 1);
    assert.deepEqual([...clock.timers.values()].map(timer => timer.interval), [20_000], 'Retryable idle sessions need a port-message heartbeat.');
    const idleSettlement = timeoutReview.messages.at(-1);
    const beforeIdle = timeoutReview.messages.length;
    const beforeIdleCalls = requests.length;
    clock.tick(19_999);
    assert.equal(timeoutReview.messages.length, beforeIdle);
    clock.tick(40_001);
    assert.deepEqual(timeoutReview.messages.slice(beforeIdle), [idleSettlement, idleSettlement, idleSettlement], 'Idle progress must keep sending the same settled state before Chrome’s 30-second idle deadline.');
    assert.equal(requests.length, beforeIdleCalls, 'Keeping a retry available must not start a Codex request.');
    let idleRetry;
    nativeHandler = (request, helper) => { idleRetry = { request, helper }; };
    retryAfter = timeoutReview.messages.length;
    await timeoutReview.onMessage.emit({ type: 'retry-file', path: 'payments.js' });
    await until(() => idleRetry, 'A retained idle file must remain retryable.');
    assert.ok([...clock.timers.values()].every(timer => timer.interval !== 20_000), 'Retrying must stop the idle heartbeat.');
    clock.tick(20_000);
    assert.ok(!timeoutReview.messages.slice(retryAfter).some(message => message.type === 'settled'), 'An old settled heartbeat must not overwrite running progress.');
    nativeHandler = normalResponse;
    await idleRetry.helper.onMessage.emit(normalResponse(idleRetry.request));
    await waitForSettlement(timeoutReview, retryAfter);
    assert.equal(timeoutReview.messages.at(-1).type, 'result');
    assert.equal(clock.timers.size, 0, 'A successful final check must release every timer.');
    const afterIdleSuccess = timeoutReview.messages.length;
    clock.tick(60_000);
    assert.equal(timeoutReview.messages.length, afterIdleSuccess, 'Completed sessions must not keep the service worker alive.');

    let idleFinalHelper;
    nativeHandler = (request, helper) => {
      if (JSON.parse(request.prompt.user).provisionalReviews) { idleFinalHelper = helper; return; }
      return stagedResponses(classifications, assessment)(request);
    };
    const idleCancelledFinal = await beginReview();
    await until(() => idleFinalHelper, 'The final check should start before cancellation.');
    await idleCancelledFinal.onMessage.emit({ type: 'cancel' });
    await waitForSettlement(idleCancelledFinal);
    assert.equal(idleFinalHelper.disconnected, true);
    const cancelledSettlement = idleCancelledFinal.messages.at(-1);
    assert.equal(cancelledSettlement.state, 'cancelled');
    const beforeCancelledIdle = idleCancelledFinal.messages.length;
    const beforeCancelledIdleCalls = requests.length;
    clock.tick(40_000);
    assert.deepEqual(idleCancelledFinal.messages.slice(beforeCancelledIdle), [cancelledSettlement, cancelledSettlement]);
    assert.equal(requests.length, beforeCancelledIdleCalls);
    nativeHandler = stagedResponses(classifications, assessment);
    retryAfter = idleCancelledFinal.messages.length;
    await idleCancelledFinal.onMessage.emit({ type: 'retry-final' });
    await waitForSettlement(idleCancelledFinal, retryAfter);
    assert.equal(idleCancelledFinal.messages.at(-1).type, 'result');
    assert.equal(requests.length - beforeCancelledIdleCalls, 1, 'A cancelled final check must remain independently retryable after idling.');
    assert.equal(clock.timers.size, 0);

    nativeHandler = request => JSON.parse(request.prompt.user).provisionalReviews
      ? { type: 'error', message: 'The final check failed.' }
      : stagedResponses(classifications, assessment)(request);
    const idleFailedFinal = await beginReview();
    await waitForSettlement(idleFailedFinal);
    const failedSettlement = idleFailedFinal.messages.at(-1);
    assert.equal(failedSettlement.state, 'check-failed');
    const beforeFailedIdle = idleFailedFinal.messages.length;
    clock.tick(20_000);
    assert.deepEqual(idleFailedFinal.messages.slice(beforeFailedIdle), [failedSettlement]);
    const oldHeartbeat = [...clock.timers.keys()][0];
    await idleFailedFinal.onMessage.emit({ type: 'cancel' });
    assert.equal(clock.timers.has(oldHeartbeat), false, 'Cancellation must clear the previous idle state’s heartbeat.');
    assert.equal(clock.timers.size, 1, 'Cancellation may retain one heartbeat for its updated retryable state.');
    const beforeIdleDisconnect = idleFailedFinal.messages.length;
    await idleFailedFinal.disconnect();
    assert.equal(clock.timers.size, 0, 'Disconnecting an idle review must release its heartbeat.');
    clock.tick(60_000);
    assert.equal(idleFailedFinal.messages.length, beforeIdleDisconnect);

    nativeHandler = generatedResponse;
    const beforeGenerated = requests.length;
    const defaultGenerated = await beginReview(generatedSnapshot);
    await waitForSettlement(defaultGenerated);
    const defaultRequests = requests.slice(beforeGenerated);
    assert.equal(defaultRequests.length, 3, 'Only the ordinary file needs classification, prioritization and a final check.');
    assert.deepEqual(fileStates(defaultGenerated, 'package-lock.json'), ['excluded']);
    assert.deepEqual(fileStates(defaultGenerated, 'generated/client.js'), ['excluded']);
    assert.deepEqual(fileStates(defaultGenerated, 'generated/data.bin'), ['skipped']);
    assert.equal(defaultGenerated.messages.at(-1).analysis.classifications.length, 1);
    for (const request of defaultRequests) {
      const evidence = JSON.parse(request.prompt.user);
      assert.deepEqual(evidence.files.map(file => file.path), ['authorization.js']);
      assert.deepEqual(evidence.context.map(source => source.path), ['authorization.js']);
      assert.ok(!request.prompt.user.includes('GENERATED_'), 'Excluded diff and source context must never reach Codex.');
      if (evidence.changedPaths) assert.deepEqual(evidence.changedPaths, ['authorization.js']);
    }
    const generatedFinalEvidence = JSON.parse(defaultRequests.at(-1).prompt.user);
    assert.ok(generatedFinalEvidence.evidenceLimits.some(warning => warning.includes('package-lock.json') && warning.includes('generated/client.js') && warning.includes('generated/data.bin')));
    const beforeCompleteIdle = defaultGenerated.messages.length;
    clock.tick(60_000);
    assert.deepEqual(defaultGenerated.messages.slice(beforeCompleteIdle), [{ type: 'heartbeat' }, { type: 'heartbeat' }, { type: 'heartbeat' }], 'A completed review with excluded files must keep Review anyway available without replaying its result.');
    assert.equal(requests.length - beforeGenerated, 3, 'The idle session must not make model calls.');
    let requestedLockfile;
    nativeHandler = (request, helper) => { requestedLockfile = { request, helper }; };
    const beforeExplicitReview = requests.length;
    const beforeExplicitMessages = defaultGenerated.messages.length;
    await defaultGenerated.onMessage.emit({ type: 'review-file', path: 'package-lock.json', snapshot: { ...generatedSnapshot, headSha: 'c'.repeat(40) } });
    await until(() => requestedLockfile, 'Review anyway must start after the final review has been idle.');
    assert.ok([...clock.timers.values()].every(timer => timer.interval !== 20_000));
    for (const path of ['package-lock.json', 'authorization.js', '../unknown', 'generated/data.bin']) {
      await defaultGenerated.onMessage.emit({ type: 'review-file', path });
    }
    assert.equal(requests.length - beforeExplicitReview, 1, 'Duplicate, completed, unknown and no-text files must not be force queued.');
    nativeHandler = generatedResponse;
    await requestedLockfile.helper.onMessage.emit(generatedResponse(requestedLockfile.request));
    await waitForSettlement(defaultGenerated, beforeExplicitMessages);
    assert.equal(requests.length - beforeExplicitReview, 3, 'Review only the requested file, then repeat the final check.');
    assert.equal(defaultGenerated.messages.at(-1).analysis.classifications.length, 2);
    assert.equal(defaultGenerated.messages.filter(message => message.state === 'complete' && message.path === 'authorization.js').length, 1);
    for (const request of requests.slice(beforeExplicitReview)) {
      const evidence = JSON.parse(request.prompt.user);
      assert.equal(evidence.headSha, generatedSnapshot.headSha, 'Explicit review must use the pinned revision, ignoring a replacement snapshot.');
      assert.ok(!request.prompt.user.includes('GENERATED_DIFF_2') && !request.prompt.user.includes('GENERATED_SOURCE_2') && !request.prompt.user.includes('GENERATED_BINARY_CONTEXT'));
    }
    assert.ok(JSON.parse(requests.at(-1).prompt.user).files.some(file => file.path === 'package-lock.json'));
    await defaultGenerated.disconnect();
    assert.equal(clock.timers.size, 0, 'Disconnecting a successful review must release its optional-file heartbeat.');

    const generatedOnly = {
      ...generatedSnapshot,
      files: generatedSnapshot.files.slice(1),
      context: generatedSnapshot.context.filter(source => source.path !== 'authorization.js')
    };
    const beforeGeneratedOnly = requests.length;
    const excludedReview = await beginReview(generatedOnly);
    await waitForSettlement(excludedReview);
    assert.equal(excludedReview.messages.at(-1).state, 'excluded');
    assert.equal(requests.length, beforeGeneratedOnly, 'An all-generated PR must make zero model calls by default.');
    clock.tick(60_000);
    assert.equal(requests.length, beforeGeneratedOnly);
    const beforeGeneratedOnlyForce = excludedReview.messages.length;
    await excludedReview.onMessage.emit({ type: 'review-file', path: 'generated/client.js' });
    await waitForSettlement(excludedReview, beforeGeneratedOnlyForce);
    assert.equal(requests.length - beforeGeneratedOnly, 3);
    assert.equal(excludedReview.messages.at(-1).type, 'result');
    assert.deepEqual(JSON.parse(requests.at(-1).prompt.user).files.map(file => file.path), ['generated/client.js']);
    await excludedReview.disconnect();
    assert.equal(clock.timers.size, 0);

    let supersededCheck;
    nativeHandler = (request, helper) => {
      if (!supersededCheck && JSON.parse(request.prompt.user).provisionalReviews) {
        supersededCheck = { request, helper };
        return;
      }
      return generatedResponse(request);
    };
    const beforeSuperseded = requests.length;
    const supersededReview = await beginReview(generatedSnapshot);
    await until(() => supersededCheck, 'The original final check should be running.');
    const beforeSupersededMessages = supersededReview.messages.length;
    await supersededReview.onMessage.emit({ type: 'review-file', path: 'package-lock.json' });
    await waitForSettlement(supersededReview, beforeSupersededMessages);
    assert.equal(supersededCheck.helper.disconnected, true, 'Adding a file must abort the final check that omitted it.');
    assert.equal(requests.length - beforeSuperseded, 6, 'Replace only the stale final check, adding two calls for the requested file.');
    assert.equal(supersededReview.messages.filter(message => message.type === 'result').length, 1);
    assert.ok(!supersededReview.messages.slice(beforeSupersededMessages).some(message => message.type === 'settled'), 'Superseding a final check must not publish a cancellation or failure.');
    assert.equal(supersededReview.messages.at(-1).analysis.classifications.length, 2);
    await supersededCheck.helper.onMessage.emit(generatedResponse(supersededCheck.request));
    assert.equal(supersededReview.messages.filter(message => message.type === 'result').length, 1, 'A late response from the aborted final check must not replace the expanded review.');
    await supersededReview.disconnect();
    assert.equal(clock.timers.size, 0);

    let cancelledSupersededCheck;
    nativeHandler = (request, helper) => {
      if (JSON.parse(request.prompt.user).provisionalReviews) {
        cancelledSupersededCheck = helper;
        return;
      }
      return generatedResponse(request);
    };
    const cancelledOptIn = await beginReview(generatedSnapshot);
    await until(() => cancelledSupersededCheck, 'The final check should start before opt-in and cancellation.');
    const beforeOptInCancellation = cancelledOptIn.messages.length;
    const requestingFile = cancelledOptIn.onMessage.emit({ type: 'review-file', path: 'package-lock.json' });
    const cancellingOptIn = cancelledOptIn.onMessage.emit({ type: 'cancel' });
    await Promise.all([requestingFile, cancellingOptIn]);
    await waitForSettlement(cancelledOptIn, beforeOptInCancellation);
    assert.equal(cancelledOptIn.messages.at(-1).state, 'cancelled');
    assert.equal(cancelledSupersededCheck.disconnected, true);
    assert.equal(fileStates(cancelledOptIn, 'package-lock.json').at(-1), 'cancelled');
    assert.equal(cancelledOptIn.messages.filter(message => message.state === 'complete' && message.path === 'authorization.js').length, 1);
    nativeHandler = generatedResponse;
    const beforeCancelledOptInRetry = requests.length;
    const beforeCancelledOptInMessages = cancelledOptIn.messages.length;
    await cancelledOptIn.onMessage.emit({ type: 'retry-file', path: 'package-lock.json' });
    await waitForSettlement(cancelledOptIn, beforeCancelledOptInMessages);
    assert.equal(cancelledOptIn.messages.at(-1).type, 'result');
    assert.equal(requests.length - beforeCancelledOptInRetry, 3, 'Cancelled explicit review remains included when retried, without rerunning completed ordinary files.');
    await cancelledOptIn.disconnect();
    assert.equal(clock.timers.size, 0);

    const generatedParallel = [];
    nativeHandler = (request, helper) => { generatedParallel.push({ request, helper }); };
    const parallelGeneratedReview = await beginReview(generatedSnapshot);
    await until(() => generatedParallel.length === 1, 'The ordinary file should start alone.');
    await parallelGeneratedReview.onMessage.emit({ type: 'review-file', path: 'package-lock.json' });
    await parallelGeneratedReview.onMessage.emit({ type: 'review-file', path: 'generated/client.js' });
    await until(() => generatedParallel.length === 3, 'Explicit files should reuse available queue slots.');
    assert.equal(nativePorts.filter(helper => !helper.disconnected).length, 3);
    nativeHandler = generatedResponse;
    for (const held of generatedParallel) await held.helper.onMessage.emit(generatedResponse(held.request));
    await waitForSettlement(parallelGeneratedReview);
    assert.equal(parallelGeneratedReview.messages.at(-1).analysis.classifications.length, 3);
    assert.ok(!requests.at(-1).prompt.user.includes('GENERATED_BINARY_CONTEXT'));
    assert.equal(clock.timers.size, 0, 'No-text generated files do not require a force-review session heartbeat.');
    await parallelGeneratedReview.disconnect();

    const savedGet = chrome.storage.local.get;
    let releaseSettings;
    chrome.storage.local.get = () => new Promise(resolve => { releaseSettings = resolve; });
    const initializingReview = port();
    await onConnect.emit(initializingReview);
    const beforeInitialization = requests.length;
    const initialization = initializingReview.onMessage.emit({ type: 'analyze', snapshot: generatedOnly });
    await until(() => releaseSettings, 'Settings must still be loading while initial file states are visible.');
    await initializingReview.onMessage.emit({ type: 'review-file', path: 'package-lock.json' });
    assert.equal(requests.length, beforeInitialization, 'Explicit review must wait for settings instead of failing the file.');
    releaseSettings({ codexSettings: { model: '' } });
    chrome.storage.local.get = savedGet;
    await initialization;
    await waitForSettlement(initializingReview);
    assert.equal(initializingReview.messages.at(-1).type, 'result');
    assert.equal(requests.length - beforeInitialization, 3);
    assert.ok(!initializingReview.messages.some(message => message.state === 'failed'));
    await initializingReview.disconnect();
    assert.equal(clock.timers.size, 0);

    nativeHandler = request => request.schema.properties.edits ? generatedResponse(request) : { type: 'error', message: 'Requested generated review failed.' };
    const failedGeneratedReview = await beginReview(generatedOnly);
    await waitForSettlement(failedGeneratedReview);
    const beforeForcedFailure = failedGeneratedReview.messages.length;
    await failedGeneratedReview.onMessage.emit({ type: 'review-file', path: 'package-lock.json' });
    await waitForSettlement(failedGeneratedReview, beforeForcedFailure);
    assert.equal(failedGeneratedReview.messages.at(-1).state, 'incomplete');
    assert.equal(fileStates(failedGeneratedReview, 'package-lock.json').at(-1), 'failed');
    const beforeForcedRetry = requests.length;
    const beforeForcedRetryMessages = failedGeneratedReview.messages.length;
    nativeHandler = generatedResponse;
    await failedGeneratedReview.onMessage.emit({ type: 'retry-file', path: 'package-lock.json' });
    await waitForSettlement(failedGeneratedReview, beforeForcedRetryMessages);
    assert.equal(requests.length - beforeForcedRetry, 3);
    assert.equal(failedGeneratedReview.messages.at(-1).type, 'result');
    assert.deepEqual(JSON.parse(requests.at(-1).prompt.user).files.map(file => file.path), ['package-lock.json']);
    await failedGeneratedReview.disconnect();
    assert.equal(clock.timers.size, 0);
  } finally {
    await Promise.all(reviewPorts.slice(clockPortsStart).map(reviewPort => reviewPort.disconnect()));
    clock.restore();
  }

  nativeHandler = () => ({ type: 'status', authenticated: true });
  await sendMessage({ type: 'save-settings', provider: 'codex', model: 'codex-saved-model' });
  assert.deepEqual(await sendMessage({ type: 'save-settings', provider: 'claude', model: 'claude-saved-model' }), { configured: true, provider: 'claude', model: 'claude-saved-model' });
  assert.deepEqual(storage.codexSettings, { model: 'codex-saved-model' });
  assert.deepEqual(storage.claudeSettings, { model: 'claude-saved-model' });
  assert.equal((await sendMessage({ type: 'get-settings' }, contentSender)).provider, 'claude');
  assert.equal((await sendMessage({ type: 'get-settings', provider: 'codex' })).model, 'codex-saved-model');
  nativeHandler = (_request, helper) => helper.name.endsWith('.claude') ? helper.hostDisconnect('Specified native messaging host not found.') : { type: 'status', authenticated: true };
  assert.match((await sendMessage({ type: 'get-settings' })).connectionError, /Claude Code helper is not installed/);
  assert.equal((await sendMessage({ type: 'get-settings', provider: 'codex' })).configured, true, 'A missing Claude helper must not break Codex.');

  const beforePinnedProvider = nativePorts.length;
  let heldClaude;
  nativeHandler = (request, helper) => {
    if (request.type === 'status') return { type: 'status', authenticated: true };
    heldClaude = { request, helper };
  };
  const pinnedProviderReview = await beginReview(generatedSnapshot);
  await until(() => heldClaude, 'The chosen Claude provider should start the first file.');
  await sendMessage({ type: 'save-settings', provider: 'codex', model: '' });
  nativeHandler = () => ({ type: 'error', message: 'Synthetic prioritization failure.' });
  await heldClaude.helper.onMessage.emit(generatedResponse(heldClaude.request));
  await waitForSettlement(pinnedProviderReview);
  assert.equal(fileStates(pinnedProviderReview, 'authorization.js').at(-1), 'failed');
  nativeHandler = generatedResponse;
  let afterPinnedMessages = pinnedProviderReview.messages.length;
  await pinnedProviderReview.onMessage.emit({ type: 'retry-file', path: 'authorization.js' });
  await waitForSettlement(pinnedProviderReview, afterPinnedMessages);
  afterPinnedMessages = pinnedProviderReview.messages.length;
  await pinnedProviderReview.onMessage.emit({ type: 'review-file', path: 'package-lock.json' });
  await waitForSettlement(pinnedProviderReview, afterPinnedMessages);
  const pinnedCalls = nativePorts.slice(beforePinnedProvider).filter(helper => helper.request?.type === 'analyze');
  assert.equal(pinnedCalls.length, 8, 'Initial failure, file retry and generated opt-in reuse the original provider.');
  assert.ok(pinnedCalls.every(helper => helper.name === 'com.review_focus.claude' && helper.request.model === 'claude-saved-model'), 'Every pass, retry and final check must keep the review’s provider and model despite settings changes.');
  await pinnedProviderReview.disconnect();
  nativeHandler = () => ({ type: 'status', authenticated: true });
  assert.equal((await sendMessage({ type: 'get-settings' }, contentSender)).provider, 'codex');
  assert.equal((await sendMessage({ type: 'get-settings', provider: 'claude' })).model, 'claude-saved-model');

  nativeHandler = () => ({ type: 'error', message: 'Codex is not logged in. Run codex login.' });
  const beforeUnconfigured = requests.length;
  const unconfigured = await beginReview();
  await waitForSettlement(unconfigured);
  assert.match(unconfigured.messages.find(message => message.state === 'failed').message, /Run codex login/);
  assert.equal(requests.length - beforeUnconfigured, 1, 'A login error must prevent prioritization.');

  let navigatingHelper;
  nativeHandler = (_request, helper) => { navigatingHelper = helper; };
  const navigating = await beginReview();
  await until(() => navigatingHelper, 'The request should start before navigation.');
  const beforeDisconnect = navigating.messages.length;
  await navigating.disconnect();
  await until(() => navigatingHelper.disconnected, 'Closing a PR must disconnect its helper.');
  assert.equal(navigating.messages.length, beforeDisconnect, 'A disconnected page must not receive stale results.');
  await Promise.all(reviewPorts.map(reviewPort => reviewPort.disconnect()));
  assert.ok(nativePorts.every(helper => helper.disconnected), 'Every native request must be cleaned up.');
  assert.ok(!JSON.stringify(requests).includes(retiredCredential), 'The retired API key must never reach native messages.');
  assert.ok(!JSON.stringify(requests).includes('apiKey'), 'No provider credentials belong in the native protocol.');
  console.log('Runtime verified: three concurrent file pipelines, immediate validated results, generated-file exclusion and explicit review, scoped final checks, late and concurrent opt-in, superseded check cancellation, isolated failure and retry, per-file timeouts, idle session heartbeats and cleanup, pinned evidence, trusted settings and native cleanup. No live Codex calls.');
} finally {
  await Promise.all(reviewPorts.map(reviewPort => reviewPort.disconnect()));
  globalThis.fetch = savedFetch;
  delete globalThis.chrome;
}
