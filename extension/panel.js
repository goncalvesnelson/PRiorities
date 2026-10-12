// The PRiorities side panel: Chrome shows it beside the GitHub tab it was opened for. Everything
// that reads or changes GitHub's page goes through the page agent in that tab (page-agent.js).
import { isGeneratedFile, sectionLinks } from './review-data.js';

const readyMark = '✓ Ready · ';
const attentionMark = '⚠ Needs attention · ';
const unanalyzedStates = ['skipped', 'excluded', 'deleted'];
const deletedFileState = { state: 'deleted', message: 'Deleted file listed without sending its contents to the AI. Turn off this option in Settings to analyze deleted files.' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, action, className = '') {
  const node = element('button', `rf-button ${className}`, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

// Icons are drawn, not typed, so they sit in the optical centre of their buttons.
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('rf-icon');
  if (name === 'more') {
    for (const x of [3, 8, 13]) {
      const dot = document.createElementNS(svg.namespaceURI, 'circle');
      dot.setAttribute('cx', x); dot.setAttribute('cy', 8); dot.setAttribute('r', 1.4);
      svg.append(dot);
    }
  }
  return svg;
}

function disclosure(label, className = '') {
  const node = element('details', className);
  node.append(element('summary', '', label));
  return node;
}

// `link` may turn a code identifier into a reference to the code it names.
function appendInline(parent, text, link) {
  let index = 0;
  for (const match of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g)) {
    parent.append(text.slice(index, match.index));
    if (match[1] === undefined) parent.append(appendInline(element('strong'), match[2], link));
    else parent.append(link?.(match[1]) ?? element('code', '', match[1]));
    index = match.index + match[0].length;
  }
  parent.append(text.slice(index));
  return parent;
}

function gistLine(tag, gist) {
  const node = appendInline(element(tag, 'rf-gist'), gist);
  node.title = node.textContent;
  return node;
}

function richText(tag, className, text, link) {
  const node = element(tag, `rf-rich ${className}`.trim());
  let block;
  for (const line of text.trim().split('\n')) {
    const item = /^\s*[-*]\s+(.*)/.exec(line);
    if (!line.trim()) block = undefined;
    else if (item) {
      if (block?.tagName !== 'UL') node.append(block = element('ul'));
      block.append(appendInline(element('li'), item[1].trim(), link));
    } else {
      if (block?.tagName === 'P') block.append(element('br'));
      else node.append(block = element('p'));
      appendInline(block, line.trim(), link);
    }
  }
  return node;
}

function clockTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function roughDuration(seconds) {
  return seconds < 60 ? `${Math.max(5, Math.round(seconds / 5) * 5)} s` : `${Math.round(seconds / 60)} min`;
}

