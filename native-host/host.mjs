import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { endianness, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const origin = 'chrome-extension://bjmajanmepopjciklnijlfbdpafokfpe/';
const maxInputBytes = 6 * 1024 * 1024;
const maxOutputBytes = 1024 * 1024 - 1;
const littleEndian = endianness() === 'LE';
const provider = process.argv[2];
const executablePath = process.argv[3];
const providerName = provider === 'claude' ? 'Claude Code' : 'Codex';
const loginCommand = provider === 'claude' ? 'claude auth login' : 'codex login';
const statusCommand = provider === 'claude' ? 'claude auth status' : 'codex login status';
const childEnvironment = Object.fromEntries([
  'HOME', provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'
].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
let input = Buffer.alloc(0);
let expectedBytes;
let started = false;
let finished = false;
let disconnected = false;
let activeChild;
let temporaryDirectory;
let requestTimer;

function cleanup() {
  clearTimeout(requestTimer);
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}

function send(message) {
  let body = Buffer.from(JSON.stringify(message));
  if (body.length > maxOutputBytes) body = Buffer.from(JSON.stringify({ type: 'error', message: `${providerName} returned a result too large for Chrome. Try a smaller pull request.` }));
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  process.stdin.destroy();
  process.stdout.end(Buffer.concat([header, body]), () => process.exit(0));
}

function complete(message) {
  if (finished) return;
  finished = true;
  cleanup();
  if (disconnected) process.exit(0);
  else send(message);
}

async function stop(message) {
  if (finished) return;
  finished = true;
  clearTimeout(requestTimer);
  const pid = activeChild?.pid;
  if (pid) {
    try { process.kill(-pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') process.exitCode = 1; }
    await new Promise(resolve => setTimeout(resolve, 150));
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') process.exitCode = 1; }
  }
  cleanup();
  if (disconnected) process.exit(0);
  else send({ type: 'error', message });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRequest(request) {
  if (!object(request)) return false;
  if (request.type === 'status') return Object.keys(request).length === 1;
  if (request.type !== 'analyze' || Object.keys(request).some(key => !['type', 'model', 'prompt', 'schema'].includes(key))) return false;
  if (typeof request.model !== 'string' || (request.model !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(request.model))) return false;
  if (!object(request.prompt) || Object.keys(request.prompt).length !== 2) return false;
  if (typeof request.prompt.system !== 'string' || !request.prompt.system.trim() || Buffer.byteLength(request.prompt.system) > 65536) return false;
  if (typeof request.prompt.user !== 'string' || !request.prompt.user.trim()) return false;
  if (!object(request.schema) || request.schema.type !== 'object' || Buffer.byteLength(JSON.stringify(request.schema)) > 65536) return false;
  return true;
}

function runCli(args, inputText = '', outputLimit = 0, captureErrors = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      cwd: temporaryDirectory, env: childEnvironment, detached: true,
      stdio: ['pipe', outputLimit ? 'pipe' : 'ignore', captureErrors ? 'pipe' : 'ignore']
    });
    activeChild = child;
    const output = [];
    let outputBytes = 0;
    function collect(chunk) {
      if (finished) return;
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) {
        void stop(`${providerName} returned a result too large for Chrome. Try a smaller pull request.`);
        return;
      }
      output.push(chunk);
    }
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.stdin.on('error', () => {});
    child.once('error', () => reject(new Error(`${providerName} could not be started. Reinstall the helper after installing ${providerName}.`)));
    child.once('close', code => {
      activeChild = undefined;
      resolve({ code, output: Buffer.concat(output).toString('utf8') });
    });
    child.stdin.end(inputText);
  });
}

