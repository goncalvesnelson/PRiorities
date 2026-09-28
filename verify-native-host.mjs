import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
const startedPath = join(root, 'started.json');
const fakeCliPath = join(root, "fake cli ' `$safe`.mjs");
const schema = { type: 'object', properties: { edits: { type: 'array', items: { type: 'object' } } }, required: ['edits'], additionalProperties: false };
const request = { type: 'analyze', model: '', prompt: { system: 'Classify every supplied edit.', user: 'A synthetic changed-line fixture.' }, schema };
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

function frame(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function openHost(launcherPath, extensionOrigin = origin) {
  const child = spawn(launcherPath, [extensionOrigin], { env: {
    ...process.env, ...untrustedEnvironment
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  liveChildren.add(child);
  let output = Buffer.alloc(0);
  let errorOutput = '';
  child.stdout.on('data', chunk => { output = Buffer.concat([output, chunk]); });
  child.stderr.on('data', chunk => { errorOutput += chunk; });
  child.stdin.on('error', () => {});
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Native host did not finish.')); }, 8000);
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timeout);
      liveChildren.delete(child);
      resolve({ code, output, errorOutput });
    });
  });
  return { child, completed };
}

async function exchange(launcherPath, value, fragmented = false, extensionOrigin = origin) {
  const host = openHost(launcherPath, extensionOrigin);
  const bytes = Buffer.isBuffer(value) ? value : frame(value);
  if (fragmented) {
    for (const part of [bytes.subarray(0, 1), bytes.subarray(1, 3), bytes.subarray(3, 8), bytes.subarray(8)]) {
      host.child.stdin.write(part);
      await delay(5);
    }
  } else host.child.stdin.write(bytes);
  const { output, errorOutput, code } = await host.completed;
  assert.equal(code, 0);
  assert.equal(errorOutput, '');
  assert.ok(output.length > 4);
  const size = littleEndian ? output.readUInt32LE(0) : output.readUInt32BE(0);
  assert.equal(output.length, size + 4);
  assert.ok(size < 1024 * 1024);
  return JSON.parse(output.subarray(4).toString());
}

