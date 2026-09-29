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

After pulling changes, run `npm ci`, `npm run build:extension`, and `npm run install:cli-host`, then choose **Reload** in `chrome://extensions` and refresh the PR page. Reloading or disabling the extension stops its UI in already-open pages and restores folded code; refresh the page after enabling or reloading it to reconnect. Completed saved reviews remain available, but unfinished analyses do not survive an extension reload. The installer copies the native helper; reloading Chrome alone does not update that copy. If you use `CODEX_HOME` or `CLAUDE_CONFIG_DIR`, set the same directory when rerunning the installer. For a fresh installation:

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**, choose **Load unpacked**, and select this folder:

   `PRiorities/extension` inside your checkout

3. Open **PRiorities** from Chrome’s extensions menu, choose **Codex** or **Claude Code**, and choose **Check connection**, then **Save settings**. It should report the selected CLI's login.
4. Open a PR's **Files changed** tab, refresh it if it was already open, then choose **Analyze PR** in the PRiorities panel. For native folding, choose **Unified** in GitHub’s diff view settings (the gear button). GitHub’s current Changes page may keep its saved Split preference even when its URL requests unified view.

Choose any PR you can read. Fresh analysis uses the current captured PR; no prepared review is bundled.

Selecting commits in GitHub changes the analysis scope. On a commit-range diff, **Analyze range** reads every file in that comparison, and the toolbar shows its base and head commits. File classifications, the final check, source context, and saved reviews all use that pair. The PR description and linked issues still provide intent, but may describe work outside the selected range. Navigation to Checks and reloads reconnect to the same range analysis. Changing the comparison’s commit pair clears the current analysis session; completed reviews remain cached separately by commit pair.

Settings loads the model catalog from your installed CLI. Choose a model and one of its supported reasoning effort levels, then **Save settings**. **Custom model ID…** lets you enter a specific release, including older versions; for a custom ID absent from the catalog, the CLI checks effort support when analysis starts. Each CLI has separate model and effort preferences. Reviews use the selected account’s allowance.