function analysisArguments(request) {
  const schemaPath = join(temporaryDirectory, 'schema.json');
  const instructionsPath = join(temporaryDirectory, 'instructions.txt');
  const outputPath = join(temporaryDirectory, 'result.json');
  writeFileSync(instructionsPath, `${request.prompt.system}\n\nAnalyze only the supplied evidence. Do not use tools, read local files, run commands, or browse. Return only the requested JSON.`, { mode: 0o600 });
  if (provider === 'claude') {
    const args = ['--safe-mode', '--setting-sources', '', '--print', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--output-format', 'json', '--json-schema', JSON.stringify(request.schema), '--system-prompt-file', instructionsPath];
    if (request.model) args.push('--model', request.model);
    return { args };
  }
  writeFileSync(schemaPath, JSON.stringify(request.schema), { mode: 0o600 });
  writeFileSync(outputPath, '', { mode: 0o600 });
  const configuration = {
    approval_policy: 'never', web_search: 'disabled',
    'history.persistence': 'none', project_doc_max_bytes: 0,
    'skills.include_instructions': false, 'features.skip_host_skill_discovery': true,
    model_instructions_file: instructionsPath,
    'tools.update_plan.enabled': false, 'tools.experimental_request_user_input.enabled': false
  };
  for (const feature of ['shell_tool', 'apps', 'plugins', 'hooks', 'browser_use', 'browser_use_external', 'computer_use', 'multi_agent', 'multi_agent_v2', 'image_generation', 'view_image', 'request_permissions_tool', 'sleep_tool', 'send_message_to_user_async', 'memories', 'external_agent_memory_import', 'goals', 'token_budget', 'tool_suggest', 'skill_search', 'skill_mcp_dependency_install']) {
    configuration[`features.${feature}`] = false;
  }
  const args = ['exec', '--strict-config', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-schema', schemaPath, '--output-last-message', outputPath];
  for (const [key, value] of Object.entries(configuration)) args.push('-c', `${key}=${JSON.stringify(value)}`);
  if (request.model) args.push('--model', request.model);
  args.push('-');
  return { args, outputPath };
}

async function handle(request) {
  try {
    temporaryDirectory = mkdtempSync(join(tmpdir(), `review-focus-${provider}-`));
    chmodSync(temporaryDirectory, 0o700);
    requestTimer = setTimeout(() => stop(`${providerName} took too long. Try again with a smaller pull request.`), request.type === 'status' ? 15000 : 600000);
    const statusArgs = provider === 'claude' ? ['--safe-mode', '--setting-sources', '', 'auth', 'status', '--json'] : ['login', 'status'];
    const { code: statusCode, output } = await runCli(statusArgs, '', 16384, provider === 'codex');
    if (finished) return;
    let authenticated = false;
    if (provider === 'claude') {
      try {
        const status = JSON.parse(output);
        authenticated = statusCode === 0 && status.loggedIn === true && status.authMethod === 'claude.ai' && status.apiProvider === 'firstParty';
      } catch {}
    } else authenticated = statusCode === 0 && output.split(/\r?\n/).some(line => line.trim() === 'Logged in using ChatGPT');
    if (request.type === 'status') {
      complete(authenticated ? { type: 'status', authenticated: true } : { type: 'status', authenticated: false, message: `Sign in with your ${providerName} account by running ${loginCommand}, then check the connection again.` });
      return;
    }
    if (!authenticated) {
      complete({ type: 'error', message: `Sign in with your ${providerName} account by running ${loginCommand}, then try again.` });
      return;
    }
    const { args, outputPath } = analysisArguments(request);
    const { code, output: analysisOutput } = await runCli(args, request.prompt.user, provider === 'claude' ? 4 * 1024 * 1024 : 0);
    if (finished) return;
    if (code !== 0) {
      complete({ type: 'error', message: `${providerName} could not complete this analysis. Check ${statusCommand}, model access, and account limits, then try again.` });
      return;
    }
    if (outputPath && statSync(outputPath).size > maxOutputBytes - 128) {
      complete({ type: 'error', message: `${providerName} returned a result too large for Chrome. Try a smaller pull request.` });
      return;
    }
    let result;
    try { result = JSON.parse(outputPath ? readFileSync(outputPath, 'utf8') : analysisOutput); } catch {
      complete({ type: 'error', message: `${providerName} did not return valid JSON. No review changes were applied.` });
      return;
    }
    if (provider === 'claude') {
      if (!object(result) || result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false) {
        complete({ type: 'error', message: 'Claude Code could not complete this analysis. Check model access and account limits, then try again.' });
        return;
      }
      result = result.structured_output;
    }
    if (!object(result)) {
      complete({ type: 'error', message: `${providerName} did not return a review object. No review changes were applied.` });
      return;
    }
    complete({ type: 'result', result });
  } catch {
    complete({ type: 'error', message: `The local ${providerName} helper could not complete the request. Check that ${providerName} is installed and signed in.` });
  }
}

process.stdout.on('error', () => { disconnected = true; void stop('Chrome disconnected.'); });
process.stdin.on('error', () => { disconnected = true; void stop('Chrome disconnected.'); });
process.stdin.on('end', () => {
  if (finished) return;
  if (!started) { complete({ type: 'error', message: 'Chrome sent an incomplete request.' }); return; }
  disconnected = true;
  void stop('Chrome disconnected.');
});
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { disconnected = true; void stop('The review was cancelled.'); });

if (!['codex', 'claude'].includes(provider) || !isAbsolute(executablePath ?? '') || process.argv[4] !== origin || process.argv.length !== 5) {
  complete({ type: 'error', message: 'This helper only accepts requests from the PRiorities extension.' });
} else {
  process.stdin.on('data', chunk => {
    if (finished) return;
    if (started) { void stop('Only one request is allowed per connection.'); return; }
    if (input.length + chunk.length > maxInputBytes + 4) { complete({ type: 'error', message: 'The review request is too large.' }); return; }
    input = Buffer.concat([input, chunk]);
    if (expectedBytes === undefined && input.length >= 4) {
      expectedBytes = littleEndian ? input.readUInt32LE(0) : input.readUInt32BE(0);
      if (expectedBytes === 0 || expectedBytes > maxInputBytes) { complete({ type: 'error', message: 'The review request has an invalid size.' }); return; }
    }
    if (expectedBytes === undefined || input.length < expectedBytes + 4) return;
    if (input.length !== expectedBytes + 4) { complete({ type: 'error', message: 'Only one request is allowed per connection.' }); return; }
    let request;
    try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.subarray(4))); } catch {
      complete({ type: 'error', message: 'Chrome sent an invalid JSON request.' });
      return;
    }
    if (!validRequest(request)) { complete({ type: 'error', message: 'Chrome sent an invalid review request.' }); return; }
    input = Buffer.alloc(0);
    started = true;
    void handle(request);
  });
}
