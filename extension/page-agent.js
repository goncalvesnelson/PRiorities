// Runs inside the GitHub tab only while the PRiorities side panel is connected. It reads the pull
// request, folds and scrolls GitHub's own diff, and relays the panel's messages to the background.
// It adds nothing to the page except fold markers, their tooltip and the scroll highlight.
import { capturePullRequest, findNativeFiles, readPageIdentity } from './github.js';
import { sectionPaths } from './review-data.js';
import { isProtectedPath } from './review-preferences.js';

const ownedAttribute = 'data-review-focus-owned';
const nativeHiddenClass = 'review-focus-native-hidden';
const nativeUnfoldedClass = 'review-focus-native-unfolded';
const nativeTargetClass = 'review-focus-native-target';
const titleMarks = /^(?:✓ Ready|⚠ Needs attention) ·\s*/;
// A fold row costs about as much space as the lines it hides, so shorter runs stay open.
const minimumFold = 3;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
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

function titles(topics) {
  return [...new Set(topics)].map(topic => `“${topic.title}”`).join(', ');
}

function foldReason(rows) {
  const suggested = rows.filter(row => !row.done.length);
  const supporting = suggested.map(row => row.topic).filter(Boolean);
  const done = rows.flatMap(row => row.done);
  return [
    ...!suggested.length ? [] : supporting.length ? [`Supporting changes from ${titles(supporting)}.`] : ['Unchanged context around the changes.'],
    ...done.length ? [`You marked ${titles(done)} done.`] : []
  ].join(' ');
}

