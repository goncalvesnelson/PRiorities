const form = document.querySelector('#settings-form');
const provider = document.querySelector('#provider');
const model = document.querySelector('#model');
const saveButton = document.querySelector('#save');
const checkButton = document.querySelector('#check-connection');
const connectionStatus = document.querySelector('#connection-status');
const status = document.querySelector('#status');
const drafts = new Map();
let selectedProvider = provider.value;
let requestVersion = 0;

function showStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

function setLoading(loading) {
  model.disabled = loading;
  saveButton.disabled = loading;
  checkButton.disabled = loading;
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  if (!response) throw new Error('PRiorities is unavailable. Reload the extension and this settings page.');
  if (!['codex', 'claude'].includes(response.provider) || message.provider && response.provider !== message.provider) throw new Error('Reload PRiorities in chrome://extensions, then reopen Settings. This page is connected to an older extension worker.');
  return response;
}

function renderProvider() {
  const label = selectedProvider === 'claude' ? 'Claude Code' : 'Codex';
  const company = selectedProvider === 'claude' ? 'Anthropic' : 'OpenAI';
  document.querySelector('#connection-title').textContent = `Local ${label} connection`;
  document.querySelector('#login-command').textContent = selectedProvider === 'claude' ? 'claude auth login' : 'codex login';
  model.placeholder = `${label} default`;
  document.querySelector('#model-help').textContent = `Leave blank for ${label}’s default, or enter ${selectedProvider === 'claude' ? 'a Claude model alias or ID' : 'a model ID'} available to your account. This preference is saved separately for each CLI.`;
  document.querySelector('#provider-privacy').textContent = `The PR description, included diffs and captured source context go to ${company} through ${label}, using your account allowance. Opening a PR sends no code.`;
}

function renderConnection(settings) {
  const label = settings.provider === 'claude' ? 'Claude Code' : 'Codex';
  connectionStatus.textContent = settings.configured ? `Connected to ${label} with your ${settings.provider === 'claude' ? 'Claude' : 'ChatGPT'} login.` : settings.connectionError || `${label} is not connected. Sign in through the CLI, then check again.`;
}

async function loadSettings(selection) {
  const version = ++requestVersion;
  setLoading(true);
  renderProvider();
  connectionStatus.textContent = 'Checking the local helper…';
  try {
    const settings = await request({ type: 'get-settings', ...(selection ? { provider: selection } : {}) });
    if (version !== requestVersion) return;
    selectedProvider = settings.provider;
    provider.value = selectedProvider;
    model.value = drafts.get(selectedProvider) ?? settings.model;
    renderProvider();
    renderConnection(settings);
  } catch (error) {
    if (version === requestVersion) connectionStatus.textContent = error.message;
  } finally {
    if (version === requestVersion) setLoading(false);
  }
}

provider.addEventListener('change', () => {
  if (!model.disabled) drafts.set(selectedProvider, model.value);
  selectedProvider = provider.value;
  model.value = drafts.get(selectedProvider) ?? '';
  showStatus('Choose Save settings to use this CLI for new reviews. Running reviews keep their original CLI.');
  void loadSettings(selectedProvider);
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const version = ++requestVersion;
  setLoading(true);
  provider.disabled = true;
  try {
    const settings = await request({ type: 'save-settings', provider: selectedProvider, model: model.value.trim() });
    if (version !== requestVersion) return;
    model.value = settings.model;
    drafts.set(selectedProvider, settings.model);
    renderConnection(settings);
    showStatus(settings.configured ? 'Settings saved. Return to a GitHub PR and choose Analyze PR.' : 'Settings saved. Connect the selected CLI before analyzing a PR.');
  } catch (error) {
    if (version === requestVersion) showStatus(error.message, true);
  } finally {
    provider.disabled = false;
    if (version === requestVersion) setLoading(false);
  }
});

checkButton.addEventListener('click', () => {
  drafts.set(selectedProvider, model.value);
  void loadSettings(selectedProvider);
});

const cacheForm = document.querySelector('#cache-form');
const cacheLimit = document.querySelector('#cache-limit');
const cacheSave = document.querySelector('#save-cache-limit');
const cacheClear = document.querySelector('#clear-cache');
const cacheStatus = document.querySelector('#cache-status');

async function updateCache(message) {
  cacheLimit.disabled = true;
  cacheSave.disabled = true;
  cacheClear.disabled = true;
  cacheStatus.textContent = '';
  cacheStatus.dataset.error = 'false';
  try {
    const info = await chrome.runtime.sendMessage(message);
    if (!info || info.error) throw new Error(info?.error || 'Saved reviews are unavailable.');
    cacheLimit.value = info.limitMB;
    const usedMB = info.usedBytes / (1024 * 1024);
    document.querySelector('#cache-usage').textContent = `${info.count} saved ${info.count === 1 ? 'review' : 'reviews'} · ${usedMB.toFixed(1)} of ${info.limitMB} MB used`;
    const bar = document.querySelector('#cache-usage-bar');
    bar.max = info.limitMB;
    bar.value = usedMB;
    cacheClear.disabled = info.count === 0;
    if (message.type === 'clear-cache') cacheStatus.textContent = 'Saved reviews cleared. Open reviews in other tabs remain available.';
    if (message.type === 'set-cache-limit') cacheStatus.textContent = 'Cache limit saved.';
  } catch (error) {
    cacheStatus.textContent = error.message;
    cacheStatus.dataset.error = 'true';
  } finally {
    cacheLimit.disabled = false;
    cacheSave.disabled = false;
  }
}

cacheForm.addEventListener('submit', event => {
  event.preventDefault();
  void updateCache({ type: 'set-cache-limit', limitMB: Number(cacheLimit.value) });
});
cacheClear.addEventListener('click', () => { void updateCache({ type: 'clear-cache' }); });

await Promise.all([loadSettings(), updateCache({ type: 'cache-info' })]);
