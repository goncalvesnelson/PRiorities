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
const tooLarge = `${providerName} returned a result too large for Chrome. Try a smaller pull request.`;
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
let progressTimer;
let progressSentAt = 0;
let pendingProgress;

class HelperError extends Error {}

function cleanup() {
  clearTimeout(requestTimer);
  clearTimeout(progressTimer);
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
}

function frame(body) {
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function send(message) {
  let body = Buffer.from(JSON.stringify(message));
  if (body.length > maxOutputBytes) body = Buffer.from(JSON.stringify({ type: 'error', message: tooLarge }));
  process.stdin.destroy();
  process.stdout.end(frame(body), () => process.exit(0));
}

function reportProgress(progress) {
  pendingProgress = progress;
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = undefined;
    if (finished || disconnected) return;
    progressSentAt = Date.now();
    process.stdout.write(frame(Buffer.from(JSON.stringify(pendingProgress))));
  }, Math.max(0, progressSentAt + 1000 - Date.now()));
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
  if (['status', 'models'].includes(request.type)) return Object.keys(request).length === 1;
  if (request.type !== 'analyze' || Object.keys(request).some(key => !['type', 'model', 'effort', 'prompt', 'schema'].includes(key))) return false;
  if (typeof request.model !== 'string' || (request.model !== '' && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(request.model))) return false;
  if (typeof request.effort !== 'string' || !/^(?:[a-z][a-z0-9_-]{0,29})?$/.test(request.effort)) return false;
  if (!object(request.prompt) || Object.keys(request.prompt).length !== 2) return false;
  if (typeof request.prompt.system !== 'string' || !request.prompt.system.trim() || Buffer.byteLength(request.prompt.system) > 65536) return false;
  if (typeof request.prompt.user !== 'string' || !request.prompt.user.trim()) return false;
  if (!object(request.schema) || request.schema.type !== 'object' || Buffer.byteLength(JSON.stringify(request.schema)) > 65536) return false;
  return true;
}

function runCli(args, inputText = '', outputLimit = 0, readLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      cwd: temporaryDirectory, env: childEnvironment, detached: true,
      stdio: ['pipe', outputLimit ? 'pipe' : 'ignore', 'pipe']
    });
    activeChild = child;
    const output = [];
    const errors = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let line = Buffer.alloc(0);
    function keep(chunk) {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) {
        void stop(tooLarge);
        return;
      }
      output.push(chunk);
    }
    function collect(chunk) {
      if (finished) return;
      if (!readLine) {
        keep(chunk);
        return;
      }
      line = Buffer.concat([line, chunk]);
      let newline;
      while (!finished && (newline = line.indexOf(10)) >= 0) {
        keep(Buffer.from(readLine(line.subarray(0, newline + 1).toString('utf8'))));
        line = line.subarray(newline + 1);
      }
      if (line.length > outputLimit) void stop(tooLarge);
    }
    child.stdout?.on('data', collect);
    child.stderr?.on('data', chunk => {
      const remaining = 16384 - errorBytes;
      if (remaining <= 0) return;
      const part = chunk.subarray(0, remaining);
      errors.push(part);
      errorBytes += part.length;
    });
    child.stdin.on('error', () => {});
    child.once('error', () => reject(new HelperError(`${providerName} could not be started. Reinstall the helper after installing ${providerName}.`)));
    child.once('close', code => {
      activeChild = undefined;
      if (readLine && line.length && !finished) keep(Buffer.from(readLine(line.toString('utf8'))));
      resolve({ code, output: Buffer.concat(output).toString('utf8'), errorOutput: Buffer.concat(errors).toString('utf8') });
    });
    child.stdin.end(inputText);
  });
}

