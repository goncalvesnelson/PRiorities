import { capturePullRequest, findNativeFiles, readPageIdentity } from './github.js';
import { isGeneratedFile } from './review-data.js';
import { isProtectedPath } from './review-preferences.js';

const hiddenClass = 'review-focus-native-hidden';
const ownedAttribute = 'data-review-focus-owned';

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

function disclosure(label, className = '') {
  const node = element('details', className);
  node.append(element('summary', '', label));
  return node;
}

function isDiffPage() {
  return /^\/[^/]+\/[^/]+\/pull\/\d+\/(?:(?:files|changes)(?:\/|$)|commits\/[a-f0-9]{40}(?:\/|$))/.test(location.pathname);
}

function rowKey(row) {
  return JSON.stringify([row.type, row.oldLine ?? null, row.newLine ?? null, row.text]);
}

function rowSelected(row, excerpts) {
  return excerpts.some(excerpt => {
    const line = excerpt.side === 'before' ? row.oldLine : row.newLine;
    return line !== null && line >= excerpt.startLine && line <= excerpt.endLine;
  });
}

function topicLabel(topics) {
  const unique = [...new Set(topics.filter(Boolean))];
  if (!unique.length) return 'Surrounding context';
  return `Supporting changes: ${unique.map(topic => topic.title).join('; ')}`;
}

export function createNativeFolding(doc, snapshot, analysis, onChange = () => {}, revealed = new Set(), alwaysShow = [], protectedPaths = []) {
  const topicsByEdit = new Map(analysis.topics.flatMap(topic => topic.editIds.map(id => [id, topic])));
  const keptEdits = new Set(analysis.classifications.filter(entry => entry.kinds.some(kind => kind === 'unknown' || alwaysShow.includes(kind))).map(entry => entry.editId));
  const fileRows = new Map(snapshot.files.map(file => {
    const rows = new Map();
    const protectedFile = isProtectedPath(file.path, protectedPaths);
    for (const hunk of file.hunks) {
      for (const item of hunk.items) {
        const topic = topicsByEdit.get(item.id);
        const kept = protectedFile || keptEdits.has(item.id) || topic?.priority === 'review';
        for (const row of item.type === 'edit' ? item.rows : [item]) {
          if (row.type !== 'marker') rows.set(rowKey(row), { row, topic, kept });
        }
      }
    }
    return [file.path, rows];
  }));
  const excerptsByPath = new Map();
  for (const topic of analysis.topics.filter(topic => topic.priority === 'review')) {
    for (const excerpt of topic.excerpts) {
      const excerpts = excerptsByPath.get(excerpt.path) ?? [];
      excerpts.push(excerpt);
      excerptsByPath.set(excerpt.path, excerpts);
    }
  }
  const hidden = new Set();
  const folds = [];
  let matched = 0;
  let unmatched = 0;
  let appliedLayout;

  function restore() {
    appliedLayout = undefined;
    for (const row of hidden) row.classList.remove(hiddenClass);
    hidden.clear();
    for (const fold of folds) fold.marker.remove();
    folds.length = 0;
  }

  function counts() {
    const hiddenChanges = folds.filter(fold => !revealed.has(fold.key)).reduce((sum, fold) => sum + fold.changed, 0);
    return { hidden: hidden.size, hiddenChanges, matched, unmatched, groups: folds.length };
  }

  function setExpanded(fold, expanded) {
    if (expanded) revealed.add(fold.key);
    else revealed.delete(fold.key);
    for (const row of fold.rows) {
      row.element.classList.toggle(hiddenClass, !expanded);
      if (expanded) hidden.delete(row.element);
      else hidden.add(row.element);
    }
    fold.toggle.textContent = expanded ? 'Hide' : 'Show';
    fold.toggle.setAttribute('aria-expanded', String(expanded));
    fold.toggle.setAttribute('aria-label', `${expanded ? 'Hide' : 'Show'} ${fold.rows.length} lines. ${fold.reason}`);
    onChange(counts());
  }

  function foldRows(path, rows) {
    if (rows.length < 2) return;
    const first = rows[0].element;
    const marker = doc.createElement(first.tagName === 'TR' ? 'tr' : 'div');
    marker.className = 'review-focus-native-fold';
    marker.setAttribute(ownedAttribute, '');
    const container = doc.createElement(first.tagName === 'TR' ? 'td' : 'div');
    if (first.tagName === 'TR') container.colSpan = Math.max(1, [...first.cells].reduce((sum, cell) => sum + cell.colSpan, 0));
    const body = element('div', 'review-focus-native-fold-body');
    const reason = topicLabel(rows.map(row => row.topic));
    const label = element('span', 'review-focus-native-reason', `${rows.length} ${reason.startsWith('Surrounding') ? 'context' : 'supporting'} lines`);
    label.title = reason;
    const toggle = button('', () => setExpanded(fold, !revealed.has(fold.key)), 'review-focus-native-toggle');
    const fold = { key: JSON.stringify([path, rowKey(rows[0]), rowKey(rows.at(-1))]), marker, toggle, rows, reason, changed: rows.filter(row => row.type !== 'context').length };
    body.append(label, toggle);
    container.append(body);
    marker.append(container);
    first.before(marker);
    folds.push(fold);
    setExpanded(fold, revealed.has(fold.key));
  }

  function apply() {
    const files = findNativeFiles(doc);
    const layout = files.flatMap(file => [file.element, file.path, ...file.rows.flatMap(row => {
      let next = row.element.nextElementSibling;
      while (next?.hasAttribute(ownedAttribute)) next = next.nextElementSibling;
      return [row.element, row.element.parentElement, next, rowKey(row), row.element.getAttribute('role'), Boolean(row.element.querySelector('form, textarea, .review-thread-component, .js-comment-container') || next?.matches('tr.inline-comments'))];
    })]);
    const intactFolds = folds.every(fold => fold.marker.nextElementSibling === fold.rows[0].element);
    if (intactFolds && appliedLayout?.length === layout.length && layout.every((value, index) => value === appliedLayout[index])) return counts();
    restore();
    appliedLayout = layout;
    matched = 0;
    unmatched = 0;
    for (const file of files) {
      const expected = fileRows.get(file.path);
      if (!expected) continue;
      const excerpts = excerptsByPath.get(file.path) ?? [];
      const elementCounts = new Map();
      for (const row of file.rows) elementCounts.set(row.element, (elementCounts.get(row.element) ?? 0) + 1);
      let group = [];
      const flush = () => { foldRows(file.path, group); group = []; };
      for (const row of file.rows) {
        const match = expected.get(rowKey(row));
        const supported = row.element.tagName === 'TR' || row.element.getAttribute('role') === 'row';
        const hasDiscussion = row.element.querySelector('form, textarea, .review-thread-component, .js-comment-container') || row.element.nextElementSibling?.matches('tr.inline-comments');
        if (!match || !supported || elementCounts.get(row.element) !== 1 || hasDiscussion) {
          unmatched++;
          flush();
          continue;
        }
        matched++;
        if (match.kept || rowSelected(match.row, excerpts)) {
          flush();
          continue;
        }
        if (group.length && group.at(-1).element.nextElementSibling !== row.element) flush();
        group.push({ ...row, topic: match.topic });
      }
      flush();
    }
    return counts();
  }

  function revealRow(row) {
    const fold = folds.find(entry => entry.rows.some(item => item.element === row));
    if (fold) setExpanded(fold, true);
  }

  return { apply, restore, counts, revealRow };
}

