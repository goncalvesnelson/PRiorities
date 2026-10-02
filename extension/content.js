// PRiorities stays out of GitHub's page until its side panel connects to this tab.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'priorities-panel' || port.sender?.id !== chrome.runtime.id) return;
  const queued = [];
  const queue = message => queued.push(message);
  let closed = false;
  port.onMessage.addListener(queue);
  port.onDisconnect.addListener(() => { closed = true; });
  import(chrome.runtime.getURL('page-agent.js')).then(({ startPageAgent }) => {
    port.onMessage.removeListener(queue);
    if (!closed) startPageAgent(port, queued);
  }).catch(error => {
    console.warn('PRiorities could not start:', error.message);
    port.disconnect();
  });
});
