# PRiorities

Focus GitHub code reviews on the changes that need your judgment.

PRiorities is a Chrome extension that uses your local Codex or Claude Code login to explain changes in a Guide beside captured before/after code. Each file is classified separately, with up to three files in parallel, then a single review of the whole PR chooses what to show.

- Follow behavior-based sections in comprehension order, with prerequisites first and review priorities visible in the overview.
- Read before/after code together; fold other sections’ changes with links to their explanations.
- Switch between **Guide** and GitHub’s **Full diff** without another model call. Comments and draft reviews stay in Full diff.
- Choose review focus, always-visible change types and file paths, and custom analysis prompts in Settings.
- Pick your CLI model and reasoning effort, and see them beside the review.
- Analyze the full PR or the commit range selected in GitHub, with source context and saved reviews matched to those commits.
- Skip generated files and lockfiles by default, with **Review anyway** available for each file.
- Retry individual files or the whole-PR review without repeating completed classifications.
- Keep unfinished analysis running across GitHub tab changes and reloads in the same browser tab; reconnect on return to the diff.
- Check each continuous changed block as inspected. Checking every block marks the file **Viewed**; partial progress persists across reloads and tabs for the same captured commits.
- Use GitHub’s **Viewed** checkbox or **Reviewed by you** to check or clear all of a file’s blocks.
- Reopen completed reviews from a local cache: 100 MB by default, customizable in Settings. Commit or context changes require a fresh review; the cache evicts the least recently used entries when full.

## Install

Requires Google Chrome 133 or later on macOS, Node.js 24, and a signed-in Codex or Claude Code CLI.

```sh
git clone https://github.com/goncalvesnelson/PRiorities.git
cd PRiorities
npm ci
npm run build:extension
npm run install:cli-host
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `extension/` directory.
3. Open **PRiorities** from Chrome's extensions menu, select your CLI, model and reasoning effort, then save.
4. Open a GitHub PR's changes view and choose **Analyze PR**. Guide uses paired, unified code regardless of GitHub’s diff layout.

The helper uses your existing CLI login. If needed, sign in with `codex login` or `claude auth login`. Chrome starts the helper on demand; no separate service needs to keep running.

See [the extension guide](EXTENSION.md) for review controls, cache behavior, context capture, and troubleshooting boundaries.

## Data and review limits

Analysis starts when you request it. The selected CLI sends the captured PR evidence to its model provider; this uses your account's allowance. Login credentials stay with the CLI. Completed review results and selected excerpts are cached locally in the extension. Block inspection progress is saved separately in local browser storage.

Prioritization is a model judgment. Supporting changes remain accessible, and unresolved edits stay visible. You control the reviewed-file checklist; completing AI analysis never checks it. PRiorities doesn't submit comments or approve PRs.

## Development

```sh
npm run verify:extension
```

This builds the extension and runs native-host, background/runtime, and installed-extension browser checks. Tests use public or synthetic GitHub fixtures and fake CLIs; they don't send code to a live model. The browser checks require Google Chrome at its standard macOS installation path. `npm run verify` runs the same suite.

After pulling changes, run `npm ci`, `npm run build:extension`, and `npm run install:cli-host`, then reload the extension in Chrome and refresh the PR tab. The installer updates Chrome’s copied helper; reloading the extension alone does not. Preserve any custom `CODEX_HOME` or `CLAUDE_CONFIG_DIR` when rerunning it.

The earlier standalone prototype and its captured private PR data remain outside this repository. Tests here don't require another repository checkout.

Research notes: [review literature, approach assessment and evaluation plan](review-literature-research.md), [Laya assessment](laya-fit-research.md), and [GitHub integration options](pr-lens-research.md).
