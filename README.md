# PRiorities

Focus GitHub code reviews on the changes that need your judgment.

PRiorities is a Chrome extension that uses your local Codex or Claude Code login to explain important changes and collapse supporting code inside GitHub's diff. Reviews run file by file, with up to three files in parallel, so you can start reading while the remaining files finish.

- Get explanations, before/after behavior, and source excerpts beside each file.
- Switch between focused and full diffs; expand any collapsed code.
- Skip generated files and lockfiles by default, with **Review anyway** available for each file.
- Retry individual files and check relationships across files after they finish.
- Reopen completed reviews from a local cache: 100 MB by default, customizable in Settings. Commit or context changes require a fresh review; the cache evicts the least recently used entries when full.

## Install

Requires Google Chrome on macOS, Node.js 24, and a signed-in Codex or Claude Code CLI.

```sh
git clone https://github.com/goncalvesnelson/PRiorities.git
cd PRiorities
npm ci
npm run build:extension
npm run install:cli-host
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `extension/` directory.
3. Open **PRiorities** from Chrome's extensions menu, select your CLI, check its connection, and save.
4. Open a GitHub PR's changes view and choose **Analyze PR**. Use GitHub's **Unified** diff view for code folding.

The helper uses your existing CLI login. If needed, sign in with `codex login` or `claude auth login`. Chrome starts the helper on demand; no separate service needs to keep running.

See [the extension guide](EXTENSION.md) for review controls, cache behavior, context capture, and troubleshooting boundaries.

## Data and review limits

Analysis starts when you request it. The selected CLI sends the captured PR evidence to its model provider; this uses your account's allowance. Login credentials stay with the CLI. Completed review results and selected excerpts are cached locally in the extension.

Prioritization is a model judgment. Supporting changes remain accessible, and unresolved edits stay visible. PRiorities doesn't submit comments, approve PRs, or mark files viewed.

## Development

```sh
npm run verify:extension
```

This builds the extension and runs native-host, background/runtime, and installed-extension browser checks. Tests use public or synthetic GitHub fixtures and fake CLIs; they don't send code to a live model. The browser checks require Google Chrome at its standard macOS installation path. `npm run verify` runs the same suite.

After changes, rebuild with `npm run build:extension`, reload the extension in Chrome, and refresh the PR tab.

The earlier standalone prototype and its captured private PR data remain outside this repository. Tests here don't require another repository checkout.

Research notes: [review literature](review-literature-research.md), [Laya assessment](laya-fit-research.md), and [GitHub integration options](pr-lens-research.md).
