import { capturePullRequest, findNativeFiles, readPageIdentity } from './github.js';
import { isGeneratedFile } from './review-data.js';
import { isProtectedPath } from './review-preferences.js';

const surfaceHiddenClass = 'review-focus-native-surface-hidden';
const ownedAttribute = 'data-review-focus-owned';
const readyMark = '✓ Ready · ';
const attentionMark = '⚠ Needs attention · ';
const titleMarks = /^(?:✓ Ready|⚠ Needs attention) ·\s*/;
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

function disclosure(label, className = '') {
  const node = element('details', className);
  node.append(element('summary', '', label));
  return node;
}

function appendInline(parent, text) {
  let index = 0;
  for (const match of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g)) {
    parent.append(text.slice(index, match.index));
    if (match[1] === undefined) parent.append(appendInline(element('strong'), match[2]));
    else parent.append(element('code', '', match[1]));
    index = match.index + match[0].length;
  }
  parent.append(text.slice(index));
  return parent;
}

function richText(tag, className, text) {
  const node = element(tag, `rf-rich ${className}`.trim());
  let block;
  for (const line of text.trim().split('\n')) {
    const item = /^\s*[-*]\s+(.*)/.exec(line);
    if (!line.trim()) block = undefined;
    else if (item) {
      if (block?.tagName !== 'UL') node.append(block = element('ul'));
      block.append(appendInline(element('li'), item[1].trim()));
    } else {
      if (block?.tagName === 'P') block.append(element('br'));
      else node.append(block = element('p'));
      appendInline(block, line.trim());
    }
  }
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

// Notes attach at the start of a changed block so removals and additions stay together.
function noteAnchors(rows, excerpts) {
  const blockEdge = (index, step) => {
    while (rows[index].editId && rows[index + step]?.editId === rows[index].editId) index += step;
    return index;
  };
  const spans = excerpts.map(excerpt => ({ excerpt, first: rows.findIndex(row => rowSelected(row, [excerpt])), last: rows.findLastIndex(row => rowSelected(row, [excerpt])) }))
    .filter(span => span.first >= 0)
    .map(span => ({ ...span, first: blockEdge(span.first, -1), last: blockEdge(span.last, 1) }))
    .sort((a, b) => a.first - b.first);
  const anchors = new Map();
  let run;
  for (const span of spans) {
    if (run && span.first <= run.last) {
      run.last = Math.max(run.last, span.last);
      run.excerpts.push(span.excerpt);
      continue;
    }
    run = { last: span.last, excerpts: [span.excerpt] };
    anchors.set(rows[span.first], run.excerpts);
  }
  for (const notes of anchors.values()) notes.sort((a, b) => excerpts.indexOf(a) - excerpts.indexOf(b));
  return anchors;
}

function guideFileRows(snapshot, file) {
  const sources = ['before', 'after'].map(side => {
    const source = snapshot.context.find(entry => entry.path === file.path && entry.side === side);
    if (!source) return null;
    const lines = source.text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
  });
  const [before, after] = sources;
  const rows = [];
  let oldLine = 1;
  let newLine = 1;
  function contextUntil(oldEnd, newEnd) {
    const count = oldEnd - oldLine;
    if (count !== newEnd - newLine || count < 0) throw new Error('Captured source does not align with this diff. Open Full diff to inspect the file.');
    if (count && !before && !after) {
      rows.push({ type: 'marker', text: '… Source between these ranges was not captured …', oldLine: null, newLine: null });
      oldLine = oldEnd;
      newLine = newEnd;
      return;
    }
    while (oldLine < oldEnd) {
      const oldText = before?.[oldLine - 1];
      const newText = after?.[newLine - 1];
      if (oldText === undefined && newText === undefined || oldText !== undefined && newText !== undefined && oldText !== newText) throw new Error('Captured source does not align with this diff. Open Full diff to inspect the file.');
      rows.push({ type: 'context', text: oldText ?? newText, oldLine: oldText === undefined ? null : oldLine, newLine: newText === undefined ? null : newLine, outsideDiff: true });
      oldLine++;
      newLine++;
    }
  }
  for (const hunk of file.hunks) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header);
    if (!match) throw new Error('The captured hunk has no line range. Open Full diff to inspect the file.');
    contextUntil(Number(match[1]) + (match[2] === '0' ? 1 : 0), Number(match[3]) + (match[4] === '0' ? 1 : 0));
    rows.push({ type: 'marker', text: hunk.header, oldLine: null, newLine: null });
    for (const item of hunk.items) {
      for (const row of item.type === 'edit' ? item.rows : [item]) {
        rows.push({ ...row, ...(item.type === 'edit' ? { editId: item.id } : {}) });
        if (row.oldLine !== null) oldLine = row.oldLine + 1;
        if (row.newLine !== null) newLine = row.newLine + 1;
      }
    }
  }
  const remaining = before ? before.length + 1 - oldLine : after ? after.length + 1 - newLine : 0;
  if (remaining > 0) contextUntil(oldLine + remaining, newLine + remaining);
  return rows;
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