function cliFailure(output) {
  if (/(?:unknown|unrecognized|unexpected) (?:argument|option|flag)|unknown subcommand/i.test(output)) return `${providerName} does not support a required CLI option. Update ${providerName}, reinstall the helper, and try again.`;
  if (/(?:invalid|unsupported|unknown)[^\n]{0,80}(?:reasoning|effort)|(?:reasoning|effort)[^\n]{0,80}(?:invalid|unsupported|not supported|not available)/i.test(output)) return `${providerName} rejected the selected effort. Choose an effort supported by this model in Settings.`;
  if (/model_not_found|(?:invalid|unknown|unsupported) model|model[^\n]{0,256}(?:not found|(?:does|may) not exist|not supported|not available|not have access|access denied)|(?:do not|don't) have access to[^\n]{0,40}model/i.test(output)) return `${providerName} could not use the selected model. Choose an available model in Settings or check the custom model ID and your account's access.`;
  if (/rate[_ -]?limit|usage limit|quota|too many requests|hit your (?:usage )?limit|exceeded[^\n]{0,40}limit/i.test(output)) return `${providerName} reached an account or rate limit. Wait for the limit to reset or check your account allowance, then retry.`;
  if (/authentication_error|unauthorized|invalid_api_key|token[^\n]{0,30}expired|not logged in/i.test(output)) return `${providerName} rejected the login credentials. Run ${loginCommand}, then check the connection again.`;
  if (/ECONN(?:REFUSED|RESET)|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network (?:error|failure)|connection (?:error|failed|refused|reset)|failed to (?:connect|fetch)|request timed out|TLS|certificate/i.test(output)) return `${providerName} could not reach its service. Check your network connection and CLI proxy settings, then retry.`;
  return null;
}

function codexFailure({ code, output, errorOutput }, args) {
  if (code !== 0 && !output.trim()) {
    const startupError = errorOutput.replace(/^WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted \(os error 1\)\r?\n/, '');
    const rejectedOption = /^error: unexpected argument '(-{1,2}[a-z][a-z-]*)' found(?:\r?\n|$)/.exec(startupError)?.[1];
    if (rejectedOption && args.includes(rejectedOption)) return 'Codex does not support a required CLI option. Update Codex, reinstall the helper, and try again.';
  }
  let failure = null;
  for (const line of output.split(/\r?\n/).filter(line => line.trim())) {
    let event;
    try { event = JSON.parse(line); } catch {
      throw new HelperError('Codex returned unreadable analysis events. Update the CLI and retry. No review changes were applied.');
    }
    if (event?.type === 'turn.completed') failure = null;
    if (!['error', 'turn.failed'].includes(event?.type)) continue;
    const message = event.type === 'turn.failed' ? event.error?.message : event.message;
    if (typeof message !== 'string') throw new HelperError('Codex returned an unreadable analysis error. Update the CLI and retry.');
    failure = cliFailure(message) ?? 'Codex stopped before completing this analysis. Run the CLI in Terminal to inspect the failure, then retry. No review changes were applied.';
  }
  return failure;
}

function loginStatus({ code, output, errorOutput }) {
  const diagnostics = `${output}\n${errorOutput}`;
  let loggedIn;
  let supportedAccount;
  if (provider === 'claude') {
    let status;
    try { status = JSON.parse(output); } catch {}
    if (object(status) && typeof status.loggedIn === 'boolean') {
      loggedIn = status.loggedIn;
      if (typeof status.authMethod === 'string' && typeof status.apiProvider === 'string') supportedAccount = status.authMethod === 'claude.ai' && status.apiProvider === 'firstParty';
    }
  } else {
    const lines = diagnostics.split(/\r?\n/).map(line => line.trim());
    if (lines.includes('Logged in using ChatGPT')) { loggedIn = true; supportedAccount = true; }
    else if (lines.some(line => line.startsWith('Logged in using an API key'))) { loggedIn = true; supportedAccount = false; }
    else if (lines.includes('Not logged in')) loggedIn = false;
  }
  if (loggedIn === false) return { authenticated: false, message: `Sign in with your ${providerName} account by running ${loginCommand}, then check the connection again.` };
  if (loggedIn && supportedAccount === false) return { authenticated: false, message: `This helper requires a ${provider === 'claude' ? 'Claude subscription login through claude.ai' : 'ChatGPT login'}. The CLI is using a different account mode. Switch accounts with ${loginCommand}, then check the connection again.` };
  if (code === 0 && loggedIn && supportedAccount) return { authenticated: true };
  const failure = cliFailure(diagnostics);
  if (failure) throw new HelperError(failure);
  if (code !== 0) throw new HelperError(`${providerName} could not check its login. Run ${statusCommand} in Terminal to inspect the failure, then check the connection again.`);
  throw new HelperError(`${providerName} returned an unreadable login status. Run ${statusCommand} in Terminal and update the CLI before checking again.`);
}

function progressText(text) {
  return [...text.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ')].slice(0, 200).join('').trim();
}

// Tolerates truncated or malformed JSON: only complete strings at known positions count.
function answerScanner(progress) {
  let containers = [];
  let text;
  let escaped = false;
  function finishString() {
    const top = containers.at(-1);
    if (top && !top.array && top.expectingKey) {
      top.key = text;
      return false;
    }
    const [root, list, item] = containers;
    if (containers.length !== 3 || root.array || !list.array || item.array) return false;
    if (list.name === 'topics' && item.key === 'title' && progress.sections.length < 50) {
      let title;
      try { title = JSON.parse(`"${text}"`); } catch { return false; }
      title = progressText(title);
      if (title) progress.sections.push(title);
      return Boolean(title);
    }
    if (['classifications', 'edits'].includes(list.name) && item.key === 'editId') {
      progress.labelled++;
      return true;
    }
    return false;
  }
  return delta => {
    let changed = false;
    for (const character of delta) {
      if (!containers) break;
      if (text !== undefined) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') {
          changed = finishString() || changed;
          text = undefined;
          continue;
        }
        if (text.length < 1000) text += character;
        continue;
      }
      const top = containers.at(-1);
      if (character === '"') text = '';
      else if (character === '{') containers.push({ array: false, expectingKey: true });
      else if (character === '[') containers.push({ array: true, name: top?.key });
      else if (character === ':' && top && !top.array) top.expectingKey = false;
      else if (character === ',' && top && !top.array) Object.assign(top, { expectingKey: true, key: undefined });
      else if (character === '}' || character === ']') {
        if (!top || top.array !== (character === ']')) containers = undefined;
        else containers.pop();
      }
    }
    return changed;
  };
}

function analysisReader() {
  const progress = { phase: '', sections: [], labelled: 0, thought: '' };
  let scan;
  const report = phase => {
    progress.phase = phase;
    reportProgress({ type: 'progress', phase, sections: [...progress.sections], labelled: progress.labelled, thought: progress.thought });
  };
  return line => {
    let event;
    try { event = JSON.parse(line); } catch { return line; }
    if (provider === 'codex') {
      if (event?.type === 'turn.started') report('reasoning');
      const item = event?.type === 'item.completed' ? event.item : undefined;
      // Codex sends a reasoning step once it ends, joining its summary parts with newlines; each part usually opens with a bold headline.
      if (item?.type === 'reasoning' && typeof item.text === 'string') {
        const headlines = item.text.split('\n').map(line => line.trim().match(/^\*\*(.+)\*\*$/)?.[1]).filter(Boolean);
        const thought = progressText(headlines.at(-1) ?? item.text.trim().split('\n', 1)[0]);
        if (thought) {
          progress.thought = thought;
          report('reasoning');
        }
      }
      return line;
    }
    if (event?.type === 'result') return line;
    const stream = event?.type === 'stream_event' ? event.event : undefined;
    const block = stream?.type === 'content_block_start' ? stream.content_block?.type : undefined;
    if (block === 'thinking') report('reasoning');
    if (block === 'tool_use') {
      Object.assign(progress, { sections: [], labelled: 0 });
      scan = answerScanner(progress);
      report('writing');
    }
    if (scan && stream?.type === 'content_block_delta' && typeof stream.delta?.partial_json === 'string' && scan(stream.delta.partial_json)) report(progress.phase);
    return '';
  };
}

function analysisArguments(request) {
  const schemaPath = join(temporaryDirectory, 'schema.json');
  const instructionsPath = join(temporaryDirectory, 'instructions.txt');
  const outputPath = join(temporaryDirectory, 'result.json');
  writeFileSync(instructionsPath, `${request.prompt.system}\n\nAnalyze only the supplied evidence. Do not use tools, read local files, run commands, or browse. Return only the requested JSON.`, { mode: 0o600 });
  if (provider === 'claude') {
    const args = ['--safe-mode', '--setting-sources', '', '--print', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-chrome', '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--json-schema', JSON.stringify(request.schema), '--system-prompt-file', instructionsPath];
    if (request.model) args.push('--model', request.model);
    if (request.effort) args.push('--effort', request.effort);
    return { args };
  }
  writeFileSync(schemaPath, JSON.stringify(request.schema), { mode: 0o600 });
  writeFileSync(outputPath, '', { mode: 0o600 });
  const configuration = {
    approval_policy: 'never', web_search: 'disabled', model_reasoning_summary: 'auto',
    'history.persistence': 'none', project_doc_max_bytes: 0,
    'skills.include_instructions': false, 'features.skip_host_skill_discovery': true,
    model_instructions_file: instructionsPath,
    'tools.update_plan.enabled': false, 'tools.experimental_request_user_input.enabled': false
  };
  for (const feature of ['shell_tool', 'apps', 'plugins', 'hooks', 'browser_use', 'browser_use_external', 'computer_use', 'multi_agent', 'multi_agent_v2', 'image_generation', 'view_image', 'request_permissions_tool', 'sleep_tool', 'send_message_to_user_async', 'memories', 'external_agent_memory_import', 'goals', 'token_budget', 'tool_suggest', 'skill_search', 'skill_mcp_dependency_install']) {
    configuration[`features.${feature}`] = false;
  }
  const args = ['exec', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--output-schema', schemaPath, '--output-last-message', outputPath];
  for (const [key, value] of Object.entries(configuration)) args.push('-c', `${key}=${JSON.stringify(value)}`);
  if (request.model) args.push('--model', request.model);
  if (request.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(request.effort)}`);
  args.push('-');
  return { args, outputPath };
}

function readModels() {
  return new Promise((resolve, reject) => {
    const args = provider === 'codex'
      ? ['app-server', '--stdio', '-c', 'features.plugins=false', '-c', 'features.hooks=false', '-c', 'features.apps=false']
      : ['--safe-mode', '--setting-sources', '', '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
    const child = spawn(executablePath, args, { cwd: temporaryDirectory, env: childEnvironment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    activeChild = child;
    let buffer = '';
    let bytes = 0;
    let models;
    let failure;
    let errorOutput = '';
    const catalog = [];
    const cursors = new Set();
    const sendRequest = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    const finish = (value, error) => {
      if (models || failure) return;
      models = value;
      failure = error;
      child.stdin.end();
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    };
    child.stdin.on('error', () => {});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(0, 16384); });
    child.once('error', () => reject(new HelperError(`${providerName} could not be started. Reinstall the helper after installing ${providerName}.`)));
    child.once('close', () => {
      activeChild = undefined;
      if (models) resolve(models);
      else reject(failure ?? new HelperError(cliFailure(errorOutput) ?? `${providerName} closed before returning its models. Run ${statusCommand} in Terminal and update the CLI before trying again.`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (models || failure || finished) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) { finish(null, new HelperError('The model catalog is too large.')); return; }
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (provider === 'codex' && message.id === 1) {
            if (message.error) throw new HelperError('Codex could not initialize its model catalog. Update the CLI and retry.');
            sendRequest({ method: 'initialized', params: {} });
            sendRequest({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: true } });
          } else if (provider === 'codex' && message.id === 2) {
            if (!Array.isArray(message.result?.data)) throw new HelperError('Codex returned an unreadable model catalog. Update the CLI and retry.');
            catalog.push(...message.result.data);
            if (catalog.length > 500) throw new HelperError('The model catalog exceeds the 500-model limit.');
            const cursor = message.result.nextCursor;
            if (cursor) {
              if (typeof cursor !== 'string' || cursors.has(cursor)) throw new HelperError('Codex repeated a model catalog page. Update the CLI and retry.');
              cursors.add(cursor);
              sendRequest({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: true, cursor } });
            } else finish(catalog.map(model => ({ id: model.model, label: model.displayName, efforts: model.supportedReasoningEfforts?.map(option => option.reasoningEffort), defaultEffort: model.defaultReasoningEffort, isDefault: model.isDefault === true })));
          } else if (provider === 'claude' && message.type === 'control_response' && message.response?.request_id === 'catalog') {
            const entries = message.response.response?.models;
            if (message.response.subtype !== 'success' || !Array.isArray(entries)) throw new HelperError('Claude Code could not return its model catalog. Update the CLI and retry.');
            if (entries.length > 500) throw new HelperError('The model catalog exceeds the 500-model limit.');
            finish(entries.map(model => ({ id: model.resolvedModel, label: model.displayName, efforts: model.supportedEffortLevels ?? [], defaultEffort: model.supportedEffortLevels?.includes('medium') ? 'medium' : model.supportedEffortLevels?.[0] ?? '', isDefault: model.value === 'default' })));
          }
        } catch (error) { finish(null, error instanceof HelperError ? error : new HelperError(`${providerName} returned an unreadable model catalog. Update the CLI and retry.`)); }
      }
    });
    if (provider === 'codex') sendRequest({ id: 1, method: 'initialize', params: { clientInfo: { name: 'priorities', version: '0.6.0' } } });
    else sendRequest({ type: 'control_request', request_id: 'catalog', request: { subtype: 'initialize' } });
  });
}

