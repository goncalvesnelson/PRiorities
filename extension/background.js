import { analyzeWithCLI, getCLIModels, getCLIStatus } from './cli-client.js';
import { allEdits, analysisSchema, classificationSchema, defaultFileLimit, isGeneratedFile, makeClassificationPrompt, makePrompt, maxFileLimit, sectionPaths, validateAnalysis, validateClassifications, validateSnapshot } from './review-data.js';
import { cacheInfo, clearCache, peekReview, readReview, reviewCacheKey, reviewLookup, saveReview, saveSectionTicks, setCacheLimit } from './review-cache.js';
import { changeKinds, defaultReviewPreferences, validateReviewPreferences } from './review-preferences.js';

const jobs = new Map();
const connectionChecks = new Map();
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let durationWrite = Promise.resolve();

function isOptions(sender) {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('options.html');
}

// A tick marks one section done in one of the files that section lists.
function validTick(analysis, snapshot, tick) {
  const topic = analysis.topics.find(entry => entry.id === tick?.topicId);
  return Boolean(topic) && sectionPaths(topic, snapshot).has(tick.path);
}

// Section IDs are the model's, so a rerun can reuse one for different code. A tick carries over only
// while its section adds nothing in that file: no new edit there, and no cited lines outside the ones
// it already cited on the same side.
function carriesTick(previous, analysis, snapshot, tick) {
  if (!validTick(analysis, snapshot, tick)) return false;
  const [before, after] = [previous, analysis].map(review => review.topics.find(topic => topic.id === tick.topicId));
  const editPaths = new Map(allEdits(snapshot).map(edit => [edit.id, edit.path]));
  const reviewedEdits = new Set(before.editIds.filter(id => editPaths.get(id) === tick.path));
  const reviewedExcerpts = before.excerpts.filter(excerpt => excerpt.path === tick.path);
  return after.editIds.every(id => editPaths.get(id) !== tick.path || reviewedEdits.has(id))
    && after.excerpts.every(excerpt => excerpt.path !== tick.path || reviewedExcerpts.some(old => old.side === excerpt.side && old.startLine <= excerpt.startLine && excerpt.endLine <= old.endLine));
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
  const { classificationConcurrency, changedFileLimit, listDeletedFiles } = await chrome.storage.local.get(['classificationConcurrency', 'changedFileLimit', 'listDeletedFiles']);
  return {
    provider, model: validModel(stored[key]?.model) ? stored[key].model : '', effort: validEffort(stored[key]?.effort) ? stored[key].effort : '',
    concurrency: validConcurrency(classificationConcurrency) ? classificationConcurrency : 6,
    fileLimit: validFileLimit(changedFileLimit) ? changedFileLimit : defaultFileLimit,
    listDeletedFiles: listDeletedFiles === true
  };
}

function validModel(model) {
  return typeof model === 'string' && (model === '' || /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(model));
}

function validEffort(effort) {
  return typeof effort === 'string' && /^(?:[a-z][a-z0-9_-]{0,29})?$/.test(effort);
}

function validConcurrency(concurrency) {
  return Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 10;
}

function validFileLimit(fileLimit) {
  return Number.isInteger(fileLimit) && fileLimit >= 1 && fileLimit <= maxFileLimit;
}

async function readDurations() {
  await storageReady;
  const { analysisDurations } = await chrome.storage.local.get('analysisDurations');
  return Array.isArray(analysisDurations) ? analysisDurations : [];
}

async function expectedSeconds({ provider, model, effort }, lines) {
  try {
    const rates = (await readDurations()).filter(run => run?.provider === provider && run.model === model && run.effort === effort && run.seconds > 0 && run.lines > 0)
      .map(run => run.seconds / run.lines).sort((a, b) => a - b);
    if (rates.length < 3) return undefined;
    return Math.round(rates[Math.floor(rates.length / 2)] * lines);
  } catch {
    return undefined;
  }
}

function recordDuration({ provider, model, effort }, seconds, lines) {
  if (!(seconds > 0 && lines > 0)) return;
  durationWrite = durationWrite.then(async () => {
    const runs = [...await readDurations(), { provider, model, effort, seconds, lines }].slice(-20);
    await chrome.storage.local.set({ analysisDurations: runs });
  }).catch(() => {});
}

