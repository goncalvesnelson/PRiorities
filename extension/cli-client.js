function connectionError(label, message) {
  if (/not found|not registered|specified native messaging host/i.test(message)) {
    return new Error(`The PRiorities ${label} helper is not installed. Run node install-native-host.mjs from the PRiorities folder, then check the connection again.`);
  }
  return new Error(`The local ${label} helper disconnected. ${message || 'Check the helper installation and retry.'}`);
}

function validProgressText(text) {
  return typeof text === 'string' && [...text].length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(text);
}

function validProgress(message) {
  return Object.keys(message).length === 5 && ['reasoning', 'writing'].includes(message.phase)
    && Number.isSafeInteger(message.labelled) && message.labelled >= 0
    && Array.isArray(message.sections) && message.sections.length <= 50
    && message.sections.every(title => validProgressText(title) && title.length > 0)
    && validProgressText(message.thought);
}

function nativeRequest(provider, request, signal, onProgress) {
  return new Promise((resolve, reject) => {
    if (!['codex', 'claude'].includes(provider)) {
      reject(new Error('Choose Codex or Claude Code in Settings.'));
      return;
    }
    const label = provider === 'claude' ? 'Claude Code' : 'Codex';
    if (signal?.aborted) {
      reject(new Error('Analysis cancelled.'));
      return;
    }

    let port;
    try {
      port = chrome.runtime.connectNative(`com.review_focus.${provider}`);
    } catch (error) {
      reject(connectionError(label, error.message));
      return;
    }

    let settled = false;
    let timeout;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      port.disconnect();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new Error('Analysis cancelled.'));
    const onDisconnect = () => finish(connectionError(label, chrome.runtime.lastError?.message));
    const onMessage = message => {
      if (message?.type === 'error' && typeof message.message === 'string' && message.message.trim() && message.message.length <= 4000) {
        finish(new Error(message.message));
        return;
      }
      if (request.type === 'status' && message?.type === 'status' && typeof message.authenticated === 'boolean' && (message.message === undefined || typeof message.message === 'string' && message.message.length <= 4000)) {
        finish(null, { authenticated: message.authenticated, ...(message.message ? { message: message.message } : {}) });
        return;
      }
      if (request.type === 'analyze' && message?.type === 'progress') {
        if (validProgress(message)) onProgress?.({ phase: message.phase, sections: message.sections, labelled: message.labelled, thought: message.thought });
        return;
      }
      if (request.type === 'analyze' && message?.type === 'result' && message.result && typeof message.result === 'object' && !Array.isArray(message.result)) {
        finish(null, message.result);
        return;
      }
      if (request.type === 'models' && message?.type === 'models' && Array.isArray(message.models) && message.models.length > 0 && message.models.length <= 500 && message.models.every(model => model && typeof model.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(model.id) && typeof model.label === 'string' && model.label.length <= 200 && Array.isArray(model.efforts) && model.efforts.length <= 20 && model.efforts.every(effort => typeof effort === 'string' && /^[a-z][a-z0-9_-]{0,29}$/.test(effort)) && typeof model.defaultEffort === 'string' && (!model.defaultEffort || model.efforts.includes(model.defaultEffort)) && typeof model.isDefault === 'boolean')) {
        finish(null, message.models);
        return;
      }
      finish(new Error(`The local ${label} helper returned an unreadable response.`));
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (request.type === 'status') timeout = setTimeout(() => finish(new Error(`The local ${label} helper did not respond. Check its installation and your login.`)), 15_000);
    if (request.type === 'models') timeout = setTimeout(() => finish(new Error(`The local ${label} helper did not return its models. Check its connection and try again.`)), 35_000);
    try {
      port.postMessage(request);
    } catch (error) {
      finish(connectionError(label, error.message));
    }
  });
}

export function getCLIStatus(provider) {
  return nativeRequest(provider, { type: 'status' });
}

export function getCLIModels(provider) {
  return nativeRequest(provider, { type: 'models' });
}

export function analyzeWithCLI({ provider, model, effort = '', prompt, schema, signal, onProgress }) {
  return nativeRequest(provider, { type: 'analyze', model, effort, prompt, schema }, signal, onProgress);
}
