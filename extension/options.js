import { changeKinds, classificationPrompt, prioritizationPrompt } from './review-preferences.js';

const form = document.querySelector('#settings-form');
const provider = document.querySelector('#provider');
const model = document.querySelector('#model');
const customModel = document.querySelector('#custom-model');
const customField = document.querySelector('#custom-model-field');
const effort = document.querySelector('#effort');
const saveButton = document.querySelector('#save');
const checkButton = document.querySelector('#check-connection');
const connectionStatus = document.querySelector('#connection-status');
const status = document.querySelector('#status');
const drafts = new Map();
let selectedProvider = provider.value;
let requestVersion = 0;
let models = [];
let catalogError = '';
let loading = false;

function showStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

function selection() {
  return { model: model.value === '__custom__' ? customModel.value.trim() : model.value, effort: effort.value };
}

function setLoading(value) {
  loading = value;
  model.disabled = value;
  customModel.disabled = value || customField.hidden;
  effort.disabled = value || effort.options.length < 2;
  saveButton.disabled = value;
  checkButton.disabled = value;
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  if (!response) throw new Error('PRiorities is unavailable. Reload the extension and this settings page.');
  if (!['codex', 'claude'].includes(response.provider) || message.provider && response.provider !== message.provider) throw new Error('The extension returned invalid provider settings. Reload PRiorities and try again.');
  return response;
}

function renderProvider() {
  const label = selectedProvider === 'claude' ? 'Claude Code' : 'Codex';
  const company = selectedProvider === 'claude' ? 'Anthropic' : 'OpenAI';
  document.querySelector('#connection-title').textContent = `Local ${label} connection`;
  document.querySelector('#login-command').textContent = selectedProvider === 'claude' ? 'claude auth login' : 'codex login';
  document.querySelector('#provider-privacy').textContent = `The PR description, included diffs and captured source context go to ${company} through ${label}, using your account allowance. Opening a PR sends no code.`;
}

function renderEffort(preferred = '') {
  const custom = model.value === '__custom__';
  customField.hidden = !custom;
  customModel.required = custom;
  const selected = models.find(entry => entry.id === selection().model);
  const choices = selected?.efforts ?? [...new Set(models.flatMap(entry => entry.efforts))];
  effort.replaceChildren();
  if (!selected || !choices.length) effort.add(new Option(selected ? 'Not configurable for this model' : 'Model default', ''));
  for (const value of choices) effort.add(new Option(value, value));
  effort.value = choices.includes(preferred) ? preferred : selected?.defaultEffort || effort.options[0].value;
  document.querySelector('#model-help').textContent = catalogError || (custom ? 'Enter an exact model ID supported by your CLI and account, including older releases.' : 'Models reported by your local CLI. Your selection is saved separately for each CLI.');
  document.querySelector('#effort-help').textContent = selected
    ? choices.length ? 'Supported effort levels for this model. Higher levels may take longer.' : 'This CLI does not offer an effort setting for this model.'
    : 'Effort support for custom models is checked by the CLI when analysis starts. Model default leaves effort unset.';
  setLoading(loading);
}

function renderModels(choice) {
  model.replaceChildren();
  for (const entry of models) model.add(new Option(`${entry.label} (${entry.id})`, entry.id));
  model.add(new Option('Custom model ID…', '__custom__'));
  const preferred = choice.model || models.find(entry => entry.isDefault)?.id || models[0]?.id || '';
  model.value = models.some(entry => entry.id === preferred) ? preferred : '__custom__';
  customModel.value = model.value === '__custom__' ? preferred : '';
  renderEffort(choice.effort);
}

function renderConnection(settings) {
  const label = settings.provider === 'claude' ? 'Claude Code' : 'Codex';
  connectionStatus.textContent = settings.configured ? `Connected to ${label} with your ${settings.provider === 'claude' ? 'Claude' : 'ChatGPT'} login.` : settings.connectionError || `${label} is not connected. Sign in through the CLI, then check again.`;
}

async function loadSettings(selectionProvider) {
  const version = ++requestVersion;
  setLoading(true);
  renderProvider();
  connectionStatus.textContent = 'Checking the local helper…';
  try {
    const settings = await request({ type: 'get-settings', ...(selectionProvider ? { provider: selectionProvider } : {}) });
    if (version !== requestVersion) return;
    selectedProvider = settings.provider;
    provider.value = selectedProvider;
    renderProvider();
    renderConnection(settings);
    document.querySelector('#model-help').textContent = 'Loading models from your local CLI…';
    let catalog;
    try { catalog = await request({ type: 'get-models', provider: selectedProvider }); }
    catch (error) { catalog = { models: [], error: error.message }; }
    if (version !== requestVersion) return;
    models = catalog.models;
    catalogError = catalog.error || '';
    renderModels(drafts.get(selectedProvider) ?? settings);
  } catch (error) {
    if (version === requestVersion) connectionStatus.textContent = error.message;
  } finally {
    if (version === requestVersion) setLoading(false);
  }
}

