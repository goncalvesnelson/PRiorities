// Opens a visible Chrome window with the built extension and a fixture PR, for checking UI changes.
// It uses a throwaway profile, fake GitHub pages and a fake Codex CLI: no live model calls and
// nothing touches your own Chrome profile. Close the window to finish.
//
//   npm run preview            light theme
//   npm run preview -- --dark  GitHub dark theme
//   npm run preview -- --shot=out.png   headless: save a screenshot once the review is ready, then exit
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNativeHost } from './install-native-host.mjs';

const dark = process.argv.includes('--dark');
const shot = process.argv.find(arg => arg.startsWith('--shot='))?.slice('--shot='.length);
const prUrl = 'https://github.com/microsoft/vscode/pull/200000';
const headSha = '9ed10330f92962e92c6b121fd0cf6588268e89a8';
const sourcePath = 'src/vs/editor/contrib/suggest/browser/suggestWidgetRenderer.ts';
const classic = await readFile(new URL('test-fixtures/github-classic.html', import.meta.url), 'utf8');
const blob = JSON.parse(await readFile(new URL('test-fixtures/github-source.json', import.meta.url), 'utf8'));
const sourcePage = `<script type="application/json" data-target="react-app.embeddedData">${JSON.stringify({ payload: { blob } }).replace(/</g, '\\u003c')}</script>`;
const theme = dark
  ? ':root{--color-prettylights-syntax-keyword:#ff7b72;--color-prettylights-syntax-constant:#79c0ff;--color-prettylights-syntax-string:#a5d6ff;--color-prettylights-syntax-entity:#d2a8ff;--color-prettylights-syntax-comment:#9198a1}body{color:#f0f6fc;background:#0d1117}.file{border-color:#3d444d}.file-header{background:#151b23}.blob-code-addition,.blob-num-addition{background:#12261e}.blob-code-deletion,.blob-num-deletion{background:#331c1f}.blob-code-hunk,.blob-num-hunk{background:#162536;color:#9198a1}.blob-num{color:#9198a1}a{color:#4493f8}'
  : ':root{--color-prettylights-syntax-keyword:#cf222e;--color-prettylights-syntax-constant:#0550ae;--color-prettylights-syntax-string:#0a3069;--color-prettylights-syntax-entity:#6639ba;--color-prettylights-syntax-comment:#59636e}body{color:#1f2328;background:#fff}.file{border-color:#d1d9e0}.file-header{background:#f6f8fa}.blob-code-addition,.blob-num-addition{background:#dafbe1}.blob-code-deletion,.blob-num-deletion{background:#ffebe9}.blob-code-hunk,.blob-num-hunk{background:#ddf4ff;color:#59636e}.blob-num{color:#59636e}a{color:#0969da}';
const pageStyle = `<style>${theme}body{margin:24px;font:14px system-ui}main{max-width:1300px;margin:auto}.file{border:1px solid;border-radius:6px;margin:16px 0}.file-header{padding:12px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}.blob-code-inner{white-space:pre;font:12px ui-monospace,monospace}.blob-num{width:45px;text-align:right;padding:0 8px;font:12px ui-monospace,monospace}.sr-only,template{display:none}</style>`;
const filesPage = `<!doctype html><html data-color-mode="${dark ? 'dark' : 'light'}"><meta charset="utf-8">${pageStyle}<main><h1 class="js-issue-title">Apply font variation settings to suggestions</h1><a href="/microsoft/vscode/pull/200000/files">Files changed <span class="Counter">1</span></a>${classic.replace(/^.*?<main>/s, '').replace(/<\/main>\s*$/, '')}</main></html>`;
const discussionPage = '<main><div id="issue-1"><div class="js-comment-body">Apply editor font variation settings to suggestion labels, so suggestions match the editor when a variable font is configured.</div></div></main>';