function sourceLink(snapshot, excerpt) {
  const url = new URL(snapshot.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const revision = excerpt.side === 'before' ? snapshot.baseSha : snapshot.headSha;
  const path = excerpt.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${parts[0]}/${parts[1]}/blob/${revision}/${path}#L${excerpt.startLine}-L${excerpt.endLine}`;
}

// Long names cut in the middle so their end (a file name, a package) stays readable; the start
// shrinks to an ellipsis only when space runs out. Callers put the full name in a tooltip.
function middleEllipsis(text, tag = 'span') {
  const node = element(tag, 'rf-truncate');
  const slash = text.lastIndexOf('/');
  const split = slash > 0 && text.length - slash <= 48 ? slash : Math.max(0, text.length - Math.min(12, Math.ceil(text.length * .4)));
  node.append(element('span', 'rf-truncate-start', text.slice(0, split)), element('span', 'rf-truncate-end', text.slice(split)));
  return node;
}

function pathButton(path, label, action, className) {
  const node = button('', action, className);
  node.append(middleEllipsis(label));
  node.title = path;
  return node;
}

function lineRange(target) {
  return `L${target.startLine}${target.endLine > target.startLine ? `–${target.endLine}` : ''}`;
}

// `page` is the bridge to the tab's page agent (see connectPage below); `autostart` runs Analyze
// once the panel knows the page, as when it is opened from the toolbar's Analyze this PR.
function startPanel(page, { autostart = false, onAutostart = () => {} } = {}) {
  const listeners = new AbortController();
  const eventOptions = { signal: listeners.signal };
  const panel = element('div', 'rf-panel');
  document.body.append(panel);
  let pageState = page.state;
  let foldCounts = null;
  let settingsLoaded = false;
  let savedReviewChecked = false;
  let snapshot;
  let highlights;
  let analysis;
  let port;
  let controller;
  let operation = 0;
  let settingsRequest = 0;
  let busy = false;
  let identityKey = '';
  let pathKey = '';
  let resumeProbe = '';
  let currentIdentity;
  let configured = false;
  let model = '';
  let effort = '';
  let fileLimit;
  let listDeletedFiles;
  let status = '';
  let error = '';
  let settingsError = '';
  let destroyed = false;
  const fileStates = new Map();
  const observedReviews = new Map();
  let reviewControls = new Map();
  const openTopics = new Set();
  let foldNative = true;
  let finalResult = false;
  let reviewStage = '';
  let attempted = false;
  let providerName = 'selected CLI';
  let reviewProviderName = '';
  let reviewModel = '';
  let reviewEffort = '';
  let reviewPreferences;
  let savedReview;
  const missedSavedReviews = new Set();
  let pendingAction;
  let cacheMessage = '';
  let cacheWarning = false;
  let cacheLookupFailed = false;
  let openingSavedReview = false;
  let cacheProbe = '';
  let cacheProbeVersion = 0;
  let fileFilter = 'all';
  let fileListOpen = false;
  let captureStartedAt;
  let startedAt;
  let checkProgress;
  let progressStage = 0;
  let clock;

  const header = element('div', 'rf-toolbar');
  // Open sections stick just below the toolbar, whose height grows if its buttons wrap.
  new ResizeObserver(() => panel.style.setProperty('--rf-toolbar-height', `${header.offsetHeight}px`)).observe(header);
  const brand = element('strong', 'rf-brand', 'PRiorities');
  const progressToggle = button('', () => { fileListOpen = !fileListOpen; renderFileProgress(); }, 'rf-progress-toggle');
  progressToggle.setAttribute('aria-controls', 'rf-file-progress');
  progressToggle.hidden = true;
  const buttons = element('div', 'rf-actions');
  const analyze = button('Analyze PR', () => analyzePullRequest({ cacheOnly: canOpenSavedReview(), force: (attempted || cacheLookupFailed) && !canOpenSavedReview() }), 'rf-primary rf-analyze');
  const alternateReview = button('Run fresh review', () => analyzePullRequest(savedReview && missedSavedReviews.has(savedReview.candidate) ? { cacheOnly: true } : { force: true }));
  const cancel = button('Cancel', () => cancelAnalysis());
  const settings = button('Settings', () => openSettings());
  const retryFinal = button('Retry review decisions', () => retryReview());
  retryFinal.hidden = true;
  cancel.hidden = true;
  const menu = disclosure('⋯', 'rf-menu');
  const menuToggle = menu.querySelector('summary');
  menuToggle.replaceChildren(icon('more'));
  menuToggle.setAttribute('aria-label', 'More actions');
  menuToggle.title = 'More actions';
  const menuActions = element('div', 'rf-menu-actions');
  menuActions.append(alternateReview, settings);
  menu.append(menuActions);
  menuActions.addEventListener('click', event => { if (event.target.closest('button')) menu.open = false; });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menuToggle.focus();
    event.stopPropagation();
  });
  document.addEventListener('pointerdown', event => {
    if (menu.open && !event.composedPath().includes(menu)) menu.open = false;
  }, eventOptions);
  document.addEventListener('focusin', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  buttons.append(analyze, cancel, retryFinal, menu);
  header.append(brand, buttons);
  const statusNode = element('p', 'rf-status');
  statusNode.setAttribute('role', 'status');
  statusNode.setAttribute('aria-live', 'polite');
  const errorNode = element('p', 'rf-error');
  errorNode.setAttribute('role', 'alert');
  const nativeNotice = element('p', 'rf-navigation-notice');
  nativeNotice.hidden = true;
  const result = element('div', 'rf-result');
  const welcome = element('p', 'rf-welcome', 'Read the explanation here while you review GitHub’s own diff. PRiorities folds less important code there behind green markers; every line stays one click away.');
  const progressPanel = element('div', 'rf-progress-panel');
  const phase = element('strong', 'rf-phase');
  const steps = element('ol', 'rf-steps');
  steps.setAttribute('aria-label', 'Analysis steps');
  const elapsed = element('span', 'rf-elapsed');
  elapsed.setAttribute('role', 'timer');
  const progressDetail = element('span', 'rf-progress-detail');
  const progressLine = element('div', 'rf-progress-line');
  progressLine.append(phase, steps, progressDetail);
  const progressBar = element('progress', 'rf-progress-bar');
  progressBar.setAttribute('aria-label', 'Files classified');
  progressPanel.append(progressLine, progressBar);
  const cacheNotice = element('p', 'rf-cache-notice');
  const runSettings = element('p', 'rf-run-settings rf-caption');
  const fileProgress = element('div', 'rf-file-progress');
  fileProgress.id = 'rf-file-progress';
  fileProgress.hidden = true;
  const secondary = element('div', 'rf-secondary');
  secondary.append(runSettings, progressToggle);
  panel.append(header, progressPanel, secondary, welcome, statusNode, cacheNotice, errorNode, nativeNotice, fileProgress, result);

  function canOpenSavedReview() {
    return Boolean(savedReview && !analysis && !missedSavedReviews.has(savedReview.candidate));
  }

  function renderControls() {
    if (destroyed) return;
    panel.dataset.busy = String(busy);
    const currentError = [settingsError, error].filter(Boolean).join(' ');
    const activeModel = reviewProviderName ? reviewModel : model;
    const activeEffort = reviewProviderName ? reviewEffort : effort;
    const settingsChanged = Boolean(reviewProviderName && model &&
      (reviewProviderName !== providerName || reviewModel !== model || reviewEffort !== effort));
    const rangeSelected = /\/pull\/\d+\/(?:files|changes|commits)\/[^/]+/.test(pageState?.pathname ?? '');
    const offPage = !pageState?.identity ? 'Open a GitHub pull request in this tab to analyze it.' : !pageState.diff ? 'Open this pull request’s Files changed tab to analyze it.' : '';
    const analyzeLabel = rangeSelected ? 'Analyze range' : 'Analyze PR';
    const comparison = snapshot ?? currentIdentity;
    const primaryAction = !analysis || settingsChanged;
    runSettings.textContent = `${reviewProviderName || providerName} · ${activeModel || 'Choose a model in Settings'}${activeModel ? ` · Effort: ${activeEffort || 'model default'}` : ''}${reviewPreferences ? ` · Focus: ${reviewPreferences.focus}` : ''}`;
    if (rangeSelected) runSettings.textContent += comparison?.baseSha && comparison.headSha ? ` · Range: ${comparison.baseSha.slice(0, 8)}…${comparison.headSha.slice(0, 8)}` : ' · Selected commits';
    analyze.disabled = busy || Boolean(offPage);
    analyze.hidden = busy;
    analyze.textContent = canOpenSavedReview() ? 'Open saved review' : settingsChanged ? analyzeLabel : attempted || cacheLookupFailed ? 'Run fresh review' : analyzeLabel;
    analyze.classList.toggle('rf-primary', primaryAction);
    if (!primaryAction && analyze.parentElement !== menuActions) menuActions.prepend(analyze);
    else if (primaryAction && analyze.parentElement !== buttons) buttons.insertBefore(analyze, cancel);
    alternateReview.hidden = busy || !savedReview || Boolean(analysis);
    alternateReview.textContent = savedReview && missedSavedReviews.has(savedReview.candidate) ? 'Retry saved review' : 'Run fresh review';
    cancel.hidden = !busy;
    cancel.disabled = pendingAction?.type === 'cancel';
    retryFinal.hidden = busy || !port || !['check-failed', 'cancelled'].includes(reviewStage) || [...fileStates.values()].some(file => !['classified', 'complete', ...unanalyzedStates].includes(file.state));
    errorNode.hidden = !currentError;
    if (errorNode.textContent !== currentError) errorNode.textContent = currentError;
    welcome.hidden = busy || Boolean(analysis) || fileStates.size > 0;
    progressPanel.hidden = !busy;
    const states = [...fileStates.values()];
    const total = states.filter(file => !unanalyzedStates.includes(file.state)).length;
    const classified = classifiedCount();
    const stage = openingSavedReview || !snapshot ? 0 : reviewStage !== 'checking' ? 1 : checkProgress?.phase === 'checking' ? 3 : 2;
    progressStage = stage;
    phase.textContent = [reviewStage === 'reconnecting' ? 'Reconnecting to analysis' : openingSavedReview ? 'Opening saved review' : 'Copying this pull request', 'Labelling files', 'Writing the review', 'Checking the review'][stage];
    const detail = stage === 1 ? `${classified} of ${total} files classified` : stage === 2 ? 'Every file is classified; comparing the changes' : stage === 3 ? 'Validating the answer against the captured code' : reviewStage === 'reconnecting' ? 'Checking for work already running in this tab' : openingSavedReview ? 'Checking the saved review against the current context' : 'Capturing the complete diff and context';
    const tracked = !openingSavedReview && reviewStage !== 'reconnecting';
    phase.hidden = tracked;
    steps.hidden = !tracked;
    const kinds = checkProgress?.kinds?.map(([kind, count]) => `${count} ${kind}`).join(' · ');
    const estimate = checkProgress?.estimate ? roughDuration(checkProgress.estimate) : '';
    steps.replaceChildren(...[
      ['Copy', ''], [`Label${total ? ` ${classified}/${total}` : ''}`, kinds ? `Labelled blocks: ${kinds}` : ''],
      ['Write review', estimate ? `Usually about ${estimate} with this model, based on recent reviews` : ''], ['Check', '']
    ].map(([label, note], index) => {
      const step = element('li', '', label);
      step.dataset.state = index < stage ? 'done' : index === stage ? 'current' : 'pending';
      if (note) {
        step.title = note;
        step.append(element('span', 'rf-visually-hidden', `, ${note}`));
      }
      if (index < stage) step.append(element('span', 'rf-visually-hidden', ', done'));
      if (index === stage) {
        step.setAttribute('aria-current', 'step');
        step.append(' ', elapsed);
        if (stage === 2 && estimate) step.append(element('span', 'rf-estimate', ` / ~${estimate}`));
      }
      return step;
    }));
    const live = liveProgress(stage);
    progressDetail.textContent = live.text || detail;
    progressDetail.title = live.title || progressDetail.textContent;
    renderClock();
    if (busy && !clock) clock = setInterval(renderClock, 1000);
    if (!busy && clock) { clearInterval(clock); clock = undefined; }
    renderProgressSummary();
    if (stage === 1 && total) { progressBar.max = total; progressBar.value = classified; }
    else progressBar.removeAttribute('value');
    cacheNotice.hidden = Boolean(analysis) && !cacheWarning || !cacheMessage && !savedReview;
    cacheNotice.textContent = cacheMessage || (savedReview ? `Saved ${new Date(savedReview.savedAt).toLocaleString()}. Opening checks the current context without a new model call.` : '');
    let nextStatus = pendingAction?.message ?? status;
    if (busy && snapshot && !currentError && !pendingAction) nextStatus = `${phase.textContent}. ${detail}.`;
    if (!busy && offPage) nextStatus = offPage;
    else if (!busy && !status) nextStatus = !configured
      ? `Connect your local ${providerName} helper in Settings, then analyze this PR.`
      : `Ready to analyze ${rangeSelected ? 'these commits' : 'this PR'} with ${providerName}${model ? ` (${model})` : ''}. Analysis starts only when you click ${analyzeLabel}.`;
    if (settingsChanged && !busy && !pendingAction && !currentError) nextStatus = `Settings changed. ${analyzeLabel} will use ${providerName} (${model}), effort: ${effort || 'model default'}.`;
    if (statusNode.textContent !== nextStatus) statusNode.textContent = nextStatus;
    const ordinaryStatus = (busy && snapshot || finalResult && verifiedPage() || !attempted && configured && !status) && !currentError && !pendingAction && !(settingsChanged && !busy);
    statusNode.classList.toggle('rf-visually-hidden', Boolean(ordinaryStatus) && !offPage);
    result.hidden = !finalResult;
    maybeAutostart();
  }

  function maybeAutostart() {
    if (!autostart || busy || analysis || !settingsLoaded || !savedReviewChecked || !pageState?.diff || analyze.disabled) return;
    autostart = false;
    onAutostart();
    analyze.click();
  }

  function renderClock() {
    const since = [captureStartedAt, startedAt, checkProgress?.startedAt, checkProgress?.startedAt][progressStage];
    elapsed.textContent = Number.isFinite(since) ? clockTime(Math.max(0, Math.floor((Date.now() - since) / 1000))) : '';
  }

  function liveProgress(stage) {
    if (stage === 1) {
      const active = [...fileStates].filter(([, file]) => file.state === 'classifying').map(([path, file]) => {
        const blocks = snapshot.files.find(entry => entry.path === path)?.hunks.flatMap(hunk => hunk.items.filter(item => item.type === 'edit')).length ?? 0;
        return { path, count: file.labelled ? `${Math.min(file.labelled, blocks)}/${blocks}` : '' };
      });
      if (!active.length) return {};
      return {
        text: `Labelling ${active.map(({ path, count }) => `${path.split('/').at(-1)}${count ? ` ${count}` : ''}`).join(' · ')}`,
        title: active.map(({ path, count }) => `${path}${count ? `: ${count} blocks labelled` : ''}`).join('\n')
      };
    }
    if (stage !== 2 || !checkProgress) return {};
    const { sections = [], labelled, edits, phase: activity } = checkProgress;
    const blocks = labelled ? `${Math.min(labelled, edits)}/${edits} blocks` : '';
    const latest = sections.length ? `Section ${sections.length}: ${sections.at(-1)}` : { reasoning: 'Reasoning…', writing: 'Writing the answer…' }[activity] ?? '';
    return {
      text: [blocks, latest].filter(Boolean).join(' · '),
      title: [blocks && `${blocks} labelled in the answer`, ...sections.map((title, index) => `${index + 1}. ${title}`)].filter(Boolean).join('\n')
    };
  }

  function markTitle(mark) {
    void page.call('markTitle', mark).catch(() => {});
  }

  async function loadSettings(refreshConnection = false) {
    if (!isActive()) return;
    const request = ++settingsRequest;
    try {
      const settings = await page.call('sendBackground', { type: 'get-settings', refreshConnection });
      if (request !== settingsRequest || !isActive()) return;
      if (settings?.error) throw new Error(settings.error);
      if (!['codex', 'claude'].includes(settings?.provider)) throw new Error('The extension returned invalid provider settings.');
      providerName = settings.provider === 'claude' ? 'Claude Code' : 'Codex';
      configured = Boolean(settings?.configured);
      model = settings?.model ?? '';
      effort = settings?.effort ?? '';
      ({ fileLimit, listDeletedFiles } = settings);
      settingsError = '';
      settingsLoaded = true;
      void refreshSavedReview(true);
      renderControls();
    } catch (failure) {
      if (request !== settingsRequest || !isActive()) return;
      configured = false;
      model = '';
      settingsLoaded = true;
      settingsError = `The extension could not read its settings. Reload the GitHub tab after reloading the extension. ${failure.message}`;
      renderControls();
    }
  }

  function refreshConnection() {
    if (destroyed || busy && !snapshot || !identityKey) return;
    void loadSettings();
  }

  async function refreshSavedReview(force = false) {
    if (!isActive() || busy || analysis || !pageState?.diff) return;
    const identity = pageState.identity;
    if (!identity?.headSha || !identity.baseSha) {
      savedReviewChecked = true;
      return;
    }
    const key = JSON.stringify([identity.owner, identity.repo, identity.number, identity.baseSha, identity.headSha, providerName, model, effort]);
    if (!force && key === cacheProbe) return;
    cacheProbe = key;
    const version = ++cacheProbeVersion;
    try {
      const cached = await page.call('sendBackground', { type: 'peek-review', baseSha: identity.baseSha, headSha: identity.headSha });
      if (version !== cacheProbeVersion || !isActive() || busy || analysis) return;
      savedReviewChecked = true;
      if (cached?.error) throw new Error(cached.error);
      if (cacheLookupFailed) { cacheMessage = ''; cacheWarning = false; }
      cacheLookupFailed = false;
      savedReview = cached?.available ? { ...cached, candidate: JSON.stringify([key, cached.key, cached.savedAt]) } : undefined;
      renderControls();
    } catch (failure) {
      if (version !== cacheProbeVersion || !isActive() || busy || analysis) return;
      savedReviewChecked = true;
      cacheLookupFailed = true;
      cacheWarning = true;
      cacheMessage = failure.message;
      renderControls();
    }
  }

  async function openSettings() {
    if (!isActive()) return;
    try {
      const settings = await page.call('sendBackground', { type: 'open-settings' });
      if (settings?.error) throw new Error(settings.error);
    } catch (failure) {
      if (!isActive()) return;
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
        return;
      }
      error = `Settings could not open. Open PRiorities from Chrome’s extensions menu. ${failure.message}`;
      renderControls();
    }
  }

  function cancelAnalysis(message = 'Analysis cancelled. Completed file classifications are kept.', close = false) {
    if (!isActive()) return;
    if (port && !close) {
      pendingAction = { type: 'cancel', message: 'Stopping active analyses…' };
      renderControls();
      port.postMessage({ type: 'cancel' });
      return;
    }
    operation++;
    controller?.abort();
    controller = undefined;
    if (port) {
      try { port.postMessage({ type: 'discard' }); } catch {}
      port.disconnect();
      port = undefined;
    }
    busy = false;
    pendingAction = undefined;
    status = message;
    renderControls();
  }

  function clearReview() {
    foldCounts = null;
    void page.call('setSnapshot', null).catch(() => {});
    openTopics.clear();
    nativeNotice.hidden = true;
    nativeNotice.replaceChildren();
    snapshot = undefined;
    highlights = undefined;
    analysis = undefined;
    finalResult = false;
    reviewStage = '';
    reviewProviderName = '';
    reviewModel = '';
    reviewEffort = '';
    reviewPreferences = undefined;
    pendingAction = undefined;
    savedReview = undefined;
    cacheMessage = '';
    cacheWarning = false;
    cacheLookupFailed = false;
    openingSavedReview = false;
    startedAt = undefined;
    checkProgress = undefined;
    cacheProbe = '';
    cacheProbeVersion++;
    fileFilter = 'all';
    fileStates.clear();
    fileProgress.hidden = true;
    fileListOpen = false;
    progressToggle.hidden = true;
    result.replaceChildren();
  }

  function retryReview(path) {
    if (!isActive() || !port || openingSavedReview || !verifiedPage()) return;
    busy = true;
    finalResult = false;
    restoreFolding();
    error = '';
    reviewStage = path ? 'files' : 'checking';
    checkProgress = undefined;
    pendingAction = { type: path ? 'file' : 'check', path, message: path ? `Retrying ${path}…` : 'Retrying review decisions…' };
    port.postMessage(path ? { type: 'retry-file', path } : { type: 'retry-final' });
    renderControls();
  }

  function reviewGeneratedFile(path) {
    if (!isActive() || !port || openingSavedReview || !verifiedPage() || fileStates.get(path)?.state !== 'excluded') return;
    fileStates.set(path, { state: 'queued', message: 'Queued by your request.' });
    cacheMessage = '';
    fileFilter = 'all';
    busy = true;
    finalResult = false;
    restoreFolding();
    error = '';
    reviewStage = 'files';
    checkProgress = undefined;
    pendingAction = { type: 'file', path, message: `Analyzing ${path}…` };
    port.postMessage({ type: 'review-file', path });
    renderFileProgress();
    renderControls();
  }

  function generatedCount() {
    return [...fileStates.values()].filter(file => file.state === 'excluded').length;
  }

  function deletedCaption(count) {
    return `${count} deleted ${count === 1 ? 'file' : 'files'} listed, not analyzed`;
  }

  function fileLabel(file) {
    return { queued: 'AI waiting', classifying: 'AI classifying', classified: 'AI classified · review decisions pending', complete: 'AI ready', failed: 'AI needs retry', cancelled: 'AI cancelled', skipped: 'AI skipped · no text changes', excluded: 'AI skipped · machine-maintained', deleted: 'AI skipped · deleted' }[file.state];
  }

  function fileTopics(path) {
    if (!analysis) return [];
    const file = snapshot.files.find(entry => entry.path === path);
    const ids = new Set(file.hunks.flatMap(hunk => hunk.items.filter(item => item.type === 'edit').map(item => item.id)));
    return analysis.topics.filter(topic => topic.editIds.some(id => ids.has(id)));
  }

  function classifiedCount() {
    return [...fileStates.values()].filter(file => ['classified', 'complete'].includes(file.state)).length;
  }

  function fileCounts() {
    const states = [...fileStates.values()];
    const total = states.filter(file => !unanalyzedStates.includes(file.state)).length;
    const active = states.filter(file => file.state === 'classifying').length;
    const waiting = states.filter(file => file.state === 'queued').length;
    const failed = states.filter(file => file.state === 'failed').length;
    const excluded = generatedCount();
    const deleted = states.filter(file => file.state === 'deleted').length;
    return `${classifiedCount()} of ${total} files ${finalResult ? 'AI ready' : 'classified'}${active ? ` · ${active} classifying` : ''}${waiting ? ` · ${waiting} waiting` : ''}${failed ? ` · ${failed} failed` : ''}${excluded ? ` · ${excluded} machine-maintained ${excluded === 1 ? 'file' : 'files'} skipped by AI` : ''}${deleted ? ` · ${deletedCaption(deleted)}` : ''}`;
  }

  function renderProgressSummary() {
    const states = [...fileStates.values()];
    const reviewed = [...fileStates.keys()].filter(path => observedReviews.get(path) === true).length;
    const unknown = [...fileStates.keys()].filter(path => !observedReviews.has(path)).length;
    const total = states.filter(file => !unanalyzedStates.includes(file.state)).length;
    const phaseLabel = openingSavedReview ? 'Opening saved review' : reviewStage === 'checking' ? 'Review decisions' : reviewStage === 'check-failed' ? 'Review decisions failed' : reviewStage === 'cancelled' || !busy && states.some(file => file.state === 'cancelled') ? 'Cancelled' : states.some(file => file.state === 'failed') ? 'Needs retry' : busy ? 'Analyzing' : '';
    progressToggle.hidden = !states.length;
    const analyzed = total ? `${finalResult ? 'AI ready' : 'Classified'} ${classifiedCount()}/${total}` : `All ${states.length} files skipped`;
    const stepsShown = busy && !openingSavedReview;
    progressToggle.textContent = `${stepsShown ? 'Files' : `${analyzed}${phaseLabel ? ` · ${phaseLabel}` : ''}`} · Viewed ${reviewed}/${states.length}${unknown ? ` (${unknown} unknown)` : ''}`;
    progressToggle.title = `${fileCounts()}. ${reviewed} of ${states.length} files viewed in GitHub. ${fileListOpen ? 'Hide' : 'Show'} file progress.`;
    progressToggle.setAttribute('aria-expanded', String(fileListOpen));
  }

  // GitHub disables its Viewed button while it saves, and redraws it as files scroll in. A button
  // that was usable moments ago keeps its last state, so the panel doesn't flash "unavailable".
  const settleMs = 1500;
  const lastUsable = new Map();
  let settleTimer;
  function readReviewControls() {
    const now = Date.now();
    const controls = new Map(pageState?.reviews ?? []);
    let settling = false;
    for (const [path, state] of controls) {
      observedReviews.set(path, state.reviewed);
      if (!state.disabled) lastUsable.set(path, now);
      else if (now - (lastUsable.get(path) ?? -Infinity) < settleMs) {
        controls.set(path, { ...state, disabled: false });
        settling = true;
      }
    }
    for (const [path, at] of lastUsable) {
      if (controls.has(path) || now - at >= settleMs || !reviewControls.has(path)) continue;
      controls.set(path, reviewControls.get(path));
      settling = true;
    }
    clearTimeout(settleTimer);
    if (settling) settleTimer = setTimeout(() => { if (readReviewControls()) renderFileProgress(); }, settleMs);
    const changed = controls.size !== reviewControls.size || [...controls].some(([path, state]) => {
      const previous = reviewControls.get(path);
      return !previous || state.reviewed !== previous.reviewed || state.disabled !== previous.disabled;
    });
    reviewControls = controls;
    return changed;
  }

  function updateReviewToggle(label, path) {
    const control = reviewControls.get(path);
    const reviewed = observedReviews.get(path);
    const input = label.querySelector('input');
    input.checked = reviewed === true;
    input.indeterminate = reviewed === undefined;
    input.disabled = !control;
    input.setAttribute('aria-disabled', String(!control || control.disabled));
    label.dataset.reviewed = reviewed === undefined ? 'unknown' : String(reviewed);
    const hint = label.querySelector('.rf-review-unavailable');
    // Unavailability is shown by dimming, and explained in the tooltip, so GitHub's brief
    // save and redraw states never push a sentence in and out of the layout.
    const unavailable = !control || control.disabled;
    label.dataset.unavailable = String(unavailable);
    hint.textContent = !unavailable ? '' : control ? 'Unavailable in this view' : reviewed === undefined ? 'Status unavailable' : 'Load file to update';
    label.title = !unavailable ? 'Uses GitHub’s Viewed checkbox. AI analysis never changes your checkmark.'
      : control ? 'GitHub’s Viewed checkbox is unavailable in this view.' : 'Load this file in GitHub’s diff to read or change its Viewed status.';
  }

  function reviewToggle(path) {
    const label = element('label', 'rf-reviewed-toggle');
    const input = element('input');
    input.type = 'checkbox';
    input.setAttribute('aria-label', `Reviewed by you: ${path}`);
    input.addEventListener('click', event => {
      if (!isActive() || !verifiedPage()) {
        event.preventDefault();
        checkPage();
        return;
      }
      const control = reviewControls.get(path);
      if (!control || control.disabled) event.preventDefault();
    });
    input.addEventListener('change', () => {
      if (!isActive() || !verifiedPage()) {
        checkPage();
        return;
      }
      // GitHub's checkbox stays the source of truth; the page agent reports its new state back.
      void page.call('setReviewed', path, input.checked).catch(() => {}).finally(() => renderFileProgress());
    });
    label.dataset.path = path;
    label.append(input, element('span', '', 'Reviewed'), element('span', 'rf-review-unavailable'));
    updateReviewToggle(label, path);
    return label;
  }

  function renderFileProgress() {
    const focused = document.activeElement;
    const focusedPath = focused?.closest('.rf-file-progress-row')?.dataset.path;
    const focusedFilter = focused?.closest('.rf-file-filters') ? focused.textContent : null;
    const previousScroll = fileProgress.querySelector('.rf-file-list')?.scrollTop ?? 0;
    fileProgress.hidden = !fileStates.size || !fileListOpen;
    renderProgressSummary();
    fileProgress.replaceChildren();
    fileProgress.append(element('p', 'rf-analysis-count rf-caption', fileCounts()));
    fileProgress.append(element('p', 'rf-review-help rf-caption', 'Your checkmarks track your review in GitHub. AI ready means analysis finished.'));
    const filters = element('div', 'rf-file-filters');
    for (const [value, label] of [['all', 'All files'], ['unreviewed', 'To review'], ['reviewed', 'Reviewed'], ['failed', 'AI needs retry']]) {
      const filter = button(label, () => { fileFilter = value; renderFileProgress(); });
      filter.setAttribute('aria-pressed', String(fileFilter === value));
      filters.append(filter);
    }
    fileProgress.append(filters);
    const rows = element('div', 'rf-file-list');
    for (const [path, file] of fileStates) {
      if (fileFilter === 'reviewed' && observedReviews.get(path) !== true) continue;
      if (fileFilter === 'unreviewed' && observedReviews.get(path) === true) continue;
      if (fileFilter === 'failed' && !['failed', 'cancelled'].includes(file.state)) continue;
      const row = element('div', 'rf-file-progress-row');
      row.dataset.state = file.state;
      row.dataset.path = path;
      const label = element('span', 'rf-file-state', fileLabel(file));
      label.dataset.state = file.state;
      row.append(pathButton(path, path, () => void revealFile(path), 'rf-file-path'), label, reviewToggle(path));
      if (finalResult && file.state !== 'deleted') {
        const owners = fileTopics(path);
        const references = analysis.topics.filter(topic => !owners.includes(topic) && topic.excerpts.some(excerpt => excerpt.path === path));
        const links = element('div', 'rf-file-sections');
        for (const topic of [...owners, ...references]) links.append(button(`${topic.title}${references.includes(topic) ? ' (cited evidence)' : ''}`, () => openTopic(topic.id), 'rf-link-button'));
        row.append(links);
      }
      if (['failed', 'cancelled'].includes(file.state) && port && !openingSavedReview) row.append(button('Retry file', () => retryReview(path)));
      if (file.state === 'excluded' && port && !openingSavedReview) row.append(button('Review anyway', () => reviewGeneratedFile(path)));
      if (['failed', 'cancelled'].includes(file.state) && file.message) row.append(element('span', 'rf-caption', file.message));
      rows.append(row);
    }
    if (!rows.childElementCount) rows.append(element('p', 'rf-caption', 'No files in this view.'));
    fileProgress.append(rows);
    rows.scrollTop = previousScroll;
    if (focusedFilter) [...filters.children].find(filter => filter.textContent === focusedFilter)?.focus({ preventScroll: true });
    if (focusedPath) {
      const row = [...rows.children].find(row => row.dataset.path === focusedPath);
      const replacement = focused.tagName === 'INPUT' ? row?.querySelector('input') : [...row?.querySelectorAll('button') ?? []].find(button => button.textContent === focused.textContent);
      (replacement ?? filters.querySelector('[aria-pressed="true"]')).focus({ preventScroll: true });
    }
    for (const node of result.querySelectorAll('.rf-reviewed-toggle')) updateReviewToggle(node, node.dataset.path);
  }

  function editLocations() {
    const classifications = new Map(analysis.classifications.map(entry => [entry.editId, entry]));
    return new Map(snapshot.files.flatMap(file => file.hunks.flatMap(hunk => hunk.items.filter(item => item.type === 'edit').map(edit => [edit.id, { file, edit, classification: classifications.get(edit.id) }]))));
  }

  // Lines this section adds and removes in a file, coloured like a diff.
  function changeDelta(path, topic, locations) {
    const rows = [...locations.values()].filter(entry => entry.file.path === path && (!topic || topic.editIds.includes(entry.edit.id))).flatMap(entry => entry.edit.rows);
    const delta = element('span', 'rf-file-delta');
    if (!rows.length) {
      delta.textContent = 'cited evidence';
      return delta;
    }
    const count = type => rows.filter(row => row.type === type).length;
    delta.append(element('span', 'rf-delta-add', `+${count('add')}`), ' ', element('span', 'rf-delta-delete', `−${count('delete')}`));
    return delta;
  }

  function sectionFileRow(path, topic, locations) {
    const jump = pathButton(path, path.split('/').at(-1), () => void revealFile(path, topic), 'rf-link-button');
    jump.title = `${path} · show its changes in the diff`;
    jump.setAttribute('aria-label', path);
    const row = element('div', 'rf-section-file');
    row.append(jump, changeDelta(path, topic, locations), reviewToggle(path));
    return row;
  }

  function finishFailure(message, request) {
    if (operation !== request || !isActive()) return;
    busy = false;
    pendingAction = undefined;
    error = message;
    status = 'Analysis did not finish. Check Settings or try again.';
    markTitle(attentionMark);
    controller?.abort();
    controller = undefined;
    if (port) { port.disconnect(); port = undefined; }
    for (const [path, file] of fileStates) {
      if (['queued', 'classifying'].includes(file.state)) fileStates.set(path, { state: 'failed', message: 'The analysis connection closed. Analyze again to restart.' });
    }
    renderFileProgress();
    renderControls();
  }

  async function analyzePullRequest({ force = false, cacheOnly = false } = {}) {
    if (!isActive() || busy) return;
    const restoringReview = cacheOnly ? savedReview : undefined;
    cancelAnalysis('', true);
    clearReview();
    openingSavedReview = cacheOnly;
    const request = ++operation;
    busy = true;
    status = 'Checking analysis settings…';
    renderControls();
    await loadSettings(!cacheOnly);
    if (request !== operation) return;
    if ((!configured || !model) && !cacheOnly) {
      busy = false;
      error = configured ? 'Choose a model and effort in Settings before analyzing.' : `Connect ${providerName} in Settings first.`;
      renderControls();
      await openSettings();
      return;
    }
    attempted = true;
    reviewProviderName = providerName;
    reviewModel = model;
    reviewEffort = effort;
    reviewStage = cacheOnly ? 'restoring' : 'capture';
    busy = true;
    error = '';
    status = 'Reading this pull request and its pinned source…';
    captureStartedAt = Date.now();
    renderControls();
    controller = new AbortController();
    controller.signal.addEventListener('abort', () => void page.call('abortCapture').catch(() => {}));
    try {
      page.onCaptureProgress = message => {
        if (request !== operation) return;
        status = message;
        renderControls();
      };
      const captured = await page.call('capture', { fileLimit, listDeletedFiles });
      if (request !== operation || !isActive()) return;
      ({ snapshot, highlights } = captured);
      void page.call('setSnapshot', snapshot).catch(() => {});
      reviewStage = 'files';
      for (const file of snapshot.files) {
        const hasEdits = file.hunks.some(hunk => hunk.items.some(item => item.type === 'edit'));
        fileStates.set(file.path, { state: !hasEdits ? 'skipped' : isGeneratedFile(file) ? 'excluded' : 'queued' });
      }
      for (const file of snapshot.deletedFiles ?? []) fileStates.set(file.path, deletedFileState);
      const connection = connectReview(request, { restoringReview, cacheOnly });
      connection.postMessage({ type: 'discard' });
      connection.postMessage({ type: 'analyze', snapshot, highlights, force, cacheOnly });
    } catch (failure) {
      if (request !== operation) return;
      finishFailure(failure.message, request);
    }
  }

  function connectReview(request, { restoringReview, cacheOnly = false } = {}) {
    const connection = page.connectBackground();
    port = connection;
    renderFileProgress();
    connection.onMessage.addListener(message => {
      if (request !== operation || !isActive()) return;
      if (message.type === 'heartbeat') return;
      if (message.type === 'no-session') {
        port = undefined;
        connection.disconnect();
        busy = false;
        reviewStage = '';
        renderControls();
        void refreshSavedReview();
        return;
      }
      if (message.type === 'resumed') {
        ({ snapshot, highlights } = message);
        void page.call('setSnapshot', snapshot).catch(() => {});
        attempted = true;
        busy = true;
        cacheOnly = message.restoring;
        openingSavedReview = message.restoring;
        reviewStage = 'files';
        fileStates.clear();
        for (const file of snapshot.files) fileStates.set(file.path, { state: 'queued' });
        for (const file of snapshot.deletedFiles ?? []) fileStates.set(file.path, deletedFileState);
        status = 'Reconnected to the analysis already running in this tab.';
        renderControls();
        return;
      }
      if (message.type === 'session') {
        reviewProviderName = message.provider === 'claude' ? 'Claude Code' : 'Codex';
        reviewModel = message.model;
        reviewEffort = message.effort;
        reviewPreferences = message.review;
        startedAt = message.startedAt;
        renderControls();
        return;
      }
      if (message.type === 'cache-miss') {
        if (restoringReview) missedSavedReviews.add(restoringReview.candidate);
        cancelAnalysis('The saved review does not match the current commits, captured context or analysis settings. It is still saved. Run a fresh review, or choose Retry saved review in More actions (⋯) if a temporary fetch failed.', true);
        clearReview();
        savedReview = restoringReview;
        renderControls();
        return;
      }
      const identity = pageState?.identity;
      if (message.type !== 'error' && (!identity || !snapshot || `${identity.owner}/${identity.repo}/${identity.number}` !== identityKey || pageState.diff && (identity.headSha && identity.headSha !== snapshot.headSha || identity.baseSha && identity.baseSha !== snapshot.baseSha))) {
        checkPage();
        return;
      }
      if (message.type === 'file-progress') {
        if (!fileStates.has(message.path)) return;
        if (pendingAction?.type === 'file' && pendingAction.path === message.path) pendingAction = undefined;
        fileStates.set(message.path, message);
        if (!openingSavedReview && ['queued', 'classifying'].includes(message.state)) {
          busy = true;
          finalResult = false;
          restoreFolding();
          reviewStage = 'files';
        }
        status = message.state === 'failed' ? 'A file needs another attempt. Completed classifications are kept.' : 'Review decisions follow once every file is classified.';
        renderFileProgress();
        renderControls();
      } else if (message.type === 'progress') {
        if (pendingAction?.type === 'check' && message.stage === 'checking') pendingAction = undefined;
        reviewStage = message.stage;
        checkProgress = message;
        renderControls();
      } else if (message.type === 'settled') {
        busy = false;
        pendingAction = undefined;
        reviewStage = message.state;
        status = `${fileCounts()}. ${message.message}`;
        error = message.state === 'check-failed' ? message.message : '';
        if (message.state !== 'cancelled') markTitle(attentionMark);
        renderFileProgress();
        renderControls();
      } else if (message.type === 'error') {
        if (cacheOnly) {
          if (restoringReview) missedSavedReviews.add(restoringReview.candidate);
          cancelAnalysis('The saved review could not be opened.', true);
          clearReview();
          savedReview = restoringReview;
          error = message.message;
          renderControls();
          return;
        }
        finishFailure(message.message, request);
      } else if (message.type === 'result') {
        busy = false;
        openingSavedReview = false;
        pendingAction = undefined;
        if (restoringReview) missedSavedReviews.delete(restoringReview.candidate);
        controller = undefined;
        analysis = message.analysis;
        finalResult = true;
        reviewStage = 'complete';
        cacheMessage = message.cache?.restored ? `Opened saved review from ${new Date(message.cache.savedAt).toLocaleString()}. Commits, context, provider, model, effort and review preferences match. No new model calls were made.`
          : message.cache?.saved ? 'Review saved on this browser. Reopen this PR to reuse it, or run a fresh review anytime.' : message.cache?.message || '';
        cacheWarning = !message.cache?.restored && !message.cache?.saved && Boolean(message.cache?.message);
        for (const [path, file] of fileStates) {
          if (!unanalyzedStates.includes(file.state)) fileStates.set(path, { ...file, state: 'complete', message: '' });
        }
        error = '';
        status = '';
        if (!analysis.topics.some(topic => openTopics.has(topic.id)) && analysis.topics[0]) openTopics.add(analysis.topics[0].id);
        restoreFolding();
        renderAnalysis();
        applyFolding();
        renderFileProgress();
        renderControls();
        markTitle(readyMark);
      }
    });
    connection.onDisconnect.addListener(() => {
      if (request !== operation || !isActive() || port !== connection) return;
      port = undefined;
      if (busy) {
        finishFailure('The analysis connection closed. Close and reopen PRiorities to reconnect; completed classifications are kept.', request);
        return;
      }
      if (!finalResult) status = 'The analysis session closed. Analyze again to restart.';
      renderFileProgress();
      renderControls();
    });
    return connection;
  }

  function resumeAnalysis(identity) {
    const key = JSON.stringify([identityKey, identity.baseSha, identity.headSha]);
    if (busy || port || snapshot || resumeProbe === key) return;
    resumeProbe = key;
    const request = ++operation;
    busy = true;
    reviewStage = 'reconnecting';
    renderControls();
    try {
      connectReview(request).postMessage({ type: 'resume', baseSha: identity.baseSha, headSha: identity.headSha });
    } catch (failure) {
      finishFailure(failure.message, request);
    }
  }

  function detachAnalysis() {
    operation++;
    controller?.abort();
    controller = undefined;
    if (port) {
      const connection = port;
      port = undefined;
      connection.disconnect();
    }
    busy = false;
    status = '';
    resumeProbe = '';
    clearReview();
  }

  function verifiedPage() {
    const identity = pageState?.identity;
    if (!snapshot || !identity || !pageState.diff) return false;
    const path = new URL(snapshot.url).pathname.split('/').filter(Boolean);
    return identity.owner === path[0] && identity.repo === path[1] && String(identity.number) === path[3]
      && identity.headSha === snapshot.headSha && (!identity.baseSha || identity.baseSha === snapshot.baseSha);
  }

  function renderFoldSummary(counts = foldCounts) {
    const node = result.querySelector('.rf-fold-summary');
    if (!node) return;
    node.textContent = !foldNative ? 'Folding is off: GitHub shows every line it normally shows.'
      : counts?.unreadable && !counts.matched ? 'Switch GitHub’s diff to Unified to fold code; split view is left unchanged.'
      : counts?.groups ? `${counts.folded} of ${counts.groups} green ${counts.groups === 1 ? 'fold' : 'folds'} closed in the loaded files (${counts.hidden.toLocaleString()} ${counts.hidden === 1 ? 'line' : 'lines'} hidden).`
      : 'Nothing is folded in the files GitHub has loaded.';
  }

  // The page agent folds GitHub's diff and refolds it as GitHub loads more files; it reports counts back.
  function applyFolding() {
    if (!finalResult || !analysis || !foldNative) {
      restoreFolding();
      return;
    }
    void page.call('setFolding', { analysis, preferences: { protectedPaths: reviewPreferences?.protectedPaths ?? [], alwaysShow: reviewPreferences?.alwaysShow ?? [] } }).catch(() => {});
  }

  function restoreFolding() {
    foldCounts = null;
    void page.call('setFolding', null).catch(() => {});
    renderFoldSummary();
  }

  function showNotice(message, target) {
    nativeNotice.replaceChildren();
    nativeNotice.hidden = !message;
    if (!message) return;
    nativeNotice.append(document.createTextNode(`${message} `));
    if (target) nativeNotice.append(sourceAnchor(target, 'Open source at this commit'));
  }

  // Scrolls GitHub's diff to the cited lines, unfolding them first if PRiorities folded them.
  async function revealCode(target) {
    if (!isActive() || !verifiedPage()) {
      checkPage();
      return;
    }
    const captured = snapshot;
    showNotice('');
    const outcome = await page.call('reveal', target).catch(() => 'stale');
    if (snapshot !== captured) return;
    if (outcome === 'not-loaded') showNotice(`GitHub has not loaded ${target.path}. Use its file list to load the diff, or open the captured commit source.`, target);
    else if (outcome === 'outside') showNotice(`${target.path} ${lineRange(target)} is outside the lines GitHub shows in this diff. Expand the file in GitHub, or open the source.`, target);
  }

  function revealFile(path, topic) {
    if (!snapshot) return;
    const file = snapshot.files.find(entry => entry.path === path);
    const edit = file?.hunks.flatMap(hunk => hunk.items.filter(item => item.type === 'edit')).find(item => !topic || topic.editIds.includes(item.id));
    const row = edit?.rows.find(entry => entry.type !== 'marker');
    if (row) return revealCode({ path, side: row.type === 'delete' ? 'before' : 'after', startLine: row.oldLine ?? row.newLine, endLine: row.oldLine ?? row.newLine });
    return revealCode({ path, side: 'after', startLine: 1, endLine: 0 });
  }

  function sourceAnchor(target, label) {
    const link = element('a', 'rf-source-link', label);
    link.href = sourceLink(snapshot, { ...target, endLine: Math.max(target.startLine, target.endLine) });
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function reference(content, target, tooltip) {
    const node = element('button', 'rf-ref');
    node.type = 'button';
    node.append(content);
    node.title = `${tooltip ? `${tooltip}\n` : ''}${target.path} ${lineRange(target)} · click to show it in the diff`;
    node.addEventListener('click', () => void revealCode(target));
    return node;
  }

  // Lines a section cites or changes, for linking the identifiers its prose mentions.
  function codeTargets(topic, locations) {
    const targets = [];
    for (const excerpt of topic.excerpts) {
      for (const row of excerpt.rows ?? []) {
        const line = excerpt.side === 'before' ? row.oldLine : row.newLine;
        if (line !== null) targets.push({ path: excerpt.path, side: excerpt.side, startLine: line, endLine: line, text: row.text, note: excerpt.note });
      }
    }
    for (const id of topic.editIds) {
      const entry = locations.get(id);
      for (const row of entry.edit.rows) {
        if (row.type === 'marker') continue;
        const side = row.type === 'delete' ? 'before' : 'after';
        const line = side === 'before' ? row.oldLine : row.newLine;
        targets.push({ path: entry.file.path, side, startLine: line, endLine: line, text: row.text, note: entry.classification?.reason ?? '' });
      }
    }
    return targets;
  }

  function identifierLinker(topic, locations) {
    const targets = codeTargets(topic, locations);
    return identifier => {
      if (identifier.trim().length < 2) return null;
      const target = targets.find(entry => entry.text.includes(identifier));
      if (!target) return null;
      const note = target.note.length > 280 ? `${target.note.slice(0, 279)}…` : target.note;
      const node = reference(middleEllipsis(identifier, 'code'), target, note);
      node.title = `${identifier}\n${node.title}`;
      return node;
    };
  }

  function openTopic(id) {
    if (!finalResult) return;
    openTopics.add(id);
    const card = [...result.querySelectorAll('.rf-topic')].find(node => node.dataset.topicId === id);
    if (!card) return;
    card.open = true;
    card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    card.querySelector('summary').focus({ preventScroll: true });
  }

  function renderTopic(topic, index, locations, links) {
    const card = element('details', 'rf-topic');
    card.dataset.topicId = topic.id;
    card.dataset.priority = topic.priority;
    card.style.setProperty('--rf-index', String(index));
    card.open = openTopics.has(topic.id);
    card.addEventListener('toggle', () => { if (card.open) openTopics.add(topic.id); else openTopics.delete(topic.id); });
    const summary = element('summary', 'rf-topic-summary');
    const heading = element('span', 'rf-topic-heading');
    heading.append(element('span', 'rf-topic-number', String(index + 1)), appendInline(element('span', 'rf-topic-title'), topic.title), element('span', 'rf-priority', topic.priority === 'review' ? 'Review' : 'Supporting'));
    summary.append(heading);
    summary.append(gistLine('span', topic.gist));
    card.append(summary);
    const body = element('div', 'rf-topic-body');
    const link = identifierLinker(topic, locations);
    // Before and After sit in faint red and green tiles, echoing a diff's removed and added lines.
    for (const [field, label] of [['before', 'Before'], ['after', 'After']]) {
      const tile = element('div', `rf-compare rf-compare-${field}`);
      tile.append(element('h3', '', label), richText('div', `rf-${field === 'after' ? 'change-explanation' : field}`, topic[field], link));
      body.append(tile);
    }
    body.append(element('h3', '', 'Why it matters'), richText('div', 'rf-reason', topic.reason, link));
    if (topic.questions.length) {
      const questions = element('ul', 'rf-questions');
      for (const question of topic.questions) questions.append(richText('li', '', question, link));
      body.append(element('h3', '', 'Review questions'), questions);
    }
    // Files the section quotes come first, each with its quoted lines; files it only changes follow.
    const cited = [...new Set(topic.excerpts.map(excerpt => excerpt.path))];
    const changedOnly = [...new Set(topic.editIds.map(id => locations.get(id).file.path))].filter(path => !cited.includes(path));
    if (cited.length) {
      const list = element('ul', 'rf-section-files rf-code-refs');
      for (const path of cited) {
        const item = element('li');
        item.append(sectionFileRow(path, topic, locations));
        for (const excerpt of topic.excerpts.filter(entry => entry.path === path)) {
          const quote = element('div', 'rf-code-quote');
          const label = `${lineRange(excerpt)}${excerpt.side === 'before' ? ' (before)' : ''}`;
          quote.append(reference(document.createTextNode(label), excerpt, excerpt.note), richText('div', 'rf-code-note', excerpt.note, link));
          item.append(quote);
        }
        list.append(item);
      }
      body.append(element('h3', '', 'In the code'), list);
    }
    if (changedOnly.length) {
      const list = element('ul', 'rf-section-files');
      for (const path of changedOnly) {
        const item = element('li');
        item.append(sectionFileRow(path, topic, locations));
        list.append(item);
      }
      body.append(element('h3', '', cited.length ? 'Also changed in this section' : 'Files in this section'), list);
    }
    const related = [...links.filter(link => link.usedIn === topic.id).map(link => [link.symbol, 'is changed in', link.definedIn]), ...links.filter(link => link.definedIn === topic.id).map(link => [link.symbol, 'is used in', link.usedIn])];
    if (related.length) {
      const list = element('ul', 'rf-section-links');
      for (const [symbol, relation, id] of related) {
        const number = analysis.topics.findIndex(other => other.id === id) + 1;
        const item = element('li');
        item.append(element('code', '', symbol), ` ${relation} `, button(`section ${number}`, () => openTopic(id), 'rf-link-button'));
        list.append(item);
      }
      body.append(element('h3', '', 'Related sections'), list);
    }
    if (topic.uncertainty) {
      const limits = disclosure('Evidence limits', 'rf-limits');
      limits.append(richText('div', 'rf-uncertainty', topic.uncertainty, link));
      body.append(limits);
    }
    const details = disclosure('Change classifications', 'rf-evidence');
    for (const id of topic.editIds) {
      const entry = locations.get(id);
      const detail = element('div', 'rf-edit');
      detail.dataset.editId = id;
      const row = entry.edit.rows.find(item => item.type !== 'marker');
      const target = { path: entry.file.path, side: row.type === 'delete' ? 'before' : 'after', startLine: row.oldLine ?? row.newLine, endLine: row.oldLine ?? row.newLine };
      detail.append(reference(element('strong', '', `${entry.file.path} ${lineRange(target)}`), target, entry.classification.reason), element('p', 'rf-change-kind', `Change type: ${entry.classification.kinds.join(', ')}`), richText('div', '', entry.classification.reason));
      if (entry.classification.uncertainty) detail.append(richText('div', 'rf-uncertainty', entry.classification.uncertainty));
      details.append(detail);
    }
    body.append(details);
    card.append(body);
    return card;
  }

  function renderAnalysis() {
    if (!analysis || !snapshot) return;
    const scroll = panel.scrollTop;
    result.replaceChildren();
    const locations = editLocations();
    const summary = element('section', 'rf-overview');
    const reviews = analysis.topics.filter(topic => topic.priority === 'review').length;
    summary.append(element('h2', 'rf-overview-title', `${reviews} review ${reviews === 1 ? 'decision' : 'decisions'}`));
    summary.append(richText('div', 'rf-summary', analysis.summary));
    if (!reviews) summary.append(element('p', 'rf-caption', 'All sections are supporting. You can inspect every captured change.'));
    const foldControl = element('div', 'rf-fold-control');
    const foldLabel = element('label', 'rf-fold-toggle');
    const foldInput = element('input');
    foldInput.type = 'checkbox';
    foldInput.checked = foldNative;
    foldInput.addEventListener('change', () => {
      foldNative = foldInput.checked;
      applyFolding();
      renderFoldSummary();
    });
    foldLabel.append(foldInput, document.createTextNode('Fold less important code in GitHub’s diff'));
    foldControl.append(foldLabel, element('p', 'rf-caption rf-fold-summary'));
    summary.append(foldControl);
    const guided = new Set(analysis.topics.flatMap(topic => [...topic.editIds.map(id => locations.get(id).file.path), ...topic.excerpts.map(excerpt => excerpt.path)]));
    const excluded = generatedCount();
    const deletedFiles = snapshot.deletedFiles ?? [];
    const coverage = element('p', 'rf-caption rf-coverage', `Sections cover ${guided.size} of ${snapshot.files.length} files.${excluded ? ` ${excluded} machine-maintained ${excluded === 1 ? 'file' : 'files'} not analyzed (open the file list to choose Review anyway).` : ''}${deletedFiles.length ? ` ${deletedCaption(deletedFiles.length)}.` : ''}`);
    summary.append(coverage);
    if (deletedFiles.length) {
      const group = disclosure(`${deletedCaption(deletedFiles.length)} · −${deletedFiles.reduce((sum, file) => sum + file.deletions, 0).toLocaleString()} lines`, 'rf-deleted-files');
      const list = element('ul');
      for (const file of deletedFiles) {
        const item = element('li');
        item.append(pathButton(file.path, file.path, () => void revealCode({ path: file.path, side: 'before', startLine: 1, endLine: 0 }), 'rf-link-button'), element('span', 'rf-file-delta', `−${file.deletions.toLocaleString()}`));
        list.append(item);
      }
      group.append(list);
      summary.append(group);
    }
    const unresolved = analysis.classifications.filter(entry => entry.kinds.includes('unknown'));
    if (unresolved.length) {
      const notice = element('div', 'rf-unresolved', `${unresolved.length} ${unresolved.length === 1 ? 'edit has' : 'edits have'} unresolved evidence. `);
      for (const topic of analysis.topics.filter(topic => unresolved.some(entry => topic.editIds.includes(entry.editId)))) notice.append(button(topic.title, () => openTopic(topic.id), 'rf-link-button'));
      summary.append(notice);
    }
    const sections = element('section', 'rf-sections');
    sections.setAttribute('aria-label', 'Sections');
    sections.append(element('h2', 'rf-sections-title', `Sections · ${analysis.topics.length}`));
    const links = sectionLinks(analysis);
    for (const [index, topic] of analysis.topics.entries()) sections.append(renderTopic(topic, index, locations, links));
    const details = disclosure('Analysis details', 'rf-review-details');
    if (cacheMessage) details.append(element('p', 'rf-cache-detail', cacheMessage));
    details.append(element('p', 'rf-provenance', `Analyzed ${snapshot.baseSha.slice(0, 8)}…${snapshot.headSha.slice(0, 8)} with ${reviewProviderName}${reviewModel ? ` (${reviewModel})` : ''}, effort: ${reviewEffort || 'model default'}.`));
    for (const warning of snapshot.warnings ?? []) details.append(element('p', '', warning));
    result.append(summary, sections, details);
    renderFoldSummary();
    panel.scrollTop = scroll;
  }

  function checkPage() {
    if (!isActive()) return;
    const identity = pageState?.identity;
    if (!identity) {
      detachAnalysis();
      attempted = false;
      identityKey = '';
      pathKey = '';
      currentIdentity = undefined;
      observedReviews.clear();
      reviewControls.clear();
      missedSavedReviews.clear();
      result.replaceChildren();
      renderControls();
      return;
    }
    const nextIdentity = `${identity.owner}/${identity.repo}/${identity.number}`;
    const nextPath = `${pageState.pathname}${pageState.search}`;
    const changedPr = identityKey && identityKey !== nextIdentity;
    const changedHead = pageState.diff && snapshot && identity.headSha && identity.headSha !== snapshot.headSha;
    const changedBase = pageState.diff && snapshot && identity.baseSha && identity.baseSha !== snapshot.baseSha;
    if (changedPr || changedHead || changedBase) {
      cancelAnalysis('Analysis cancelled because the pull request changed.', true);
      clearReview();
      attempted = false;
      status = changedPr ? '' : 'The PR revision changed or a different commit range was selected. Analyze again before focusing this diff.';
      error = '';
    } else if (busy && !snapshot && pathKey && nextPath !== pathKey) {
      cancelAnalysis('Navigation cancelled capture. Analyze again on this page.', true);
    }
    if (changedPr || currentIdentity && (identity.headSha && identity.headSha !== currentIdentity.headSha || identity.baseSha && identity.baseSha !== currentIdentity.baseSha)) {
      observedReviews.clear();
      reviewControls.clear();
      missedSavedReviews.clear();
    }
    currentIdentity = identity;
    identityKey = nextIdentity;
    pathKey = nextPath;
    if (!pageState.diff) {
      if (!snapshot) savedReviewChecked = true;
      renderControls();
      return;
    }
    resumeAnalysis(identity);
    if (readReviewControls()) renderFileProgress();
    renderControls();
    void refreshSavedReview();
  }

  function isActive() {
    return !destroyed;
  }

  function stop() {
    if (destroyed) return;
    detachAnalysis();
    destroyed = true;
    settingsRequest++;
    listeners.abort();
    clearInterval(clock);
  }

  page.onPage = state => {
    pageState = state;
    checkPage();
  };
  page.onFoldCounts = counts => {
    foldCounts = counts;
    renderFoldSummary();
  };
  window.addEventListener('focus', refreshConnection, eventOptions);
  window.addEventListener('pagehide', stop, eventOptions);
  loadSettings();
  checkPage();
  return stop;
}

