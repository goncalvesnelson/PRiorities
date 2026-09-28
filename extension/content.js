(async () => {
  const { startReviewUI } = await import(chrome.runtime.getURL('review-ui.js'));
  startReviewUI();
})().catch(error => {
  console.warn('PRiorities could not start:', error.message);
});
