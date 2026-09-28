# PRiorities Chrome extension

A local prototype for reviewing GitHub pull requests with Codex or Claude Code and your existing CLI login. It reads the PR you open, selects the decisions that deserve attention, and folds supporting code inside GitHub’s diff. Chrome starts a local helper when needed. No API key, running HTTP server, or GitHub token is required.

## Load it

Build the extension and register the helpers with Node 24 and at least one installed CLI:

```sh
git clone https://github.com/goncalvesnelson/PRiorities.git
cd PRiorities
npm ci
npm run build:extension
npm run install:cli-host
```

The installer registers every supported CLI it finds on PATH. To use Codex, check `codex login status` and sign in with `codex login`. To use Claude Code, check `claude auth status` and sign in with `claude auth login`. The helpers use those logins without reading or copying credentials. After installing, Chrome launches the selected helper automatically; no terminal process needs to stay open. Re-run the installer when adding a CLI to an existing installation.

For an existing installation, choose **Reload** in `chrome://extensions`, then refresh the PR page. Chrome may request the new native-messaging permission. For a fresh installation:

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**, choose **Load unpacked**, and select this folder:

   `PRiorities/extension` inside your checkout

3. Open **PRiorities** from Chrome’s extensions menu, choose **Codex** or **Claude Code**, and choose **Check connection**, then **Save settings**. It should report the selected CLI's login.
4. Open a PR's **Files changed** tab, refresh it if it was already open, then choose **Analyze PR** in the PRiorities panel. For native folding, choose **Unified** in GitHub’s diff view settings (the gear button). GitHub’s current Changes page may keep its saved Split preference even when its URL requests unified view.

Choose any PR you can read. Fresh analysis uses the current captured PR; no prepared review is bundled.

