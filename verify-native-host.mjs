import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { installNativeHost } from './install-native-host.mjs';

const root = await mkdtemp(join(tmpdir(), 'review-focus-host-test-'));
const origin = 'chrome-extension://bjmajanmepopjciklnijlfbdpafokfpe/';
const littleEndian = endianness() === 'LE';
const controlPath = join(root, 'control.json');
const callsPath = join(root, 'calls.jsonl');
const statusCallsPath = join(root, 'status-calls.jsonl');
const catalogCallsPath = join(root, 'catalog-calls.jsonl');
const startedPath = join(root, 'started.json');
const fakeCliPath = join(root, "fake cli ' `$safe`.mjs");
const schema = { type: 'object', properties: { edits: { type: 'array', items: { type: 'object' } } }, required: ['edits'], additionalProperties: false };
const request = { type: 'analyze', model: '', effort: '', prompt: { system: 'Classify every supplied edit.', user: 'A synthetic changed-line fixture.' }, schema };
const liveChildren = new Set();
const untrustedEnvironment = {
  OPENAI_API_KEY: 'test-secret-key', CODEX_API_KEY: 'test-secret-key',
  OPENAI_BASE_URL: 'https://untrusted.invalid', CODEX_THREAD_ID: 'parent-thread',
  CODEX_AGENT_ID: 'parent-agent', CODEX_SESSION_ID: 'parent-session',
  ANTHROPIC_API_KEY: 'test-secret-key', ANTHROPIC_AUTH_TOKEN: 'test-secret-key',
  ANTHROPIC_BASE_URL: 'https://untrusted.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'test-secret-key',
  CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1',
  ANTHROPIC_MODEL: 'unexpected-model', CLAUDECODE: 'parent-session', CLAUDE_CODE_SIMPLE: '1',
  CLAUDE_CODE_PLUGIN_DIR: '/untrusted-plugin', NODE_OPTIONS: '--trace-warnings'
};

function claudeEvents(answer, { chunk = 11, wait = 0, partial } = {}) {
  const text = partial ?? JSON.stringify(answer);
  const deltas = [];
  for (let offset = 0; offset < text.length; offset += chunk) {
    deltas.push({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text.slice(offset, offset + chunk) } } });
    if (wait) deltas.push({ wait });
  }
  return [
    { type: 'system', subtype: 'init', tools: ['StructuredOutput'] },
    { type: 'stream_event', event: { type: 'message_start', message: { role: 'assistant', content: [] } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'StructuredOutput', input: {} } } },
    ...deltas,
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    ...(answer ? [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'StructuredOutput', input: answer }] } },
      { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: answer }
    ] : [])
  ];
}

function codexEvents(answer) {
  return [
    { type: 'thread.started', thread_id: 'thread' },
    { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Under-development features enabled: skip_host_skill_discovery.' } },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: JSON.stringify(answer) } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
  ];
}

function frame(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function openHost(launcherPath, extensionOrigin = origin, environment = {}) {
  const child = spawn(launcherPath, [extensionOrigin], { env: {
    ...process.env, ...untrustedEnvironment, ...environment
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  liveChildren.add(child);
  let output = Buffer.alloc(0);
  let unread = Buffer.alloc(0);
  let errorOutput = '';
  const frames = [];
  child.stdout.on('data', chunk => {
    output = Buffer.concat([output, chunk]);
    unread = Buffer.concat([unread, chunk]);
    while (unread.length >= 4) {
      const size = littleEndian ? unread.readUInt32LE(0) : unread.readUInt32BE(0);
      if (unread.length < size + 4) break;
      assert.ok(size < 1024 * 1024);
      frames.push({ at: Date.now(), message: JSON.parse(unread.subarray(4, size + 4).toString()) });
      unread = unread.subarray(size + 4);
    }
  });
  child.stderr.on('data', chunk => { errorOutput += chunk; });
  child.stdin.on('error', () => {});
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Native host did not finish.')); }, 8000);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timeout);
      liveChildren.delete(child);
      resolve({ code, output, errorOutput, frames, unread });
    });
  });
  return { child, completed };
}

async function exchangeFrames(launcherPath, value, fragmented = false, extensionOrigin = origin, environment = {}) {
  const host = openHost(launcherPath, extensionOrigin, environment);
  const bytes = Buffer.isBuffer(value) ? value : frame(value);
  if (fragmented) {
    for (const part of [bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3, 8), bytes.subarray(8)]) {
      host.child.stdin.write(part);
      await delay(5);
    }
  } else host.child.stdin.write(bytes);
  const { errorOutput, code, frames, unread } = await host.completed;
  assert.equal(code, 0);
  assert.equal(errorOutput, '');
  assert.equal(unread.length, 0);
  assert.ok(frames.length > 0);
  assert.ok(frames.slice(0, -1).every(frame => frame.message.type === 'progress'), 'Only progress may precede the final message.');
  return frames;
}

async function exchange(...args) {
  return (await exchangeFrames(...args)).at(-1).message;
}