async function readReviewPreferences() {
  await storageReady;
  const stored = await chrome.storage.local.get('reviewPreferences');
  return stored.reviewPreferences === undefined ? defaultReviewPreferences() : validateReviewPreferences({ ...defaultReviewPreferences(), ...stored.reviewPreferences });
}

async function connectionStatus(provider, refreshConnection) {
  if (connectionChecks.has(provider)) return connectionChecks.get(provider);
  const key = `${provider}ConnectionStatus`;
  if (!refreshConnection) {
    let cached;
    try {
      const stored = await chrome.storage.session.get(key);
      cached = stored[key];
    } catch {}
    if (connectionChecks.has(provider)) return connectionChecks.get(provider);
    const age = Date.now() - cached?.checkedAt;
    if (age >= 0 && age < 60_000) {
      return { configured: cached.configured, ...(cached.connectionError ? { connectionError: cached.connectionError } : {}) };
    }
  }
  const check = (async () => {
    let connection;
    try {
      const status = await getCLIStatus(provider);
      connection = status.authenticated
        ? { configured: true }
        : { configured: false, connectionError: status.message || `Sign in with ${provider === 'claude' ? 'claude auth login' : 'codex login'}, then check the connection again.` };
    } catch (error) {
      connection = { configured: false, connectionError: error.message };
    }
    try { await chrome.storage.session.set({ [key]: { ...connection, checkedAt: Date.now() } }); } catch {}
    return connection;
  })();
  connectionChecks.set(provider, check);
  try {
    return await check;
  } finally {
    connectionChecks.delete(provider);
  }
}

async function publicSettings(settings, refreshConnection) {
  return { ...settings, ...await connectionStatus(settings.provider, refreshConnection) };
}

async function handleMessage(message, sender) {
  if (!isOptions(sender) && !isPullRequest(sender)) throw new Error('This page cannot use PRiorities.');
  if (message?.type === 'get-settings') {
    if (message.provider !== undefined && !isOptions(sender)) throw new Error('Only the settings page can select the provider.');
    if (message.provider !== undefined && !['codex', 'claude'].includes(message.provider)) throw new Error('Choose Codex or Claude Code.');
    if (message.refreshConnection !== undefined && typeof message.refreshConnection !== 'boolean') throw new Error('Connection refresh must be true or false.');
    const settings = await readSettings(message.provider);
    return publicSettings(settings, isOptions(sender) || message.refreshConnection === true);
  }
  if (message?.type === 'open-settings') {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  if (message?.type === 'peek-review' && isPullRequest(sender)) {
    if (![message.baseSha, message.headSha].every(sha => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha))) return { available: false };
    const settings = { ...await readSettings(), review: await readReviewPreferences() };
    try {
      return await peekReview(reviewLookup({ url: pullRequestUrl(sender.url), baseSha: message.baseSha, headSha: message.headSha }, settings));
    } catch { throw new Error('Could not check saved reviews in local browser storage. Retry by returning to this tab, or choose Run fresh review.'); }
  }
  if (!isOptions(sender)) throw new Error('Only the settings page can change the provider or model.');
  if (message?.type === 'get-review-preferences') return { preferences: await readReviewPreferences() };
  if (message?.type === 'save-review-preferences') {
    const preferences = validateReviewPreferences(message.preferences);
    await storageReady;
    await chrome.storage.local.set({ reviewPreferences: preferences });
    return { preferences };
  }
  if (message?.type === 'get-models') {
    if (!['codex', 'claude'].includes(message.provider)) throw new Error('Choose Codex or Claude Code.');
    return { provider: message.provider, models: await getCLIModels(message.provider) };
  }
  if (message?.type === 'cache-info') return cacheInfo();
  if (message?.type === 'clear-cache') return clearCache();
  if (message?.type === 'set-cache-limit') return setCacheLimit(message.limitMB);
  if (message?.type === 'save-settings') {
    if (Object.keys(message).some(key => !['type', 'provider', 'model', 'effort', 'concurrency', 'fileLimit', 'listDeletedFiles'].includes(key))) {
      throw new Error('Only provider, model, effort, concurrency and changed-file preferences can be saved. Sign in through the selected CLI.');
    }
    if (!['codex', 'claude'].includes(message.provider)) throw new Error('Choose Codex or Claude Code.');
    if (!validModel(message.model)) {
      throw new Error('Enter a valid model ID, or leave it blank to use the selected CLI’s default.');
    }
    if (!validEffort(message.effort)) throw new Error('Choose a valid reasoning effort.');
    if (!validConcurrency(message.concurrency)) throw new Error('Choose a whole number from 1 to 10 files to classify at once.');
    if (!validFileLimit(message.fileLimit)) throw new Error(`Choose a whole number from 1 to ${maxFileLimit} changed files to analyze.`);
    if (typeof message.listDeletedFiles !== 'boolean') throw new Error('Choose whether to list deleted files without analyzing them.');
    await storageReady;
    const settings = { provider: message.provider, model: message.model, effort: message.effort, concurrency: message.concurrency, fileLimit: message.fileLimit, listDeletedFiles: message.listDeletedFiles };
    await chrome.storage.local.set({
      reviewProvider: settings.provider, [`${settings.provider}Settings`]: { model: settings.model, effort: settings.effort },
      classificationConcurrency: settings.concurrency, changedFileLimit: settings.fileLimit, listDeletedFiles: settings.listDeletedFiles
    });
    return publicSettings(settings, true);
  }
  throw new Error('Unknown PRiorities request.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handleMessage(message, sender).then(respond, error => respond({ error: error.message }));
  return true;
});