Leave Model blank to use the selected CLI’s default, or enter a model ID available to your account. Claude Code also accepts aliases such as `sonnet` or `opus`. Each CLI has a separate saved model preference. Reviews use the selected account’s allowance. Codex remains the default after upgrading; selecting a different CLI takes effect after **Save settings**, for new reviews only. A running review keeps its original CLI and model through retries and **Review anyway**. [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference), [programmatic execution](https://code.claude.com/docs/en/headless).

## Review a change

Analysis captures the PR once, then reviews three files concurrently. Each file runs two sequential sessions with the selected CLI: classification followed by prioritization. Progress appears beside each loaded file and in the panel’s file progress list. A completed file immediately shows its initial review and focuses its diff; queued, failed, cancelled, and unavailable files stay expanded. **Retry file** reruns only that file against the same captured commits.

GitHub-marked generated files and known lockfile names are excluded by default. Their headers and the file progress list show **Generated · not reviewed**, with a **Review anyway** button. Excluded files use no model calls, are omitted from the cross-file check, and are not folded by PRiorities. An all-generated PR makes no model calls until you choose a file. The extension does not change GitHub's own collapsed-file state.

**Review anyway** adds that file to the queue using the same captured commits. It works while other files run or after they finish. Completed file reviews remain available; the final cross-file check runs again with the newly included file. If a check is already running, it is cancelled and replaced after the requested file finishes.

Once all included text files succeed, a final session checks relationships across those files. It may change priorities and restore lines that an initial file review folded. Until that check succeeds, file reviews are labelled provisional. A failed final check preserves them and offers **Retry cross-file check**. Each file pipeline and the final check have separate ten-minute deadlines; there is no deadline on total PR duration. The selected CLI manages its own network retries; the extension does not automatically repeat failed analysis.

This uses more sessions than whole-PR analysis: two per included text file plus one final check (nine sessions for four ordinary text files and one excluded lockfile). Requesting that lockfile afterward adds three sessions: its two passes and a new final check. Three-way concurrency makes file results available sooner; it does not promise lower total latency or usage.

The opening view contains up to four review decisions with short source excerpts, visible before/after behavior, and specific evidence limits. Additional decisions keep their titles visible under **More review decisions**; expand one for its explanation and code. **Supporting evidence** lets you inspect related edits, including their change labels and reasons. The model can select no review decisions when the supplied code does not warrant any.

The native diff folds matching lower-priority rows behind explanations and **Show lines** controls. Edits classified as unresolved stay visible even if prioritization places them in a supporting topic. Excerpts belonging to additional review decisions also stay visible. **Show in diff** takes you to the corresponding source; **Full diff** restores the original rows. GitHub's comments, review controls, and viewed markers remain under your control. No comments, approvals, or repository changes are posted.

Analysis starts only when you click **Analyze PR** or **Run fresh review**. **Cancel** stops capture or terminates every active local review process and cancels queued files, retaining completed file reviews. Retry cancelled files individually to continue. A changed revision cancels the queue, restores all folded rows, and requires fresh analysis.

The progress panel distinguishes reading the PR, reviewing its files, and checking related changes. Its progress bar counts completed file reviews; it does not estimate model completion time. The file list can show all files, files needing attention, completed files, or skipped files. Pending and failed files keep their code visible.

## Saved reviews

Completed reviews are saved locally, including their explanations, classifications, and selected code excerpts. The cache uses 100 MB by default; **Settings → Saved reviews** lets you choose 1–1024 MB, view usage, or clear saved reviews. When it fills, the least recently used reviews are removed first. Reducing the limit immediately evicts entries until usage fits. A single review larger than the limit stays available in its tab but is not cached. Browser storage limits can prevent saving without interrupting the review.

On a return visit, **Open saved review** appears when a review exists for the commit pair and selected CLI/model. Opening it captures the current context and checks a SHA-256 fingerprint covering the PR URL, base and head commits, title, description, diffs, captured source, evidence limits, provider, model preference, and cache format version. An exact match restores the review without new model calls. Changed context requires **Run fresh review**, even if the commits have not changed; opening an outdated saved review never starts analysis automatically. **Run fresh review** always bypasses the cache.

Only completed cross-file reviews are cached. In-progress and failed sessions remain available in their current tab, but are not resumed after a reload. Generated files remain excluded unless that saved review already included an explicit **Review anyway** request. You can still request an excluded file after reopening a saved review. The cache uses IndexedDB inside the extension and is not synced to another browser or account.

## What goes to the selected CLI

Each file session receives the PR title and description, that file’s complete captured diff and available surrounding source, and an inventory of included paths. The final check receives evidence for the included files, validated edit classifications, and compact provisional decisions. It names excluded generated paths as an evidence limit, without their source. Codex sends this evidence to OpenAI; Claude Code sends it to Anthropic. Full before/after source is collected for up to six runtime files, within a size budget. Generated files are omitted from this source collection. Tests and other files remain represented by their diffs. Running file by file does not add source context that capture did not collect.

Generated diffs are still captured locally at the start so **Review anyway** can use the pinned snapshot. Their diff and source contents are omitted from every model request until you choose them. Capture size limits and completeness checks therefore still apply to generated files. Detection uses GitHub's generated flag in React diff data plus explicit lockfile names, including `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `composer.lock`, `Gemfile.lock`, `poetry.lock`, and `uv.lock`; it does not guess from directory names.

The extension reads up to three same-repository GitHub issues linked from the original PR description, including plain `Fixes #123` references. It includes their titles, URLs, and original descriptions, bounded to 4,000 characters per issue. Later comments and cross-repository issues are not retrieved. **Capture limitations** reports missing or truncated context. There is no cross-repository knowledge-center integration.

The extension stores your selected CLI, each CLI's model preference, and the local review cache described above. Any saved Anthropic API key from the older prototype is removed on upgrade and is never passed to a helper. Login credentials remain managed by their respective CLIs. Claude Code support uses its Claude login, not an API key or third-party provider configuration.

Both native hosts are restricted to this extension’s ID. Each session runs in a private temporary directory. Codex uses a read-only sandbox, ephemeral sessions, and disabled approvals, user configuration, tools, hooks, and personal skill discovery. Claude Code uses safe mode, an empty tool list, no session persistence, no personal settings sources, and an empty strict MCP configuration. Authentication remains available; administrator-managed Claude policies still apply. The helper deletes its temporary instructions, schema, and results after completion or cancellation. It does not change either CLI's global configuration. See [Claude Code safe mode](https://code.claude.com/docs/en/cli-reference) for the managed-policy boundary.

## Prototype boundaries

- Native folding supports recognized unified diff rows in GitHub's classic and React layouts. Split-view rows, unknown layouts, unrecognized source, inline discussion rows, and unavailable binary diffs remain visible. Use unified view to test folding.
- Capture reads the complete file inventory on GitHub's current Changes page and fetches missing diffs, including large files and generated files that require GitHub’s separate Load diff endpoint. It also follows paginated and deferred classic diffs and checks their total file count. Capture includes whitespace changes and validates paths, line counts, and commit revisions before analysis. It supports up to 100 files and a bounded input size; incomplete or truncated diffs stop capture before any analysis starts.
- Priorities are model judgments, not proofs of equivalence. Supporting changes remain available and may still require review.
- Both file passes must account for every edit in that file; the final check accounts for every included edit. Generated exclusions are shown separately from reviewed files. A missing or duplicated edit, an invalid source reference, or a review decision without evidence from its own changed code prevents that result from being applied. Each initial file review has a 60-line excerpt limit; the final review has a 60-line limit across the included files.
- The extension runs on `github.com`; GitHub Enterprise hosts are outside this prototype.
- The local helper installer targets Google Chrome on macOS. It was developed against Codex CLI 0.156.1 and Claude Code 2.1.283; older versions may lack the required execution flags.
- Input and result sizes are bounded for Chrome native messaging. Oversized results fail visibly instead of applying a partial review.

## Development and verification

Requires Node 24 and Google Chrome installed at its standard macOS path.

```sh
npm ci
npm run verify:extension
```

The verification command builds the extension, then checks the native hosts, background/runtime flows, and installed extension in a temporary Chrome profile. `npm run verify` runs the same suite. Rebuild after edits, choose **Reload** in `chrome://extensions`, and refresh the PR page.

The checks cover both CLI providers, message framing and process cleanup, credential isolation, complete diff capture, separate classification and prioritization, three concurrent file pipelines, isolated retry and cancellation, generated-file opt-in, native folding/restoration, and saved-review invalidation and eviction. They use deterministic fake CLIs plus public or synthetic [GitHub fixtures](test-fixtures/README.md). They do not call a live model or establish classification accuracy.

The earlier standalone prototype and its private PR fixture are not included in this repository. No separate repository checkout is needed to run these tests.

Retryable sessions retain a heartbeat while the PR remains open; completed sessions with excluded files also remain available for **Review anyway**. Closing the tab releases the session. Completed cached reviews can be reopened; unfinished work does not resume after a reload.

The [literature notes](review-literature-research.md) record the research behind the review flow and the evaluation still needed. The [Laya assessment](laya-fit-research.md) explains why it has not replaced semantic classification. Their dated implementation sections describe earlier prototype versions.

## Helper installation and removal

`node install-native-host.mjs` (also available as `npm run install:cli-host` in the source project) registers `com.review_focus.codex` and/or `com.review_focus.claude` in this user’s Chrome `NativeMessagingHosts` directory for the CLIs it finds, and prints the installed paths. It pins Node, the provider, and the CLI executable paths so it does not depend on Chrome’s shell PATH. Re-run the installer if those executables move. Run the installer from the repository root.

Removing the extension stops its access to the helpers. To remove the registrations too, delete `com.review_focus.codex.json` and `com.review_focus.claude.json` from `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, plus the helper directory printed by the installer. This does not sign you out of either CLI or remove the CLIs themselves.
