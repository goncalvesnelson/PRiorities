import { createHash } from 'node:crypto';

const root = '/microsoft/vscode/pull/200000';
const baseSha = '998fb692680cc20d70a805df8fa59cb1443bc897';
const headSha = '9ed10330f92962e92c6b121fd0cf6588268e89a8';
const targetBaseSha = 'd'.repeat(40);
const fetchNonce = 'synthetic-fetch-nonce';
const release = 'synthetic-release';
const paths = Array.from({ length: 53 }, (_, index) => `tests/change-${index + 1}.ts`);
paths[4] = 'tests/space, comma % and ü.ts';
const entries = paths.map(path => ({
  isBinary: false,
  isSubmodule: false,
  isTooBig: false,
  diffLines: [
    { type: 'HUNK', text: '@@ -1 +1 @@', left: 0, right: 0 },
    { type: 'DELETION', text: `-before ${path}`, html: `-<span class="pl-k">before</span> ${path}`, left: 1, right: 0 },
    { type: 'ADDITION', text: `+after ${path}`, html: `+<span class="x x-first x-last"><span class="pl-k">after</span></span> ${path}`, left: 1, right: 1 }
  ],
  linesAdded: 1,
  linesDeleted: 1,
  linesChanged: 2,
  oldCommitOid: baseSha,
  newCommitOid: headSha,
  path,
  pathDigest: createHash('sha256').update(path).digest('hex'),
  status: 'MODIFIED',
  truncatedReason: null
}));
const route = {
  isSingleFileMode: false,
  comparison: { fullDiff: { baseOid: targetBaseSha, headOid: headSha }, selectedRange: null, viewing: 'FULL' },
  diffSummaries: entries.map(({ path, pathDigest, linesAdded, linesDeleted, linesChanged }) => ({ path, pathDigest, linesAdded, linesDeleted, linesChanged, changeType: 'MODIFIED' })),
  diffContents: entries.slice(0, 4),
  fileFilter: { initialState: { filterText: '', showDeletedFiles: true, showOnlyManifestFiles: false, showOnlyOwnedFiles: false, showVendoredFiles: true, showViewedFiles: true, unselectedFileExtensions: [] } },
  pageLimits: { filesLimit: 3000, filesLimitExceeded: false, linesChangedLimit: 10000, linesChangedLimitExceeded: false },
  pullRequest: { title: 'Synthetic Changes route fixture', number: 200000, pathName: root, comparison: { baseOid: targetBaseSha, headOid: headSha } },
  urls: { changes: `${root}/changes`, files: `${root}/files`, conversation: root },
  virtualizeDiffEntries: true
};
const splitTables = entries.slice(0, 4).map(({ path, pathDigest }) => `<section role="region" aria-labelledby="${pathDigest}">
  <div class="file-name"><code>${path}</code></div>
  <table data-diff-anchor="diff-${pathDigest}"><tbody>
    <tr class="diff-line-row"><td></td><td class="diff-line-number">1</td><td class="diff-text deletion"><span class="diff-text-inner">before ${path}</span></td><td class="diff-line-number">1</td><td class="diff-text addition"><span class="diff-text-inner">after ${path}</span></td></tr>
  </tbody></table>
</section>`).join('');

const unifiedTables = entries.slice(0, 3).map(({ path, pathDigest }) => `<section id="diff-${pathDigest}" role="region" aria-labelledby="${pathDigest}">
  <div data-diff-header-wrapper style="position:sticky;top:0;z-index:1;background:var(--bgColor-muted,#f6f8fa)"><div class="diff-file-header"><code>${path}</code><button class="js-expand-all-difflines-button" aria-label="Expand all lines: ${path}">Expand all</button></div></div>
  <table data-diff-anchor="diff-${pathDigest}"><tbody>
    <tr class="diff-line-row"><td class="new-diff-line-number">1</td><td class="new-diff-line-number empty-diff-line"></td><td class="diff-text-cell"><code class="diff-text deletion"><span class="diff-text-inner">before ${path}</span></code></td></tr>
    <tr class="diff-line-row"><td class="new-diff-line-number empty-diff-line"></td><td class="new-diff-line-number">1</td><td class="diff-text-cell"><code class="diff-text addition"><span class="diff-text-inner">after ${path}</span></code></td></tr>
  </tbody></table>
</section>`).join('');

export const changes = {
  root, baseSha, headSha, fetchNonce, release, paths, entries, route,
  page(value = route, unified = false) {
    const data = { payload: { pullRequestsChangesRoute: value, userViewSettings: { splitPreference: 'split' } } };
    const files = (unified ? unifiedTables : splitTables).replaceAll('<section', '<div class="fixture-diff-entry"><section').replaceAll('</section>', '</section></div>');
    return `<!doctype html><title>Synthetic Changes route fixture</title><meta name="fetch-nonce" content="${fetchNonce}"><meta name="release" content="${release}"><style>.d-flex{display:flex!important}</style><main><h1 class="js-issue-title">Synthetic Changes route fixture</h1><div data-testid="diff-content"><div data-testid="progressive-diffs-list" class="d-flex flex-column">${files}</div></div></main><script type="application/json" data-target="react-app.embeddedData">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
  }
};
