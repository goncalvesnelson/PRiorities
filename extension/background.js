import { analyzeWithCLI, getCLIStatus } from './cli-client.js';
import { analysisSchema, classificationSchema, isGeneratedFile, makeClassificationPrompt, makePrompt, validateAnalysis, validateClassifications, validateSnapshot } from './review-data.js';
import { cacheInfo, clearCache, deleteReview, peekReview, readReview, reviewCacheKey, reviewLookup, saveReview, setCacheLimit } from './review-cache.js';

const jobs = new Map();
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).then(() => chrome.storage.local.remove('settings'));

function isOptions(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('options.html');
}

function pullRequestUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)(?:\/.*)?$/);
    if (url.origin !== 'https://github.com' || !match) return null;
    return `${url.origin}/${match[1]}/${match[2]}/pull/${match[3]}`;
  } catch {
    return null;
  }
}

function isPullRequest(sender) {
  return sender.id === chrome.runtime.id && sender.frameId === 0 && Number.isInteger(sender.tab?.id) && Boolean(pullRequestUrl(sender.url));
}

async function readSettings(provider) {
  await storageReady;
  if (!provider) {
    const stored = await chrome.storage.local.get('reviewProvider');
    provider = stored.reviewProvider === 'claude' ? 'claude' : 'codex';
  }
  const key = `${provider}Settings`;
  const stored = await chrome.storage.local.get(key);
  return { provider, model: validModel(stored[key]?.model) ? stored[key].model : '' };
}

function validModel(model) {
  return typeof model === 'string' && (model === '' || /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(model));
}

async function publicSettings(settings) {
  const result = { configured: false, ...settings };
  try {
    const status = await getCLIStatus(settings.provider);
    if (status.authenticated) return { ...result, configured: true };
    return { ...result, connectionError: status.message || `Sign in with ${settings.provider === 'claude' ? 'claude auth login' : 'codex login'}, then check the connection again.` };
  } catch (error) {
    return { ...result, connectionError: error.message };
  }
}