The PR panel displays the CLI, model ID, and effort used by the analysis. Catalog selections use resolved model IDs and explicit effort where supported. A custom model with **Model default** leaves effort to the CLI and is labelled accordingly. A running analysis keeps its original CLI, model, effort, and review preferences through retries and **Review anyway**, even if you change Settings. Model discovery makes no analysis requests. [Codex model catalog](https://learn.chatgpt.com/docs/app-server), [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference).

When you return from Settings after changing the CLI, model, or effort, **Analyze PR** appears in the toolbar once the current analysis is idle. A notice identifies the settings it will use. The existing review keeps its original model label and explanations until you choose to analyze again; changing settings does not start an analysis. Returning to the review’s original settings moves the rerun action back into **More actions**.

## Configure what stays visible

In **Settings → What should stay visible?**, choose **Selective**, **Balanced**, or **Thorough** focus. Selective concentrates on consequential decisions and the code needed to assess them; Balanced asks for more implementation and test context; Thorough asks for more distinct changes worth inspecting. These guide the model’s judgment without line, excerpt, or decision quotas. Important changes should remain visible with sufficient context; lower-priority details should be deferred for a stated reason. The model is instructed to check for both omitted important evidence and unnecessary excerpts.

**Always keep these change types visible** prevents PRiorities from folding edits with the selected classifications, regardless of the model’s priority or excerpts. It applies to analyzed files and depends on the classifier’s labels. Unresolved edits, every changed line in a review decision, and discussion rows always remain visible. Generated files still need **Review anyway** before analysis.

**Always keep these files visible** lists paths that never fold, whatever the model decides. Enter one path per line; it matches at any depth, so `go.mod` covers `services/api/go.mod`. End a line with `/` to cover a whole folder, such as `migrations/`. The default list covers common dependency manifests, `Dockerfile`, `.github/workflows/` and `migrations/`; edit it to match your repositories. Protected files are still analyzed and explained, and their file panel says why they stay expanded.

**Advanced: edit analysis prompts** exposes the full classification and prioritization instructions. Classification labels every edit; prioritization chooses the decisions and source excerpts to show. Classification runs once per file; prioritization runs once for the whole PR. Reset either editor to restore its built-in prompt, then choose **Save review preferences**. The extension still adds source-handling rules, validates results, and enforces visibility controls. Custom instructions cannot disable those checks.

Preferences apply to new analyses and are included in saved-review fingerprints. Changing focus, always-visible types, or prompts requires a fresh analysis; completed results already open in a tab retain their original preferences.

## Review a change

PRiorities appears in GitHub’s **Files changed**, **Changes**, and individual commit diffs. Its panel and file explanations are hidden on Conversation, the Commits list, and Checks.

Analysis captures the selected comparison once, then classifies three files concurrently, one session with the selected CLI per file. Progress appears beside each loaded file and in the panel’s file progress list. Files show only their status while classification runs: no explanations appear and the diff stays expanded until review decisions across those files arrive. **Retry file** reruns only that file’s classification against the same captured commits.

GitHub-marked generated files and known lockfile names are excluded from AI analysis by default. Their headers and the file progress list identify them as skipped by the AI, with a **Review anyway** button. Excluded files use no model calls, are omitted from the PR review, and are not folded by PRiorities. An all-generated PR makes no model calls until you choose a file. Skipping a file does not change GitHub's own collapsed-file state or your review checkmark.

**Review anyway** adds that file to the queue using the same captured commits. It works while other files run or after they finish. Completed classifications are kept; review decisions for the PR are chosen again with the newly included file. The previous explanations and folds are withdrawn immediately. Code stays expanded until the replacement review succeeds, including if it fails or is cancelled. If that review is already running, it is cancelled and replaced after the requested file is classified.

Once all included text files are classified, one session reads the entire captured comparison with those classifications, connects related changes across files, and chooses the review decisions. The diff folds only when this review succeeds. A failed review keeps the classifications and offers **Retry review decisions**. Each file classification and the final review have separate ten-minute deadlines; there is no deadline on total analysis duration. The selected CLI manages its own network retries; the extension does not automatically repeat failed analysis.

This uses one session per included text file plus one PR review (five sessions for four ordinary text files and one excluded lockfile). Requesting that lockfile afterward adds two sessions: its classification and a new PR review. Three-way concurrency shortens classification; it does not promise lower total latency or usage.

The toolbar shows AI progress and your GitHub Viewed count, with the selected model and effort underneath. Choose one of three views: **Full diff** shows all code without PRiorities explanations; **Explained** shows all code with explanations beside each file; **Folded** shows those same explanations and collapses supporting code. Switching views reuses the existing analysis without model calls. Use the arrow keys, Home, or End while the view control is focused. Expanded Details stay open when switching between Explained and Folded. The **More actions** menu (⋯) contains Settings and, after analysis, **Run fresh review**. Beside each loaded file, two short paragraphs explain what changed and why it is shown. Evidence limits remain visible. **Details** reveals the review question, previous behavior, selected source excerpts, and edit classifications; supporting explanations stay collapsed. **Review summary** opens the overall assessment, every decision including unloaded files, folding counts, cache information, revision, and capture limitations. The model can select no review decisions when the supplied code does not warrant any.

The native diff folds matching lower-priority rows behind a line count and **Show** control; **Hide** folds those rows again. Edits classified as unresolved stay visible even if prioritization places them in a supporting topic. Every changed line in a review decision stays visible, including lines outside its selected excerpts; only the unchanged context around it can fold. Files matching your protected paths never fold. **Show in diff** takes you to the corresponding source; **Full diff** restores the original rows. GitHub's comments, review controls, and viewed markers remain under your control. No comments, approvals, or repository changes are posted.

Analysis starts only when you click **Analyze PR** or **Run fresh review**. **Cancel** stops capture or terminates every active local review process and cancels queued files, retaining completed classifications. Retry cancelled files individually to continue. A changed revision cancels the queue, restores all folded rows, and requires fresh analysis.

Once capture finishes, unfinished analysis continues when you switch to Conversation, Checks, or Commits, or reload the page in the same browser tab. Returning to the diff reconnects automatically, restoring file progress, completed explanations, and the original model, effort, and review preferences. It uses the captured evidence without repeating completed classifications. Closing that browser tab ends the session. Leaving during the initial capture interrupts capture; no background analysis has started yet.

The progress control counts completed AI file analyses separately from your GitHub Viewed files and identifies the current phase, cancellation, or failure. Click it to open or close the file list; analysis and reconnection leave the list closed until you request it. Progress updates preserve your choice. Each native file header has a small AI status label: waiting, classifying, classified, ready, skipped, or needing retry. **AI ready** means its review decisions are available, not that you have reviewed it. The file list's **Reviewed by you** checkmark operates GitHub's Viewed control. **To review** includes files not confirmed Viewed, including those explicitly labelled with unknown status; **Reviewed** shows confirmed checkmarks, while **AI needs retry** shows failed or cancelled analyses. Important model decisions remain available in Review summary. Pending and failed files keep their code visible.

Use GitHub's **Viewed** checkbox beside each diff as you finish reading it. PRiorities reflects that state in its progress counts and filters, without adding a second checkbox to the diff. The **Reviewed by you** shortcut in the file list operates the same native control, so GitHub manages the saved marker and file collapse. When you mark a file Viewed, PRiorities also hides its adjacent explanations. Unchecking Viewed restores them with their open details preserved; Review summary remains available while the file is marked. AI completion, rerunning analysis, and clearing the review cache do not mark files for you. GitHub removes the Viewed marker when that file changes. See [GitHub's reviewed-file workflow](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request#marking-a-file-as-viewed).

If GitHub has not supplied a file's review state, it is shown as unavailable rather than assumed unreviewed. Load the file in GitHub's full files view when its control is unavailable. PRiorities mirrors GitHub's displayed state and does not independently confirm GitHub's server save.

## Saved reviews

Completed reviews are saved locally, including their explanations, classifications, and selected code excerpts. The cache uses 100 MB by default; **Settings → Saved reviews** lets you choose 1–1024 MB, view usage, or clear saved reviews. When it fills, the least recently used reviews are removed first. Reducing the limit immediately evicts entries until usage fits. A single review larger than the limit stays available in its tab but is not cached. Browser storage limits can prevent saving without interrupting the review.

On a return visit, **Open saved review** appears when a review exists for the commit pair and selected CLI, model, effort, and review preferences. Opening it captures the current context and checks a SHA-256 fingerprint covering the PR URL, base and head commits, title, description, diffs, captured source, evidence limits, provider, model, effort, review preferences (including custom prompts), and cache format version. An exact match restores the review without new model calls. Changed context requires **Run fresh review**, even if the commits have not changed; opening an outdated saved review never starts analysis automatically. **Run fresh review** always bypasses the cache.

Only completed PR reviews are cached. In-progress, failed, and cancelled sessions reconnect after navigation or a reload in the same browser tab. They do not survive closing that tab, restarting Chrome, or reloading the extension. A result that finishes while you are away is shown on return. Completed, delivered reviews saved successfully use **Open saved review** on a later reload. File analysis controls are unavailable while a saved review is opening. Generated files remain excluded unless that saved review already included an explicit **Review anyway** request. You can still request an excluded file after reopening a saved review. The cache uses IndexedDB inside the extension and is not synced to another browser or account.

A context mismatch or failed restoration leaves the saved review intact. Cache lookup, storage and validation failures show an error and never automatically start a fresh analysis; they are not reported as context mismatches. The main action becomes **Run fresh review**; **Retry saved review** lets you try capture again without starting model calls. The same failed saved entry stays secondary in that page until a different saved result becomes available or you reload. A temporary source or linked-issue fetch failure can prevent restoration until capture succeeds again, but it does not delete the earlier result. Cancelling a PR review aborts an uncommitted cache write, preserving any earlier saved review.

## What goes to the selected CLI

Each file classification receives that file’s complete captured diff and available surrounding source, and an inventory of included paths. It does not receive the PR title, description or linked issues, so the author’s framing cannot steer how edits are labelled. The PR review receives the PR title, description and linked issues, evidence for the included files, and their validated edit classifications. It also lists, for each file and side, the line ranges it may cite: the whole file when full source was captured, otherwise only the diff rows. An excerpt outside those ranges still fails validation. It names excluded generated paths as an evidence limit, without their source. Codex sends this evidence to OpenAI; Claude Code sends it to Anthropic. Full before/after source is collected for up to six runtime files, within a size budget. Generated files are omitted from this source collection. Tests and other files remain represented by their diffs. Classifying file by file does not add source context that capture did not collect.

Generated diffs are still captured locally at the start so **Review anyway** can use the pinned snapshot. Their diff and source contents are omitted from every model request until you choose them. Capture size limits and completeness checks therefore still apply to generated files. Detection uses GitHub's generated flag in React diff data plus explicit lockfile names, including `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `composer.lock`, `Gemfile.lock`, `poetry.lock`, and `uv.lock`; it does not guess from directory names.

The extension reads up to three same-repository GitHub issues linked from the original PR description, including plain `Fixes #123` references. It includes their titles, URLs, and original descriptions, bounded to 4,000 characters per issue. Later comments and cross-repository issues are not retrieved. **Capture limitations** reports missing or truncated context. There is no cross-repository knowledge-center integration.

The extension stores your selected CLI, each CLI's model and effort preferences, your review preferences and custom prompts, and the local review cache described above. Login credentials remain managed by their respective CLIs. Claude Code support uses its Claude login, not an API key or third-party provider configuration.

Opening a PR or returning to its tab checks the selected CLI connection. Automatic checks share a 60-second cooldown per CLI across all PR tabs, including failed checks; simultaneous requests share one helper. The cooldown survives background-worker restarts through [Chrome session storage](https://developer.chrome.com/docs/extensions/reference/api/storage#session). An idle tab does not periodically launch the CLI. Return checks are skipped while the tab is hidden or capturing the PR. Once capture finishes, returning from Settings reads your choices for the next analysis while the running analysis keeps its original settings. **Analyze PR** and connection checks in Settings bypass the cooldown, so you can retry immediately after signing in. Settings changes are read again when you start a review.

Both native hosts are restricted to this extension’s ID. Each session runs in a private temporary directory. Codex uses a read-only sandbox, ephemeral sessions, and disabled approvals, user configuration, tools, hooks, and personal skill discovery. Claude Code uses safe mode, an empty tool list, no session persistence, no personal settings sources, and an empty strict MCP configuration. Authentication remains available; administrator-managed Claude policies still apply. The helper deletes its temporary instructions, schema, and results after completion or cancellation. It does not change either CLI's global configuration. See [Claude Code safe mode](https://code.claude.com/docs/en/cli-reference) for the managed-policy boundary.

Codex analysis failures are classified from its structured `error` and `turn.failed` events. Echoed prompts and generated review text cannot supply the diagnostic. Failures without a recognized structured cause show a generic error; raw CLI output is not displayed. See [Codex JSON event output](https://learn.chatgpt.com/docs/non-interactive-mode).

## Prototype boundaries

- Native folding supports recognized unified diff rows in GitHub's classic and React layouts. Split-view rows, unknown layouts, unrecognized source, inline discussion rows, and unavailable binary diffs remain visible. Use unified view to test folding.
- Capture reads the complete file inventory on GitHub's current Changes page and fetches missing diffs, including large files and generated files that require GitHub’s separate Load diff endpoint. It also follows paginated and deferred classic diffs and checks their total file count. Capture includes whitespace changes and validates paths, line counts, and commit revisions before analysis. It supports up to 100 files and a bounded input size; incomplete or truncated diffs stop capture before any analysis starts.
- Priorities are model judgments, not proofs of equivalence. Supporting changes remain available and may still require review.
- Each file classification must account for every edit in that file; the PR review accounts for every included edit. Generated exclusions are shown separately from reviewed files. A missing or duplicated edit, an invalid source reference, or a review decision without evidence from its own changed code prevents that result from being applied. Selection follows importance and evidence, including with custom prompts; the extension does not reject or trim a result to meet a line, excerpt, or topic count. Every cited line must exist in the captured source. A failed PR review keeps completed classifications available for retry.
- The extension runs on `github.com`; GitHub Enterprise hosts are outside this prototype.
- The local helper installer targets Google Chrome on macOS. It was developed against Codex CLI 0.156.1 and Claude Code 2.1.283; older versions may lack the required execution flags.
- Input and result sizes are bounded for Chrome native messaging. Oversized results fail visibly instead of applying a partial review.

## Development and verification

Requires Node 24 and Google Chrome installed at its standard macOS path.

```sh
npm ci
npm run verify:extension
```

The verification command builds the extension, then checks the native hosts, background/runtime flows, and installed extension in a temporary Chrome profile. `npm run verify` runs the same suite. Rebuild after edits, rerun `npm run install:cli-host` when the helper changes, choose **Reload** in `chrome://extensions`, and refresh the PR page.

The checks cover both CLI providers, message framing and process cleanup, credential isolation, complete diff capture, per-file classification followed by one PR review, three concurrent file classifications, isolated retry and cancellation, generated-file opt-in, native folding/restoration, and saved-review invalidation and eviction. They use deterministic fake CLIs plus public or synthetic [GitHub fixtures](test-fixtures/README.md). They do not call a live model or establish classification accuracy.

The earlier standalone prototype and its private PR fixture are not included in this repository. No separate repository checkout is needed to run these tests.

Retryable sessions remain available while their browser tab is open, including while you visit another GitHub subtab. Completed sessions with excluded files also remain available for **Review anyway**. Closing the tab releases the session. Completed cached reviews can be reopened in a later visit.

The [literature notes](review-literature-research.md) record the research behind the review flow and the evaluation still needed. The [Laya assessment](laya-fit-research.md) explains why it has not replaced semantic classification. Their dated implementation sections describe earlier prototype versions.

## Helper installation and removal

`node install-native-host.mjs` (also available as `npm run install:cli-host` in the source project) registers `com.review_focus.codex` and/or `com.review_focus.claude` in this user’s Chrome `NativeMessagingHosts` directory for the CLIs it finds, and prints the installed paths. It records absolute paths for Node and the selected CLI, preserving stable executable symlinks so CLI updates take effect. Its PATH contains their directories and system directories; it does not copy the installer shell’s PATH. Re-run the installer if those executables move. Run the installer from the repository root.

Removing the extension stops its access to the helpers. To remove the registrations too, delete `com.review_focus.codex.json` and `com.review_focus.claude.json` from `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`, plus the helper directory printed by the installer. This does not sign you out of either CLI or remove the CLIs themselves.