function createSession(tabId, url, port) {
  // Ticks belong to the session, so they outlive a result that Review anyway or a retry replaces;
  // `tickedAnalysis` is the result they were made on.
  const job = { files: new Map(), active: 0, checking: null, checkVersion: 0, finalState: 'pending', cancelled: false, settled: false, ticks: [], tickedAnalysis: null, port };
  const send = message => {
    if (job.disposed || !job.port) return;
    try {
      job.port.postMessage(message);
      if (message.type === 'result') job.resultDelivered = true;
    } catch {
      job.detach();
    }
  };

  function fileProgress(path, entry) {
    return { type: 'file-progress', path, state: entry.state, ...(entry.message ? { message: entry.message } : {}), ...(entry.state === 'classifying' && entry.labelled ? { labelled: entry.labelled } : {}), ...(entry.state === 'classifying' && entry.thought ? { thought: entry.thought } : {}) };
  }

  function sessionMessage() {
    return { type: 'session', ...job.settings, startedAt: job.startedAt };
  }

  function restartClock() {
    job.startedAt = Date.now();
    send(sessionMessage());
  }

  function setFileState(entry, state, message) {
    entry.state = state;
    entry.message = message;
    send(fileProgress(entry.snapshot.files[0].path, entry));
  }

  function settle(session, state, message) {
    if (session.disposed || session.settled) return;
    session.settled = true;
    const update = { type: 'settled', state, message };
    session.settlement = update;
    keepSessionAlive(session);
    send(update);
  }

  function stopIdleHeartbeat(session) {
    clearInterval(session.idleHeartbeat);
    session.idleHeartbeat = null;
  }

  function keepSessionAlive(session) {
    stopIdleHeartbeat(session);
    // A browser API call keeps detached sessions alive and detects a closed tab.
    session.idleHeartbeat = setInterval(() => {
      void chrome.tabs.get(tabId).catch(() => job.dispose());
      send({ type: 'heartbeat' });
    }, 20_000);
  }

  function cancel() {
    if (job.disposed || job.finalState === 'complete') return;
    stopIdleHeartbeat(job);
    job.cancelled = true;
    job.settled = false;
    for (const entry of job.files.values()) {
      if (entry.state === 'queued') setFileState(entry, 'cancelled', 'Cancelled before analysis.');
      entry.controller?.abort();
    }
    job.checking?.abort();
    if (!job.active && !job.checking) settle(job, 'cancelled', 'Analysis cancelled. Completed file classifications are kept.');
  }

  job.dispose = () => {
    job.disposed = true;
    stopIdleHeartbeat(job);
    for (const entry of job.files.values()) entry.controller?.abort();
    job.checking?.abort();
    job.port = null;
    if (jobs.get(tabId) === job) jobs.delete(tabId);
  };

  job.detach = () => {
    job.port = null;
    if (job.result?.cache.saved && job.resultDelivered) job.dispose();
    else keepSessionAlive(job);
  };

  job.resume = port => {
    const previous = job.port;
    job.port = port;
    if (previous && previous !== port) previous.disconnect();
    send({ type: 'resumed', snapshot: job.snapshot, restoring: job.restoring === true });
    if (job.settings) send(sessionMessage());
    for (const [path, entry] of job.files) send(fileProgress(path, entry));
    if (job.result) {
      send({ ...job.result, ticks: job.ticks });
      if (job.tickSaveFailed) send({ type: 'tick-save-failed' });
    } else if (job.settled) send(job.settlement);
    else if (job.finalState === 'checking') send(job.progress);
  };

  function finish(session, result) {
    session.result = result;
    session.tickedAnalysis = result.analysis;
    session.tickSaveFailed = false;
    session.resultDelivered = false;
    session.finalState = 'complete';
    session.settled = true;
    // The panel can still mark sections done, so the session stays alive until the panel detaches.
    keepSessionAlive(session);
    send({ ...result, ticks: session.ticks });
  }

  async function classifyFile(session, entry) {
    const controller = new AbortController();
    entry.controller = controller;
    let timedOut = false;
    const started = Date.now();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 600_000);
    const heartbeat = setInterval(() => setFileState(entry, entry.state, `Classifying edits… ${Math.floor((Date.now() - started) / 1000)}s`), 15_000);
    try {
      entry.labelled = 0;
      entry.thought = '';
      setFileState(entry, 'classifying', 'Classifying edits…');
      const changedPaths = [...session.files.values()].filter(file => file.included).map(file => file.snapshot.files[0].path);
      const raw = await analyzeWithCLI({
        ...session.settings, signal: controller.signal, prompt: makeClassificationPrompt(entry.snapshot, changedPaths, session.settings.review, session.snapshot), schema: classificationSchema,
        onProgress: progress => {
          entry.labelled = progress.labelled;
          entry.thought = progress.thought;
          setFileState(entry, entry.state, entry.message);
        }
      });
      if (controller.signal.aborted) throw new Error('Analysis cancelled.');
      entry.classifications = validateClassifications(raw, entry.snapshot);
      setFileState(entry, 'classified', 'Classified. Review decisions follow once every file is classified.');
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

  async function reviewPullRequest(session) {
    stopIdleHeartbeat(session);
    const controller = new AbortController();
    const version = session.checkVersion;
    session.checking = controller;
    session.finalState = 'checking';
    let timedOut = false;
    const started = Date.now();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 600_000);
    const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15_000);
    const report = progress => {
      session.progress = { ...session.progress, ...progress };
      send(session.progress);
    };
    try {
      session.progress = { type: 'progress', stage: 'checking', startedAt: started };
      send(session.progress);
      const classified = [...session.files.values()].filter(entry => entry.state === 'classified');
      const includedPaths = new Set([...session.files].filter(([, entry]) => entry.included).map(([path]) => path));
      const excludedPaths = session.snapshot.files.filter(file => !includedPaths.has(file.path)).map(file => file.path);
      const deletedFiles = session.snapshot.deletedFiles ?? [];
      const snapshot = {
        ...session.snapshot,
        files: session.snapshot.files.filter(file => includedPaths.has(file.path)),
        context: session.snapshot.context.filter(source => includedPaths.has(source.path)),
        warnings: [
          ...session.snapshot.warnings,
          ...(excludedPaths.length ? [`Generated or machine-maintained files excluded from standalone analysis: ${excludedPaths.join(', ')}.`] : []),
          ...(deletedFiles.length ? [`Files deleted outright by this PR, listed by path and deleted-line count; their contents were not supplied or analyzed: ${deletedFiles.map(file => `${file.path} (${file.deletions} ${file.deletions === 1 ? 'line' : 'lines'})`).join(', ')}.`] : [])
        ]
      };
      const classifications = validateClassifications({ edits: classified.flatMap(entry => entry.classifications) }, snapshot);
      const lines = allEdits(snapshot).flatMap(edit => edit.rows).filter(row => ['add', 'delete'].includes(row.type)).length;
      const kinds = changeKinds.map(kind => [kind, classifications.filter(entry => entry.kinds.includes(kind)).length]).filter(([, count]) => count).sort((a, b) => b[1] - a[1]);
      const estimate = await expectedSeconds(session.settings, lines);
      if (controller.signal.aborted) throw new Error('Analysis cancelled.');
      if (session.checkVersion !== version) return;
      report({ edits: classifications.length, kinds, ...(estimate ? { estimate } : {}) });
      const raw = await analyzeWithCLI({
        ...session.settings, signal: controller.signal, onProgress: report,
        prompt: makePrompt(snapshot, classifications, session.settings.review, session.snapshot), schema: analysisSchema
      });
      if (controller.signal.aborted) throw new Error('Analysis cancelled.');
      if (session.checkVersion !== version) return;
      report({ phase: 'checking', startedAt: Date.now() });
      const analysis = validateAnalysis(raw, snapshot, { initialClassifications: classifications, alwaysShow: session.settings.review.alwaysShow });
      void recordDuration(session.settings, (Date.now() - started) / 1000, lines);
      const ticks = session.ticks.filter(tick => carriesTick(session.tickedAnalysis, analysis, session.snapshot, tick));
      let cache = { saved: false, message: 'This review could not be saved locally. It remains available in this tab.' };
      try {
        if (session.cacheIdentity) cache = await saveReview(session.cacheIdentity, {
          analysis, paths: classified.map(entry => entry.snapshot.files[0].path)
        }, controller.signal, ticks);
      } catch {}
      if (controller.signal.aborted) throw new Error('Analysis cancelled.');
      if (session.checkVersion !== version) return;
      session.ticks = ticks;
      finish(session, { type: 'result', analysis, provider: session.settings.provider, model: session.settings.model, cache });
    } catch (error) {
      if (session.checkVersion !== version) return;
      if (controller.signal.aborted && !timedOut) {
        session.finalState = 'cancelled';
        settle(session, 'cancelled', 'Choosing review decisions was cancelled. File classifications are kept.');
      } else {
        session.finalState = 'failed';
        const message = timedOut ? 'Choosing review decisions timed out after 10 minutes.' : error.message || 'Choosing review decisions failed.';
        settle(session, 'check-failed', `${message} File classifications are kept. Retry review decisions to continue.`);
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (session.checking === controller) session.checking = null;
      if (session.checkVersion !== version) schedule(session);
    }
  }

  function restoreReview(session, cached) {
    if (!cached || !Array.isArray(cached.paths) || !cached.paths.length) return false;
    const restored = new Set(cached.paths);
    if (restored.size !== cached.paths.length || [...restored].some(path => !session.files.has(path) || session.files.get(path).state === 'skipped')) return false;
    if ([...session.files].some(([path, entry]) => entry.included && entry.state !== 'skipped' && !restored.has(path))) return false;
    const included = session.snapshot.files.filter(file => restored.has(file.path) || session.files.get(file.path).included && session.files.get(file.path).state === 'skipped');
    const snapshot = { ...session.snapshot, files: included, context: session.snapshot.context.filter(source => included.some(file => file.path === source.path)) };
    const analysis = validateAnalysis(cached.analysis, snapshot, { initialClassifications: cached.analysis.classifications });
    session.initialized = true;
    session.restoring = false;
    for (const path of restored) {
      const entry = session.files.get(path);
      const editIds = new Set(allEdits(entry.snapshot).map(edit => edit.id));
      entry.included = true;
      entry.classifications = analysis.classifications.filter(classification => editIds.has(classification.editId));
      setFileState(entry, 'classified', 'Saved review restored.');
    }
    session.ticks = cached.ticks.filter(tick => validTick(analysis, session.snapshot, tick));
    finish(session, { type: 'result', analysis, provider: session.settings.provider, model: session.settings.model, cache: { saved: true, restored: true, savedAt: cached.savedAt } });
    return true;
  }

  function schedule(session) {
    if (session.disposed || session.checking || session.restoring || !session.settings || !session.initialized) return;
    if (!session.cancelled) {
      // The PR review waits for the slowest file, so files with the most edits to label start first.
      const queued = [...session.files.values()].filter(entry => entry.state === 'queued').sort((a, b) => b.edits - a.edits);
      for (const entry of queued) {
        if (session.active === session.settings.concurrency) break;
        session.active++;
        void classifyFile(session, entry);
      }
    }
    if (session.active) return;
    if (session.cancelled) {
      settle(session, 'cancelled', 'Analysis cancelled. Completed file classifications are kept.');
      return;
    }
    const incomplete = [...session.files.values()].some(entry => !['classified', 'skipped', 'excluded'].includes(entry.state));
    if (incomplete) {
      settle(session, 'incomplete', 'Some files still need analysis. Completed file classifications are kept; retry the remaining files to continue.');
      return;
    }
    if (![...session.files.values()].some(entry => entry.state === 'classified')) {
      session.finalState = 'excluded';
      settle(session, 'excluded', 'Generated and machine-maintained files are excluded by default. Choose Review anyway on a file to analyze it.');
      return;
    }
    if (session.finalState === 'pending') void reviewPullRequest(session);
  }

  job.handleMessage = async message => {
    if (job.disposed) return;
    if (message?.type === 'cancel') {
      cancel();
      return;
    }
    if (message?.type === 'set-section-tick') {
      if (!job.result || typeof message.done !== 'boolean' || !validTick(job.result.analysis, job.snapshot, message)) return;
      const tick = { topicId: message.topicId, path: message.path };
      const others = job.ticks.filter(entry => entry.topicId !== tick.topicId || entry.path !== tick.path);
      job.ticks = message.done ? [...others, tick] : others;
      if (!job.result.cache.saved) return;
      try {
        await saveSectionTicks(job.cacheIdentity.key, job.result.cache.savedAt, tick, message.done);
      } catch {
        // The tick still applies in this session; the saved review keeps its earlier state for it.
        job.tickSaveFailed = true;
        send({ type: 'tick-save-failed' });
      }
      return;
    }
    if (job?.restoring && ['review-file', 'retry-file', 'retry-final'].includes(message?.type)) return;
    if (message?.type === 'review-file') {
      const entry = typeof message.path === 'string' ? job?.files.get(message.path) : null;
      if (!entry || entry.state !== 'excluded') return;
      stopIdleHeartbeat(job);
      job.cancelled = false;
      job.settled = false;
      job.checkVersion++;
      job.finalState = 'pending';
      job.result = null;
      entry.included = true;
      restartClock();
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
      job.checkVersion++;
      job.finalState = 'pending';
      job.result = null;
      restartClock();
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
      job.result = null;
      schedule(job);
      return;
    }
    if (message?.type !== 'analyze') return;
    try {
      const serialized = JSON.stringify(message.snapshot);
      if (!serialized || new TextEncoder().encode(serialized).length > 2_000_000) throw new Error('This PR is too large for the prototype. No changes were hidden.');
      const snapshot = validateSnapshot(message.snapshot);
      if (message.force !== undefined && typeof message.force !== 'boolean' || message.cacheOnly !== undefined && typeof message.cacheOnly !== 'boolean' || message.force && message.cacheOnly) throw new Error('Invalid saved-review request.');
      job.restoring = message.cacheOnly === true;
      job.startedAt = Date.now();
      if (pullRequestUrl(snapshot.url) !== url) throw new Error('The assessment does not match this pull request. Refresh the page.');
      job.snapshot = snapshot;
      for (const file of snapshot.files) {
        const fileSnapshot = { ...snapshot, files: [file], context: snapshot.context.filter(source => source.path === file.path) };
        const edits = allEdits(fileSnapshot).length;
        const included = !isGeneratedFile(file);
        job.files.set(file.path, { snapshot: fileSnapshot, edits, included, state: edits ? included ? 'queued' : 'excluded' : 'skipped' });
      }
      for (const entry of job.files.values()) {
        const message = entry.state === 'skipped' ? 'No text edits to analyze. This file remains expanded.'
          : entry.state === 'excluded' ? 'Generated or machine-maintained file excluded by default. Choose Review anyway to include it.' : 'Queued for analysis.';
        setFileState(entry, entry.state, message);
      }
      job.settings = { ...await readSettings(), review: await readReviewPreferences() };
      if (job.disposed) return;
      if (snapshot.files.length > job.settings.fileLimit) throw new Error(`This PR has ${snapshot.files.length} files to analyze; PRiorities analyzes up to ${job.settings.fileLimit} (change this in Settings). Use Full diff to review it. No analysis was sent.`);
      if (Boolean(snapshot.deletedFiles) !== job.settings.listDeletedFiles) throw new Error('The deleted-files setting changed while this PR was read. Analyze again.');
      send(sessionMessage());
      const session = job;
      let cacheError;
      let cacheFailureMessage = 'Could not calculate the captured PR fingerprint to open or save its review. Reload the extension and try again.';
      try {
        session.cacheIdentity = await reviewCacheKey(snapshot, session.settings);
        if (!message.force) {
          cacheFailureMessage = 'Could not read saved reviews from local browser storage. Reload the extension and retry, or choose Run fresh review.';
          const cached = await readReview(session.cacheIdentity.key);
          if (session.disposed || session.cancelled) return;
          if (cached && !session.checkVersion) {
            cacheFailureMessage = 'The saved review contains invalid or incomplete analysis and cannot be restored. Choose Run fresh review to replace it.';
            if (restoreReview(session, cached)) return;
            throw new Error(cacheFailureMessage);
          }
        }
      } catch {
        cacheError = new Error(cacheFailureMessage);
      } finally {
        session.initialized = true;
      }
      if (session.disposed || session.cancelled) return;
      if (cacheError && !message.force) throw cacheError;
      if (message.cacheOnly) {
        send({ type: 'cache-miss' });
        job.dispose();
        return;
      }
      schedule(job);
    } catch (error) {
      send({ type: 'error', message: error.message || 'Analysis failed. No changes were hidden.' });
      job.dispose();
    }
  };
  return job;
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'review-focus' || !isPullRequest(port.sender)) {
    port.disconnect();
    return;
  }
  const tabId = port.sender.tab.id;
  const url = pullRequestUrl(port.sender.url);
  let connected = true;
  port.onDisconnect.addListener(() => {
    connected = false;
    const session = jobs.get(tabId);
    if (session?.port === port) session.detach();
  });
  port.onMessage.addListener(async message => {
    if (!connected) return;
    let session = jobs.get(tabId);
    if (message?.type === 'resume') {
      if (![message.baseSha, message.headSha].every(sha => sha == null || typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha))) {
        port.postMessage({ type: 'error', message: 'Invalid pull request revision. Refresh the page.' });
        return;
      }
      if (session && (pullRequestUrl(session.snapshot?.url) !== url || ['baseSha', 'headSha'].some(key => message[key] && message[key] !== session.snapshot[key]))) {
        session.dispose();
        session = null;
      }
      if (session) session.resume(port);
      else port.postMessage({ type: 'no-session' });
      return;
    }
    if (message?.type === 'discard') {
      if (session && (session.port === port || !session.port && pullRequestUrl(session.snapshot.url) === url)) session.dispose();
      return;
    }
    if (message?.type === 'analyze') {
      if (session) {
        port.postMessage({ type: 'error', message: 'This tab already has an analysis session. Close it before starting another.' });
        return;
      }
      session = createSession(tabId, url, port);
      jobs.set(tabId, session);
    }
    if (session?.port === port) await session.handleMessage(message);
  });
});

chrome.tabs.onRemoved.addListener(tabId => jobs.get(tabId)?.dispose());