model.addEventListener('change', () => renderEffort());
customModel.addEventListener('input', () => renderEffort(effort.value));
provider.addEventListener('change', () => {
  if (!loading) drafts.set(selectedProvider, selection());
  selectedProvider = provider.value;
  showStatus('Choose Save settings to use this CLI for new analyses. Running analyses keep their original settings.');
  void loadSettings(selectedProvider);
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  const version = ++requestVersion;
  const chosen = selection();
  if (!chosen.model) { showStatus('Choose a model or enter a custom model ID.', true); return; }
  setLoading(true);
  provider.disabled = true;
  try {
    const settings = await request({ type: 'save-settings', provider: selectedProvider, ...chosen });
    if (version !== requestVersion) return;
    drafts.set(selectedProvider, { model: settings.model, effort: settings.effort });
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
  drafts.set(selectedProvider, selection());
  void loadSettings(selectedProvider);
});

const preferencesForm = document.querySelector('#review-preferences-form');
const focus = document.querySelector('#review-focus');
const classification = document.querySelector('#classification-prompt');
const prioritization = document.querySelector('#prioritization-prompt');
const preferencesStatus = document.querySelector('#review-preferences-status');
const kinds = document.querySelector('#change-types');
for (const kind of changeKinds.filter(kind => kind !== 'unknown')) {
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.value = kind;
  label.append(input, document.createTextNode(kind[0].toUpperCase() + kind.slice(1)));
  kinds.append(label);
}

async function updateReviewPreferences(message) {
  for (const control of preferencesForm.elements) control.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.preferences || result.error) throw new Error(result?.error || 'Review preferences are unavailable.');
    const preferences = result.preferences;
    focus.value = preferences.focus;
    for (const input of kinds.querySelectorAll('input')) input.checked = preferences.alwaysShow.includes(input.value);
    classification.value = preferences.classificationPrompt || classificationPrompt;
    prioritization.value = preferences.prioritizationPrompt || prioritizationPrompt;
    preferencesStatus.dataset.error = 'false';
    preferencesStatus.textContent = message.type === 'save-review-preferences' ? 'Preferences saved. Saved reviews must match these preferences; changed preferences require a fresh analysis. Running analyses keep their original settings.' : '';
  } catch (error) {
    preferencesStatus.dataset.error = 'true';
    preferencesStatus.textContent = error.message;
  } finally {
    for (const control of preferencesForm.elements) control.disabled = false;
  }
}

document.querySelector('#reset-classification').addEventListener('click', () => { classification.value = classificationPrompt; });
document.querySelector('#reset-prioritization').addEventListener('click', () => { prioritization.value = prioritizationPrompt; });
preferencesForm.addEventListener('submit', event => {
  event.preventDefault();
  void updateReviewPreferences({ type: 'save-review-preferences', preferences: {
    focus: focus.value,
    alwaysShow: [...kinds.querySelectorAll('input:checked')].map(input => input.value),
    classificationPrompt: classification.value.trim() === classificationPrompt ? '' : classification.value,
    prioritizationPrompt: prioritization.value.trim() === prioritizationPrompt ? '' : prioritization.value
  } });
});

const cacheForm = document.querySelector('#cache-form');
const cacheLimit = document.querySelector('#cache-limit');
const cacheSave = document.querySelector('#save-cache-limit');
const cacheClear = document.querySelector('#clear-cache');
const cacheStatus = document.querySelector('#cache-status');

async function updateCache(message) {
  let empty = false;
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
    empty = info.count === 0;
    if (message.type === 'clear-cache') cacheStatus.textContent = 'Saved reviews cleared. Open reviews in other tabs remain available.';
    if (message.type === 'set-cache-limit') cacheStatus.textContent = 'Cache limit saved.';
  } catch (error) {
    cacheStatus.textContent = error.message;
    cacheStatus.dataset.error = 'true';
  } finally {
    cacheLimit.disabled = false;
    cacheSave.disabled = false;
    cacheClear.disabled = empty;
  }
}

cacheForm.addEventListener('submit', event => {
  event.preventDefault();
  void updateCache({ type: 'set-cache-limit', limitMB: Number(cacheLimit.value) });
});
cacheClear.addEventListener('click', () => { void updateCache({ type: 'clear-cache' }); });

await Promise.all([loadSettings(), updateReviewPreferences({ type: 'get-review-preferences' }), updateCache({ type: 'cache-info' })]);