async function handleMessage(message, sender) {
  if (!isOptions(sender) && !isPullRequest(sender)) throw new Error('This page cannot use PRiorities.');
  if (message?.type === 'get-settings') {
    if (message.provider !== undefined && !isOptions(sender)) throw new Error('Only the settings page can select the provider.');
    if (message.provider !== undefined && !['codex', 'claude'].includes(message.provider)) throw new Error('Choose Codex or Claude Code.');
    const settings = await readSettings(message.provider);
    return publicSettings(settings);
  }
  if (message?.type === 'open-settings') {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  if (message?.type === 'peek-review' && isPullRequest(sender)) {
    if (![message.baseSha, message.headSha].every(sha => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha))) return { available: false };
    const settings = await readSettings();
    try {
      return await peekReview(reviewLookup({ url: pullRequestUrl(sender.url), baseSha: message.baseSha, headSha: message.headSha }, settings));
    } catch { return { available: false }; }
  }
  if (!isOptions(sender)) throw new Error('Only the settings page can change the provider or model.');
  if (message?.type === 'cache-info') return cacheInfo();
  if (message?.type === 'clear-cache') return clearCache();
  if (message?.type === 'set-cache-limit') return setCacheLimit(message.limitMB);
  if (message?.type === 'save-settings') {
    if (Object.keys(message).some(key => !['type', 'provider', 'model'].includes(key))) {
      throw new Error('Only provider and model preferences can be saved. Sign in through the selected CLI.');
    }
    if (!['codex', 'claude'].includes(message.provider)) throw new Error('Choose Codex or Claude Code.');
    if (!validModel(message.model)) {
      throw new Error('Enter a valid model ID, or leave it blank to use the selected CLI’s default.');
    }
    await storageReady;
    const settings = { provider: message.provider, model: message.model };
    await chrome.storage.local.set({ reviewProvider: settings.provider, [`${settings.provider}Settings`]: { model: settings.model } });
    return publicSettings(settings);
  }
  throw new Error('Unknown PRiorities request.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handleMessage(message, sender).then(respond, error => respond({ error: error.message }));
  return true;
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'review-focus' || !isPullRequest(port.sender)) {
    port.disconnect();
    return;
  }

  let job;
  let connected = true;
  const tabId = port.sender.tab.id;
  const send = message => {
    if (!connected) return;
    try {
      port.postMessage(message);
    } catch {
      disconnect();
    }
  };

  function setFileState(entry, state, message, analysis) {
    entry.state = state;
    if (analysis) entry.analysis = analysis;
    send({ type: 'file-progress', path: entry.snapshot.files[0].path, state, ...(message ? { message } : {}), ...(analysis ? { analysis } : {}) });
  }

  function settle(session, state, message) {
    if (!connected || session.settled) return;
    session.settled = true;
    const update = { type: 'settled', state, message };
    keepSessionAlive(session, update);
    send(update);
  }

  function stopIdleHeartbeat(session) {
    clearInterval(session.idleHeartbeat);
    session.idleHeartbeat = null;
  }

  function keepSessionAlive(session, update) {
    stopIdleHeartbeat(session);
    // Port messages keep Chrome's service worker alive while more files can be requested or retried.
    session.idleHeartbeat = setInterval(() => send(update), 20_000);
  }

  function cancel() {
    if (!job || job.finalState === 'complete') return;
    stopIdleHeartbeat(job);
    job.cancelled = true;
    job.settled = false;
    for (const entry of job.files.values()) {
      if (entry.state === 'queued') setFileState(entry, 'cancelled', 'Cancelled before analysis.');
      entry.controller?.abort();
    }
    job.checking?.abort();
    if (!job.active && !job.checking) settle(job, 'cancelled', 'Analysis cancelled. Completed file reviews are kept.');
  }

  function disconnect() {
    connected = false;
    if (job) stopIdleHeartbeat(job);
    cancel();
    if (jobs.get(tabId) === job) jobs.delete(tabId);
  }

  async function analyzeFile(session, entry) {
    const controller = new AbortController();
    entry.controller = controller;
    let timedOut = false;
    const started = Date.now();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 600_000);
    const heartbeat = setInterval(() => send({
      type: 'file-progress', path: entry.snapshot.files[0].path, state: entry.state,
      message: `${entry.state === 'classifying' ? 'Classifying edits' : 'Choosing review decisions'}… ${Math.floor((Date.now() - started) / 1000)}s`
    }), 15_000);
    try {
      setFileState(entry, 'classifying', 'Classifying edits…');
      const request = { ...session.settings, signal: controller.signal };
      const changedPaths = [...session.files.values()].filter(file => file.included).map(file => file.snapshot.files[0].path);
      const rawClassifications = await analyzeWithCLI({ ...request, prompt: makeClassificationPrompt(entry.snapshot, changedPaths), schema: classificationSchema });
      if (controller.signal.aborted) throw new Error('Analysis cancelled.');
      const classifications = validateClassifications(rawClassifications, entry.snapshot);
      setFileState(entry, 'prioritizing', 'Choosing review decisions…');
      const raw = await analyzeWithCLI({ ...request, prompt: makePrompt(entry.snapshot, classifications, { changedPaths }), schema: analysisSchema });
      if (controller.signal.aborted) throw new Error('Analysis cancelled.');
      const analysis = { ...validateAnalysis(raw, entry.snapshot), classifications };
      setFileState(entry, 'complete', 'Ready. The check across files may revise this review.', analysis);
    } catch (error) {
      if (timedOut) setFileState(entry, 'failed', 'This file timed out after 10 minutes. Its changes remain expanded. Retry this file to continue.');
      else if (controller.signal.aborted) setFileState(entry, 'cancelled', 'Analysis cancelled. This file remains expanded.');
      else setFileState(entry, 'failed', `${error.message || 'Analysis failed.'} This file remains expanded.`);
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      entry.controller = null;
      session.active--;
      schedule(session);
    }
  }

  async function checkAcrossFiles(session) {
    stopIdleHeartbeat(session);
    const controller = new AbortController();
    const version = session.checkVersion;
    session.checking = controller;
    session.finalState = 'checking';
    let timedOut = false;
    const started = Date.now();
    const progress = 'Checking related changes across files…';
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 600_000);
    const heartbeat = setInterval(() => send({ type: 'progress', stage: 'checking', message: `${progress} ${Math.floor((Date.now() - started) / 1000)}s` }), 15_000);
    try {
      send({ type: 'progress', stage: 'checking', message: progress });
      const complete = [...session.files.values()].filter(entry => entry.state === 'complete');
      const includedPaths = new Set([...session.files].filter(([, entry]) => entry.included).map(([path]) => path));
      const excludedPaths = session.snapshot.files.filter(file => !includedPaths.has(file.path)).map(file => file.path);
      const snapshot = {
        ...session.snapshot,
        files: session.snapshot.files.filter(file => includedPaths.has(file.path)),
        context: session.snapshot.context.filter(source => includedPaths.has(source.path)),
        warnings: [...session.snapshot.warnings, ...(excludedPaths.length ? [`Generated files excluded from this review: ${excludedPaths.join(', ')}. Their source was not inspected.`] : [])]
      };
      const classifications = validateClassifications({ edits: complete.flatMap(entry => entry.analysis.classifications) }, snapshot);
      const fileReviews = complete.map(entry => ({ path: entry.snapshot.files[0].path, analysis: entry.analysis }));
      const raw = await analyzeWithCLI({
        ...session.settings, signal: controller.signal,
        prompt: makePrompt(snapshot, classifications, { fileReviews }), schema: analysisSchema
      });
      if (controller.signal.aborted) throw new Error('Analysis cancelled.');
      if (session.checkVersion !== version) return;
      const analysis = { ...validateAnalysis(raw, snapshot), classifications };
      let cache;
      try {
        cache = session.cacheIdentity && await saveReview(session.cacheIdentity, {
          analysis, files: complete.map(entry => ({ path: entry.snapshot.files[0].path, analysis: entry.analysis }))
        });
      } catch { cache = { saved: false, message: 'This review could not be saved locally. It remains available in this tab.' }; }
      if (controller.signal.aborted) throw new Error('Analysis cancelled.');
      if (session.checkVersion !== version) return;
      stopIdleHeartbeat(session);
      session.finalState = 'complete';
      session.settled = true;
      if ([...session.files.values()].some(entry => entry.state === 'excluded')) keepSessionAlive(session, { type: 'heartbeat' });
      send({ type: 'result', analysis, provider: session.settings.provider, model: session.settings.model, cache });
    } catch (error) {
      if (session.checkVersion !== version) return;
      if (controller.signal.aborted && !timedOut) {
        session.finalState = 'cancelled';
        settle(session, 'cancelled', 'The check across files was cancelled. Completed file reviews are kept.');
      } else {
        session.finalState = 'failed';
        const message = timedOut ? 'The check across files timed out after 10 minutes.' : error.message || 'The check across files failed.';
        settle(session, 'check-failed', `${message} Completed file reviews are kept. Retry the final check to continue.`);
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (session.checking === controller) session.checking = null;
      if (session.checkVersion !== version) schedule(session);
    }
  }

  function restoreReview(session, cached) {
    if (!cached || !Array.isArray(cached.files) || !cached.files.length || cached.files.length > session.files.size) return false;
    const restored = new Map();
    for (const file of cached.files) {
      const entry = session.files.get(file.path);
      if (!entry || restored.has(file.path) || entry.state === 'skipped') return false;
      const classifications = validateClassifications({ edits: file.analysis.classifications }, entry.snapshot);
      restored.set(file.path, { ...validateAnalysis(file.analysis, entry.snapshot), classifications });
    }
    if ([...session.files].some(([path, entry]) => entry.included && entry.state !== 'skipped' && !restored.has(path))) return false;
    const included = session.snapshot.files.filter(file => restored.has(file.path) || session.files.get(file.path).included && session.files.get(file.path).state === 'skipped');
    const snapshot = { ...session.snapshot, files: included, context: session.snapshot.context.filter(source => included.some(file => file.path === source.path)) };
    const classifications = validateClassifications({ edits: cached.analysis.classifications }, snapshot);
    const analysis = { ...validateAnalysis(cached.analysis, snapshot), classifications };
    session.initialized = true;
    for (const [path, review] of restored) {
      const entry = session.files.get(path);
      entry.included = true;
      setFileState(entry, 'complete', 'Saved review restored.', review);
    }
    session.finalState = 'complete';
    session.settled = true;
    if ([...session.files.values()].some(entry => entry.state === 'excluded')) keepSessionAlive(session, { type: 'heartbeat' });
    send({ type: 'result', analysis, provider: session.settings.provider, model: session.settings.model, cache: { saved: true, restored: true, savedAt: cached.savedAt } });
    return true;
  }

  function schedule(session) {
    if (!connected || job !== session || session.checking || !session.settings || !session.initialized) return;
    if (!session.cancelled) {
      for (const entry of session.files.values()) {
        if (session.active === 3) break;
        if (entry.state !== 'queued') continue;
        session.active++;
        void analyzeFile(session, entry);
      }
    }
    if (session.active) return;
    if (session.cancelled) {
      settle(session, 'cancelled', 'Analysis cancelled. Completed file reviews are kept.');
      return;
    }
    const incomplete = [...session.files.values()].some(entry => !['complete', 'skipped', 'excluded'].includes(entry.state));
    if (incomplete) {
      settle(session, 'incomplete', 'Some files still need analysis. Completed file reviews are kept; retry the remaining files to continue.');
      return;
    }
    if (![...session.files.values()].some(entry => entry.state === 'complete')) {
      session.finalState = 'excluded';
      settle(session, 'excluded', 'Generated files are excluded by default. Choose Review anyway on a file to analyze it.');
      return;
    }
    if (session.finalState === 'pending') void checkAcrossFiles(session);
  }

  port.onDisconnect.addListener(disconnect);
  port.onMessage.addListener(async message => {
    if (message?.type === 'cancel') {
      cancel();
      return;
    }
    if (message?.type === 'review-file') {
      const entry = typeof message.path === 'string' ? job?.files.get(message.path) : null;
      if (!entry || entry.state !== 'excluded') return;
      stopIdleHeartbeat(job);
      job.cancelled = false;
      job.settled = false;
      job.checkVersion++;
      job.finalState = 'pending';
      entry.included = true;
      setFileState(entry, 'queued', 'Queued for your requested review.');
      job.checking?.abort();
      schedule(job);
      return;
    }
    if (message?.type === 'retry-file') {
      const entry = typeof message.path === 'string' ? job?.files.get(message.path) : null;
      if (!entry || entry.controller || !['failed', 'cancelled'].includes(entry.state)) return;
      stopIdleHeartbeat(job);
      job.cancelled = false;
      job.settled = false;
      job.finalState = 'pending';
      setFileState(entry, 'queued', 'Queued for another attempt.');
      schedule(job);
      return;
    }
    if (message?.type === 'retry-final') {
      if (!job || job.checking || !['failed', 'cancelled'].includes(job.finalState)) return;
      stopIdleHeartbeat(job);
      job.cancelled = false;
      job.settled = false;
      job.finalState = 'pending';
      schedule(job);
      return;
    }
    if (message?.type !== 'analyze') return;
    if (jobs.has(tabId)) {
      send({ type: 'error', message: 'This tab already has an analysis session. Close it before starting another.' });
      return;
    }
    job = { files: new Map(), active: 0, checking: null, checkVersion: 0, finalState: 'pending', cancelled: false, settled: false };
    jobs.set(tabId, job);
    try {
      const serialized = JSON.stringify(message.snapshot);
      if (!serialized || new TextEncoder().encode(serialized).length > 2_000_000) throw new Error('This PR is too large for the prototype. No changes were hidden.');
      const snapshot = validateSnapshot(message.snapshot);
      if (message.force !== undefined && typeof message.force !== 'boolean' || message.cacheOnly !== undefined && typeof message.cacheOnly !== 'boolean') throw new Error('Invalid saved-review request.');
      if (pullRequestUrl(snapshot.url) !== pullRequestUrl(port.sender.url)) throw new Error('The assessment does not match this pull request. Refresh the page.');
      job.snapshot = snapshot;
      for (const file of snapshot.files) {
        const fileSnapshot = { ...snapshot, files: [file], context: snapshot.context.filter(source => source.path === file.path) };
        const hasEdits = file.hunks.some(hunk => hunk.items.some(item => item.type === 'edit'));
        const included = !isGeneratedFile(file);
        job.files.set(file.path, { snapshot: fileSnapshot, included, state: hasEdits ? included ? 'queued' : 'excluded' : 'skipped' });
      }
      for (const entry of job.files.values()) {
        const message = entry.state === 'skipped' ? 'No text edits to analyze. This file remains expanded.'
          : entry.state === 'excluded' ? 'Generated file excluded by default. Choose Review anyway to include it.' : 'Queued for analysis.';
        setFileState(entry, entry.state, message);
      }
      job.settings = await readSettings();
      send({ type: 'session', ...job.settings });
      const session = job;
      try {
        session.cacheIdentity = await reviewCacheKey(snapshot, session.settings);
        if (!message.force) {
          const cached = await readReview(session.cacheIdentity.key);
          if (!connected || job !== session || session.cancelled) return;
          if (cached && !session.checkVersion) {
            try { if (restoreReview(session, cached)) return; } catch {}
            await deleteReview(session.cacheIdentity.key);
          }
        }
      } catch {}
      if (!connected || job !== session || session.cancelled) return;
      if (message.cacheOnly && !session.checkVersion) {
        try {
          const previous = await peekReview(session.cacheIdentity.lookup);
          if (previous.key) await deleteReview(previous.key);
        } catch {}
        send({ type: 'cache-miss' });
        return;
      }
      session.initialized = true;
      schedule(job);
    } catch (error) {
      send({ type: 'error', message: error.message || 'Analysis failed. No changes were hidden.' });
      if (jobs.get(tabId) === job) jobs.delete(tabId);
      job = null;
    }
  });
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