function progressOf(frames) {
  const progress = frames.filter(frame => frame.message.type === 'progress');
  for (const { message } of progress) assert.deepEqual(Object.keys(message), ['type', 'phase', 'sections', 'labelled', 'thought']);
  for (let index = 1; index < progress.length; index++) assert.ok(progress[index].at - progress[index - 1].at >= 900, 'Progress is throttled to about one message per second.');
  return progress.map(frame => frame.message);
}

async function control(mode = 'success', authenticated = true, status = {}, details = {}) {
  await writeFile(controlPath, JSON.stringify({ mode, authenticated, status, ...details }));
}

async function calls() {
  if (!existsSync(callsPath)) return [];
  return (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function waitForStarted() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(startedPath)) return JSON.parse(await readFile(startedPath, 'utf8'));
    await delay(20);
  }
  throw new Error('Fake CLI did not start.');
}

function processRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

try {
  await writeFile(fakeCliPath, `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const control = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
const args = process.argv.slice(2);
const claudeEvents = ${claudeEvents};
const codexEvents = ${codexEvents};
const emit = async events => {
  for (const event of events) {
    if (event.wait) await new Promise(resolve => setTimeout(resolve, event.wait));
    else await new Promise(resolve => process.stdout.write((typeof event === 'string' ? event : JSON.stringify(event)) + '\\n', resolve));
  }
};
const claude = args.includes('--safe-mode');
if (args.includes('status')) {
  appendFileSync(${JSON.stringify(statusCallsPath)}, JSON.stringify({ args, environment: Object.keys(process.env), cwd: process.cwd() }) + '\\n');
  if (control.mode === 'status-incompatible') { console.error("error: unknown option '--safe-mode' PRIVATE STATUS test-secret-key"); process.exit(1); }
  if (control.mode === 'status-failure') { console.error('PRIVATE STATUS test-secret-key'); process.exit(1); }
  if (claude) {
    console.error('PRIVATE STATUS test-secret-key');
    console.log(control.mode === 'invalid-status' ? 'not json' : JSON.stringify({ loggedIn: control.authenticated, authMethod: control.authenticated ? 'claude.ai' : 'api_key', apiProvider: 'firstParty', ...control.status }));
  } else console.error(control.mode === 'invalid-status' ? 'unreadable test-secret-key' : control.mode === 'status-auth-mode' ? 'Logged in using an API key - test-secret-key' : control.authenticated ? 'Logged in using ChatGPT' : 'Not logged in');
  process.exit(0);
}
if (args.includes('app-server') || args.includes('--input-format')) {
  const { createInterface } = await import('node:readline');
  createInterface({input:process.stdin}).on('line', line => {
    const message = JSON.parse(line);
    appendFileSync(${JSON.stringify(catalogCallsPath)}, JSON.stringify(message) + '\\n');
    if (control.mode === 'catalog-closed') { console.error('PRIVATE CATALOG test-secret-key'); process.exit(1); }
    if (control.mode === 'catalog-invalid') { console.log('PRIVATE CATALOG test-secret-key'); return; }
    if (control.mode === 'catalog-overflow') { console.log('x'.repeat(4 * 1024 * 1024)); return; }
    if (claude) {
      const models = control.mode === 'catalog-limit' ? Array.from({length:control.count}, (_, index) => ({value:index === 0 ? 'default' : 'model-' + index,resolvedModel:'model-' + index,displayName:'Test model',supportedEffortLevels:['low','high']})) : [{value:'default',resolvedModel:'test-model',displayName:'Test model',supportedEffortLevels:['low','high']},{value:'opus',resolvedModel:'test-model',displayName:'Test model',supportedEffortLevels:['low','high']}];
      if (control.mode === 'catalog-shape') Object.assign(models[0], control.model);
      console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:'catalog',response:{models}}}));
    } else if (message.method === 'initialize') console.log(JSON.stringify({id:1,...(control.mode === 'catalog-initialize-failure' ? {error:{message:'PRIVATE CATALOG test-secret-key'}} : {result:{}})}));
    else if (message.method === 'model/list') {
      const offset = Number(message.params.cursor ?? 0);
      const data = control.mode === 'catalog-limit' ? Array.from({length:Math.min(100, control.count - offset)}, (_, index) => ({model:'model-' + (offset + index),displayName:'Test model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'high',isDefault:offset + index === 0})) : [{model:message.params.cursor ? 'older-model' : 'test-model',displayName:'Test model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],defaultReasoningEffort:'high',isDefault:!message.params.cursor}];
      const nextCursor = control.mode === 'catalog-repeat' ? 'repeat' : control.mode === 'catalog-pages' && !message.params.cursor ? 'older' : control.mode === 'catalog-limit' && offset + 100 < control.count ? String(offset + 100) : null;
      if (control.mode === 'catalog-shape') Object.assign(data[0], control.model);
      console.log(JSON.stringify({id:2,result:{data,nextCursor}}));
    }
  });
} else {
if (control.mode === 'startup-option') {
  console.error(control.diagnostic + '\\nPRIVATE REPOSITORY SOURCE test-secret-key /private/sensitive/path');
  process.exit(2);
}
const value = flag => args[args.indexOf(flag) + 1];
const config = Object.fromEntries(args.flatMap((arg, index) => arg === '-c' ? [args[index + 1].split(/=(.*)/s).slice(0, 2)] : []));
const instructionsPath = claude ? value('--system-prompt-file') : JSON.parse(config.model_instructions_file);
const instructions = readFileSync(instructionsPath, 'utf8');
const schema = JSON.parse(claude ? value('--json-schema') : readFileSync(value('--output-schema'), 'utf8'));
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, config, schema, prompt, instructions, cwd: process.cwd(), directoryMode: statSync(process.cwd()).mode & 0o777, fileMode: statSync(instructionsPath).mode & 0o777, environment: Object.keys(process.env) }) + '\\n');
const result = schema.properties.edits ? { edits: [{ editId: 'sample-edit', kinds: ['behavior'], reason: 'A guard changes the result.', uncertainty: '' }] } : { summary: 'Review the guard.', topics: [] };
const output = content => claude ? process.stdout.write(content) : writeFileSync(value('--output-last-message'), content);
if (control.mode === 'events') {
  console.error(prompt + ' PRIVATE REPOSITORY SOURCE test-secret-key');
  const events = Buffer.from(control.events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\\n'));
  for (let offset = 0; offset < events.length; offset += 97) {
    await new Promise(resolve => process.stdout.write(events.subarray(offset, offset + 97), resolve));
  }
  output(JSON.stringify(result));
  process.exitCode = control.code;
} else if (control.mode === 'stream') {
  await emit(control.events);
  if (!claude) writeFileSync(value('--output-last-message'), JSON.stringify(control.answer));
} else if (control.mode === 'wait') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid, descendant: descendant.pid, cwd: process.cwd() }));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (control.mode === 'failure') {
  console.error('PRIVATE REPOSITORY SOURCE test-secret-key /private/sensitive/path');
  process.exit(1);
} else if (control.mode === 'diagnostic' || control.mode === 'diagnostic-envelope') {
  if (claude) {
    await emit([{type:'system',subtype:'init'},{type:'assistant',message:{role:'assistant',content:[{type:'text',text:control.diagnostic}]},error:'unknown'}]);
    console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:[control.diagnostic + ' PRIVATE REPOSITORY SOURCE test-secret-key /private/sensitive/path']}));
  }
  else console.log(JSON.stringify({type:'turn.failed',error:{message:control.diagnostic + ' PRIVATE REPOSITORY SOURCE test-secret-key /private/sensitive/path'}}));
  process.exit(control.mode === 'diagnostic-envelope' ? 0 : 1);
} else if (control.mode === 'removed-output' || control.mode === 'unreadable-output') {
  rmSync(value('--output-last-message'));
  if (control.mode === 'unreadable-output') mkdirSync(value('--output-last-message'));
} else if (control.mode === 'invalid') output('not json');
else if (control.mode === 'huge') output(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { content: 'x'.repeat(1024 * 1024) } }));
else if (control.mode === 'overflow') output('x'.repeat(5 * 1024 * 1024));
else if (control.mode === 'error-envelope') output(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, structured_output: result, errors: ['PRIVATE REPOSITORY test-secret-key'] }));
else if (control.mode === 'error-success') output(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, structured_output: result }));
else if (control.mode === 'missing-output') output(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result) }));
else if (control.mode === 'nonobject') output(claude ? JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: [] }) : '[]');
else {
  await emit(claude ? claudeEvents(result) : codexEvents(result));
  if (!claude) output(JSON.stringify(result));
}
}
`, { mode: 0o700 });
  await chmod(fakeCliPath, 0o700);
  const installations = [];
  for (const provider of ['codex', 'claude']) {
    await rm(callsPath, { force: true });
    await rm(statusCallsPath, { force: true });
    await control();
    const installed = await installNativeHost({ provider, browserProfileDirectory: join(root, "Chrome profile ' `$safe`"), executablePath: fakeCliPath });
    installations.push(installed);
    const manifest = JSON.parse(await readFile(installed.manifestPath, 'utf8'));
    assert.equal(manifest.name, `com.review_focus.${provider}`);
    assert.deepEqual(manifest.allowed_origins, [origin]);
    assert.equal(manifest.path, installed.launcherPath);
    assert.deepEqual(await exchange(installed.launcherPath, { type: 'status' }, true), { type: 'status', authenticated: true });

    const catalog = await exchange(installed.launcherPath, {type:'models'});
    assert.deepEqual(catalog, {type:'models',models:[{id:'test-model',label:'Test model',efforts:['low','high'],defaultEffort:provider === 'claude' ? 'low' : 'high',isDefault:true}]});
    if (provider === 'codex') {
      await rm(catalogCallsPath, { force: true });
      await control('catalog-pages');
      const pages = await exchange(installed.launcherPath, { type: 'models' });
      assert.deepEqual(pages.models.map(model => model.id), ['test-model', 'older-model']);
      assert.deepEqual(pages.models.map(model => model.isDefault), [true, false]);
      const catalogCalls = (await readFile(catalogCallsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(catalogCalls.filter(call => call.method === 'model/list').map(call => call.params), [{ limit: 100, includeHidden: true }, { limit: 100, includeHidden: true, cursor: 'older' }]);
    }
    await control('catalog-limit', true, {}, { count: 500 });
    const fullCatalog = await exchange(installed.launcherPath, { type: 'models' });
    assert.equal(fullCatalog.models.length, 500);
    assert.equal(fullCatalog.models.at(-1).id, 'model-499');
    await control('catalog-limit', true, {}, { count: 501 });
    const excessiveCatalog = await exchange(installed.launcherPath, { type: 'models' });
    assert.equal(excessiveCatalog.type, 'error');
    assert.match(excessiveCatalog.message, /500-model limit/);
    const catalogFailures = [
      ['catalog-invalid', /unreadable model catalog/],
      ['catalog-overflow', /catalog is too large/],
      ['catalog-closed', /closed before returning its models/],
      ...(provider === 'codex' ? [['catalog-repeat', /repeated a model catalog page/], ['catalog-initialize-failure', /could not initialize its model catalog/]] : [])
    ];
    for (const [mode, expected] of catalogFailures) {
      await control(mode);
      const failedCatalog = await exchange(installed.launcherPath, { type: 'models' });
      assert.equal(failedCatalog.type, 'error');
      assert.match(failedCatalog.message, expected);
      assert.doesNotMatch(failedCatalog.message, /test-secret-key|PRIVATE CATALOG|signed in/);
    }
    for (const model of provider === 'claude'
      ? [{ resolvedModel: 'invalid-model', displayName: 'x'.repeat(201) }, { resolvedModel: 'invalid-model', supportedEffortLevels: Array(21).fill('low') }]
      : [{ displayName: 'x'.repeat(201) }, { supportedReasoningEfforts: Array(21).fill({ reasoningEffort: 'low' }) }, { defaultReasoningEffort: 'unsupported' }]) {
      await control('catalog-shape', true, {}, { model });
      const failedCatalog = await exchange(installed.launcherPath, { type: 'models' });
      assert.equal(failedCatalog.type, 'error');
      assert.match(failedCatalog.message, /unreadable model catalog/);
    }
    assert.equal((await calls()).length, 0, 'Listing models must never start analysis.');
    await control();
    const firstFrames = await exchangeFrames(installed.launcherPath, request, true);
    const first = firstFrames.at(-1).message;
    assert.equal(progressOf(firstFrames)[0].phase, provider === 'claude' ? 'writing' : 'reasoning', 'Analysis reports its phase before the result.');
    assert.equal(first.type, 'result');
    assert.equal(first.result.edits[0].editId, 'sample-edit');
    const prioritization = { ...request, model: 'test-model', effort: 'high', prompt: { system: 'Prioritize the classified edits.', user: JSON.stringify({ evidence: request.prompt.user, classifications: first.result.edits }) }, schema: { type: 'object', properties: { summary: { type: 'string' }, topics: { type: 'array', items: { type: 'object' } } }, required: ['summary', 'topics'], additionalProperties: false } };
    assert.deepEqual(await exchange(installed.launcherPath, prioritization), { type: 'result', result: { summary: 'Review the guard.', topics: [] } });
    const recorded = await calls();
    assert.equal(recorded.length, 2);
    assert.notEqual(recorded[0].cwd, recorded[1].cwd);
    assert.equal(recorded[0].prompt, request.prompt.user);
    assert.equal(recorded[1].prompt, prioritization.prompt.user);
    assert.deepEqual(recorded[0].schema, schema);
    assert.ok(recorded[0].instructions.startsWith(request.prompt.system));
    assert.ok(!recorded[0].args.includes('--model'));
    assert.equal(recorded[1].args[recorded[1].args.indexOf('--model') + 1], 'test-model');
    for (const record of recorded) {
      assert.equal(existsSync(record.cwd), false);
      assert.equal(record.directoryMode, 0o700);
      assert.equal(record.fileMode, 0o600);
      if (provider === 'codex') {
        for (const flag of ['--json', '--strict-config', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check']) assert.ok(record.args.includes(flag));
        assert.equal(record.args[record.args.indexOf('--sandbox') + 1], 'read-only');
        assert.equal(record.config.forced_login_method, undefined);
        assert.equal(JSON.parse(record.config.approval_policy), 'never');
        assert.equal(record.config['features.shell_tool'], 'false');
        assert.equal(record.config['features.skip_host_skill_discovery'], 'true');
        assert.equal(record.config.project_doc_max_bytes, '0');
        assert.equal(record.config.model_reasoning_effort, record === recorded[1] ? '"high"' : undefined);
        assert.equal(record.config.model_reasoning_summary, '"auto"', 'Codex sends reasoning summaries only when asked.');
      } else {
        for (const flag of ['--safe-mode', '--print', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome', '--no-session-persistence']) assert.ok(record.args.includes(flag));
        for (const [flag, value] of [['--tools', ''], ['--setting-sources', ''], ['--mcp-config', '{"mcpServers":{}}'], ['--permission-mode', 'dontAsk'], ['--permission-prompts', 'none'], ['--output-format', 'stream-json']]) assert.equal(record.args[record.args.indexOf(flag) + 1], value);
        for (const flag of ['--verbose', '--include-partial-messages', '--json-schema']) assert.ok(record.args.includes(flag));
        assert.equal(record.args.includes('--effort') ? record.args[record.args.indexOf('--effort') + 1] : undefined, record === recorded[1] ? 'high' : undefined);
        assert.ok(!record.args.includes('--bare'));
        assert.ok(!record.args.includes('--dangerously-skip-permissions'));
      }
      for (const name of Object.keys(untrustedEnvironment)) assert.ok(!record.environment.includes(name), name);
    }

    await control('success', false);
    const unsigned = await exchange(installed.launcherPath, { type: 'status' });
    assert.equal(unsigned.authenticated, false);
    assert.match(unsigned.message, /^Sign in/);
    assert.ok(unsigned.message.includes(provider === 'claude' ? 'claude auth login' : 'codex login'));
    assert.ok(!unsigned.message.includes('test-secret-key'));
    assert.equal((await exchange(installed.launcherPath, request)).type, 'error');
    assert.equal((await calls()).length, 2);
    if (provider === 'claude') {
      for (const status of [{ authMethod: 'api_key' }, { authMethod: 'console' }, { apiProvider: 'bedrock' }]) {
        await control('success', true, status);
        const unsupported = await exchange(installed.launcherPath, { type: 'status' });
        assert.equal(unsupported.authenticated, false);
        assert.match(unsupported.message, /requires a Claude subscription login through claude.ai/);
        assert.doesNotMatch(unsupported.message, /^Sign in/);
        assert.equal((await exchange(installed.launcherPath, request)).type, 'error');
      }
      await control('success', true, { authMethod: null });
      const malformedStatus = await exchange(installed.launcherPath, { type: 'status' });
      assert.equal(malformedStatus.type, 'error');
      assert.match(malformedStatus.message, /unreadable login status/);
    } else {
      await control('status-auth-mode');
      const unsupported = await exchange(installed.launcherPath, { type: 'status' });
      assert.equal(unsupported.authenticated, false);
      assert.match(unsupported.message, /requires a ChatGPT login/);
      assert.doesNotMatch(unsupported.message, /^Sign in|test-secret-key/);
      assert.equal((await exchange(installed.launcherPath, request)).type, 'error');
    }
    for (const [mode, expected] of [['invalid-status', /unreadable login status/], ['status-incompatible', /does not support a required CLI option/], ['status-failure', /could not check its login/]]) {
      await control(mode);
      for (const attempted of [{ type: 'status' }, request]) {
        const failedStatus = await exchange(installed.launcherPath, attempted);
        assert.equal(failedStatus.type, 'error');
        assert.match(failedStatus.message, expected);
        assert.doesNotMatch(failedStatus.message, /^Sign in|test-secret-key|PRIVATE STATUS/);
      }
    }
    assert.equal((await calls()).length, 2);
    await control();
    const unavailableDirectory = await exchange(installed.launcherPath, { type: 'status' }, false, origin, { TMPDIR: join(root, 'missing-temporary-directory') });
    assert.equal(unavailableDirectory.type, 'error');
    assert.match(unavailableDirectory.message, /could not create its private working directory/);
    assert.doesNotMatch(unavailableDirectory.message, /signed in/);
    await rename(fakeCliPath, `${fakeCliPath}.unavailable`);
    try {
      const unavailableCli = await exchange(installed.launcherPath, { type: 'status' });
      assert.equal(unavailableCli.type, 'error');
      assert.match(unavailableCli.message, /could not be started.*Reinstall the helper/);
    } finally { await rename(`${fakeCliPath}.unavailable`, fakeCliPath); }
    assert.equal((await exchange(installed.launcherPath, { type: 'status' }, false, 'chrome-extension://other/')).type, 'error');
    for (const invalid of [Buffer.from('{'), Buffer.from([0xff]), JSON.stringify({ ...request, model: '--dangerous' }), JSON.stringify({ ...request, schema: [] }), JSON.stringify({ ...request, unexpected: true }), JSON.stringify({ ...request, provider: provider === 'claude' ? 'codex' : 'claude' })]) {
      const payload = Buffer.isBuffer(invalid) ? invalid : Buffer.from(invalid);
      assert.equal((await exchange(installed.launcherPath, frame(payload))).type, 'error');
    }
    const oversizedHeader = Buffer.alloc(4);
    if (littleEndian) oversizedHeader.writeUInt32LE(6 * 1024 * 1024 + 1);
    else oversizedHeader.writeUInt32BE(6 * 1024 * 1024 + 1);
    assert.equal((await exchange(installed.launcherPath, oversizedHeader)).type, 'error');
    assert.equal((await exchange(installed.launcherPath, Buffer.concat([frame(request), frame(request)]))).type, 'error');
    assert.equal((await calls()).length, 2);
    const truncated = openHost(installed.launcherPath);
    truncated.child.stdin.end(frame(request).subarray(0, 9));
    const truncatedResponse = await truncated.completed;
    assert.match(JSON.parse(truncatedResponse.output.subarray(4).toString()).message, /incomplete/);

    for (const mode of ['failure', 'invalid', 'huge', 'nonobject', ...(provider === 'claude' ? ['overflow', 'error-envelope', 'error-success', 'missing-output'] : [])]) {
      await control(mode);
      const response = await exchange(installed.launcherPath, request);
      assert.equal(response.type, 'error');
      assert.ok(!JSON.stringify(response).includes('test-secret-key'));
      assert.ok(!JSON.stringify(response).includes('PRIVATE REPOSITORY'));
      if (mode === 'invalid') assert.match(response.message, /did not return valid JSON/);
      assert.equal(existsSync((await calls()).at(-1).cwd), false);
    }
    for (const [diagnostic, expected] of [
      ['model_not_found: The model does not exist.', /could not use the selected model/],
      ["There's an issue with the selected model (custom-model). It may not exist or you may not have access to it.", /could not use the selected model/],
      ['Unsupported reasoning effort for selected model.', /rejected the selected effort/],
      ['rate_limit_error: Too many requests.', /account or rate limit/],
      ["You've hit your limit · resets 5pm", /account or rate limit/],
      ['Connection failed: ECONNRESET.', /could not reach its service/],
      ['authentication_error: token expired.', /rejected the login credentials/],
      ["error: unexpected argument '--permission-prompts' found", /does not support a required CLI option/]
    ]) {
      for (const mode of provider === 'claude' ? ['diagnostic', 'diagnostic-envelope'] : ['diagnostic']) {
        await control(mode, true, {}, { diagnostic });
        const failedAnalysis = await exchange(installed.launcherPath, request);
        assert.equal(failedAnalysis.type, 'error');
        assert.match(failedAnalysis.message, expected);
        assert.doesNotMatch(failedAnalysis.message, /test-secret-key|PRIVATE REPOSITORY|\/private\/sensitive/);
        assert.equal(existsSync((await calls()).at(-1).cwd), false);
      }
    }

    if (provider === 'codex') {
      const startupWarning = 'WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)\n';
      for (const [diagnostic, expected] of [
        ["error: unexpected argument '--strict-config' found", /does not support a required CLI option.*Update Codex/],
        ["error: unexpected argument '--ignore-rules' found", /does not support a required CLI option.*Update Codex/],
        [startupWarning + "error: unexpected argument '--strict-config' found", /does not support a required CLI option.*Update Codex/],
        ["error: unexpected argument '--unrelated-option' found", /stopped before completing/],
        ["Prompt mentions error: unexpected argument '--strict-config' found", /stopped before completing/],
        ["PRIVATE PROMPT\nerror: unexpected argument '--strict-config' found", /stopped before completing/]
      ]) {
        await control('startup-option', true, {}, { diagnostic });
        const response = await exchange(installed.launcherPath, request);
        assert.equal(response.type, 'error');
        assert.match(response.message, expected);
        assert.doesNotMatch(response.message, /test-secret-key|PRIVATE REPOSITORY|\/private\/sensitive/);
      }
      for (const mode of ['removed-output', 'unreadable-output']) {
        await control(mode);
        const response = await exchange(installed.launcherPath, request);
        assert.equal(response.type, 'error');
        assert.match(response.message, /could not read the Codex analysis file.*temporary-folder permissions/);
        assert.doesNotMatch(response.message, /valid JSON|test-secret-key|PRIVATE REPOSITORY|\/private\/sensitive/);
        assert.equal(existsSync((await calls()).at(-1).cwd), false);
      }
      const keywords = startupWarning + "error: unexpected argument '--strict-config' found\nunauthorized quota TLS certificate rate limit";
      const agentMessage = { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ type: 'error', message: keywords }) } };
      for (const padding of ['', 'x'.repeat(20_000)]) {
        const echoedRequest = { ...request, prompt: { ...request.prompt, user: `${keywords} ${padding}` } };
        for (const [events, expected] of [
          [[agentMessage], /stopped before completing/],
          [[agentMessage, { type: 'error', message: 'Unexpected internal failure.' }], /stopped before completing/],
          [[agentMessage, { type: 'error', message: 'Connection failed: ECONNRESET.' }], /could not reach its service/],
          [[{ type: 'error', message: 'rate limit' }, agentMessage, { type: 'turn.failed', error: { message: 'Unsupported reasoning effort.' } }], /rejected the selected effort/]
        ]) {
          await control('events', true, {}, { events, code: 1 });
          const response = await exchange(installed.launcherPath, echoedRequest);
          assert.equal(response.type, 'error');
          assert.match(response.message, expected);
          assert.doesNotMatch(response.message, /test-secret-key|PRIVATE REPOSITORY/);
        }
      }
      for (const [events, expected] of [
        [[{ type: 'turn.failed', error: { message: 'model_not_found' } }], /could not use the selected model/],
        [['not json'], /unreadable analysis events/],
        [[{ type: 'error', message: { private: keywords } }], /unreadable analysis error/],
        [[{ type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(5 * 1024 * 1024) } }], /too large for Chrome/]
      ]) {
        await control('events', true, {}, { events, code: 0 });
        const response = await exchange(installed.launcherPath, request);
        assert.equal(response.type, 'error');
        assert.match(response.message, expected);
      }
      await control('events', true, {}, { events: [{ type: 'error', message: 'Connection failed.' }, agentMessage, { type: 'turn.completed', usage: {} }], code: 0 });
      assert.equal((await exchange(installed.launcherPath, request)).type, 'result', 'A successful turn must not inherit an earlier recovered error or agent message.');
      await control('events', true, {}, { events: [], code: 0 });
      assert.equal((await exchange(installed.launcherPath, { ...request, prompt: { ...request.prompt, user: keywords } })).type, 'result', 'Successful analysis must not interpret echoed stderr as a startup error.');
    }

    const streamed = {
      summary: 'Ignore \"title\": \"Injected\" inside prose.',
      topics: [
        { id: 'first', priority: 'review', title: 'First\u0007 section\u202e', gist: 'Not a \"title\": \"Gist\" section.', editIds: ['a'] },
        { id: 'second', priority: 'supporting', title: `Long ${'😀'.repeat(205)}`, gist: 'The long section.', editIds: ['b', 'c'] }
      ],
      classifications: ['a', 'b', 'c'].map(editId => ({ editId, kinds: ['behavior'], reason: 'Synthetic.', uncertainty: '' }))
    };
    const reviewRequest = { ...request, schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } };
    if (provider === 'claude') {
      await control('stream', true, {}, { events: [...claudeEvents(streamed, { chunk: 7, wait: 25 }).slice(0, -2), { wait: 1100 }, ...claudeEvents(streamed).slice(-2)] });
      const streamFrames = await exchangeFrames(installed.launcherPath, reviewRequest);
      assert.deepEqual(streamFrames.at(-1).message, { type: 'result', result: streamed }, 'Progress never changes the extracted result.');
      const sectionProgress = progressOf(streamFrames);
      assert.ok(sectionProgress.length >= 2 && sectionProgress.length <= 5, `Expected throttled progress, received ${sectionProgress.length} messages.`);
      assert.deepEqual(sectionProgress.at(-1), { type: 'progress', phase: 'writing', sections: ['First section', `Long ${'😀'.repeat(195)}`], labelled: 3, thought: '' }, 'Titles are complete, cleaned and capped at 200 code points; prose is not parsed as structure.');
      assert.ok(sectionProgress.every(progress => progress.labelled <= 3 && progress.sections.every(title => sectionProgress.at(-1).sections.includes(title))));

      const labels = { edits: streamed.classifications };
      await control('stream', true, {}, { events: [...claudeEvents(labels, { chunk: 5 }).slice(0, -2), { wait: 1100 }, ...claudeEvents(labels).slice(-2)] });
      const labelFrames = await exchangeFrames(installed.launcherPath, request);
      assert.deepEqual(labelFrames.at(-1).message, { type: 'result', result: labels });
      assert.deepEqual(progressOf(labelFrames).at(-1), { type: 'progress', phase: 'writing', sections: [], labelled: 3, thought: '' }, 'File classification reports how many blocks are labelled.');

      for (const [partial, expected] of [
        ['{"summary":"x","topics":[{"title":"Good"}]]]}}"title":"Bad","classifications":[{"editId":"z"}', ['Good']],
        ['{"topics":[{"title":"Unterminated', []],
        ['not json at all "title":"Loose"', []]
      ]) {
        await control('stream', true, {}, { events: [...claudeEvents(null, { partial }), { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 42 } } }, { wait: 1100 }, claudeEvents(streamed).at(-1)] });
        const garbageFrames = await exchangeFrames(installed.launcherPath, reviewRequest);
        assert.deepEqual(garbageFrames.at(-1).message, { type: 'result', result: streamed }, 'Unreadable partial answers leave the final result intact.');
        assert.deepEqual(progressOf(garbageFrames).at(-1).sections, expected);
        assert.equal(progressOf(garbageFrames).at(-1).labelled, 0);
      }
      await control('stream', true, {}, { events: claudeEvents(null, { partial: '{"topics":[{"title":"Cut off"},{"title":"Next' }) });
      const truncatedStream = await exchange(installed.launcherPath, reviewRequest);
      assert.equal(truncatedStream.type, 'error');
      assert.match(truncatedStream.message, /did not return valid JSON/, 'A stream that ends before its result still fails safely.');
    } else {
      const reasoning = [
        { type: 'item.completed', item: { id: 'reasoning_0', type: 'reasoning', text: 42 } },
        { type: 'item.completed', item: { id: 'reasoning_1', type: 'reasoning', text: `**Reading the diff**\n\nThe guard moved.\n**Weighing\u0007 the guard ${'😀'.repeat(205)}**\n\nI need to check \"title\": \"Injected\".` } }
      ];
      const plain = { type: 'item.completed', item: { id: 'reasoning_plain', type: 'reasoning', text: '  Comparing the callers\nThen the tests.' } };
      const blank = { type: 'item.completed', item: { id: 'reasoning_blank', type: 'reasoning', text: ' \n\u0007\n ' } };
      await control('stream', true, {}, { events: [...codexEvents(streamed).slice(0, 3), { wait: 1100 }, plain, { wait: 1100 }, ...reasoning, { wait: 1100 }, blank, { wait: 1100 }, ...codexEvents(streamed).slice(3)], answer: streamed });
      const codexFrames = await exchangeFrames(installed.launcherPath, reviewRequest);
      assert.deepEqual(codexFrames.at(-1).message, { type: 'result', result: streamed });
      assert.deepEqual(progressOf(codexFrames), [
        { type: 'progress', phase: 'reasoning', sections: [], labelled: 0, thought: '' },
        { type: 'progress', phase: 'reasoning', sections: [], labelled: 0, thought: 'Comparing the callers' },
        { type: 'progress', phase: 'reasoning', sections: [], labelled: 0, thought: `Weighing the guard ${'😀'.repeat(181)}` }
      ], 'Codex exposes no partial answer, so it reports its phase and the cleaned, capped last headline of its latest reasoning summary, or its first line without one; a blank summary reports nothing.');
    }

    for (const cancellation of ['disconnect', 'signal', 'second-request']) {
      await rm(startedPath, { force: true });
      await control('wait');
      const host = openHost(installed.launcherPath);
      host.child.stdin.write(frame(request));
      const running = await waitForStarted();
      assert.ok(processRunning(running.pid));
      assert.ok(processRunning(running.descendant));
      if (cancellation === 'disconnect') host.child.stdin.end();
      else if (cancellation === 'signal') host.child.kill('SIGTERM');
      else host.child.stdin.write(frame({ type: 'status' }));
      await host.completed;
      assert.equal(existsSync(running.cwd), false);
      for (let attempt = 0; attempt < 30 && (processRunning(running.pid) || processRunning(running.descendant)); attempt++) await delay(20);
      assert.equal(processRunning(running.pid), false);
      assert.equal(processRunning(running.descendant), false);
    }
    const statusCalls = (await readFile(statusCallsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const call of statusCalls) {
      for (const name of Object.keys(untrustedEnvironment)) assert.ok(!call.environment.includes(name), name);
      assert.equal(existsSync(call.cwd), false);
      assert.deepEqual(call.args, provider === 'claude' ? ['--safe-mode', '--setting-sources', '', 'auth', 'status', '--json'] : ['login', 'status']);
    }
  }
  await control();
  for (const installed of installations) assert.deepEqual(await exchange(installed.launcherPath, { type: 'status' }), { type: 'status', authenticated: true });
  assert.notEqual(installations[0].launcherPath, installations[1].launcherPath);
  assert.equal(installations[0].scriptPath, installations[1].scriptPath);
  assert.equal(JSON.parse(await readFile(installations[0].manifestPath, 'utf8')).name, 'com.review_focus.codex');
  await assert.rejects(installNativeHost({ provider: 'unexpected', executablePath: fakeCliPath }), /Unsupported/);
  await assert.rejects(installNativeHost({ provider: 'claude', executablePath: 'relative' }), /absolute/);
  for (const provider of ['codex', 'claude']) {
    const stableCli = join(root, `${provider}-stable`);
    const releases = [join(root, `${provider}-release-1`), join(root, `${provider}-release-2`)];
    for (const [index, release] of releases.entries()) {
      const status = provider === 'claude' ? JSON.stringify({ loggedIn: index === 0, authMethod: 'claude.ai', apiProvider: 'firstParty' }) : index === 0 ? 'Logged in using ChatGPT' : 'Not logged in';
      await writeFile(release, `#!${process.execPath}\nconsole.${provider === 'claude' ? 'log' : 'error'}(${JSON.stringify(status)});\n`, { mode: 0o755 });
    }
    await symlink(releases[0], stableCli);
    const installed = await installNativeHost({ provider, browserProfileDirectory: join(root, `${provider}-update-profile`), executablePath: stableCli });
    assert.equal(installed.executablePath, stableCli);
    assert.equal((await exchange(installed.launcherPath, { type: 'status' })).authenticated, true);
    await rm(stableCli);
    await symlink(releases[1], stableCli);
    await rm(releases[0]);
    const updated = await exchange(installed.launcherPath, { type: 'status' });
    assert.equal(updated.type, 'status');
    assert.equal(updated.authenticated, false, 'The installed helper must follow the updater’s stable CLI link after the old release is removed.');
  }
  const cliDirectory = join(root, 'bin');
  await mkdir(cliDirectory);
  await symlink(fakeCliPath, join(cliDirectory, 'claude'));
  const installerHome = join(root, 'installer-home');
  const installer = await promisify(execFile)(process.execPath, ['install-native-host.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env, HOME: installerHome, PATH: `${cliDirectory}:./node_modules/.bin:/temporary-codex-path` } });
  assert.match(installer.stdout, /Skipped codex/);
  assert.match(installer.stdout, /com.review_focus.claude/);
  assert.equal(existsSync(join(installerHome, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.review_focus.claude.json')), true);
  const launcher = await readFile(join(installerHome, 'Library', 'Application Support', 'Review Focus', 'native-host', 'review-focus-claude'), 'utf8');
  assert.ok(!launcher.includes('./node_modules/.bin') && !launcher.includes('/temporary-codex-path'), 'The helper must not inherit transient or relative directories from the installer’s PATH.');
  console.log('Native host verification passed for Codex and Claude Code: framing, two-stage flow, private temporary files, login modes, safe actionable errors, catalog paging and limits, generated output boundaries, coexistence, single-provider installation, and process-group cancellation.');
} finally {
  for (const child of liveChildren) child.kill('SIGTERM');
  await rm(root, { recursive: true, force: true });
}
