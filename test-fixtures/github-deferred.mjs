const root = '/microsoft/vscode/pull/200000';
const paths = Array.from({ length: 53 }, (_, index) => `tests/change-${index + 1}.ts`);
const placeholders = paths.map((path, index) => `<div class="js-file" data-tagsearch-path="${path}">
  <div class="file-header" data-path="${path}">${path}</div>
  <include-fragment class="js-diff-entry-loader" data-fragment-url="${root}/deferred-diff/${index + 1}">
    <button type="button" class="js-diff-load">Load diff</button>
  </include-fragment>
</div>`);
const opening = `<main><h1 class="js-issue-title">Synthetic deferred diff fixture</h1>
  <include-fragment src="${root}/partials/tabs?tab=files"></include-fragment>
  <div data-url="/microsoft/vscode/diffs/998fb692680cc20d70a805df8fa59cb1443bc897..9ed10330f92962e92c6b121fd0cf6588268e89a8"></div>
  <div class="js-diff-progressive-container">${placeholders.slice(0, 4).join('')}`;

export const deferred = {
  paths,
  initial: `${opening}<include-fragment src="${root}/deferred-page/2"></include-fragment></div></main>`,
  missing: `${opening}</div></main>`,
  unexpected: `${opening}<include-fragment src="https://github.com/other/repo/deferred-page/2"></include-fragment></div></main>`,
  pages: new Map([
    [`${root}/partials/tabs?tab=files`, '<a data-tab-item="files-tab"><span id="files_tab_counter" class="Counter">53</span></a>'],
    [`${root}/deferred-page/2`, placeholders.slice(4).join('')],
    ...paths.map((path, index) => [`${root}/deferred-diff/${index + 1}`, `<table>
      <tr><td class="blob-code-hunk">@@ -1 +1 @@</td></tr>
      <tr><td id="diff-${index}L1" data-line-number="1"></td><td class="blob-code-inner" data-code-marker="-">before ${path}</td></tr>
      <tr><td id="diff-${index}R1" data-line-number="1"></td><td class="blob-code-inner" data-code-marker="+">after ${path}</td></tr>
    </table>`])
  ])
};