// The panel talks to the tab only through its page agent. Background analysis ports are relayed
// by the agent too, so the background still sees a GitHub pull request tab as their sender.
function pageBridge(port, state) {
  let nextId = 0;
  const calls = new Map();
  const relayed = new Map();
  const bridge = {
    state,
    onPage() {},
    onFoldCounts() {},
    onCaptureProgress() {},
    call(method, ...args) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        calls.set(id, { resolve, reject });
        try { port.postMessage({ kind: 'call', id, method, args }); } catch (failure) {
          calls.delete(id);
          reject(failure);
        }
      });
    },
    connectBackground() {
      const id = ++nextId;
      const messageListeners = [];
      const disconnectListeners = [];
      let open = true;
      relayed.set(id, {
        message: message => { for (const listener of messageListeners) listener(message); },
        disconnected() {
          if (!open) return;
          open = false;
          relayed.delete(id);
          for (const listener of disconnectListeners) listener();
        }
      });
      port.postMessage({ kind: 'bg-connect', id });
      return {
        postMessage(message) {
          if (!open) throw new Error('Attempting to use a disconnected port object');
          port.postMessage({ kind: 'bg-post', id, message });
        },
        disconnect() {
          if (!open) return;
          open = false;
          relayed.delete(id);
          try { port.postMessage({ kind: 'bg-disconnect', id }); } catch {}
        },
        onMessage: { addListener: listener => messageListeners.push(listener) },
        onDisconnect: { addListener: listener => disconnectListeners.push(listener) }
      };
    }
  };
  port.onMessage.addListener(message => {
    if (message.kind === 'page') {
      bridge.state = message.state;
      bridge.onPage(message.state);
    } else if (message.kind === 'fold-counts') bridge.onFoldCounts(message.counts);
    else if (message.kind === 'capture-progress') bridge.onCaptureProgress(message.message);
    else if (message.kind === 'reply') {
      const call = calls.get(message.id);
      calls.delete(message.id);
      if (message.ok) call?.resolve(message.value);
      else call?.reject(new Error(message.error));
    } else if (message.kind === 'bg-message') relayed.get(message.id)?.message(message.message);
    else if (message.kind === 'bg-disconnected') relayed.get(message.id)?.disconnected();
  });
  return bridge;
}