function sourceLink(snapshot, excerpt) {
  const url = new URL(snapshot.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const revision = excerpt.side === 'before' ? snapshot.baseSha : snapshot.headSha;
  const path = excerpt.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${parts[0]}/${parts[1]}/blob/${revision}/${path}#L${excerpt.startLine}-L${excerpt.endLine}`;
}

function renderRows(rows) {
  const table = element('table', 'rf-code');
  const body = element('tbody');
  for (const row of rows) {
    const line = element('tr', `rf-code-${row.type}`);
    line.append(element('td', 'rf-line-number', String(row.oldLine ?? '')));
    line.append(element('td', 'rf-line-number', String(row.newLine ?? '')));
    line.append(element('td', 'rf-line-marker', row.type === 'add' ? '+' : row.type === 'delete' ? '−' : ''));
    line.append(element('td', 'rf-code-text', row.text));
    body.append(line);
  }
  table.append(body);
  const scroll = element('div', 'rf-code-scroll');
  scroll.append(table);
  return scroll;
}

export function startReviewUI() {
  if (!chrome.runtime?.id || document.querySelector('#review-focus-extension')) return;
  const listeners = new AbortController();
  const eventOptions = { signal: listeners.signal };
  const host = element('section');
  host.id = 'review-focus-extension';
  host.setAttribute(ownedAttribute, '');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = element('link');
  style.rel = 'stylesheet';
  style.href = chrome.runtime.getURL('review.css');
  const panel = element('div', 'rf-panel');
  shadow.append(style, panel);
  let snapshot;
  let analysis;
  let folding;
  let port;
  let controller;
  let operation = 0;
  let settingsRequest = 0;
  let busy = false;
  let mode = 'focused';
  let identityKey = '';
  let pathKey = '';
  let resumeProbe = '';
  let currentIdentity;
  let configured = false;
  let model = '';
  let effort = '';
  let status = '';
  let error = '';
  let settingsError = '';
  let timer;
  let destroyed = false;
  const fileStates = new Map();
  const filePanels = new Map();
  const observedReviews = new Map();
  let reviewControls = new Map();
  const revealed = new Set();
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
  let reviewGroups = [];
  let fileOrder = 'priority';

  const header = element('div', 'rf-toolbar');
  const brand = element('strong', 'rf-brand', 'PRiorities');
  const progressToggle = button('', () => { fileListOpen = !fileListOpen; renderFileProgress(); }, 'rf-progress-toggle');
  progressToggle.setAttribute('aria-controls', 'rf-file-progress');
  progressToggle.hidden = true;
  const buttons = element('div', 'rf-actions');
  const analyze = button('Analyze PR', () => analyzePullRequest({ cacheOnly: canOpenSavedReview(), force: (attempted || cacheLookupFailed) && !canOpenSavedReview() }), 'rf-primary rf-analyze');
  const alternateReview = button('Run fresh review', () => analyzePullRequest(savedReview && missedSavedReviews.has(savedReview.candidate) ? { cacheOnly: true } : { force: true }));
  const cancel = button('Cancel', () => cancelAnalysis());
  const settings = button('Settings', () => openSettings());
  const focused = button('Folded', () => setMode('focused'));
  const explained = button('Explained', () => setMode('explained'));
  const full = button('Full diff', () => setMode('full'));
  full.title = 'All code, without PRiorities explanations.';
  explained.title = 'All code, with PRiorities explanations beside each file.';
  focused.title = 'PRiorities explanations, with supporting code folded.';
  const retryFinal = button('Retry review decisions', () => retryReview());
  retryFinal.hidden = true;
  cancel.hidden = true;
  const viewToggle = element('div', 'rf-view-toggle');
  viewToggle.setAttribute('role', 'group');
  viewToggle.setAttribute('aria-label', 'Review view');
  const viewButtons = [full, explained, focused];
  viewToggle.append(...viewButtons);
  viewToggle.addEventListener('keydown', event => {
    const index = viewButtons.indexOf(event.target);
    if (index < 0) return;
    const next = event.key === 'ArrowRight' ? (index + 1) % viewButtons.length
      : event.key === 'ArrowLeft' ? (index + viewButtons.length - 1) % viewButtons.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? viewButtons.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    viewButtons[next].focus();
    viewButtons[next].click();
  });
  const menu = disclosure('⋯', 'rf-menu');
  const menuToggle = menu.querySelector('summary');
  menuToggle.setAttribute('aria-label', 'More actions');
  menuToggle.title = 'More actions';
  const menuActions = element('div', 'rf-menu-actions');
  menuActions.append(alternateReview, settings);
  menu.append(menuActions);
  menuActions.addEventListener('click', event => { if (event.target.closest('button')) menu.open = false; });
  shadow.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    menuToggle.focus();
    event.stopPropagation();
  });
  document.addEventListener('pointerdown', event => {
    if (menu.open && !event.composedPath().includes(menu)) menu.open = false;
  }, eventOptions);
  shadow.addEventListener('focusin', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  buttons.append(viewToggle, analyze, cancel, retryFinal, menu);
  header.append(brand, progressToggle, buttons);
  const statusNode = element('p', 'rf-status');
  statusNode.setAttribute('role', 'status');
  statusNode.setAttribute('aria-live', 'polite');
  const errorNode = element('p', 'rf-error');
  errorNode.setAttribute('role', 'alert');
  const result = element('div', 'rf-result');
  const welcome = element('p', 'rf-welcome', 'Focus on the changes that need you. Every line stays accessible.');
  const progressPanel = element('div', 'rf-progress-panel');
  const phase = element('strong', 'rf-phase');
  const progressDetail = element('span', 'rf-progress-detail');
  const progressHeading = element('div', 'rf-progress-heading');
  progressHeading.append(phase, progressDetail);
  const progressBar = element('progress', 'rf-progress-bar');
  progressBar.setAttribute('aria-label', 'Files classified');
  progressPanel.append(progressHeading, progressBar);
  const cacheNotice = element('p', 'rf-cache-notice');
  const runSettings = element('p', 'rf-run-settings rf-caption');
  const fileProgress = element('div', 'rf-file-progress');
  fileProgress.id = 'rf-file-progress';
  fileProgress.hidden = true;
  const secondary = element('div', 'rf-secondary');
  const orderControl = element('select', 'rf-file-order');
  orderControl.setAttribute('aria-label', 'File order');
  orderControl.title = 'Priority order groups related files by review decision. GitHub order restores the captured file order.';
  for (const [value, label] of [['priority', 'Priority order'], ['github', 'GitHub order']]) {
    const option = element('option', '', label);
    option.value = value;
    orderControl.append(option);
  }
  orderControl.addEventListener('change', () => {
    if (!isActive()) return;
    keepReadingPosition(() => {
      fileOrder = orderControl.value;
      applyFileOrder();
      renderFileProgress();
    });
  });
  secondary.append(runSettings, orderControl, result);
  panel.append(header, secondary, welcome, progressPanel, statusNode, cacheNotice, errorNode, fileProgress);

  function canOpenSavedReview() {
    return Boolean(savedReview && !analysis && !missedSavedReviews.has(savedReview.candidate));
  }

  function renderControls() {
    if (destroyed) return;
    const currentError = [settingsError, error].filter(Boolean).join(' ');
    const activeModel = reviewProviderName ? reviewModel : model;
    const activeEffort = reviewProviderName ? reviewEffort : effort;
    const settingsChanged = Boolean(reviewProviderName && model &&
      (reviewProviderName !== providerName || reviewModel !== model || reviewEffort !== effort));
    const rangeSelected = /\/pull\/\d+\/(?:files|changes|commits)\/[^/]+/.test(location.pathname);
    const analyzeLabel = rangeSelected ? 'Analyze range' : 'Analyze PR';
    const comparison = snapshot ?? currentIdentity;
    const primaryAction = !analysis || settingsChanged;
    runSettings.textContent = `${reviewProviderName || providerName} · ${activeModel || 'Choose a model in Settings'}${activeModel ? ` · Effort: ${activeEffort || 'model default'}` : ''}${reviewPreferences ? ` · Focus: ${reviewPreferences.focus}` : ''}`;
    if (rangeSelected) runSettings.textContent += comparison?.baseSha && comparison.headSha ? ` · Range: ${comparison.baseSha.slice(0, 8)}…${comparison.headSha.slice(0, 8)}` : ' · Selected commits';
    analyze.disabled = busy;
    analyze.hidden = busy;
    analyze.textContent = canOpenSavedReview() ? 'Open saved review' : settingsChanged ? analyzeLabel : attempted || cacheLookupFailed ? 'Run fresh review' : analyzeLabel;
    analyze.classList.toggle('rf-primary', primaryAction);
    if (!primaryAction && analyze.parentElement !== menuActions) menuActions.prepend(analyze);
    else if (primaryAction && analyze.parentElement !== buttons) buttons.insertBefore(analyze, cancel);
    alternateReview.hidden = busy || !savedReview || Boolean(analysis);
    alternateReview.textContent = savedReview && missedSavedReviews.has(savedReview.candidate) ? 'Retry saved review' : 'Run fresh review';
    cancel.hidden = !busy;
    cancel.disabled = pendingAction?.type === 'cancel';
    viewToggle.hidden = !analysis;
    retryFinal.hidden = busy || !port || !['check-failed', 'cancelled'].includes(reviewStage) || [...fileStates.values()].some(file => !['classified', 'complete', 'skipped', 'excluded'].includes(file.state));
    focused.setAttribute('aria-pressed', String(mode === 'focused'));
    explained.setAttribute('aria-pressed', String(mode === 'explained'));
    full.setAttribute('aria-pressed', String(mode === 'full'));
    for (const control of viewButtons) control.tabIndex = control.getAttribute('aria-pressed') === 'true' ? 0 : -1;
    errorNode.hidden = !currentError;
    if (errorNode.textContent !== currentError) errorNode.textContent = currentError;
    welcome.hidden = busy || Boolean(analysis) || fileStates.size > 0;
    progressPanel.hidden = !busy || fileStates.size > 0;
    const states = [...fileStates.values()];
    const total = states.filter(file => !['skipped', 'excluded'].includes(file.state)).length;
    const classified = classifiedCount();
    const stage = openingSavedReview || !snapshot ? 0 : reviewStage === 'checking' ? 2 : 1;
    phase.textContent = [reviewStage === 'reconnecting' ? 'Reconnecting to analysis' : openingSavedReview ? 'Opening saved review' : 'Reading this pull request', 'Classifying files', 'Choosing review decisions'][stage];
    progressDetail.textContent = stage === 1 ? `${classified} of ${total} files classified` : stage === 2 ? 'Every file is classified; comparing the changes' : reviewStage === 'reconnecting' ? 'Checking for work already running in this tab' : openingSavedReview ? 'Checking the saved review against the current context' : 'Capturing the complete diff and context';
    renderProgressSummary();
    if (stage === 1 && total) { progressBar.max = total; progressBar.value = classified; }
    else progressBar.removeAttribute('value');
    cacheNotice.hidden = Boolean(analysis) && !cacheWarning || !cacheMessage && !savedReview;
    cacheNotice.textContent = cacheMessage || (savedReview ? `Saved ${new Date(savedReview.savedAt).toLocaleString()}. Opening checks the current context without a new model call.` : '');
    let nextStatus = pendingAction?.message ?? status;
    if (busy && snapshot && !currentError && !pendingAction) nextStatus = `${phase.textContent}. ${progressDetail.textContent}.`;
    if (!busy && !status) nextStatus = !configured
      ? `Connect your local ${providerName} helper in Settings, then analyze this PR.`
      : `Ready to analyze ${rangeSelected ? 'these commits' : 'this PR'} with ${providerName}${model ? ` (${model})` : ''}. Analysis starts only when you click ${analyzeLabel}.`;
    if (settingsChanged && !busy && !pendingAction && !currentError) nextStatus = `Settings changed. ${analyzeLabel} will use ${providerName} (${model}), effort: ${effort || 'model default'}.`;
    const split = [...document.querySelectorAll('table[data-diff-anchor] tr.diff-line-row')].some(row => row.querySelectorAll('.diff-text').length > 1);
    if (analysis && mode === 'focused' && split) nextStatus += ' GitHub is in split view. Choose Unified in its diff view settings to collapse lines.';
    if (statusNode.textContent !== nextStatus) statusNode.textContent = nextStatus;
    const ordinaryStatus = (busy && snapshot || finalResult && verifiedPage() || !attempted && configured && !status) && !currentError && !pendingAction && !split && !(settingsChanged && !busy);
    statusNode.classList.toggle('rf-visually-hidden', Boolean(ordinaryStatus));
    const foldingDetail = result.querySelector('.rf-folding-detail');
    if (foldingDetail) foldingDetail.textContent = status;
    result.hidden = mode === 'full' || !finalResult;
    orderControl.hidden = !finalResult || mode === 'full';
    orderControl.value = fileOrder;
  }

  async function loadSettings(refreshConnection = false) {
    if (!isActive()) return;
    const request = ++settingsRequest;
    try {
      const settings = await chrome.runtime.sendMessage({ type: 'get-settings', refreshConnection });
      if (request !== settingsRequest || !isActive()) return;
      if (settings?.error) throw new Error(settings.error);
      if (!['codex', 'claude'].includes(settings?.provider)) throw new Error('The extension returned invalid provider settings.');
      providerName = settings.provider === 'claude' ? 'Claude Code' : 'Codex';
      configured = Boolean(settings?.configured);
      model = settings?.model ?? '';
      effort = settings?.effort ?? '';
      settingsError = '';
      void refreshSavedReview(true);
      renderControls();
    } catch (failure) {
      if (request !== settingsRequest || !isActive()) return;
      configured = false;
      model = '';
      settingsError = `The extension could not read its settings. Reload this page after reloading the extension. ${failure.message}`;
      renderControls();
    }
  }

  function refreshConnection() {
    if (destroyed || document.hidden || busy && !snapshot || !identityKey) return;
    void loadSettings();
  }

  async function refreshSavedReview(force = false) {
    if (!isActive() || busy || analysis || !isDiffPage()) return;
    const identity = readPageIdentity(document, location.href);
    if (!identity?.headSha || !identity.baseSha) return;
    const key = JSON.stringify([identity.owner, identity.repo, identity.number, identity.baseSha, identity.headSha, providerName, model, effort]);
    if (!force && key === cacheProbe) return;
    cacheProbe = key;
    const version = ++cacheProbeVersion;
    try {
      const cached = await chrome.runtime.sendMessage({ type: 'peek-review', baseSha: identity.baseSha, headSha: identity.headSha });
      if (version !== cacheProbeVersion || !isActive() || busy || analysis) return;
      if (cached?.error) throw new Error(cached.error);
      if (cacheLookupFailed) { cacheMessage = ''; cacheWarning = false; }
      cacheLookupFailed = false;
      savedReview = cached?.available ? { ...cached, candidate: JSON.stringify([key, cached.key, cached.savedAt]) } : undefined;
      renderControls();
    } catch (failure) {
      if (version !== cacheProbeVersion || !isActive() || busy || analysis) return;
      cacheLookupFailed = true;
      cacheWarning = true;
      cacheMessage = failure.message;
      renderControls();
    }
  }

  async function openSettings() {
    if (!isActive()) return;
    try {
      const settings = await chrome.runtime.sendMessage({ type: 'open-settings' });
      if (settings?.error) throw new Error(settings.error);
    } catch (failure) {
      if (!isActive()) return;
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
    applyFileOrder(true);
    folding?.restore();
    folding = undefined;
    snapshot = undefined;
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
    cacheProbe = '';
    cacheProbeVersion++;
    fileFilter = 'all';
    reviewGroups = [];
    fileStates.clear();
    revealed.clear();
    removeFilePanels();
    fileProgress.hidden = true;
    fileListOpen = false;
    progressToggle.hidden = true;
    result.replaceChildren();
  }

  function retryReview(path) {
    if (!isActive() || !port || openingSavedReview || !verifiedPage()) return;
    busy = true;
    error = '';
    reviewStage = path ? 'files' : 'checking';
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
    applyFolding();
    error = '';
    reviewStage = 'files';
    pendingAction = { type: 'file', path, message: `Analyzing ${path}…` };
    port.postMessage({ type: 'review-file', path });
    if (analysis) renderAnalysis();
    renderFileProgress();
    renderControls();
  }

  function generatedCount() {
    return [...fileStates.values()].filter(file => file.state === 'excluded').length;
  }

  function fileLabel(file) {
    return { queued: 'AI waiting', classifying: 'AI classifying', classified: 'AI classified · review decisions pending', complete: 'AI ready', failed: 'AI needs retry', cancelled: 'AI cancelled', skipped: 'AI skipped · no text changes', excluded: 'AI skipped · generated' }[file.state];
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
    const total = states.filter(file => !['skipped', 'excluded'].includes(file.state)).length;
    const active = states.filter(file => file.state === 'classifying').length;
    const waiting = states.filter(file => file.state === 'queued').length;
    const failed = states.filter(file => file.state === 'failed').length;
    const excluded = generatedCount();
    return `${classifiedCount()} of ${total} files ${finalResult ? 'AI ready' : 'classified'}${active ? ` · ${active} classifying` : ''}${waiting ? ` · ${waiting} waiting` : ''}${failed ? ` · ${failed} failed` : ''}${excluded ? ` · ${excluded} generated ${excluded === 1 ? 'file' : 'files'} skipped by AI` : ''}`;
  }

  function renderProgressSummary() {
    const states = [...fileStates.values()];
    const reviewed = [...fileStates.keys()].filter(path => observedReviews.get(path) === true).length;
    const unknown = [...fileStates.keys()].filter(path => !observedReviews.has(path)).length;
    const total = states.filter(file => !['skipped', 'excluded'].includes(file.state)).length;
    const phaseLabel = openingSavedReview ? 'Opening saved review' : reviewStage === 'checking' ? 'Review decisions' : reviewStage === 'check-failed' ? 'Review decisions failed' : reviewStage === 'cancelled' || !busy && states.some(file => file.state === 'cancelled') ? 'Cancelled' : states.some(file => file.state === 'failed') ? 'Needs retry' : busy ? 'Analyzing' : '';
    progressToggle.hidden = !states.length;
    const analyzed = total ? `${finalResult ? 'AI ready' : 'Classified'} ${classifiedCount()}/${total}` : `All ${states.length} files skipped`;
    progressToggle.textContent = `${analyzed}${phaseLabel ? ` · ${phaseLabel}` : ''} · Viewed ${reviewed}/${states.length}${unknown ? ` (${unknown} unknown)` : ''}`;
    progressToggle.title = `${fileCounts()}. ${reviewed} of ${states.length} files viewed in GitHub. ${fileListOpen ? 'Hide' : 'Show'} file progress.`;
    progressToggle.setAttribute('aria-expanded', String(fileListOpen));
  }

  function nativeReviewControl(native) {
    return native?.element.querySelector('input.js-reviewed-checkbox, button[aria-pressed][aria-label="Viewed"], button[aria-pressed][aria-label="Not Viewed"]');
  }

  function readReviewControls() {
    const controls = new Map();
    for (const native of findNativeFiles(document)) {
      const control = nativeReviewControl(native);
      if (!control) continue;
      const reviewed = control.tagName === 'INPUT' ? control.checked : control.getAttribute('aria-pressed') === 'true';
      observedReviews.set(native.path, reviewed);
      controls.set(native.path, { reviewed, disabled: control.disabled || control.getAttribute('aria-disabled') === 'true' });
    }
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
    hint.hidden = Boolean(control && !control.disabled);
    hint.textContent = control ? 'Unavailable in this view' : reviewed === undefined ? 'Status unavailable' : 'Load file to update';
    label.title = control && !control.disabled ? 'Uses GitHub’s Viewed checkbox. AI analysis never changes your checkmark.' : 'Load this file in GitHub’s full diff to read or change its Viewed status.';
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
      const native = findNativeFiles(document).find(file => file.path === path);
      const control = nativeReviewControl(native);
      if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') event.preventDefault();
    });
    input.addEventListener('change', () => {
      if (!isActive() || !verifiedPage()) {
        checkPage();
        return;
      }
      const native = findNativeFiles(document).find(file => file.path === path);
      const control = nativeReviewControl(native);
      if (control && !control.disabled && control.getAttribute('aria-disabled') !== 'true') {
        const reviewed = control.tagName === 'INPUT' ? control.checked : control.getAttribute('aria-pressed') === 'true';
        if (input.checked !== reviewed) control.click();
      }
      readReviewControls();
      renderFileProgress();
    });
    label.append(input, element('span', '', 'Reviewed by you'), element('span', 'rf-review-unavailable'));
    updateReviewToggle(label, path);
    return label;
  }

  function renderFileProgress() {
    const focused = shadow.activeElement;
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
    const groups = priorityOrderActive() ? reviewGroups : [{ paths: [...fileStates.keys()] }];
    for (const group of groups) {
      let heading;
      for (const path of group.paths) {
        const file = fileStates.get(path);
        if (fileFilter === 'reviewed' && observedReviews.get(path) !== true) continue;
        if (fileFilter === 'unreviewed' && observedReviews.get(path) === true) continue;
        if (fileFilter === 'failed' && !['failed', 'cancelled'].includes(file.state)) continue;
        if (group.title && !heading) {
          heading = element('h3', 'rf-file-group', group.title);
          rows.append(heading);
        }
        const row = element('div', 'rf-file-progress-row');
        row.dataset.state = file.state;
        row.dataset.path = path;
        const label = element('span', 'rf-file-state', fileLabel(file));
        label.dataset.state = file.state;
        row.append(button(path, () => {
          const native = findNativeFiles(document).find(entry => entry.path === path);
          native?.element.scrollIntoView({ block: 'start', behavior: 'auto' });
        }, 'rf-file-path'), label, reviewToggle(path));
        if (['failed', 'cancelled'].includes(file.state) && port && !openingSavedReview) row.append(button('Retry file', () => retryReview(path)));
        if (file.state === 'excluded' && port && !openingSavedReview) row.append(button('Review anyway', () => reviewGeneratedFile(path)));
        if (['failed', 'cancelled'].includes(file.state) && file.message) row.append(element('span', 'rf-caption', file.message));
        rows.append(row);
      }
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
    renderFilePanels();
  }

  function buildReviewGroups() {
    const locations = editLocations();
    const assigned = new Set();
    const groups = [];
    const add = (title, paths) => {
      const remaining = [...new Set(paths)].filter(path => !assigned.has(path));
      if (!remaining.length) return;
      for (const path of remaining) assigned.add(path);
      groups.push({ title, paths: remaining });
    };
    const topicPaths = topic => [...topic.editIds.map(id => locations.get(id).file.path), ...topic.excerpts.map(excerpt => excerpt.path)];
    for (const topic of analysis.topics.filter(topic => topic.priority === 'review')) add(topic.title, topicPaths(topic));
    add('Unresolved evidence', analysis.classifications.filter(entry => entry.kinds.includes('unknown')).map(entry => locations.get(entry.editId).file.path));
    for (const topic of analysis.topics.filter(topic => topic.priority === 'supporting')) add(topic.title, topicPaths(topic));
    add('Not analyzed', [...fileStates.keys()]);
    return groups;
  }

  function priorityOrderActive() {
    return finalResult && mode !== 'full' && fileOrder === 'priority';
  }

  function keepReadingPosition(update) {
    const reading = host.isConnected && host.getBoundingClientRect().bottom < 0;
    const visibleFiles = reading ? findNativeFiles(document).filter(file => {
      const rect = file.element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight;
    }) : [];
    const anchor = visibleFiles.find(file => file.element.contains(document.activeElement))?.element ?? visibleFiles[0]?.element;
    const top = anchor?.getBoundingClientRect().top;
    update();
    if (anchor) window.scrollBy({ top: anchor.getBoundingClientRect().top - top, behavior: 'instant' });
  }

  function applyFileOrder(restore = false) {
    if (!snapshot) return;
    const paths = !restore && priorityOrderActive() && verifiedPage()
      ? reviewGroups.flatMap(group => group.paths) : snapshot.files.map(file => file.path);
    const ranks = new Map(paths.map((path, index) => [path, index]));
    const files = findNativeFiles(document);
    const lists = new Map();
    for (const file of files) {
      if (!ranks.has(file.path)) continue;
      const list = file.element.closest('[data-testid="progressive-diffs-list"], .js-diff-progressive-container')
        ?? (file.element.matches('.js-file') ? file.element.parentElement : null);
      if (!list) continue;
      let entry = file.element;
      while (entry.parentElement !== list) entry = entry.parentElement;
      const entries = lists.get(list) ?? new Map();
      if (entries.has(entry)) entries.set(entry, null);
      else entries.set(entry, file.path);
      lists.set(list, entries);
    }
    const moves = [];
    for (const [list, entries] of lists) {
      const children = [...list.children];
      const ordered = children.filter(child => entries.get(child)).sort((left, right) => ranks.get(entries.get(left)) - ranks.get(entries.get(right)));
      let index = 0;
      const desired = children.map(child => entries.get(child) ? ordered[index++] : child);
      if (desired.some((child, index) => child !== children[index])) moves.push({ list, desired });
    }
    if (!moves.length) return;
    keepReadingPosition(() => {
      for (const { list, desired } of moves) {
        for (const [index, child] of desired.entries()) {
          if (list.children[index] !== child) list.moveBefore(child, list.children[index] ?? null);
        }
      }
    });
  }

  function editLocations() {
    const classifications = new Map(analysis.classifications.map(entry => [entry.editId, entry]));
    return new Map(snapshot.files.flatMap(file => file.hunks.flatMap(hunk => hunk.items.filter(item => item.type === 'edit').map(edit => [edit.id, { file, edit, classification: classifications.get(edit.id) }]))));
  }

  function removeFilePanels() {
    for (const { node, badge } of filePanels.values()) {
      node.remove();
      badge.remove();
    }
    filePanels.clear();
  }

  function renderFilePanels() {
    if (!isActive() || !isDiffPage()) return;
    let locations;
    for (const [container, record] of filePanels) {
      if (container.isConnected) continue;
      record.node.remove();
      record.badge.remove();
      filePanels.delete(container);
    }
    for (const native of findNativeFiles(document)) {
      const file = fileStates.get(native.path);
      if (!file) continue;
      let record = filePanels.get(native.element);
      if (record && record.node.dataset.path !== native.path) {
        record.node.remove();
        record.badge.remove();
        filePanels.delete(native.element);
        record = undefined;
      }
      if (!record) {
        const node = element('div', 'review-focus-file-progress');
        node.setAttribute(ownedAttribute, '');
        node.dataset.path = native.path;
        const root = node.attachShadow({ mode: 'open' });
        const style = element('link');
        style.rel = 'stylesheet';
        style.href = chrome.runtime.getURL('review.css');
        const content = element('div', 'rf-panel rf-file-panel');
        root.append(style, content);
        const badge = element('span', 'review-focus-file-status');
        badge.setAttribute(ownedAttribute, '');
        badge.dataset.path = native.path;
        const badgeRoot = badge.attachShadow({ mode: 'open' });
        const heading = element('span', 'rf-panel rf-file-status');
        const label = element('span', 'rf-file-state');
        const actions = element('span', 'rf-file-actions');
        heading.append(label, actions);
        badgeRoot.append(style.cloneNode(), heading);
        record = { node, content, badge, label, actions };
        filePanels.set(native.element, record);
      }
      const header = native.element.querySelector('.file-header, [class*="diff-file-header"]');
      for (const orphan of native.element.querySelectorAll('.review-focus-file-status')) {
        if (orphan !== record.badge) orphan.remove();
      }
      if (header && record.badge.parentElement !== header) header.append(record.badge);
      if (!record.node.isConnected) {
        if (header) {
          const headerWrapper = header.closest('[data-diff-header-wrapper]') ?? header;
          headerWrapper.after(record.node);
        } else if (native.element.tagName === 'TABLE') native.element.before(record.node);
        else native.element.prepend(record.node);
      }
      if (!header && record.badge.nextElementSibling !== record.node) record.node.before(record.badge);
      record.badge.dataset.state = file.state;
      record.label.dataset.state = file.state;
      record.label.textContent = fileLabel(file);
      record.label.title = file.message || 'AI analysis status. Your Viewed checkmark is independent.';
      const action = port && !openingSavedReview
        ? ['failed', 'cancelled'].includes(file.state) ? 'retry' : file.state === 'excluded' ? 'include' : ''
        : '';
      if (record.action !== action) {
        const activeElement = record.badge.shadowRoot.activeElement;
        const wasFocused = activeElement && activeElement === record.actions.firstElementChild;
        record.actions.replaceChildren();
        if (action) record.actions.append(button(action === 'retry' ? 'Retry file' : 'Review anyway', () => action === 'retry' ? retryReview(native.path) : reviewGeneratedFile(native.path), 'rf-link-button'));
        if (wasFocused) (record.actions.firstElementChild ?? progressToggle).focus({ preventScroll: true });
        record.action = action;
      }
      const topics = file.state === 'complete' && analysis && finalResult ? fileTopics(native.path) : [];
      const existingDetails = record.content.querySelector('.rf-file-decisions');
      if (existingDetails) existingDetails.hidden = observedReviews.get(native.path) === true;
      const sameTopics = record.topics?.length === topics.length && topics.every((topic, index) => topic === record.topics[index]);
      const showExplanations = mode !== 'full' && finalResult;
      if (record.state === file.state && record.message === file.message && sameTopics && record.showExplanations === showExplanations) continue;
      record.state = file.state;
      record.message = file.message;
      record.topics = topics;
      record.showExplanations = showExplanations;
      record.node.dataset.state = file.state;
      record.content.replaceChildren();
      if (['failed', 'cancelled', 'skipped'].includes(file.state) && file.message) record.content.append(element('p', 'rf-file-message', file.message));
      if (file.state !== 'complete' || !showExplanations || !analysis) {
        record.node.hidden = !record.content.childElementCount;
        continue;
      }
      record.node.hidden = false;
      const details = element('div', 'rf-file-decisions');
      details.hidden = observedReviews.get(native.path) === true;
      if (!locations) locations = editLocations();
      const limits = [...new Set([...locations.values()].filter(entry => entry.file.path === native.path && entry.classification?.kinds.includes('unknown')).map(entry => entry.classification.uncertainty || entry.classification.reason))];
      for (const limit of limits) {
        const notice = element('p', 'rf-uncertainty rf-kept-visible');
        notice.append(element('strong', '', 'Kept visible because evidence is incomplete: '), document.createTextNode(limit));
        details.append(notice);
      }
      const keptKinds = [...new Set([...locations.values()].filter(entry => entry.file.path === native.path).flatMap(entry => entry.classification?.kinds.filter(kind => reviewPreferences?.alwaysShow.includes(kind)) ?? []))];
      if (keptKinds.length) details.append(element('p', 'rf-kept-visible rf-caption', `Your settings keep ${keptKinds.join(', ')} edits visible.`));
      if (isProtectedPath(native.path, reviewPreferences?.protectedPaths ?? [])) details.append(element('p', 'rf-kept-visible rf-caption', 'Your protected paths keep this file visible.'));
      for (const topic of topics) details.append(renderTopic(topic, locations));
      record.content.append(details);
    }
  }

  function reviewedSnapshot() {
    return { ...snapshot, files: snapshot.files.filter(file => fileStates.get(file.path)?.state === 'complete') };
  }

  function finishFailure(message, request) {
    if (operation !== request || !isActive()) return;
    busy = false;
    pendingAction = undefined;
    error = message;
    status = 'Analysis did not finish. Check Settings or try again.';
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
    renderControls();
    controller = new AbortController();
    try {
      const captured = await capturePullRequest({ signal: controller.signal, onProgress: message => {
        if (request !== operation) return;
        status = message;
        renderControls();
      } });
      if (request !== operation || !isActive()) return;
      snapshot = captured;
      mode = 'focused';
      reviewStage = 'files';
      for (const file of snapshot.files) {
        const hasEdits = file.hunks.some(hunk => hunk.items.some(item => item.type === 'edit'));
        fileStates.set(file.path, { state: !hasEdits ? 'skipped' : isGeneratedFile(file) ? 'excluded' : 'queued' });
      }
      const connection = connectReview(request, { restoringReview, cacheOnly });
      connection.postMessage({ type: 'discard' });
      connection.postMessage({ type: 'analyze', snapshot: captured, force, cacheOnly });
    } catch (failure) {
      if (request !== operation) return;
      finishFailure(failure.message, request);
    }
  }

  function connectReview(request, { restoringReview, cacheOnly = false } = {}) {
    const connection = chrome.runtime.connect({ name: 'review-focus' });
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
        snapshot = message.snapshot;
        attempted = true;
        busy = true;
        cacheOnly = message.restoring;
        openingSavedReview = message.restoring;
        mode = 'focused';
        reviewStage = 'files';
        fileStates.clear();
        for (const file of snapshot.files) fileStates.set(file.path, { state: 'queued' });
        status = 'Reconnected to the analysis already running in this tab.';
        renderControls();
        return;
      }
      if (message.type === 'session') {
        reviewProviderName = message.provider === 'claude' ? 'Claude Code' : 'Codex';
        reviewModel = message.model;
        reviewEffort = message.effort;
        reviewPreferences = message.review;
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
      const identity = readPageIdentity(document, location.href);
      if (message.type !== 'error' && (!identity || !snapshot || `${identity.owner}/${identity.repo}/${identity.number}` !== identityKey || isDiffPage() && (identity.headSha && identity.headSha !== snapshot.headSha || identity.baseSha && identity.baseSha !== snapshot.baseSha))) {
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
          applyFolding();
          reviewStage = 'files';
        }
        status = message.state === 'failed' ? 'A file needs another attempt. Completed classifications are kept.' : 'Review decisions follow once every file is classified.';
        renderFileProgress();
        renderControls();
      } else if (message.type === 'progress') {
        if (pendingAction?.type === 'check' && message.stage === 'checking') pendingAction = undefined;
        reviewStage = message.stage;
        status = message.message;
        renderControls();
      } else if (message.type === 'settled') {
        busy = false;
        pendingAction = undefined;
        reviewStage = message.state;
        status = `${fileCounts()}. ${message.message}`;
        error = message.state === 'check-failed' ? message.message : '';
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
        folding?.restore();
        analysis = message.analysis;
        finalResult = true;
        reviewStage = 'complete';
        cacheMessage = message.cache?.restored ? `Opened saved review from ${new Date(message.cache.savedAt).toLocaleString()}. Commits, context, provider, model, effort and review preferences match. No new model calls were made.`
          : message.cache?.saved ? 'Review saved on this browser. Reopen this PR to reuse it, or run a fresh review anytime.' : message.cache?.message || '';
        cacheWarning = !message.cache?.restored && !message.cache?.saved && Boolean(message.cache?.message);
        for (const [path, file] of fileStates) {
          if (!['skipped', 'excluded'].includes(file.state)) fileStates.set(path, { ...file, state: 'complete', message: '' });
        }
        reviewGroups = buildReviewGroups();
        error = '';
        status = '';
        folding = createNativeFolding(document, reviewedSnapshot(), analysis, () => updateFoldingStatus(), revealed, reviewPreferences?.alwaysShow, reviewPreferences?.protectedPaths);
        renderAnalysis();
        renderFileProgress();
        applyFolding();
        renderControls();
      }
    });
    connection.onDisconnect.addListener(() => {
      if (request !== operation || !isActive() || port !== connection) return;
      port = undefined;
      if (busy) {
        finishFailure('The analysis connection closed. Reload this page to reconnect; completed classifications are kept.', request);
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
      if (chrome.runtime?.id) connection.disconnect();
    }
    busy = false;
    status = '';
    resumeProbe = '';
    clearReview();
  }

  function verifiedPage() {
    const identity = readPageIdentity(document, location.href);
    if (!snapshot || !identity || !isDiffPage()) return false;
    const path = new URL(snapshot.url).pathname.split('/').filter(Boolean);
    return identity.owner === path[0] && identity.repo === path[1] && String(identity.number) === path[3]
      && identity.headSha === snapshot.headSha && (!identity.baseSha || identity.baseSha === snapshot.baseSha);
  }

  function updateFoldingStatus() {
    if (!analysis || busy || !finalResult) return;
    const total = reviewedSnapshot().files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
    if (mode === 'full') {
      status = 'Full diff restored. GitHub’s review controls and viewed state are unchanged.';
    } else if (mode === 'explained') {
      status = 'All code is visible, with PRiorities explanations beside each file.';
    } else if (!verifiedPage()) {
      status = 'Assessment ready. GitHub’s visible revision could not be verified, so the native diff stays expanded.';
    } else {
      const counts = folding.counts();
      status = counts.matched
        ? `${counts.hiddenChanges} of ${total} changed lines collapsed in the loaded GitHub diff. ${counts.unmatched ? `${counts.unmatched} unrecognized rows stay visible.` : 'Expand any section to inspect its evidence.'}`
        : 'Assessment ready. Open Files changed to focus the diff. Unrecognized layouts stay expanded.';
    }
    const excluded = generatedCount();
    if (excluded) status += ` ${excluded} generated ${excluded === 1 ? 'file was' : 'files were'} skipped by AI.`;
    renderControls();
  }

  function applyFolding() {
    applyFileOrder();
    if (!folding) return;
    if (mode === 'focused' && finalResult && verifiedPage()) folding.apply();
    else folding.restore();
    updateFoldingStatus();
  }

  function setMode(next) {
    if (!isActive()) return;
    keepReadingPosition(() => {
      mode = next;
      applyFolding();
      renderFileProgress();
      renderControls();
    });
  }

  function jumpToSource(excerpt) {
    if (!isActive()) return;
    const file = findNativeFiles(document).find(entry => entry.path === excerpt.path);
    const row = file?.rows.find(entry => {
      const line = excerpt.side === 'before' ? entry.oldLine : entry.newLine;
      return line !== null && line >= excerpt.startLine && line <= excerpt.endLine
        && excerpt.rows.some(source => source.text === entry.text && (excerpt.side === 'before' ? source.oldLine === entry.oldLine : source.newLine === entry.newLine));
    });
    if (row && verifiedPage()) {
      folding?.revealRow(row.element);
      row.element.scrollIntoView({ block: 'center', behavior: 'auto' });
      row.element.classList.add('review-focus-native-target');
      setTimeout(() => row.element.classList.remove('review-focus-native-target'), 2200);
      return;
    }
    window.open(sourceLink(snapshot, excerpt), '_blank', 'noopener,noreferrer');
  }

  function renderExcerpt(excerpt) {
    const block = element('div', 'rf-excerpt');
    const heading = element('div', 'rf-excerpt-heading');
    const link = element('a', 'rf-source-link', `${excerpt.path}:${excerpt.startLine}–${excerpt.endLine} (${excerpt.side})`);
    link.href = sourceLink(snapshot, excerpt);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    heading.append(link, button('Show in diff', () => jumpToSource(excerpt), 'rf-link-button'));
    block.append(heading, renderRows(excerpt.rows));
    return block;
  }

  function renderTopic(topic, editLocations, collapsed = false) {
    const supporting = topic.priority === 'supporting';
    const card = supporting || collapsed
      ? disclosure(topic.title, `rf-topic ${supporting ? 'rf-supporting' : 'rf-review'}`)
      : element('article', 'rf-topic rf-review');
    card.dataset.topicId = topic.id;
    const body = element('div', 'rf-topic-body');
    const change = element('p', 'rf-change-explanation', topic.after);
    const reason = element('p', 'rf-reason', topic.reason);
    reason.title = supporting ? 'Why supporting' : 'Why shown';
    body.append(change, reason);
    if (topic.uncertainty) {
      const uncertainty = element('p', 'rf-uncertainty');
      uncertainty.append(element('strong', '', 'Evidence limits: '), document.createTextNode(topic.uncertainty));
      body.append(uncertainty);
    }
    const evidence = disclosure('Details', 'rf-evidence');
    let rendered = false;
    evidence.addEventListener('toggle', () => {
      if (!evidence.open || rendered) return;
      rendered = true;
      if (!supporting && !collapsed) evidence.append(element('h3', 'rf-topic-title', topic.title));
      if (topic.question) {
        const question = element('p', 'rf-question');
        question.append(element('strong', '', 'Check: '), document.createTextNode(topic.question));
        evidence.append(question);
      }
      const before = element('p', 'rf-before');
      before.append(element('strong', '', 'Before: '), document.createTextNode(topic.before));
      evidence.append(before, element('p', 'rf-evidence-summary', topic.evidenceSummary));
      for (const excerpt of topic.excerpts) evidence.append(renderExcerpt(excerpt));
      for (const id of topic.editIds) {
        const { file, edit, classification } = editLocations.get(id);
        const detail = element('div', 'rf-edit');
        detail.dataset.editId = id;
        detail.append(element('strong', '', `${file.path} · ${edit.rows.filter(row => row.type !== 'marker').length} changed lines`));
        detail.append(element('p', 'rf-change-kind', `Change type: ${classification.kinds.join(', ')}`));
        detail.append(element('p', 'rf-change-reason', classification.reason));
        if (classification.uncertainty) detail.append(element('p', 'rf-uncertainty', classification.uncertainty));
        evidence.append(detail);
      }
    });
    body.append(evidence);
    card.append(body);
    return card;
  }

  function renderAnalysis() {
    const open = result.querySelector('.rf-review-index')?.open ?? false;
    result.replaceChildren();
    const summary = element('div', 'rf-overview');
    const reviewTopics = analysis.topics.filter(topic => topic.priority === 'review');
    const supportingTopics = analysis.topics.filter(topic => topic.priority === 'supporting');
    summary.append(element('h2', 'rf-overview-title', `${reviewTopics.length} review ${reviewTopics.length === 1 ? 'decision' : 'decisions'}`));
    summary.append(element('p', 'rf-summary', analysis.summary));
    const excluded = generatedCount();
    if (excluded) summary.append(element('p', 'rf-generated-notice', `${excluded} generated ${excluded === 1 ? 'file was' : 'files were'} skipped by AI. Use Review anyway beside a file to include it.`));
    const unresolved = analysis.classifications.filter(entry => entry.kinds.includes('unknown')).length;
    if (unresolved) summary.append(element('p', 'rf-unresolved', `${unresolved} ${unresolved === 1 ? 'edit could' : 'edits could'} not be classified. Their changed lines stay visible.`));
    const index = disclosure('Review summary', 'rf-review-index');
    index.open = open;
    index.append(summary);
    index.append(element('p', 'rf-caption', 'Explanations appear beside each loaded file. This index also includes files GitHub has not loaded.'));
    const locations = editLocations();
    for (const topic of [...reviewTopics, ...supportingTopics]) {
      const entry = renderTopic(topic, locations, true);
      const paths = [...new Set(topic.editIds.map(id => locations.get(id).file.path))];
      entry.querySelector('summary').append(element('span', 'rf-index-paths', paths.join(', ')));
      index.append(entry);
    }
    if (!analysis.topics.length) index.append(element('p', 'rf-caption', 'No review decisions or supporting changes are ready yet.'));
    const details = element('div', 'rf-review-details');
    details.append(element('p', 'rf-folding-detail', status));
    if (cacheMessage) details.append(element('p', 'rf-cache-detail', cacheMessage));
    details.append(element('p', 'rf-provenance', `Analyzed ${snapshot.baseSha.slice(0, 8)}…${snapshot.headSha.slice(0, 8)} with ${reviewProviderName}${reviewModel ? ` (${reviewModel})` : ''}, effort: ${reviewEffort || 'model default'}.`));
    if (snapshot.warnings?.length) {
      details.append(element('strong', '', 'Capture limitations'));
      for (const warning of snapshot.warnings) details.append(element('p', '', warning));
    }
    index.append(details);
    result.append(index);
  }

  function mount() {
    if (!isDiffPage()) return;
    const list = document.querySelector('[data-testid="progressive-diffs-list"], .js-diff-progressive-container');
    if (list?.parentElement) {
      if (list.previousElementSibling !== host) list.before(host);
      return;
    }
    if (host.isConnected) return;
    const firstFile = findNativeFiles(document)[0]?.element;
    const anchor = firstFile?.parentElement;
    if (anchor?.parentElement && anchor !== document.body) anchor.before(host);
    else {
      const main = document.querySelector('main, [role="main"]');
      if (main) main.prepend(host);
    }
  }

  function checkPage() {
    if (!isActive()) return;
    const identity = readPageIdentity(document, location.href);
    if (!identity) {
      detachAnalysis();
      host.remove();
      attempted = false;
      identityKey = '';
      pathKey = '';
      observedReviews.clear();
      reviewControls.clear();
      missedSavedReviews.clear();
      result.replaceChildren();
      return;
    }
    const nextIdentity = `${identity.owner}/${identity.repo}/${identity.number}`;
    const nextPath = `${location.pathname}${location.search}`;
    const changedPr = identityKey && identityKey !== nextIdentity;
    const changedHead = isDiffPage() && snapshot && identity.headSha && identity.headSha !== snapshot.headSha;
    const changedBase = isDiffPage() && snapshot && identity.baseSha && identity.baseSha !== snapshot.baseSha;
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
    if (!isDiffPage()) {
      applyFileOrder(true);
      folding?.restore();
      removeFilePanels();
      host.remove();
      return;
    }
    mount();
    resumeAnalysis(identity);
    if (readReviewControls()) renderFileProgress();
    else renderFilePanels();
    applyFolding();
    renderControls();
    void refreshSavedReview();
  }

  function scheduleCheck() {
    if (!isActive()) return;
    clearTimeout(timer);
    timer = setTimeout(checkPage, 180);
  }

  function isActive() {
    if (destroyed) return false;
    if (chrome.runtime?.id) return true;
    stop();
    return false;
  }

  function stop() {
    destroyed = true;
    settingsRequest++;
    listeners.abort();
    observer.disconnect();
    clearInterval(interval);
    clearTimeout(timer);
    detachAnalysis();
    host.remove();
  }

  const observer = new MutationObserver(records => {
    const relevant = records.some(record => {
      if (record.target.nodeType === Node.ELEMENT_NODE && record.target.closest(`[${ownedAttribute}]`)) return false;
      if (record.type === 'attributes') return record.target.matches('input.js-reviewed-checkbox, button[aria-pressed]');
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType !== Node.ELEMENT_NODE || !node.hasAttribute(ownedAttribute));
    });
    if (relevant) scheduleCheck();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-label', 'aria-disabled', 'checked', 'disabled'] });
  document.addEventListener('change', event => {
    if (event.target.matches('input.js-reviewed-checkbox')) scheduleCheck();
  }, eventOptions);
  document.addEventListener('turbo:load', scheduleCheck, eventOptions);
  document.addEventListener('pjax:end', scheduleCheck, eventOptions);
  window.addEventListener('popstate', scheduleCheck, eventOptions);
  window.addEventListener('focus', refreshConnection, eventOptions);
  document.addEventListener('visibilitychange', refreshConnection, eventOptions);
  const interval = setInterval(() => {
    if (!isActive()) return;
    const identity = readPageIdentity(document, location.href);
    if (location.pathname + location.search !== pathKey || identity?.headSha !== currentIdentity?.headSha || identity?.baseSha !== currentIdentity?.baseSha || isDiffPage() && !host.isConnected) scheduleCheck();
  }, 1500);
  window.addEventListener('pagehide', event => {
    if (!isActive()) return;
    if (event.persisted) detachAnalysis();
    else stop();
  }, eventOptions);
  window.addEventListener('pageshow', scheduleCheck, eventOptions);
  loadSettings();
  checkPage();
}