const classifications = [
  { editId: '0-0-3', kinds: ['behavior'], reason: 'Reads `fontVariationSettings` from the editor font info so the renderer can apply it.', uncertainty: '' },
  { editId: '0-1-3', kinds: ['behavior'], reason: 'Applies the variation settings to the label element style.', uncertainty: '' }
];
const assessment = {
  summary: 'The author reports that suggestion labels ignore the editor’s font variation settings. The change reads `fontVariationSettings` from the editor font info and applies it to each label’s style.',
  topics: [
    {
      id: 'apply-variation', priority: 'review', title: 'Suggestion labels apply the editor’s font variation settings',
      gist: 'Where `ItemRenderer` reads and applies `fontVariationSettings`.',
      before: 'Suggestion labels used the editor font family and features, but not its variation settings.',
      after: 'Each rendered label sets `fontVariationSettings` from the editor font info.',
      reason: 'Users of variable fonts saw suggestions in a different weight or width than the editor text.',
      questions: ['Does `main.style.fontVariationSettings` also need resetting when the font info changes?', 'Should other widgets that copy `fontFeatureSettings` copy variation settings too?'],
      uncertainty: 'The code that re-renders labels on configuration changes is not part of the diff.',
      editIds: ['0-0-3'],
      excerpts: [{ path: sourcePath, side: 'after', startLine: 137, endLine: 137, note: 'Reads `fontVariationSettings` alongside the existing font family and features.' }]
    },
    {
      id: 'label-style', priority: 'supporting', title: 'The label style receives the setting',
      gist: 'One assignment on `main.style`, mirroring the existing font feature line.',
      before: 'The label style set only the font family and features.',
      after: 'The label style also sets `fontVariationSettings`.',
      reason: 'It follows the same pattern as the surrounding style assignments, so it needs less attention.',
      questions: [], uncertainty: '',
      editIds: ['0-1-3'],
      excerpts: [{ path: sourcePath, side: 'after', startLine: 151, endLine: 151, note: 'Assigns the value read above to `main.style`.' }]
    }
  ]
};

const profile = await mkdtemp(join(tmpdir(), 'priorities-preview-'));
const fakeCli = join(profile, 'fake-codex.mjs');
await writeFile(fakeCli, `#!${process.execPath}
import { readFile, writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args.includes('login')) { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }
if (args.includes('app-server')) {
  const { createInterface } = await import('node:readline');
  createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') console.log(JSON.stringify({ id: 1, result: {} }));
    if (message.method === 'model/list') console.log(JSON.stringify({ id: 2, result: { data: [{ model: 'preview-model', displayName: 'Preview model (fake)', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium', isDefault: true }], nextCursor: null } }));
  });
} else {
  for await (const _ of process.stdin) {}
  const schema = JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  const result = schema.required.includes('edits') ? { edits: ${JSON.stringify(classifications)} } : { ...${JSON.stringify(assessment)}, classifications: ${JSON.stringify(classifications)} };
  console.log(JSON.stringify({ type: 'turn.started' }));
  await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(result));
}
`, { mode: 0o755 });
await installNativeHost({ browserProfileDirectory: profile, hostDirectory: join(profile, 'helper'), executablePath: fakeCli });

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--remote-debugging-pipe', '--enable-unsafe-extension-debugging', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--window-size=1600,1000', ...(shot ? ['--headless=new'] : []), 'about:blank'
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let sequence = 0;
let incoming = '';
const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
});
chrome.stdio[4].on('data', chunk => {
  incoming += chunk.toString();
  let boundary;
  while ((boundary = incoming.indexOf('\0')) >= 0) {
    const message = JSON.parse(incoming.slice(0, boundary));
    incoming = incoming.slice(boundary + 1);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request?.reject(new Error(message.error.message));
      else request?.resolve(message.result);
    } else if (message.method === 'Fetch.requestPaused') void route(message).catch(() => {});
  }
});

async function route({ params: { request, requestId }, sessionId }) {
  const url = new URL(request.url);
  if (url.origin !== 'https://github.com') return send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId);
  let status = 200;
  let body = '<main>Not part of the preview fixture.</main>';
  if (url.pathname.endsWith('/files')) body = filesPage;
  else if (url.pathname === new URL(prUrl).pathname) body = discussionPage;
  else if (url.pathname.includes(`/blob/${headSha}/`) || url.pathname.includes('/blob/')) body = sourcePage;
  else status = 404;
  return send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(body).toString('base64') }, sessionId);
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if (await check()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`The preview did not become ready: ${label}.`);
}