// Resolves with the first page report, or undefined when this tab has no page agent to connect to.
function connectPage(tabId) {
  return new Promise(resolve => {
    let port;
    try { port = chrome.tabs.connect(tabId, { name: 'priorities-panel' }); } catch { resolve(undefined); return; }
    const timeout = setTimeout(() => { port.disconnect(); resolve(undefined); }, 2000);
    const first = message => {
      if (message.kind !== 'page') return;
      clearTimeout(timeout);
      port.onMessage.removeListener(first);
      resolve({ port, state: message.state });
    };
    port.onMessage.addListener(first);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      clearTimeout(timeout);
      resolve(undefined);
    });
  });
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const tabId = Number(params.get('tab'));
  // `start` stays in the URL until Analyze runs, so a reload while the tab switches to Files changed keeps it.
  const autostart = params.has('start');
  const onAutostart = () => {
    params.delete('start');
    history.replaceState(null, '', `?${params}`);
  };
  const waiting = element('div', 'rf-panel rf-waiting');
  const brand = element('div', 'rf-toolbar');
  brand.append(element('strong', 'rf-brand', 'PRiorities'));
  const message = element('p', 'rf-welcome', 'Connecting to the GitHub tab…');
  waiting.append(brand, message);
  document.body.append(waiting);
  for (let attempt = 0; ; attempt++) {
    const connection = Number.isInteger(tabId) ? await connectPage(tabId) : undefined;
    if (connection) {
      waiting.remove();
      const bridge = pageBridge(connection.port, connection.state);
      startPanel(bridge, { autostart, onAutostart });
      // A reload or full navigation replaces the tab's page agent; starting over resumes any analysis.
      connection.port.onDisconnect.addListener(() => location.reload());
      return;
    }
    if (attempt === 2) message.textContent = 'Waiting for a GitHub pull request in this tab. If PRiorities was just installed or reloaded, refresh the tab.';
    await new Promise(resolve => setTimeout(resolve, 800));
  }
}

void boot();