async function handle(request) {
  try {
    try {
      temporaryDirectory = mkdtempSync(join(tmpdir(), `review-focus-${provider}-`));
      chmodSync(temporaryDirectory, 0o700);
    } catch (error) {
      if (typeof error.code !== 'string') throw error;
      throw new HelperError('The local helper could not create its private working directory. Check local disk space and temporary-folder permissions.');
    }
    requestTimer = setTimeout(() => stop(`${providerName} took too long. Check its connection and try again.`), request.type === 'analyze' ? 600000 : request.type === 'models' ? 30000 : 15000);
    const statusArgs = provider === 'claude' ? ['--safe-mode', '--setting-sources', '', 'auth', 'status', '--json'] : ['login', 'status'];
    const statusResult = await runCli(statusArgs, '', 16384);
    if (finished) return;
    const status = loginStatus(statusResult);
    if (request.type === 'status') {
      complete({ type: 'status', ...status });
      return;
    }
    if (!status.authenticated) {
      complete({ type: 'error', message: status.message });
      return;
    }
    if (request.type === 'models') {
      const models = await readModels();
      const unique = [...new Map(models.map(model => [model.id, model])).values()];
      const defaultModel = models.find(model => model.isDefault)?.id;
      if (!unique.length || unique.some(model => typeof model.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(model.id) || typeof model.label !== 'string' || model.label.length > 200 || !Array.isArray(model.efforts) || model.efforts.length > 20 || model.efforts.some(effort => typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,29}$/.test(effort)) || typeof model.defaultEffort !== 'string' || model.defaultEffort && !model.efforts.includes(model.defaultEffort))) throw new HelperError(`${providerName} returned an unreadable model catalog. Update the CLI and retry.`);
      complete({ type: 'models', models: unique.map(model => ({ ...model, isDefault: model.id === defaultModel })) });
      return;
    }
    let analysis;
    try { analysis = analysisArguments(request); } catch (error) {
      if (typeof error.code !== 'string') throw error;
      throw new HelperError('The local helper could not prepare its analysis files. Check local disk space and temporary-folder permissions.');
    }
    const { args, outputPath } = analysis;
    const cliResult = await runCli(args, request.prompt.user, 4 * 1024 * 1024, analysisReader());
    if (finished) return;
    const { code, output: analysisOutput, errorOutput } = cliResult;
    const failure = provider === 'codex' ? codexFailure(cliResult, args) : cliFailure(`${errorOutput}\n${analysisOutput}`);
    if (code !== 0 || provider === 'codex' && failure) {
      complete({ type: 'error', message: failure ?? `${providerName} stopped before completing this analysis. Run the CLI in Terminal to inspect the failure, then retry. No review changes were applied.` });
      return;
    }
    let resultText = analysisOutput;
    if (outputPath) {
      try {
        if (statSync(outputPath).size > maxOutputBytes - 128) {
          complete({ type: 'error', message: tooLarge });
          return;
        }
        resultText = readFileSync(outputPath, 'utf8');
      } catch (error) {
        if (typeof error.code !== 'string') throw error;
        throw new HelperError('The local helper could not read the Codex analysis file. Check local disk space and temporary-folder permissions, then retry. No review changes were applied.');
      }
    }
    let result;
    try { result = JSON.parse(resultText); } catch {
      complete({ type: 'error', message: `${providerName} did not return valid JSON. No review changes were applied.` });
      return;
    }
    if (provider === 'claude') {
      if (!object(result) || result.type !== 'result' || result.subtype !== 'success' || result.is_error !== false) {
        complete({ type: 'error', message: cliFailure(analysisOutput) ?? 'Claude Code reported an unsuccessful analysis. Run the CLI in Terminal to inspect the failure, then retry. No review changes were applied.' });
        return;
      }
      result = result.structured_output;
    }
    if (!object(result)) {
      complete({ type: 'error', message: `${providerName} did not return a review object. No review changes were applied.` });
      return;
    }
    complete({ type: 'result', result });
  } catch (error) {
    complete({ type: 'error', message: error instanceof HelperError ? error.message : `The local ${providerName} helper encountered an unexpected error. Reinstall the helper and retry.` });
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