try {
  const { id: extensionId } = await send('Extensions.loadUnpacked', { path: fileURLToPath(new URL('extension/', import.meta.url)) });
  const [tab] = (await send('Target.getTargets')).targetInfos.filter(target => target.type === 'page');
  const { sessionId } = await send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => (await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  await page('Page.navigate', { url: `chrome-extension://${extensionId}/options.html` });
  await waitFor(() => evaluate('!document.querySelector("#model").disabled'), 'settings page');
  const capture = async path => writeFile(path, Buffer.from((await page('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  if (shot) await capture(shot.replace(/\.png$/, '-settings.png'));
  await evaluate('document.querySelector("#settings-form").requestSubmit()');
  await waitFor(() => evaluate('document.querySelector("#status").textContent.includes("Settings saved")'), 'saving settings');
  await page('Fetch.enable', { patterns: [{ urlPattern: 'http*://*' }] });
  await page('Page.navigate', { url: `${prUrl}/files` });
  await waitFor(() => evaluate('Boolean(document.querySelector(".file"))'), 'PR page');
  // Opens the side panel the way the toolbar's Analyze this PR does; a user gesture is required.
  const helper = await send('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html` });
  const { sessionId: helperSession } = await send('Target.attachToTarget', { targetId: helper.targetId, flatten: true });
  await waitFor(async () => (await send('Runtime.evaluate', { expression: 'document.readyState === "complete" && typeof chrome.tabs?.getCurrent === "function"', returnByValue: true }, helperSession)).result?.value === true, 'helper page');
  await send('Runtime.evaluate', { userGesture: true, awaitPromise: true, expression: `(async () => {
    const helper = await chrome.tabs.getCurrent();
    const [tab] = (await chrome.tabs.query({})).filter(entry => entry.id !== helper.id);
    void chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html?tab=' + tab.id + '&start=1', enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
  })()` }, helperSession).then(({ exceptionDetails }) => {
    if (exceptionDetails) throw new Error(`Chrome would not open the side panel: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  });
  await send('Target.closeTarget', { targetId: helper.targetId });
  await send('Target.activateTarget', { targetId: tab.targetId });
  let panelSession;
  await waitFor(async () => {
    const target = (await send('Target.getTargets')).targetInfos.find(info => info.url.includes('/sidepanel.html'));
    if (target && !panelSession) ({ sessionId: panelSession } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }));
    return Boolean(panelSession);
  }, 'side panel');
  const inPanel = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, panelSession)).result?.value;
  if (shot) {
    await waitFor(() => inPanel('Boolean(document.querySelector(".rf-topic"))'), 'review');
    await new Promise(resolve => setTimeout(resolve, 1200));
    await capture(shot);
    const capturePanel = async suffix => writeFile(shot.replace(/\.png$/, `-${suffix}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' }, panelSession)).data, 'base64'));
    await capturePanel('panel');
    await inPanel('document.querySelector(".rf-section-files").scrollIntoView({ block: "center" })');
    await capturePanel('panel-files');
    const badge = await evaluate('(() => { const r = document.querySelector(".review-focus-native-toggle").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', ...badge });
    await new Promise(resolve => setTimeout(resolve, 300));
    await capture(shot.replace(/\.png$/, '-tooltip.png'));
    await inPanel('document.querySelector(".rf-code-refs .rf-ref").click()');
    await waitFor(() => evaluate('Boolean(document.querySelector(".review-focus-native-target"))'), 'reference click to highlight the diff');
    console.log(`Saved ${shot}, plus -panel, -panel-files, -settings and -tooltip variants.`);
    chrome.kill('SIGTERM');
  } else {
    console.log(`Preview open (${dark ? 'dark' : 'light'} GitHub). Analysis is running with a fake CLI in the side panel; close the Chrome window to finish.`);
    console.log('Only this first tab serves the fixture PR. Rebuild with npm run build:extension and rerun npm run preview after changes.');
  }
} catch (error) {
  console.error(`Preview failed: ${error.message}`);
  chrome.kill('SIGTERM');
}
await new Promise(resolve => chrome.once('exit', resolve));
await rm(profile, { recursive: true, force: true });
