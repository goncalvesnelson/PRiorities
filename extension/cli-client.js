function connectionError(label, message) {
  if (/not found|not registered|specified native messaging host/i.test(message)) {
    return new Error(`The PRiorities ${label} helper is not installed. Run node install-native-host.mjs from the PRiorities folder, then check the connection again.`);
  }
  return new Error(`The local ${label} helper disconnected. ${message || 'Check the helper installation and retry.'}`);
}

function nativeRequest(provider, request, signal) {
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
      if (message?.type === 'progress') return;
      if (message?.type === 'error' && typeof message.message === 'string' && message.message.trim() && message.message.length <= 4000) {
        finish(new Error(message.message));
        return;
      }
      if (request.type === 'status' && message?.type === 'status' && typeof message.authenticated === 'boolean' && (message.message === undefined || typeof message.message === 'string' && message.message.length <= 4000)) {
        finish(null, { authenticated: message.authenticated, ...(message.message ? { message: message.message } : {}) });
        return;
      }
      if (request.type === 'analyze' && message?.type === 'result' && message.result && typeof message.result === 'object' && !Array.isArray(message.result)) {
        finish(null, message.result);
        return;
      }
      finish(new Error(`The local ${label} helper returned an unreadable response.`));
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (request.type === 'status') timeout = setTimeout(() => finish(new Error(`The local ${label} helper did not respond. Check its installation and your login.`)), 15_000);
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

export function analyzeWithCLI({ provider, model, prompt, schema, signal }) {
  return nativeRequest(provider, { type: 'analyze', model, prompt, schema }, signal);
}