async function control(mode = 'success', authenticated = true, status = {}) {
  await writeFile(controlPath, JSON.stringify({ mode, authenticated, status }));
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
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const control = JSON.parse(readFileSync(${JSON.stringify(controlPath)}, 'utf8'));
const args = process.argv.slice(2);
const claude = args.includes('--safe-mode');
if (args.includes('status')) {
  appendFileSync(${JSON.stringify(statusCallsPath)}, JSON.stringify({ args, environment: Object.keys(process.env), cwd: process.cwd() }) + '\\n');
  if (claude) {
    console.error('PRIVATE STATUS test-secret-key');
    console.log(control.mode === 'invalid-status' ? 'not json' : JSON.stringify({ loggedIn: control.authenticated, authMethod: control.authenticated ? 'claude.ai' : 'api_key', apiProvider: 'firstParty', ...control.status }));
  } else console.error(control.authenticated ? 'Logged in using ChatGPT' : 'Logged in using an API key - test-secret-key');
  process.exit(0);
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
if (control.mode === 'wait') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid, descendant: descendant.pid, cwd: process.cwd() }));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (control.mode === 'failure') {
  console.error('PRIVATE REPOSITORY SOURCE test-secret-key /private/sensitive/path');
  process.exit(1);
} else if (control.mode === 'invalid') output('not json');
else if (control.mode === 'huge') output(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { content: 'x'.repeat(1024 * 1024) } }));
else if (control.mode === 'overflow') output('x'.repeat(5 * 1024 * 1024));
else if (control.mode === 'error-envelope') output(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, structured_output: result, errors: ['PRIVATE REPOSITORY test-secret-key'] }));
else if (control.mode === 'error-success') output(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, structured_output: result }));
else if (control.mode === 'missing-output') output(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result) }));
else if (control.mode === 'nonobject') output(claude ? JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: [] }) : '[]');
else output(JSON.stringify(claude ? { type: 'result', subtype: 'success', is_error: false, structured_output: result } : result));
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

    const first = await exchange(installed.launcherPath, request, true);
    assert.equal(first.type, 'result');
    assert.equal(first.result.edits[0].editId, 'sample-edit');
    const prioritization = { ...request, model: 'test-model', prompt: { system: 'Prioritize the classified edits.', user: JSON.stringify({ evidence: request.prompt.user, classifications: first.result.edits }) }, schema: { type: 'object', properties: { summary: { type: 'string' }, topics: { type: 'array', items: { type: 'object' } } }, required: ['summary', 'topics'], additionalProperties: false } };
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
        for (const flag of ['--strict-config', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check']) assert.ok(record.args.includes(flag));
        assert.equal(record.args[record.args.indexOf('--sandbox') + 1], 'read-only');
        assert.equal(record.config.forced_login_method, undefined);
        assert.equal(JSON.parse(record.config.approval_policy), 'never');
        assert.equal(record.config['features.shell_tool'], 'false');
        assert.equal(record.config['features.skip_host_skill_discovery'], 'true');
        assert.equal(record.config.project_doc_max_bytes, '0');
      } else {
        for (const flag of ['--safe-mode', '--print', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome', '--no-session-persistence']) assert.ok(record.args.includes(flag));
        for (const [flag, value] of [['--tools', ''], ['--setting-sources', ''], ['--mcp-config', '{"mcpServers":{}}'], ['--permission-mode', 'dontAsk'], ['--permission-prompts', 'none'], ['--output-format', 'json']]) assert.equal(record.args[record.args.indexOf(flag) + 1], value);
        assert.ok(!record.args.includes('--bare'));
        assert.ok(!record.args.includes('--dangerously-skip-permissions'));
      }
      for (const name of Object.keys(untrustedEnvironment)) assert.ok(!record.environment.includes(name), name);
    }

    await control('success', false);
    const unsigned = await exchange(installed.launcherPath, { type: 'status' });
    assert.equal(unsigned.authenticated, false);
    assert.ok(unsigned.message.includes(provider === 'claude' ? 'claude auth login' : 'codex login'));
    assert.ok(!unsigned.message.includes('test-secret-key'));
    assert.equal((await exchange(installed.launcherPath, request)).type, 'error');
    assert.equal((await calls()).length, 2);
    if (provider === 'claude') {
      for (const status of [{ authMethod: 'api_key' }, { authMethod: 'console' }, { apiProvider: 'bedrock' }, { loggedIn: false }]) {
        await control('success', true, status);
        assert.equal((await exchange(installed.launcherPath, { type: 'status' })).authenticated, false);
        assert.equal((await exchange(installed.launcherPath, request)).type, 'error');
      }
      await control('invalid-status');
      assert.equal((await exchange(installed.launcherPath, { type: 'status' })).authenticated, false);
      assert.equal((await exchange(installed.launcherPath, request)).type, 'error');
      assert.equal((await calls()).length, 2);
    }
    await control();
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
      assert.equal(existsSync((await calls()).at(-1).cwd), false);
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
  const cliDirectory = join(root, 'bin');
  await mkdir(cliDirectory);
  await symlink(fakeCliPath, join(cliDirectory, 'claude'));
  const installerHome = join(root, 'installer-home');
  const installer = await promisify(execFile)(process.execPath, ['install-native-host.mjs'], { cwd: new URL('.', import.meta.url), env: { ...process.env, HOME: installerHome, PATH: cliDirectory } });
  assert.match(installer.stdout, /Skipped codex/);
  assert.match(installer.stdout, /com.review_focus.claude/);
  assert.equal(existsSync(join(installerHome, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.review_focus.claude.json')), true);
  console.log('Native host verification passed for Codex and Claude Code: framing, two-stage flow, private temporary files, login isolation, sanitized errors, generated output boundaries, coexistence, single-provider installation, and process-group cancellation.');
} finally {
  for (const child of liveChildren) child.kill('SIGTERM');
  await rm(root, { recursive: true, force: true });
}