// One shared tooltip in the page, fixed to the viewport so GitHub's scrolling diff tables can't clip it.
function foldTooltip(doc) {
  let node = doc.querySelector('.review-focus-native-tooltip');
  const api = {
    anchor: undefined,
    show(anchor, [title, ...lines]) {
      if (!node) {
        node = doc.createElement('div');
        node.className = 'review-focus-native-tooltip';
        node.setAttribute(ownedAttribute, '');
        node.setAttribute('role', 'tooltip');
        doc.body.append(node);
      }
      api.anchor = anchor;
      node.replaceChildren(element('strong', '', title), ...lines.map(line => element('span', '', line)));
      node.hidden = false;
      const rect = anchor.getBoundingClientRect();
      const width = node.offsetWidth;
      const below = rect.top < node.offsetHeight + 12;
      node.dataset.side = below ? 'below' : 'above';
      node.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, doc.documentElement.clientWidth - width - 8))}px`;
      node.style.top = `${below ? rect.bottom + 8 : rect.top - node.offsetHeight - 8}px`;
      doc.addEventListener('scroll', api.hide, { once: true, capture: true, passive: true });
    },
    hide() {
      api.anchor = undefined;
      if (node) node.hidden = true;
    }
  };
  return api;
}

// Folds rows in GitHub's own diff. With `autoFold`, review decisions, their cited evidence,
// unresolved edits, always-visible kinds and protected files stay open. A row also folds once the
// reviewer marked done (ticked) every section that changes or cites it in its file, even when it
// would stay open. Discussion rows and files without an analyzed edit (generated, excluded) are
// never touched.
function createNativeFolding(doc, snapshot, analysis, { protectedPaths = [], alwaysShow = [], ticks = [], autoFold = true, revealed = new Set(), onChange = () => {} } = {}) {
  const topicsByEdit = new Map(analysis.topics.flatMap(topic => topic.editIds.map(id => [id, topic])));
  const keptEdits = new Set(analysis.classifications.filter(entry => entry.kinds.some(kind => kind === 'unknown' || alwaysShow.includes(kind))).map(entry => entry.editId));
  const fileRows = new Map();
  for (const file of snapshot.files) {
    if (!file.hunks.some(hunk => hunk.items.some(item => item.type === 'edit' && topicsByEdit.has(item.id)))) continue;
    const rows = new Map();
    const protectedFile = isProtectedPath(file.path, protectedPaths);
    const doneTopicIds = new Set(ticks.filter(tick => tick.path === file.path).map(tick => tick.topicId));
    // An edit belongs to exactly one section; other sections reach its rows only by citing them.
    const citing = new Map(doneTopicIds.size ? analysis.topics.map(entry => [entry, entry.excerpts.filter(excerpt => excerpt.path === file.path)]).filter(([, excerpts]) => excerpts.length) : []);
    for (const hunk of file.hunks) {
      for (const item of hunk.items) {
        const topic = topicsByEdit.get(item.id);
        const kept = protectedFile || keptEdits.has(item.id) || topic?.priority === 'review';
        for (const row of item.type === 'edit' ? item.rows : [item]) {
          if (row.type === 'marker') continue;
          const sections = doneTopicIds.size ? analysis.topics.filter(entry => entry === topic || citing.has(entry) && rowSelected(row, citing.get(entry))) : [];
          const done = sections.length && sections.every(entry => doneTopicIds.has(entry.id)) ? sections : [];
          rows.set(rowKey(row), { row, topic, kept, done });
        }
      }
    }
    fileRows.set(file.path, rows);
  }
  const excerptsByPath = new Map();
  for (const topic of analysis.topics.filter(topic => topic.priority === 'review')) {
    for (const excerpt of topic.excerpts) excerptsByPath.set(excerpt.path, [...excerptsByPath.get(excerpt.path) ?? [], excerpt]);
  }
  const hidden = new Set();
  const folds = [];
  const tooltip = foldTooltip(doc);
  let matched = 0;
  let unreadable = 0;
  let appliedLayout;

  function restore() {
    appliedLayout = undefined;
    tooltip.hide();
    for (const fold of folds) {
      fold.marker.remove();
      for (const row of fold.rows) row.element.classList.remove(nativeHiddenClass, nativeUnfoldedClass);
    }
    hidden.clear();
    folds.length = 0;
  }

  function counts() {
    return { groups: folds.length, folded: folds.filter(fold => !revealed.has(fold.key)).length, hidden: hidden.size, matched, unreadable };
  }

  function setExpanded(fold, expanded) {
    if (expanded) revealed.add(fold.key);
    else revealed.delete(fold.key);
    for (const row of fold.rows) {
      row.element.classList.toggle(nativeHiddenClass, !expanded);
      row.element.classList.toggle(nativeUnfoldedClass, expanded);
      if (expanded) hidden.delete(row.element);
      else hidden.add(row.element);
    }
    const lines = `${fold.rows.length} ${fold.rows.length === 1 ? 'line' : 'lines'}`;
    fold.toggle.textContent = expanded ? `Fold ${lines}` : `${lines} folded`;
    fold.toggle.setAttribute('aria-expanded', String(expanded));
    fold.toggle.setAttribute('aria-label', `${expanded ? 'Fold again' : 'Show'} ${lines} folded by PRiorities. ${fold.reason}`);
    fold.tooltip = [expanded ? `PRiorities unfolded ${lines}` : `PRiorities folded ${lines}`, fold.reason,
      `${expanded ? 'Click to fold them again.' : 'Click to show them.'} GitHub’s diff and comments are unchanged.`];
    if (tooltip.anchor === fold.toggle) tooltip.show(fold.toggle, fold.tooltip);
    onChange(counts());
  }

  function foldRows(path, rows) {
    // A section marked done is the reviewer's own request, so its rows fold however few they are.
    if (rows.length < minimumFold && !rows.some(row => row.done.length)) return;
    const first = rows[0].element;
    const marker = doc.createElement('tr');
    marker.className = 'review-focus-native-fold';
    marker.setAttribute(ownedAttribute, '');
    const cell = doc.createElement('td');
    cell.colSpan = Math.max(1, [...first.cells].reduce((sum, item) => sum + item.colSpan, 0));
    // A green line across the diff with one badge on it; the explanation lives in the badge's tooltip.
    const body = element('div', 'review-focus-native-fold-body');
    const reason = foldReason(rows);
    const toggle = element('button', 'review-focus-native-toggle');
    toggle.type = 'button';
    const fold = { key: JSON.stringify([path, rowKey(rows[0]), rowKey(rows.at(-1))]), marker, toggle, rows, reason };
    toggle.addEventListener('click', () => setExpanded(fold, !revealed.has(fold.key)));
    for (const type of ['pointerenter', 'focus']) toggle.addEventListener(type, () => tooltip.show(toggle, fold.tooltip));
    for (const type of ['pointerleave', 'blur']) toggle.addEventListener(type, () => tooltip.hide());
    body.append(toggle);
    cell.append(body);
    marker.append(cell);
    first.before(marker);
    folds.push(fold);
    setExpanded(fold, revealed.has(fold.key));
  }

  function hasDiscussion(row) {
    return Boolean(row.querySelector('form, textarea, .review-thread-component, .js-comment-container') || row.nextElementSibling?.matches('tr.inline-comments'));
  }

  function apply() {
    const files = findNativeFiles(doc).filter(file => fileRows.has(file.path));
    const layout = files.flatMap(file => [file.element, file.path, ...file.rows.flatMap(row => {
      let next = row.element.nextElementSibling;
      while (next?.hasAttribute(ownedAttribute)) next = next.nextElementSibling;
      return [row.element, row.element.parentElement, next, rowKey(row), hasDiscussion(row.element)];
    })]);
    const intact = folds.every(fold => fold.marker.nextElementSibling === fold.rows[0].element);
    if (intact && appliedLayout?.length === layout.length && layout.every((value, index) => value === appliedLayout[index])) return counts();
    restore();
    appliedLayout = layout;
    matched = 0;
    // Split layouts put both sides on one row, so only GitHub's unified view can fold.
    unreadable = files.filter(file => !file.rows.length && file.element.querySelector('table tr')).length;
    for (const file of files) {
      const expected = fileRows.get(file.path);
      const excerpts = excerptsByPath.get(file.path) ?? [];
      const perElement = new Map();
      for (const row of file.rows) perElement.set(row.element, (perElement.get(row.element) ?? 0) + 1);
      let group = [];
      const flush = () => { foldRows(file.path, group); group = []; };
      for (const row of file.rows) {
        const match = expected.get(rowKey(row));
        if (!match || row.element.tagName !== 'TR' || perElement.get(row.element) !== 1 || hasDiscussion(row.element)) {
          flush();
          continue;
        }
        matched++;
        const suggested = autoFold && !match.kept && !rowSelected(match.row, excerpts);
        if (!suggested && !match.done.length) {
          flush();
          continue;
        }
        if (group.length && group.at(-1).element.nextElementSibling !== row.element) flush();
        group.push({ ...row, topic: match.topic, done: match.done });
      }
      flush();
    }
    return counts();
  }

  function revealRow(row) {
    const fold = folds.find(entry => entry.rows.some(item => item.element === row));
    if (fold && !revealed.has(fold.key)) setExpanded(fold, true);
  }

  return { apply, restore, counts, revealRow };
}

function nativeReviewControl(native) {
  return native?.element.querySelector('input.js-reviewed-checkbox, button[aria-pressed][aria-label="Viewed"], button[aria-pressed][aria-label="Not Viewed"]');
}

// `port` comes from the side panel; `queued` holds messages that arrived while this module loaded.
export function startPageAgent(port, queued = []) {
  const listeners = new AbortController();
  const eventOptions = { signal: listeners.signal };
  const backgroundPorts = new Map();
  const revealed = new Set();
  // Viewed states a section tick asked for before GitHub loaded the file's control.
  const pendingReviews = new Map();
  let snapshot;
  let foldState;
  let folding;
  let captureController;
  let titleMark = '';
  let lastState = '';
  let timer;
  let stopped = false;

  function post(message) {
    try { port.postMessage(message); } catch {}
  }

  function verifiedPage() {
    const identity = readPageIdentity(document, location.href);
    if (!snapshot || !identity || !isDiffPage()) return false;
    const path = new URL(snapshot.url).pathname.split('/').filter(Boolean);
    return identity.owner === path[0] && identity.repo === path[1] && String(identity.number) === path[3]
      && identity.headSha === snapshot.headSha && (!identity.baseSha || identity.baseSha === snapshot.baseSha);
  }

  function pageState() {
    const identity = readPageIdentity(document, location.href) ?? null;
    const diff = Boolean(identity) && isDiffPage();
    const reviews = [];
    if (diff) {
      for (const native of findNativeFiles(document)) {
        const control = nativeReviewControl(native);
        if (!control) continue;
        reviews.push([native.path, {
          reviewed: control.tagName === 'INPUT' ? control.checked : control.getAttribute('aria-pressed') === 'true',
          disabled: control.disabled || control.getAttribute('aria-disabled') === 'true'
        }]);
      }
    }
    return { identity, href: location.href, pathname: location.pathname, search: location.search, diff, reviews };
  }

  function applyTitleMark() {
    const title = `${titleMark}${document.title.replace(titleMarks, '')}`;
    if (document.title !== title) document.title = title;
  }

  function restoreFolding(forget = false) {
    folding?.restore();
    folding = undefined;
    if (forget) {
      revealed.clear();
      pendingReviews.clear();
    }
    for (const node of document.querySelectorAll(`.${nativeHiddenClass}, .${nativeUnfoldedClass}`)) node.classList.remove(nativeHiddenClass, nativeUnfoldedClass);
    for (const node of document.querySelectorAll('.review-focus-native-fold')) node.remove();
  }

  function applyFolding() {
    if (!foldState || !verifiedPage()) {
      if (folding) {
        restoreFolding();
        post({ kind: 'fold-counts', counts: null });
      }
      return;
    }
    folding ??= createNativeFolding(document, snapshot, foldState.analysis, {
      ...foldState.preferences, ticks: foldState.ticks, autoFold: foldState.autoFold, revealed, onChange: counts => post({ kind: 'fold-counts', counts })
    });
    post({ kind: 'fold-counts', counts: folding.apply() });
  }

  function fileDone(path) {
    const sections = foldState.analysis.topics.filter(topic => sectionPaths(topic, snapshot).has(path));
    return sections.length > 0 && sections.every(topic => foldState.ticks.some(tick => tick.topicId === topic.id && tick.path === path));
  }

  // A rerun can drop a tick without the panel unticking it, so a waiting change applies only while
  // the current ticks still ask for it.
  function applyPendingReviews() {
    if (!verifiedPage()) pendingReviews.clear();
    // The panel clears folding while a rerun runs; waiting changes are checked against its ticks once they return.
    if (!foldState) return;
    for (const [path, checked] of pendingReviews) {
      if (checked === fileDone(path)) setReviewed(path, checked);
      else pendingReviews.delete(path);
    }
  }

  function check() {
    if (stopped) return;
    applyTitleMark();
    applyFolding();
    applyPendingReviews();
    const state = pageState();
    const key = JSON.stringify(state);
    if (key === lastState) return;
    lastState = key;
    post({ kind: 'page', state });
  }

  function scheduleCheck() {
    clearTimeout(timer);
    timer = setTimeout(check, 180);
  }

  async function findNativeFile(path, captured) {
    let file = findNativeFiles(document).find(entry => entry.path === path);
    if (file) return file;
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (snapshot !== captured || !verifiedPage()) return undefined;
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
      if (snapshot !== captured || !verifiedPage()) return undefined;
      file = findNativeFiles(document).find(entry => entry.path === path);
    }
    return file;
  }

  function flash(elements) {
    for (const node of elements) node.classList.add(nativeTargetClass);
    setTimeout(() => { for (const node of elements) node.classList.remove(nativeTargetClass); }, 2400);
  }

  // Scrolls GitHub's diff to the cited lines, unfolding them first if PRiorities folded them.
  async function reveal(target) {
    if (!verifiedPage()) return 'stale';
    const captured = snapshot;
    const file = await findNativeFile(target.path, captured);
    if (snapshot !== captured) return 'stale';
    const key = target.side === 'before' ? 'oldLine' : 'newLine';
    const rows = file?.rows.filter(row => row[key] !== null && row[key] >= target.startLine && row[key] <= target.endLine) ?? [];
    for (const row of rows) folding?.revealRow(row.element);
    const scrollTarget = rows[0]?.element ?? file?.element;
    if (scrollTarget) {
      scrollTarget.scrollIntoView({ block: rows.length ? 'center' : 'start', behavior: 'smooth' });
      flash(rows.length ? rows.map(row => row.element) : [scrollTarget]);
    }
    if (!file) return 'not-loaded';
    return rows.length || target.endLine < target.startLine ? 'shown' : 'outside';
  }

  // With `whenLoaded`, a file whose control GitHub has not loaded yet gets the change once it loads.
  function setReviewed(path, checked, { whenLoaded = false } = {}) {
    if (!verifiedPage()) return false;
    const control = nativeReviewControl(findNativeFiles(document).find(file => file.path === path));
    if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true') {
      if (whenLoaded) pendingReviews.set(path, checked);
      return false;
    }
    pendingReviews.delete(path);
    const reviewed = control.tagName === 'INPUT' ? control.checked : control.getAttribute('aria-pressed') === 'true';
    if (checked !== reviewed) control.click();
    scheduleCheck();
    return true;
  }

  const methods = {
    async capture(options) {
      captureController?.abort();
      const controller = captureController = new AbortController();
      try {
        return await capturePullRequest({ ...options, signal: controller.signal, onProgress: (message, files) => post({ kind: 'capture-progress', message, files }) });
      } finally {
        controller.abort();
        if (captureController === controller) captureController = undefined;
      }
    },
    abortCapture() { captureController?.abort(); },
    setSnapshot(next) {
      restoreFolding(true);
      foldState = undefined;
      snapshot = next ?? undefined;
    },
    setFolding(next) {
      restoreFolding(Boolean(next?.forget));
      foldState = next?.analysis ? next : undefined;
      if (foldState) applyFolding();
      else post({ kind: 'fold-counts', counts: null });
    },
    reveal,
    setReviewed,
    markTitle(mark) {
      if (mark && !document.hidden) return;
      titleMark = mark;
      applyTitleMark();
    },
    sendBackground(message) { return chrome.runtime.sendMessage(message); }
  };

  function connectBackground(id) {
    const connection = chrome.runtime.connect({ name: 'review-focus' });
    backgroundPorts.set(id, connection);
    connection.onMessage.addListener(message => post({ kind: 'bg-message', id, message }));
    connection.onDisconnect.addListener(() => {
      if (backgroundPorts.get(id) !== connection) return;
      backgroundPorts.delete(id);
      post({ kind: 'bg-disconnected', id });
    });
  }

  async function handle(message) {
    if (stopped) return;
    if (message.kind === 'call') {
      try {
        const value = await methods[message.method](...message.args);
        post({ kind: 'reply', id: message.id, ok: true, value });
      } catch (failure) {
        post({ kind: 'reply', id: message.id, ok: false, error: failure?.message ?? String(failure) });
      }
    } else if (message.kind === 'bg-connect') connectBackground(message.id);
    else if (message.kind === 'bg-post') {
      try { backgroundPorts.get(message.id)?.postMessage(message.message); } catch {}
    } else if (message.kind === 'bg-disconnect') {
      const connection = backgroundPorts.get(message.id);
      backgroundPorts.delete(message.id);
      connection?.disconnect();
    }
  }

  // Closing the panel detaches any running analysis; the background keeps it for the panel to resume.
  function stop() {
    if (stopped) return;
    stopped = true;
    listeners.abort();
    observer.disconnect();
    clearInterval(interval);
    clearTimeout(timer);
    captureController?.abort();
    for (const connection of backgroundPorts.values()) connection.disconnect();
    backgroundPorts.clear();
    restoreFolding();
    pendingReviews.clear();
    document.querySelector('.review-focus-native-tooltip')?.remove();
    titleMark = '';
    applyTitleMark();
  }

  const observer = new MutationObserver(records => {
    const relevant = records.some(record => {
      if (record.target.nodeType === Node.ELEMENT_NODE && record.target.closest(`[${ownedAttribute}]`)) return false;
      if (record.type === 'attributes') return record.target === document.documentElement || record.target.matches('input.js-reviewed-checkbox, button[aria-pressed]');
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType !== Node.ELEMENT_NODE || !node.hasAttribute(ownedAttribute));
    });
    if (relevant) scheduleCheck();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-label', 'aria-disabled', 'checked', 'disabled'] });
  document.addEventListener('change', event => {
    if (event.target.matches('input.js-reviewed-checkbox')) scheduleCheck();
  }, eventOptions);
  for (const type of ['turbo:load', 'pjax:end']) document.addEventListener(type, scheduleCheck, eventOptions);
  for (const type of ['popstate', 'pageshow']) window.addEventListener(type, scheduleCheck, eventOptions);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    titleMark = '';
    applyTitleMark();
  }, eventOptions);
  window.addEventListener('pagehide', stop, eventOptions);
  const interval = setInterval(check, 1500);
  port.onMessage.addListener(handle);
  port.onDisconnect.addListener(stop);
  for (const message of queued) void handle(message);
  check();
  return stop;
}
