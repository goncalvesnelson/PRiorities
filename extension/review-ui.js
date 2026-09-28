import { capturePullRequest, findNativeFiles, readPageIdentity } from './github.js';
import { isGeneratedFile } from './review-data.js';

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
  const prefix = unique.every(topic => topic.priority === 'supporting') ? 'Supporting changes' : 'Additional evidence';
  return `${prefix}: ${unique.map(topic => topic.title).join('; ')}`;
}

export function createNativeFolding(doc, snapshot, analysis, onChange = () => {}, revealed = new Set()) {
  const topicsByEdit = new Map(analysis.topics.flatMap(topic => topic.editIds.map(id => [id, topic])));
  const unresolvedEdits = new Set(analysis.classifications.filter(entry => entry.kinds.includes('unknown')).map(entry => entry.editId));
  const fileRows = new Map(snapshot.files.map(file => {
    const rows = new Map();
    for (const hunk of file.hunks) {
      for (const item of hunk.items) {
        for (const row of item.type === 'edit' ? item.rows : [item]) {
          if (row.type !== 'marker') rows.set(rowKey(row), { row, topic: topicsByEdit.get(item.id), unresolved: unresolvedEdits.has(item.id) });
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

  function restore() {
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
    fold.toggle.textContent = `${expanded ? 'Collapse' : 'Show'} ${fold.rows.length} lines`;
    fold.toggle.setAttribute('aria-expanded', String(expanded));
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
    const label = element('span', 'review-focus-native-reason', topicLabel(rows.map(row => row.topic)));
    const toggle = button('', () => setExpanded(fold, !revealed.has(fold.key)), 'review-focus-native-toggle');
    const fold = { key: JSON.stringify([path, rowKey(rows[0]), rowKey(rows.at(-1))]), marker, toggle, rows, changed: rows.filter(row => row.type !== 'context').length };
    body.append(toggle, label);
    container.append(body);
    marker.append(container);
    first.before(marker);
    folds.push(fold);
    setExpanded(fold, revealed.has(fold.key));
  }

  function apply() {
    restore();
    matched = 0;
    unmatched = 0;
    for (const file of findNativeFiles(doc)) {
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
        const hasDiscussion = row.element.querySelector('form, textarea, .review-thread-component, .js-comment-container');
        if (!match || !supported || elementCounts.get(row.element) !== 1 || hasDiscussion) {
          unmatched++;
          flush();
          continue;
        }
        matched++;
        if (match.unresolved || rowSelected(match.row, excerpts)) {
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
  if (document.querySelector('#review-focus-extension')) return;
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
  let busy = false;
  let mode = 'focused';
  let identityKey = '';
  let pathKey = '';
  let currentIdentity;
  let configured = false;
  let model = '';
  let status = '';
  let error = '';
  let timer;
  let destroyed = false;
  const fileStates = new Map();
  const filePanels = new Map();
  const revealed = new Set();
  let finalResult = false;
  let reviewStage = '';
  let attempted = false;
  let providerName = 'selected CLI';
  let reviewProviderName = '';
  let reviewModel = '';
  let savedReview;
  let cacheMessage = '';
  let cacheProbe = '';
  let cacheProbeVersion = 0;
  let fileFilter = 'all';

  const header = element('div', 'rf-toolbar');
  const brand = element('strong', 'rf-brand', 'PRiorities');
  const buttons = element('div', 'rf-actions');
  const analyze = button('Analyze PR', () => analyzePullRequest({ cacheOnly: Boolean(savedReview && !analysis), force: attempted && !savedReview }), 'rf-primary rf-analyze');
  const freshReview = button('Run fresh review', () => analyzePullRequest({ force: true }));
  const cancel = button('Cancel', () => cancelAnalysis());
  const settings = button('Settings', () => openSettings());
  const focused = button('Focused review', () => setMode('focused'));
  const full = button('Full diff', () => setMode('full'));
  const retryFinal = button('Retry cross-file check', () => retryReview());
  retryFinal.hidden = true;
  cancel.hidden = true;
  focused.hidden = true;
  full.hidden = true;
  buttons.append(focused, full, analyze, freshReview, cancel, retryFinal, settings);
  header.append(brand, buttons);
  const statusNode = element('p', 'rf-status');
  statusNode.setAttribute('role', 'status');
  statusNode.setAttribute('aria-live', 'polite');
  const errorNode = element('p', 'rf-error');
  errorNode.setAttribute('role', 'alert');
  const result = element('div', 'rf-result');
  const welcome = element('p', 'rf-welcome', 'Start with the changes that need a decision. Generated files are skipped, and every line stays accessible.');
  const progressPanel = element('div', 'rf-progress-panel');
  const phase = element('strong', 'rf-phase');
  const progressDetail = element('span', 'rf-progress-detail');
  const progressHeading = element('div', 'rf-progress-heading');
  progressHeading.append(phase, progressDetail);
  const progressBar = element('progress', 'rf-progress-bar');
  progressBar.setAttribute('aria-label', 'File reviews complete');
  const stages = element('ol', 'rf-stages');
  for (const label of ['Read PR', 'Review files', 'Check related changes']) stages.append(element('li', '', label));
  progressPanel.append(progressHeading, progressBar, stages);
  const cacheNotice = element('p', 'rf-cache-notice');
  const fileProgress = disclosure('File progress', 'rf-file-progress');
  fileProgress.hidden = true;
  panel.append(header, welcome, progressPanel, statusNode, cacheNotice, errorNode, fileProgress, result);

  function renderControls() {
    analyze.disabled = busy;
    analyze.textContent = savedReview && !analysis ? 'Open saved review' : attempted ? 'Run fresh review' : 'Analyze PR';
    analyze.classList.toggle('rf-primary', !analysis);
    freshReview.hidden = busy || !savedReview || Boolean(analysis);
    cancel.hidden = !busy;
    focused.hidden = !analysis;
    full.hidden = !analysis;
    retryFinal.hidden = busy || !port || !['check-failed', 'cancelled'].includes(reviewStage) || [...fileStates.values()].some(file => !['complete', 'skipped', 'excluded'].includes(file.state)) || !analysis;
    focused.setAttribute('aria-pressed', String(mode === 'focused'));
    full.setAttribute('aria-pressed', String(mode === 'full'));
    errorNode.hidden = !error;
    errorNode.textContent = error;
    welcome.hidden = busy || Boolean(analysis) || fileStates.size > 0;
    progressPanel.hidden = !busy;
    const states = [...fileStates.values()];
    const total = states.filter(file => !['skipped', 'excluded'].includes(file.state)).length;
    const complete = states.filter(file => file.state === 'complete').length;
    const stage = !snapshot ? 0 : reviewStage === 'checking' ? 2 : 1;
    phase.textContent = ['Reading this pull request', 'Reviewing files', 'Checking related changes'][stage];
    progressDetail.textContent = stage === 1 ? `${complete} of ${total} files ready` : stage === 2 ? 'File reviews are ready to read below' : reviewStage === 'restoring' ? 'Checking the saved review against the current context' : 'Capturing the complete diff and context';
    if (stage === 1 && total) { progressBar.max = total; progressBar.value = complete; }
    else progressBar.removeAttribute('value');
    [...stages.children].forEach((step, index) => { step.dataset.state = index === stage ? 'current' : index < stage ? 'complete' : 'pending'; });
    cacheNotice.hidden = !cacheMessage && !savedReview;
    cacheNotice.textContent = cacheMessage || (savedReview ? `Saved review available from ${new Date(savedReview.savedAt).toLocaleString()}. Open it to verify the current context and reuse the results without a new model call.` : '');
    if (busy || status) statusNode.textContent = status;
    else if (!configured) statusNode.textContent = `Connect your local ${providerName} helper in Settings, then analyze this PR.`;
    else statusNode.textContent = `Ready to analyze this PR with ${providerName}${model ? ` (${model})` : ''}. Analysis starts only when you click Analyze PR.`;
    const split = [...document.querySelectorAll('table[data-diff-anchor] tr.diff-line-row')].some(row => row.querySelectorAll('.diff-text').length > 1);
    if (analysis && mode === 'focused' && split) statusNode.textContent += ' GitHub is in split view. Choose Unified in its diff view settings to collapse lines.';
    result.hidden = mode === 'full';
  }

  async function loadSettings() {
    try {
      const settings = await chrome.runtime.sendMessage({ type: 'get-settings' });
      if (settings?.error) throw new Error(settings.error);
      if (!['codex', 'claude'].includes(settings?.provider)) throw new Error('Reload PRiorities in chrome://extensions, then refresh this PR. The background worker has not updated to local CLI support.');
      providerName = settings.provider === 'claude' ? 'Claude Code' : 'Codex';
      configured = Boolean(settings?.configured);
      model = settings?.model ?? '';
      void refreshSavedReview(true);
      renderControls();
    } catch (failure) {
      configured = false;
      model = '';
      error = `The extension could not read its settings. Reload this page after reloading the extension. ${failure.message}`;
      renderControls();
    }
  }

  async function refreshSavedReview(force = false) {
    if (busy || analysis) return;
    const identity = readPageIdentity(document, location.href);
    if (!identity?.headSha || !identity.baseSha) return;
    const key = JSON.stringify([identity.owner, identity.repo, identity.number, identity.baseSha, identity.headSha, providerName, model]);
    if (!force && key === cacheProbe) return;
    cacheProbe = key;
    const version = ++cacheProbeVersion;
    try {
      const cached = await chrome.runtime.sendMessage({ type: 'peek-review', baseSha: identity.baseSha, headSha: identity.headSha });
      if (version !== cacheProbeVersion || busy || analysis) return;
      savedReview = cached?.available ? cached : undefined;
      renderControls();
    } catch {}
  }

  async function openSettings() {
    try {
      const settings = await chrome.runtime.sendMessage({ type: 'open-settings' });
      if (settings?.error) throw new Error(settings.error);
    } catch (failure) {
      error = `Settings could not open. Open PRiorities from Chrome’s extensions menu. ${failure.message}`;
      renderControls();
    }
  }

  function cancelAnalysis(message = 'Analysis cancelled. Completed file reviews remain available.', close = false) {
    if (port && !close) {
      status = 'Stopping active file reviews…';
      renderControls();
      port.postMessage({ type: 'cancel' });
      return;
    }
    operation++;
    controller?.abort();
    controller = undefined;
    if (port) {
      try { port.postMessage({ type: 'cancel' }); } catch { /* A disconnected worker has already stopped the request. */ }
      port.disconnect();
      port = undefined;
    }
    busy = false;
    status = message;
    renderControls();
  }

  function clearReview() {
    folding?.restore();
    folding = undefined;
    snapshot = undefined;
    analysis = undefined;
    finalResult = false;
    reviewStage = '';
    savedReview = undefined;
    cacheMessage = '';
    cacheProbe = '';
    cacheProbeVersion++;
    fileFilter = 'all';
    fileStates.clear();
    revealed.clear();
    for (const { node } of filePanels.values()) node.remove();
    filePanels.clear();
    fileProgress.hidden = true;
    result.replaceChildren();
  }

  function retryReview(path) {
    if (!port || !verifiedPage()) return;
    busy = true;
    error = '';
    reviewStage = path ? 'files' : 'checking';
    status = path ? `Retrying ${path}…` : 'Checking relationships across files…';
    port.postMessage(path ? { type: 'retry-file', path } : { type: 'retry-final' });
    renderControls();
  }

  function reviewGeneratedFile(path) {
    if (!port || !verifiedPage() || fileStates.get(path)?.state !== 'excluded') return;
    fileStates.set(path, { state: 'queued', message: 'Queued by your request.' });
    cacheMessage = '';
    fileFilter = 'all';
    busy = true;
    finalResult = false;
    error = '';
    reviewStage = 'files';
    status = `Reviewing ${path}…`;
    port.postMessage({ type: 'review-file', path });
    if (analysis) renderAnalysis();
    renderFileProgress();
    renderControls();
  }

  function generatedCount() {
    return [...fileStates.values()].filter(file => file.state === 'excluded').length;
  }

  function fileLabel(file) {
    return { queued: 'Waiting', classifying: 'Reading changes', prioritizing: 'Choosing review focus', complete: finalResult ? 'Review ready' : 'Ready · cross-file check pending', failed: 'Needs retry', cancelled: 'Cancelled', skipped: 'No text changes to analyze', excluded: 'Generated · not reviewed' }[file.state];
  }

  function fileTopics(path) {
    if (!analysis) return [];
    const file = snapshot.files.find(entry => entry.path === path);
    const ids = new Set(file.hunks.flatMap(hunk => hunk.items.filter(item => item.type === 'edit').map(item => item.id)));
    return analysis.topics.filter(topic => topic.editIds.some(id => ids.has(id)));
  }

  function fileCounts() {
    const states = [...fileStates.values()];
    const total = states.filter(file => !['skipped', 'excluded'].includes(file.state)).length;
    const complete = states.filter(file => file.state === 'complete').length;
    const active = states.filter(file => ['classifying', 'prioritizing'].includes(file.state)).length;
    const failed = states.filter(file => file.state === 'failed').length;
    const excluded = generatedCount();
    return `${complete} of ${total} file reviews ready${active ? ` · ${active} running` : ''}${failed ? ` · ${failed} failed` : ''}${excluded ? ` · ${excluded} generated ${excluded === 1 ? 'file' : 'files'} not reviewed` : ''}`;
  }

  function renderFileProgress() {
    const focusedFilter = shadow.activeElement?.closest('.rf-file-filters') ? shadow.activeElement.textContent : null;
    fileProgress.hidden = !fileStates.size;
    fileProgress.querySelector('summary').textContent = fileCounts();
    for (const child of [...fileProgress.children].slice(1)) child.remove();
    const filters = element('div', 'rf-file-filters');
    for (const [value, label] of [['all', 'All files'], ['attention', 'Needs attention'], ['ready', 'Ready'], ['skipped', 'Skipped']]) {
      const filter = button(label, () => { fileFilter = value; renderFileProgress(); });
      filter.setAttribute('aria-pressed', String(fileFilter === value));
      filters.append(filter);
    }
    fileProgress.append(filters);
    const rows = element('div', 'rf-file-list');
    for (const [path, file] of fileStates) {
      if (fileFilter === 'ready' && file.state !== 'complete') continue;
      if (fileFilter === 'skipped' && !['excluded', 'skipped'].includes(file.state)) continue;
      if (fileFilter === 'attention' && !['failed', 'cancelled'].includes(file.state) && !fileTopics(path).some(topic => topic.priority === 'review')) continue;
      const row = element('div', 'rf-file-progress-row');
      row.dataset.state = file.state;
      row.append(button(path, () => {
        const native = findNativeFiles(document).find(entry => entry.path === path);
        native?.element.scrollIntoView({ block: 'start', behavior: 'auto' });
      }, 'rf-file-path'), element('span', '', fileLabel(file)));
      if (['failed', 'cancelled'].includes(file.state) && port) row.append(button('Retry file', () => retryReview(path)));
      if (file.state === 'excluded' && port) row.append(button('Review anyway', () => reviewGeneratedFile(path)));
      if (['failed', 'cancelled'].includes(file.state) && file.message) row.append(element('span', 'rf-caption', file.message));
      rows.append(row);
    }
    if (!rows.childElementCount) rows.append(element('p', 'rf-caption', 'No files in this view.'));
    fileProgress.append(rows);
    if (focusedFilter) [...filters.children].find(filter => filter.textContent === focusedFilter)?.focus({ preventScroll: true });
    renderFilePanels();
  }

  function editLocations() {
    const classifications = new Map(analysis.classifications.map(entry => [entry.editId, entry]));
    return new Map(snapshot.files.flatMap(file => file.hunks.flatMap(hunk => hunk.items.filter(item => item.type === 'edit').map(edit => [edit.id, { file, edit, classification: classifications.get(edit.id) }]))));
  }

  function renderFilePanels() {
    for (const [container, record] of filePanels) {
      if (container.isConnected && record.node.isConnected) continue;
      record.node.remove();
      filePanels.delete(container);
    }
    for (const native of findNativeFiles(document)) {
      const file = fileStates.get(native.path);
      if (!file) continue;
      let record = filePanels.get(native.element);
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
        const header = native.element.querySelector('.file-header, [class*="diff-file-header"]');
        if (header) header.after(node);
        else if (native.element.tagName === 'TABLE') native.element.before(node);
        else native.element.prepend(node);
        record = { node, content };
        filePanels.set(native.element, record);
      }
      if (record.file === file && record.final === finalResult && record.mode === mode && record.connected === Boolean(port)) continue;
      record.file = file;
      record.final = finalResult;
      record.mode = mode;
      record.connected = Boolean(port);
      record.node.dataset.state = file.state;
      record.content.replaceChildren();
      const heading = element('div', 'rf-file-heading');
      heading.append(element('strong', '', 'PRiorities'), element('span', 'rf-file-state', fileLabel(file)));
      if (['failed', 'cancelled'].includes(file.state) && port) heading.append(button('Retry file', () => retryReview(native.path)));
      if (file.state === 'excluded' && port) heading.append(button('Review anyway', () => reviewGeneratedFile(native.path)));
      record.content.append(heading);
      if (['failed', 'cancelled', 'skipped'].includes(file.state) && file.message) record.content.append(element('p', 'rf-file-message', file.message));
      if (file.state !== 'complete' || mode === 'full' || !analysis) continue;
      const topics = fileTopics(native.path);
      const count = topics.filter(topic => topic.priority === 'review').length;
      const details = disclosure(count ? `${count} review ${count === 1 ? 'decision' : 'decisions'} in this file` : 'Supporting changes · see why');
      details.className = 'rf-file-decisions';
      details.open = Boolean(count);
      if (!finalResult) details.append(element('p', 'rf-caption', 'Initial file review. The cross-file check may revise these decisions.'));
      for (const topic of topics) details.append(renderTopic(topic, editLocations(), true));
      record.content.append(details);
    }
  }

  function applyFileResults() {
    const complete = [...fileStates.entries()].filter(([, file]) => file.state === 'complete');
    if (!complete.length) return;
    const previous = analysis ?? { topics: [], classifications: [] };
    const allocated = new Set(previous.classifications.map(entry => entry.editId));
    const added = complete.filter(([, file]) => file.analysis?.classifications.some(entry => !allocated.has(entry.editId)));
    analysis = {
      summary: 'Completed file reviews appear beside their diffs. The final check will connect related changes across files.',
      topics: [...previous.topics, ...added.flatMap(([path, file]) => file.analysis.topics.map(topic => ({ ...topic, id: `${path}:${topic.id}` })))],
      classifications: [...previous.classifications, ...added.flatMap(([, file]) => file.analysis.classifications)]
    };
    folding?.restore();
    folding = createNativeFolding(document, reviewedSnapshot(), analysis, () => updateFoldingStatus(), revealed);
    result.replaceChildren(element('p', 'rf-provenance', 'Review completed files as they arrive. Pending and failed files stay expanded; the cross-file check may revise the focus.'));
    applyFolding();
  }

  function reviewedSnapshot() {
    return { ...snapshot, files: snapshot.files.filter(file => fileStates.get(file.path)?.state === 'complete') };
  }

  function finishFailure(message, request) {
    if (operation !== request) return;
    busy = false;
    error = message;
    status = 'Analysis did not finish. Check Settings or try again.';
    controller = undefined;
    if (port) { port.disconnect(); port = undefined; }
    for (const [path, file] of fileStates) {
      if (['queued', 'classifying', 'prioritizing'].includes(file.state)) fileStates.set(path, { state: 'failed', message: 'The analysis connection closed. Analyze again to restart.' });
    }
    renderFileProgress();
    renderControls();
  }

  async function analyzePullRequest({ force = false, cacheOnly = false } = {}) {
    if (busy) return;
    cancelAnalysis('', true);
    clearReview();
    const request = ++operation;
    busy = true;
    status = 'Checking analysis settings…';
    renderControls();
    await loadSettings();
    if (request !== operation) return;
    if (!configured && !cacheOnly) {
      busy = false;
      error = `Connect ${providerName} in Settings first.`;
      renderControls();
      await openSettings();
      return;
    }
    attempted = true;
    reviewProviderName = providerName;
    reviewModel = model;
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
      if (request !== operation) return;
      snapshot = captured;
      mode = 'focused';
      reviewStage = 'files';
      for (const file of snapshot.files) {
        const hasEdits = file.hunks.some(hunk => hunk.items.some(item => item.type === 'edit'));
        fileStates.set(file.path, { state: !hasEdits ? 'skipped' : isGeneratedFile(file) ? 'excluded' : 'queued' });
      }
      const connection = chrome.runtime.connect({ name: 'review-focus' });
      port = connection;
      renderFileProgress();
      connection.onMessage.addListener(message => {
        if (request !== operation) return;
        if (message.type === 'heartbeat') return;
        if (message.type === 'session') {
          reviewProviderName = message.provider === 'claude' ? 'Claude Code' : 'Codex';
          reviewModel = message.model;
          return;
        }
        if (message.type === 'cache-miss') {
          cancelAnalysis('The saved review no longer matches the current PR context. Run a fresh review to continue.', true);
          clearReview();
          renderControls();
          return;
        }
        const identity = readPageIdentity(document, location.href);
        if (!identity || `${identity.owner}/${identity.repo}/${identity.number}` !== identityKey || identity.headSha && identity.headSha !== snapshot.headSha || identity.baseSha && identity.baseSha !== snapshot.baseSha) {
          checkPage();
          return;
        }
        if (message.type === 'file-progress') {
          if (!fileStates.has(message.path)) return;
          fileStates.set(message.path, message);
          if (['queued', 'classifying', 'prioritizing'].includes(message.state)) {
            busy = true;
            finalResult = false;
            reviewStage = 'files';
          }
          if (message.state === 'complete') applyFileResults();
          status = message.state === 'failed' ? 'A file needs another attempt. Completed reviews remain available.' : 'Open a ready file to start reviewing while the others finish.';
          renderFileProgress();
          renderControls();
        } else if (message.type === 'progress') {
          reviewStage = message.stage;
          status = message.message;
          renderControls();
        } else if (message.type === 'settled') {
          busy = false;
          reviewStage = message.state;
          status = `${fileCounts()}. ${message.message}`;
          error = message.state === 'check-failed' ? message.message : '';
          renderFileProgress();
          renderControls();
        } else if (message.type === 'error') {
          finishFailure(message.message, request);
        } else if (message.type === 'result') {
          busy = false;
          controller = undefined;
          folding?.restore();
          snapshot = captured;
          analysis = message.analysis;
          finalResult = true;
          reviewStage = 'complete';
          cacheMessage = message.cache?.restored ? `Opened saved review from ${new Date(message.cache.savedAt).toLocaleString()}. Commits, context, provider and model match. No new model calls were made.`
            : message.cache?.saved ? 'Review saved on this browser. Reopen this PR to reuse it, or run a fresh review anytime.' : message.cache?.message || '';
          for (const [path, file] of fileStates) {
            if (!['skipped', 'excluded'].includes(file.state)) fileStates.set(path, { ...file, state: 'complete', message: '' });
          }
          error = '';
          status = '';
          folding = createNativeFolding(document, reviewedSnapshot(), analysis, () => updateFoldingStatus(), revealed);
          renderAnalysis();
          renderFileProgress();
          applyFolding();
          renderControls();
        }
      });
      connection.onDisconnect.addListener(() => {
        if (request !== operation) return;
        port = undefined;
        if (busy) {
          finishFailure('The analysis connection closed before the review finished. Completed files remain available. Analyze again to restart.', request);
          return;
        }
        if (!finalResult) status = 'The analysis session closed. Completed files remain available. Analyze again to restart.';
        renderFileProgress();
        renderControls();
      });
      connection.postMessage({ type: 'analyze', snapshot: captured, force, cacheOnly });
    } catch (failure) {
      if (request !== operation) return;
      finishFailure(failure.message, request);
    }
  }

  function verifiedPage() {
    const identity = readPageIdentity(document, location.href);
    if (!snapshot || !identity) return false;
    const path = new URL(snapshot.url).pathname.split('/').filter(Boolean);
    return identity.owner === path[0] && identity.repo === path[1] && String(identity.number) === path[3]
      && identity.headSha === snapshot.headSha && (!identity.baseSha || identity.baseSha === snapshot.baseSha);
  }

  function updateFoldingStatus() {
    if (!analysis || busy || !finalResult) return;
    const total = reviewedSnapshot().files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
    if (mode === 'full') {
      status = 'Full diff restored. GitHub’s review controls and viewed state are unchanged.';
    } else if (!verifiedPage()) {
      status = 'Assessment ready. GitHub’s visible revision could not be verified, so the native diff stays expanded.';
    } else {
      const counts = folding.counts();
      status = counts.matched
        ? `${counts.hiddenChanges} of ${total} changed lines collapsed in the loaded GitHub diff. ${counts.unmatched ? `${counts.unmatched} unrecognized rows stay visible.` : 'Expand any section to inspect its evidence.'}`
        : 'Assessment ready. Open Files changed to focus the diff. Unrecognized layouts stay expanded.';
    }
    const excluded = generatedCount();
    if (excluded) status += ` ${excluded} generated ${excluded === 1 ? 'file was' : 'files were'} not reviewed.`;
    renderControls();
  }

  function applyFolding() {
    if (!folding) return;
    folding.restore();
    if (mode === 'focused' && verifiedPage()) folding.apply();
    updateFoldingStatus();
  }

  function setMode(next) {
    mode = next;
    applyFolding();
    renderFilePanels();
    renderControls();
  }

  function jumpToSource(excerpt) {
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
      ? disclosure(topic.title, `rf-topic ${supporting ? 'rf-supporting' : 'rf-review rf-more-review'}`)
      : element('article', 'rf-topic rf-review');
    card.dataset.topicId = topic.id;
    if (!supporting && !collapsed) card.append(element('h3', 'rf-topic-title', topic.title));
    const body = element('div', 'rf-topic-body');
    body.append(element('p', 'rf-reason', topic.reason));
    const flow = element('dl', 'rf-before-after');
    flow.append(element('dt', '', 'Before'), element('dd', '', topic.before));
    flow.append(element('dt', '', 'After'), element('dd', '', topic.after));
    body.append(flow);
    if (topic.question) body.append(element('p', 'rf-question', topic.question));
    if (topic.uncertainty) {
      const uncertainty = element('p', 'rf-uncertainty');
      uncertainty.append(element('strong', '', 'Evidence limits: '), document.createTextNode(topic.uncertainty));
      body.append(uncertainty);
    }
    for (const excerpt of topic.excerpts) body.append(renderExcerpt(excerpt));
    const evidence = disclosure(`Supporting evidence · ${topic.editIds.length} edits · ${topic.changedLines} changed lines`, 'rf-evidence');
    evidence.append(element('p', 'rf-evidence-summary', topic.evidenceSummary));
    for (const id of topic.editIds) {
      const { file, edit, classification } = editLocations.get(id);
      const detail = disclosure(`${file.path} · ${edit.rows.filter(row => row.type !== 'marker').length} changed lines`, 'rf-edit');
      detail.dataset.editId = id;
      let rendered = false;
      detail.addEventListener('toggle', () => {
        if (!detail.open || rendered) return;
        rendered = true;
        detail.append(element('p', 'rf-change-kind', `Change type: ${classification.kinds.join(', ')}`));
        detail.append(element('p', 'rf-change-reason', classification.reason));
        if (classification.uncertainty) detail.append(element('p', 'rf-uncertainty', classification.uncertainty));
        detail.append(renderRows(edit.rows));
      });
      evidence.append(detail);
    }
    body.append(evidence);
    card.append(body);
    return card;
  }

  function renderAnalysis() {
    result.replaceChildren();
    const summary = element('div', 'rf-overview');
    const reviewTopics = analysis.topics.filter(topic => topic.priority === 'review');
    const supportingTopics = analysis.topics.filter(topic => topic.priority === 'supporting');
    const initialTopics = reviewTopics.slice(0, 4);
    const moreTopics = reviewTopics.slice(4);
    const lines = initialTopics.flatMap(topic => topic.excerpts).reduce((sum, excerpt) => sum + excerpt.rows.length, 0);
    summary.append(element('h2', 'rf-overview-title', `${reviewTopics.length} review ${reviewTopics.length === 1 ? 'decision' : 'decisions'}`));
    summary.append(element('p', '', analysis.summary));
    const excluded = generatedCount();
    if (excluded) summary.append(element('p', 'rf-generated-notice', `${excluded} generated ${excluded === 1 ? 'file was' : 'files were'} not reviewed. Use Review anyway beside a file or in File progress to include it.`));
    if (!finalResult) summary.append(element('p', 'rf-caption', 'The review scope has changed. Existing decisions remain available while the additional file and cross-file check run.'));
    const attention = moreTopics.length
      ? `Start with ${initialTopics.length} decisions and ${lines} source lines. ${moreTopics.length} more review ${moreTopics.length === 1 ? 'decision follows' : 'decisions follow'} below.`
      : `${lines} source lines in selected excerpts.`;
    summary.append(element('p', 'rf-caption', `${attention} Model judgment; collapsed changes still need your discretion.`));
    const unresolved = analysis.classifications.filter(entry => entry.kinds.includes('unknown')).length;
    if (unresolved) summary.append(element('p', 'rf-unresolved', `${unresolved} ${unresolved === 1 ? 'edit could' : 'edits could'} not be classified. Their changed lines stay visible in the GitHub diff.`));
    result.append(summary);
    const locations = editLocations();
    if (!reviewTopics.length) result.append(element('p', 'rf-empty', 'No foreground review decisions were selected. Inspect the supporting changes below.'));
    for (const topic of initialTopics) result.append(renderTopic(topic, locations));
    if (moreTopics.length) {
      const more = element('section', 'rf-more-review-section');
      more.append(element('h3', 'rf-more-review-title', `More review decisions (${moreTopics.length})`));
      for (const topic of moreTopics) more.append(renderTopic(topic, locations, true));
      result.append(more);
    }
    if (supportingTopics.length) {
      const supporting = element('section', 'rf-supporting-section');
      supporting.append(element('h3', 'rf-supporting-title', `Supporting changes (${supportingTopics.length})`));
      for (const topic of supportingTopics) supporting.append(renderTopic(topic, locations));
      result.append(supporting);
    }
    if (snapshot.warnings?.length) {
      const warnings = disclosure('Capture limitations', 'rf-capture-warnings');
      for (const warning of snapshot.warnings) warnings.append(element('p', '', warning));
      result.append(warnings);
    }
    result.append(element('p', 'rf-provenance', `Reviewed ${snapshot.headSha.slice(0, 8)} with ${reviewProviderName}${reviewModel ? ` (${reviewModel})` : ''}. No review comments or approvals are posted.`));
  }

  function mount() {
    if (host.isConnected) return;
    const firstFile = findNativeFiles(document)[0]?.element;
    const anchor = firstFile?.closest('.js-diff-progressive-container') ?? firstFile?.parentElement;
    if (anchor?.parentElement && anchor !== document.body) anchor.before(host);
    else {
      const main = document.querySelector('main, [role="main"]');
      if (main) main.prepend(host);
    }
  }

  function checkPage() {
    if (destroyed) return;
    const identity = readPageIdentity(document, location.href);
    if (!identity) {
      cancelAnalysis('Analysis cancelled because you left the pull request.', true);
      clearReview();
      host.remove();
      attempted = false;
      identityKey = '';
      pathKey = '';
      result.replaceChildren();
      return;
    }
    const nextIdentity = `${identity.owner}/${identity.repo}/${identity.number}`;
    const nextPath = `${location.pathname}${location.search}`;
    const changedPr = identityKey && identityKey !== nextIdentity;
    const changedHead = snapshot && identity.headSha && identity.headSha !== snapshot.headSha;
    const changedBase = snapshot && identity.baseSha && identity.baseSha !== snapshot.baseSha;
    if (changedPr || changedHead || changedBase) {
      cancelAnalysis('Analysis cancelled because the pull request changed.', true);
      clearReview();
      attempted = false;
      status = changedPr ? '' : 'The PR revision changed. Analyze again before focusing this diff.';
      error = '';
    } else if (busy && !snapshot && pathKey && nextPath !== pathKey) {
      cancelAnalysis('Navigation cancelled capture. Analyze again on this page.', true);
    }
    currentIdentity = identity;
    identityKey = nextIdentity;
    pathKey = nextPath;
    mount();
    renderFilePanels();
    applyFolding();
    renderControls();
    void refreshSavedReview();
  }

  function scheduleCheck() {
    clearTimeout(timer);
    timer = setTimeout(checkPage, 180);
  }

  const observer = new MutationObserver(records => {
    const relevant = records.some(record => {
      if (record.target.nodeType === Node.ELEMENT_NODE && record.target.closest(`[${ownedAttribute}]`)) return false;
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType !== Node.ELEMENT_NODE || !node.hasAttribute(ownedAttribute));
    });
    if (relevant) scheduleCheck();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('turbo:load', scheduleCheck);
  document.addEventListener('pjax:end', scheduleCheck);
  window.addEventListener('popstate', scheduleCheck);
  window.addEventListener('focus', loadSettings);
  const interval = setInterval(() => {
    const identity = readPageIdentity(document, location.href);
    if (location.pathname + location.search !== pathKey || identity?.headSha !== currentIdentity?.headSha || !host.isConnected) scheduleCheck();
  }, 1500);
  window.addEventListener('pagehide', event => {
    if (event.persisted) {
      cancelAnalysis('Analysis cancelled because you left the page.', true);
      folding?.restore();
      return;
    }
    destroyed = true;
    observer.disconnect();
    clearInterval(interval);
    clearTimeout(timer);
    cancelAnalysis('', true);
    folding?.restore();
  }, { once: true });
  window.addEventListener('pageshow', scheduleCheck);
  loadSettings();
  checkPage();
}