function codeText(row, sides) {
  const cell = element('td', 'rf-code-text');
  const tokens = sides?.after[row.newLine] ?? sides?.before[row.oldLine];
  if (tokens?.map(([text]) => text).join('') !== row.text) {
    cell.textContent = row.text;
    return cell;
  }
  for (const [text, ...classes] of tokens) {
    cell.append(classes.reduceRight((child, className) => {
      const span = element('span', className);
      span.append(child);
      return span;
    }, text));
  }
  return cell;
}

function renderRows(rows, path, sides) {
  const table = element('table', 'rf-code');
  const body = element('tbody');
  for (const row of rows) {
    const line = element('tr', `rf-code-${row.type}`);
    if (row.editId) line.dataset.editId = row.editId;
    if (row.outsideDiff) line.dataset.outsideDiff = 'true';
    line.dataset.oldLine = row.oldLine ?? '';
    line.dataset.newLine = row.newLine ?? '';
    line.append(element('td', 'rf-line-number', String(row.oldLine ?? '')));
    line.append(element('td', 'rf-line-number', String(row.newLine ?? '')));
    line.append(element('td', 'rf-line-marker', row.type === 'add' ? '+' : row.type === 'delete' ? '−' : ''));
    line.append(codeText(row, sides));
    body.append(line);
  }
  table.append(body);
  const scroll = element('div', 'rf-code-scroll');
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', `Before and after code${path ? ` for ${path}` : ''}`);
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
  let highlights;
  let analysis;
  let port;
  let controller;
  let operation = 0;
  let settingsRequest = 0;
  let busy = false;
  let mode = 'full';
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
  let timer;
  let destroyed = false;
  const fileStates = new Map();
  const filePanels = new Map();
  const observedReviews = new Map();
  let reviewControls = new Map();
  const expanded = new Set();
  const openedReviewedFiles = new Set();
  const hiddenSurfaces = new Set();
  let selectedTopicId;
  let selectedFile;
  let foldOtherCode = true;
  let navigationNotice = '';
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
  let titleMark = '';

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
  const guide = button('Guide', () => setMode('guide'));
  const full = button('Full diff', () => setMode('full'));
  full.title = 'Read and discuss changes in GitHub’s original diff.';
  guide.title = 'Understand the change with explanations and paired code.';
  const retryFinal = button('Retry review decisions', () => retryReview());
  retryFinal.hidden = true;
  cancel.hidden = true;
  const viewToggle = element('div', 'rf-view-toggle');
  viewToggle.setAttribute('role', 'group');
  viewToggle.setAttribute('aria-label', 'Review view');
  const viewButtons = [full, guide];
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
  const nativeNotice = element('p', 'rf-navigation-notice');
  nativeNotice.hidden = true;
  const result = element('div', 'rf-result');
  const welcome = element('p', 'rf-welcome', 'Focus on the changes that need you. Every line stays accessible.');
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
  header.insertBefore(progressPanel, buttons);
  const cacheNotice = element('p', 'rf-cache-notice');
  const runSettings = element('p', 'rf-run-settings rf-caption');
  const fileProgress = element('div', 'rf-file-progress');
  fileProgress.id = 'rf-file-progress';
  fileProgress.hidden = true;
  const secondary = element('div', 'rf-secondary');
  secondary.append(runSettings);
  panel.append(header, secondary, welcome, statusNode, cacheNotice, errorNode, nativeNotice, fileProgress, result);

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
    viewToggle.hidden = !finalResult;
    retryFinal.hidden = busy || !port || !['check-failed', 'cancelled'].includes(reviewStage) || [...fileStates.values()].some(file => !['classified', 'complete', ...unanalyzedStates].includes(file.state));
    guide.setAttribute('aria-pressed', String(mode === 'guide'));
    guide.disabled = !finalResult;
    full.setAttribute('aria-pressed', String(mode === 'full'));
    for (const control of viewButtons) control.tabIndex = control.getAttribute('aria-pressed') === 'true' ? 0 : -1;
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
    if (!busy && !status) nextStatus = !configured
      ? `Connect your local ${providerName} helper in Settings, then analyze this PR.`
      : `Ready to analyze ${rangeSelected ? 'these commits' : 'this PR'} with ${providerName}${model ? ` (${model})` : ''}. Analysis starts only when you click ${analyzeLabel}.`;
    if (settingsChanged && !busy && !pendingAction && !currentError) nextStatus = `Settings changed. ${analyzeLabel} will use ${providerName} (${model}), effort: ${effort || 'model default'}.`;
    if (statusNode.textContent !== nextStatus) statusNode.textContent = nextStatus;
    const ordinaryStatus = (busy && snapshot || finalResult && verifiedPage() || !attempted && configured && !status) && !currentError && !pendingAction && !(settingsChanged && !busy);
    statusNode.classList.toggle('rf-visually-hidden', Boolean(ordinaryStatus));
    result.hidden = mode === 'full' || !finalResult;
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

  function applyTitleMark() {
    const title = `${titleMark}${document.title.replace(titleMarks, '')}`;
    if (document.title !== title) document.title = title;
  }

  function markTitle(mark) {
    if (!document.hidden) return;
    titleMark = mark;
    applyTitleMark();
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
      ({ fileLimit, listDeletedFiles } = settings);
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
    restoreNativeSurface();
    selectedTopicId = undefined;
    selectedFile = undefined;
    navigationNotice = '';
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
    expanded.clear();
    openedReviewedFiles.clear();
    removeFilePanels();
    fileProgress.hidden = true;
    fileListOpen = false;
    progressToggle.hidden = true;
    result.replaceChildren();
  }

  function retryReview(path) {
    if (!isActive() || !port || openingSavedReview || !verifiedPage()) return;
    busy = true;
    finalResult = false;
    updateSurface();
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
    updateSurface();
    error = '';
    reviewStage = 'files';
    checkProgress = undefined;
    pendingAction = { type: 'file', path, message: `Analyzing ${path}…` };
    port.postMessage({ type: 'review-file', path });
    if (analysis) renderAnalysis();
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
    label.dataset.path = path;
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
    for (const [path, file] of fileStates) {
      if (fileFilter === 'reviewed' && observedReviews.get(path) !== true) continue;
      if (fileFilter === 'unreviewed' && observedReviews.get(path) === true) continue;
      if (fileFilter === 'failed' && !['failed', 'cancelled'].includes(file.state)) continue;
      const row = element('div', 'rf-file-progress-row');
      row.dataset.state = file.state;
      row.dataset.path = path;
      const label = element('span', 'rf-file-state', fileLabel(file));
      label.dataset.state = file.state;
      const guided = finalResult && file.state !== 'deleted';
      row.append(button(path, () => guided ? selectFile(path) : showNativeFile(path), 'rf-file-path'), label, reviewToggle(path));
      if (guided) {
        const owners = fileTopics(path);
        const references = analysis.topics.filter(topic => !owners.includes(topic) && topic.excerpts.some(excerpt => excerpt.path === path));
        const links = element('div', 'rf-file-sections');
        for (const topic of [...owners, ...references]) links.append(button(`${topic.title}${references.includes(topic) ? ' (cited evidence)' : ''}`, () => selectTopic(topic.id, path), 'rf-link-button'));
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
    for (const card of result.querySelectorAll('.rf-guide-file')) updateGuideFile(card);
    renderFilePanels();
  }

  function editLocations() {
    const classifications = new Map(analysis.classifications.map(entry => [entry.editId, entry]));
    return new Map(snapshot.files.flatMap(file => file.hunks.flatMap(hunk => hunk.items.filter(item => item.type === 'edit').map(edit => [edit.id, { file, edit, classification: classifications.get(edit.id) }]))));
  }

  function changeDelta(path, topic, locations) {
    const rows = [...locations.values()].filter(entry => entry.file.path === path && (!topic || topic.editIds.includes(entry.edit.id))).flatMap(entry => entry.edit.rows);
    if (!rows.length) return 'cited evidence';
    const count = type => rows.filter(row => row.type === type).length;
    return `+${count('add')} −${count('delete')}`;
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
      if (record.state === file.state && record.message === file.message) continue;
      record.state = file.state;
      record.message = file.message;
      record.node.dataset.state = file.state;
      record.content.replaceChildren();
      if (['failed', 'cancelled', 'skipped'].includes(file.state) && file.message) record.content.append(element('p', 'rf-file-message', file.message));
      record.node.hidden = !record.content.childElementCount;
    }
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
    try {
      const captured = await capturePullRequest({ signal: controller.signal, fileLimit, listDeletedFiles, onProgress: message => {
        if (request !== operation) return;
        status = message;
        renderControls();
      } });
      if (request !== operation || !isActive()) return;
      ({ snapshot, highlights } = captured);
      mode = 'full';
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
        ({ snapshot, highlights } = message);
        attempted = true;
        busy = true;
        cacheOnly = message.restoring;
        openingSavedReview = message.restoring;
        mode = 'full';
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
          updateSurface();
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
        selectedTopicId = analysis.topics.some(topic => topic.id === selectedTopicId) ? selectedTopicId : analysis.topics[0]?.id;
        selectedFile = undefined;
        expanded.clear();
        renderAnalysis();
        renderFileProgress();
        updateSurface();
        renderControls();
        markTitle(readyMark);
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

  function restoreNativeSurface() {
    for (const node of new Set([...hiddenSurfaces, ...document.querySelectorAll(`.${surfaceHiddenClass}`)])) node.classList.remove(surfaceHiddenClass);
    hiddenSurfaces.clear();
  }

  function updateSurface() {
    if (mode !== 'guide' || !finalResult || !analysis || !verifiedPage()) {
      restoreNativeSurface();
      return;
    }
    const lists = [...document.querySelectorAll('[data-testid="progressive-diffs-list"], .js-diff-progressive-container')];
    const surfaces = lists.length ? lists : findNativeFiles(document).map(file => file.element);
    for (const surface of surfaces) {
      if (surface.contains(host)) continue;
      surface.classList.add(surfaceHiddenClass);
      hiddenSurfaces.add(surface);
    }
  }

  function setMode(next) {
    if (!isActive()) return;
    mode = next;
    nativeNotice.hidden = next !== 'full' || !navigationNotice;
    updateSurface();
    renderFileProgress();
    renderControls();
  }

  function selectTopic(id, path) {
    if (!finalResult || !analysis.topics.some(topic => topic.id === id)) return;
    selectedTopicId = id;
    selectedFile = undefined;
    mode = 'guide';
    nativeNotice.hidden = true;
    renderAnalysis();
    updateSurface();
    renderControls();
    if (path) {
      revealGuideFile(path);
      return;
    }
    result.querySelector('.rf-section-title')?.focus({ preventScroll: true });
    result.querySelector('.rf-guide-section')?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  function revealGuideFile(path) {
    const card = [...result.querySelectorAll('.rf-guide-file')].find(file => file.dataset.path === path);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  function selectFile(path) {
    const topics = fileTopics(path);
    const topic = topics.find(topic => topic.id === selectedTopicId) ?? topics[0] ?? analysis.topics.find(topic => topic.excerpts.some(excerpt => excerpt.path === path));
    if (topic) {
      selectTopic(topic.id, path);
      return;
    }
    selectedFile = path;
    mode = 'guide';
    nativeNotice.hidden = true;
    renderAnalysis();
    updateSurface();
    renderControls();
    result.querySelector('.rf-guide-file')?.focus();
  }

  async function showNativeFile(path, excerpt) {
    if (!isActive() || !verifiedPage()) return;
    const captured = snapshot;
    setMode('full');
    navigationNotice = '';
    nativeNotice.hidden = true;
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (snapshot !== captured || !verifiedPage()) return;
    let file = findNativeFiles(document).find(entry => entry.path === path);
    if (!file) {
      const anchor = document.getElementById(`diff-${digest}`);
      if (anchor) anchor.scrollIntoView({ block: 'start', behavior: 'auto' });
      else {
        const link = [...document.querySelectorAll(`a[href$="#diff-${digest}"]`)].find(link => {
          const url = new URL(link.href);
          return url.origin === location.origin && url.pathname.startsWith(new URL(captured.url).pathname + '/');
        });
        link?.click();
      }
      for (let attempt = 0; attempt < 6 && !file; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 150));
        if (snapshot !== captured || !verifiedPage()) return;
        file = findNativeFiles(document).find(entry => entry.path === path);
      }
    }
    const row = excerpt && file?.rows.find(entry => excerpt.rows.some(source => source.text === entry.text && (excerpt.side === 'before' ? source.oldLine !== null && source.oldLine === entry.oldLine : source.newLine !== null && source.newLine === entry.newLine)));
    const target = row?.element ?? file?.element;
    if (target) {
      target.scrollIntoView({ block: row ? 'center' : 'start', behavior: 'auto' });
      target.classList.add('review-focus-native-target');
      setTimeout(() => target.classList.remove('review-focus-native-target'), 2200);
      navigationNotice = row ? '' : `Opened ${path} in Full diff. Use GitHub’s file controls to expand code and read discussions.`;
    } else navigationNotice = `GitHub has not loaded ${path}. Use its file list to load the diff and discussions, or open the captured commit source below.`;
    nativeNotice.replaceChildren();
    if (navigationNotice) {
      nativeNotice.append(document.createTextNode(navigationNotice + ' '));
      const file = captured.files.find(file => file.path === path);
      const hasAfter = file?.hunks.some(hunk => hunk.items.some(item => (item.type === 'edit' ? item.rows : [item]).some(row => row.newLine !== null)));
      nativeNotice.append(sourceAnchor(path, hasAfter ? 'after' : 'before', 1, 'Open source at this commit'));
    }
    nativeNotice.hidden = !navigationNotice;
  }

  function sourceAnchor(path, side, line, label) {
    const link = element('a', 'rf-source-link', label);
    link.href = sourceLink(snapshot, { path, side, startLine: line, endLine: line });
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function blockContent(path, rows, topic, locations, notes) {
    const content = element('div', 'rf-code-run');
    const id = rows[0].editId;
    const owner = id && analysis.topics.find(entry => entry.editIds.includes(id));
    const classification = id && locations.get(id)?.classification;
    const protectedFile = isProtectedPath(path, reviewPreferences?.protectedPaths ?? []);
    const reasons = [];
    if (classification?.kinds.includes('unknown')) reasons.push('unresolved evidence');
    const kinds = classification?.kinds.filter(kind => reviewPreferences?.alwaysShow.includes(kind)) ?? [];
    if (kinds.length) reasons.push(`your always-visible types: ${kinds.join(', ')}`);
    if (protectedFile) reasons.push('protected file');
    if (owner && owner !== topic) {
      if (rows.some(row => rowSelected(row, topic?.excerpts.filter(excerpt => excerpt.path === path) ?? []))) reasons.push('selected evidence');
      if (!reasons.length) reasons.push(foldOtherCode ? 'expanded by you' : 'folding is off');
      const label = element('div', 'rf-foreign-edit');
      label.append(button(owner.title, () => selectTopic(owner.id, path), 'rf-link-button'), document.createTextNode(` — ${reasons.join('; ')}`));
      content.append(label);
    } else if (!id && protectedFile) content.append(element('div', 'rf-context-label', 'Protected context'));
    if (rows[0].outsideDiff) content.append(element('div', 'rf-context-label', 'Captured source outside the diff'));
    if (classification?.uncertainty) content.append(richText('div', 'rf-uncertainty', classification.uncertainty));
    for (const excerpt of notes) content.append(richText('div', 'rf-code-note', excerpt.note));
    content.append(renderRows(rows, path, highlights?.[path]));
    return content;
  }

  function updateGuideFile(card) {
    const path = card.dataset.path;
    const reviewed = observedReviews.get(path) === true;
    if (!reviewed) openedReviewedFiles.delete(path);
    const collapsed = reviewed && !openedReviewedFiles.has(path);
    card.dataset.collapsed = String(collapsed);
    card.querySelector('.rf-guide-file-body').hidden = collapsed;
    const toggle = card.querySelector('.rf-collapse-toggle');
    toggle.hidden = !reviewed;
    toggle.textContent = collapsed ? 'Show code' : 'Hide code';
    toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  function renderGuideFile(file, topic, locations) {
    const card = element('article', 'rf-guide-file');
    card.dataset.path = file.path;
    card.tabIndex = -1;
    const heading = element('div', 'rf-guide-file-heading');
    const collapse = button('', () => {
      if (openedReviewedFiles.has(file.path)) openedReviewedFiles.delete(file.path);
      else openedReviewedFiles.add(file.path);
      updateGuideFile(card);
    }, 'rf-link-button rf-collapse-toggle');
    const name = element('span', 'rf-file-title');
    name.title = file.path;
    name.append(element('strong', 'rf-file-name', file.path.split('/').at(-1)));
    if (file.path.includes('/')) name.append(' ', element('span', 'rf-file-dir', file.path.slice(0, file.path.lastIndexOf('/') + 1)));
    const links = element('span', 'rf-file-links');
    const excerpts = topic?.excerpts.filter(excerpt => excerpt.path === file.path) ?? [];
    links.append(button('Show in diff', () => void showNativeFile(file.path, excerpts[0]), 'rf-link-button'));
    const edits = file.hunks.flatMap(hunk => hunk.items.filter(item => item.type === 'edit'));
    const capturedRows = file.hunks.flatMap(hunk => hunk.items.flatMap(item => item.type === 'edit' ? item.rows : [item]));
    for (const [side, key] of [['before', 'oldLine'], ['after', 'newLine']]) {
      const first = capturedRows.find(row => row[key] !== null);
      if (!first) continue;
      const source = sourceAnchor(file.path, side, first[key], side === 'before' ? 'Before' : 'After');
      source.title = `Open ${side} source at this commit`;
      source.setAttribute('aria-label', source.title);
      links.append(source);
    }
    heading.append(name, element('span', 'rf-file-delta', changeDelta(file.path, topic, locations)), reviewToggle(file.path), collapse, links);
    const body = element('div', 'rf-guide-file-body');
    card.append(heading, body);
    updateGuideFile(card);
    let rows;
    try { rows = guideFileRows(snapshot, file); }
    catch (failure) {
      body.append(element('p', 'rf-error', failure.message));
      return card;
    }
    if (!rows.length) body.append(element('p', 'rf-caption', 'No text rows were captured for this file. Use Full diff to inspect it.'));
    const protectedFile = isProtectedPath(file.path, reviewPreferences?.protectedPaths ?? []);
    const visibleEdits = new Set(edits.filter(edit => !topic || topic.editIds.includes(edit.id) || edit.rows.some(row => rowSelected(row, excerpts)) || locations.get(edit.id)?.classification?.kinds.some(kind => kind === 'unknown' || reviewPreferences?.alwaysShow.includes(kind))).map(edit => edit.id));
    const kept = row => !topic || !foldOtherCode || protectedFile || (row.editId ? visibleEdits.has(row.editId) : rowSelected(row, excerpts));
    const notes = noteAnchors(rows, excerpts);
    let hidden = [];
    function appendRuns(parent, source) {
      for (let index = 0; index < source.length;) {
        const first = source[index];
        const run = [first];
        index++;
        while (index < source.length && source[index].editId === first.editId && source[index].outsideDiff === first.outsideDiff && !notes.has(source[index])) run.push(source[index++]);
        parent.append(blockContent(file.path, run, topic, locations, notes.get(first) ?? []));
      }
    }
    function flushHidden() {
      if (!hidden.length) return;
      const owners = analysis.topics.filter(entry => hidden.some(row => row.editId && entry.editIds.includes(row.editId)));
      // A fold row costs as much space as the few context lines it would hide.
      if (!owners.length && hidden.length <= 3) {
        appendRuns(body, hidden);
        hidden = [];
        return;
      }
      const key = JSON.stringify([topic?.id, file.path, rowKey(hidden[0]), rowKey(hidden.at(-1))]);
      const fold = disclosure(`${hidden.length} ${owners.length ? 'other' : 'unchanged'} ${hidden.length === 1 ? 'line' : 'lines'}`, 'rf-fold');
      fold.dataset.lines = hidden.length;
      // GitHub collapses files it marks generated and never shows source outside its diff, so only the rest counts as hidden by the Guide.
      fold.dataset.githubLines = file.isGenerated === true ? 0 : hidden.filter(row => row.type !== 'marker' && !row.outsideDiff).length;
      appendRuns(fold, hidden);
      fold.open = expanded.has(key);
      fold.addEventListener('toggle', () => { if (fold.open) expanded.add(key); else expanded.delete(key); });
      const group = element('div', 'rf-fold-group');
      group.append(fold);
      if (owners.length) {
        const references = element('span', 'rf-fold-sections', 'Changes from');
        for (const owner of owners) references.append(button(owner.title, () => selectTopic(owner.id, file.path), 'rf-link-button'));
        group.append(references);
      }
      body.append(group);
      hidden = [];
    }
    for (let index = 0; index < rows.length;) {
      const row = rows[index];
      if (row.type === 'marker' && !row.editId) {
        flushHidden();
        body.append(element('div', 'rf-hunk-header', row.text));
        index++;
      } else if (!kept(row)) {
        hidden.push(row);
        index++;
      } else {
        flushHidden();
        const run = [row];
        index++;
        while (index < rows.length && (rows[index].type !== 'marker' || rows[index].editId) && kept(rows[index]) && rows[index].editId === row.editId && rows[index].outsideDiff === row.outsideDiff) run.push(rows[index++]);
        appendRuns(body, run);
      }
    }
    flushHidden();
    return card;
  }

  function renderAnalysis() {
    if (!analysis || !snapshot) return;
    result.replaceChildren();
    const summary = element('div', 'rf-overview');
    const reviews = analysis.topics.filter(topic => topic.priority === 'review').length;
    summary.append(element('h2', 'rf-overview-title', `${reviews} review ${reviews === 1 ? 'decision' : 'decisions'}`));
    summary.append(richText('div', 'rf-summary', analysis.summary));
    summary.append(element('p', 'rf-caption', 'Mark each file Reviewed by you when you finish it. Comments, draft reviews and approval stay in Full diff.'));
    if (!reviews) summary.append(element('p', 'rf-caption', 'All sections are supporting. You can inspect every captured change.'));
    const locations = editLocations();
    const guided = new Set(analysis.topics.flatMap(topic => [...topic.editIds.map(id => locations.get(id).file.path), ...topic.excerpts.map(excerpt => excerpt.path)]));
    const excluded = generatedCount();
    const deletedFiles = snapshot.deletedFiles ?? [];
    const coverage = element('p', 'rf-caption rf-coverage', `Guide covers ${guided.size} of ${snapshot.files.length} files.${excluded ? ` ${excluded} machine-maintained ${excluded === 1 ? 'file' : 'files'} not analyzed (shown in Full diff; open the file list to choose Review anyway).` : ''}${deletedFiles.length ? ` ${deletedCaption(deletedFiles.length)} (shown in Full diff).` : ''}`);
    coverage.title = 'Full diff shows every file and line.';
    summary.append(coverage);
    if (deletedFiles.length) {
      const group = disclosure(`${deletedCaption(deletedFiles.length)} · −${deletedFiles.reduce((sum, file) => sum + file.deletions, 0).toLocaleString()} lines`, 'rf-deleted-files');
      const list = element('ul');
      for (const file of deletedFiles) {
        const item = element('li');
        item.append(button(file.path, () => void showNativeFile(file.path), 'rf-link-button'), element('span', 'rf-file-delta', `−${file.deletions.toLocaleString()}`));
        list.append(item);
      }
      group.append(list);
      summary.append(group);
    }
    const unresolved = analysis.classifications.filter(entry => entry.kinds.includes('unknown'));
    if (unresolved.length) {
      const notice = element('div', 'rf-unresolved', `${unresolved.length} ${unresolved.length === 1 ? 'edit has' : 'edits have'} unresolved evidence. `);
      for (const topic of analysis.topics.filter(topic => unresolved.some(entry => topic.editIds.includes(entry.editId)))) notice.append(button(topic.title, () => selectTopic(topic.id), 'rf-link-button'));
      summary.append(notice);
    }
    const nav = element('nav', 'rf-section-overview');
    nav.setAttribute('aria-label', 'Guide sections');
    const sections = element('ol', 'rf-section-list');
    for (const [index, topic] of analysis.topics.entries()) {
      const control = button('', () => selectTopic(topic.id), 'rf-section-link');
      control.dataset.topicId = topic.id;
      control.setAttribute('aria-current', String(!selectedFile && topic.id === selectedTopicId));
      control.append(appendInline(element('span', 'rf-section-name', `${index + 1}. `), topic.title), element('span', 'rf-priority', topic.priority === 'review' ? 'Review' : 'Supporting'));
      const item = element('li');
      item.append(control);
      sections.append(item);
    }
    nav.append(sections);
    const topic = selectedFile ? null : analysis.topics.find(topic => topic.id === selectedTopicId) ?? analysis.topics[0];
    const index = analysis.topics.indexOf(topic);
    const position = index < 0 ? 'Not analyzed' : `Section ${index + 1} of ${analysis.topics.length}`;
    const step = (label, offset) => {
      const control = button(label, () => selectTopic(analysis.topics[index + offset].id));
      control.disabled = index < 0 || !analysis.topics[index + offset];
      return control;
    };
    const paths = selectedFile ? [selectedFile] : topic ? [...new Set([...topic.editIds.map(id => locations.get(id).file.path), ...topic.excerpts.map(excerpt => excerpt.path)])] : [];
    const section = element('section', 'rf-guide-section');
    if (topic) section.dataset.topicId = topic.id;
    const explanation = element('div', 'rf-guide-explanation');
    const sectionNav = element('nav', 'rf-section-nav');
    sectionNav.setAttribute('aria-label', 'Section navigation');
    sectionNav.append(element('span', 'rf-caption', position), step('Previous', -1), step('Next', 1), button('Full diff', () => { setMode('full'); full.focus(); }));
    const title = appendInline(element('h2', 'rf-section-title'), topic?.title ?? 'Captured changes · not analyzed');
    title.tabIndex = -1;
    explanation.append(sectionNav, title);
    const changedLines = edits => edits.filter(({ file }) => file.isGenerated !== true).flatMap(({ edit }) => edit.rows).filter(row => row.type === 'add' || row.type === 'delete').length;
    const sectionCoverage = element('p', 'rf-caption rf-section-coverage');
    sectionCoverage.title = 'Folded lines open in place, other sections explain the rest, and Full diff shows every line.';
    const updateCoverage = () => {
      const folded = [...code.querySelectorAll('.rf-fold:not([open])')].reduce((sum, fold) => sum + Number(fold.dataset.githubLines), 0);
      sectionCoverage.textContent = [
        `${paths.length} of ${snapshot.files.length.toLocaleString()} files`,
        `${changedLines(topic.editIds.map(id => locations.get(id))).toLocaleString()} of ${changedLines([...locations.values()]).toLocaleString()} changed lines`,
        folded && `${folded.toLocaleString()} ${folded === 1 ? 'line' : 'lines'} folded here`
      ].filter(Boolean).join(' · ');
    };
    if (topic) {
      explanation.append(sectionCoverage);
      const files = element('ul', 'rf-section-files');
      for (const path of paths) {
        const jump = button(path.split('/').at(-1), () => revealGuideFile(path), 'rf-link-button');
        jump.title = path;
        jump.setAttribute('aria-label', path);
        const item = element('li');
        item.append(jump, element('span', 'rf-file-delta', changeDelta(path, topic, locations)), reviewToggle(path));
        files.append(item);
      }
      explanation.append(element('h3', '', 'Files in this section'), files);
      for (const [field, label] of [['before', 'Before'], ['after', 'After'], ['reason', 'Why it matters']]) {
        explanation.append(element('h3', '', label), richText('div', `rf-${field === 'after' ? 'change-explanation' : field}`, topic[field]));
      }
      if (topic.questions.length) {
        const questions = element('ul', 'rf-questions');
        for (const question of topic.questions) questions.append(richText('li', '', question));
        explanation.append(element('h3', '', 'Review questions'), questions);
      }
      if (topic.uncertainty) {
        const limits = disclosure('Evidence limits', 'rf-limits');
        limits.append(richText('div', 'rf-uncertainty', topic.uncertainty));
        explanation.append(limits);
      }
      const details = disclosure('Change classifications', 'rf-evidence');
      for (const id of topic.editIds) {
        const entry = locations.get(id);
        const detail = element('div', 'rf-edit');
        detail.dataset.editId = id;
        detail.append(element('strong', '', entry.file.path), element('p', 'rf-change-kind', `Change type: ${entry.classification.kinds.join(', ')}`), richText('div', '', entry.classification.reason));
        if (entry.classification.uncertainty) detail.append(richText('div', 'rf-uncertainty', entry.classification.uncertainty));
        details.append(detail);
      }
      explanation.append(details);
    }
    const code = element('div', 'rf-guide-code');
    const foldLabel = element('label', 'rf-fold-other');
    const foldInput = element('input');
    foldInput.type = 'checkbox';
    foldInput.checked = foldOtherCode;
    foldInput.addEventListener('change', () => {
      foldOtherCode = foldInput.checked;
      renderAnalysis();
      result.querySelector('.rf-fold-other input')?.focus({ preventScroll: true });
    });
    foldLabel.append(foldInput, document.createTextNode('Fold other code'));
    code.append(foldLabel);
    for (const path of paths) code.append(renderGuideFile(snapshot.files.find(file => file.path === path), topic, locations));
    if (topic) {
      updateCoverage();
      code.addEventListener('toggle', updateCoverage, true);
    }
    section.append(explanation, code);
    const sequence = element('div', 'rf-section-sequence');
    sequence.append(step('Previous section', -1), element('span', 'rf-caption', position), step('Next section', 1));
    const details = disclosure('Analysis details', 'rf-review-details');
    if (cacheMessage) details.append(element('p', 'rf-cache-detail', cacheMessage));
    details.append(element('p', 'rf-provenance', `Analyzed ${snapshot.baseSha.slice(0, 8)}…${snapshot.headSha.slice(0, 8)} with ${reviewProviderName}${reviewModel ? ` (${reviewModel})` : ''}, effort: ${reviewEffort || 'model default'}.`));
    for (const warning of snapshot.warnings ?? []) details.append(element('p', '', warning));
    result.append(summary, nav, section, sequence, details);
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
    applyTitleMark();
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
      restoreNativeSurface();
      removeFilePanels();
      host.remove();
      return;
    }
    mount();
    resumeAnalysis(identity);
    if (readReviewControls()) renderFileProgress();
    else renderFilePanels();
    updateSurface();
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
    clearInterval(clock);
    clearTimeout(timer);
    detachAnalysis();
    host.remove();
    titleMark = '';
    applyTitleMark();
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
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    titleMark = '';
    applyTitleMark();
  }, eventOptions);
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
