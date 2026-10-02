import { build } from 'esbuild';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('./extension/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
await build({
  entryPoints: [fileURLToPath(new URL('background.js', root))],
  outfile: fileURLToPath(new URL('background.bundle.js', root)),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: false,
  legalComments: 'eof'
});
const files = [manifest.background.service_worker, manifest.options_ui.page, manifest.action.default_popup,
  'sidepanel.html', 'panel.js', 'panel.css', 'popup.js', 'popup.css',
  ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap(entry => [...entry.js, ...entry.css]),
  ...manifest.web_accessible_resources.flatMap(entry => entry.resources)];
await Promise.all(files.map(file => access(new URL(file, root))));
console.log('Chrome extension built in extension/. Load this folder as an unpacked extension.');
