// The toolbar dropdown. Analyze opens the PRiorities side panel for this tab only, and only then
// does PRiorities touch the GitHub page. On a PR's conversation tab it switches to Files changed.
const analyze = document.querySelector('#analyze');
const hint = document.querySelector('#hint');
const pullRequest = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
const diffPage = /^\/[^/]+\/[^/]+\/pull\/\d+\/(?:(?:files|changes)(?:\/|$)|commits\/[a-f0-9]{40}(?:\/|$))/;

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const match = tab?.url && pullRequest.exec(tab.url);
analyze.disabled = !match;
hint.textContent = match ? '' : 'Open a GitHub pull request to analyze it.';

analyze.addEventListener('click', () => {
  if (!match) return;
  // sidePanel.open must run straight from the click, so nothing here is awaited before it.
  void chrome.sidePanel.setOptions({ tabId: tab.id, path: `sidepanel.html?tab=${tab.id}&start=${Date.now()}`, enabled: true });
  void chrome.sidePanel.open({ tabId: tab.id });
  if (!diffPage.test(new URL(tab.url).pathname)) void chrome.tabs.update(tab.id, { url: `${match[0]}/files` });
  window.close();
});
document.querySelector('#settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
