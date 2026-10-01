# PRiorities

Focus GitHub code reviews on the changes that need your judgment.

PRiorities is a Chrome extension that uses your local Codex or Claude Code login to explain changes in a Guide beside captured before/after code. Each file is classified separately, with up to six files in parallel by default, then a single review of the whole PR chooses what to show.

- Follow behavior-based sections in comprehension order, with prerequisites first and review priorities visible in a compact overview. Each section gives before/after behavior, why it matters and its review questions in a column that stays pinned beside long files on wide screens, with section navigation and **Full diff** always in reach.
- Read before/after code together, with a short note above each cited range; fold other sections’ changes with links to their explanations, and collapse files you have marked reviewed.
- Results open in GitHub’s **Full diff** so you can survey the whole change first; **Guide** is one click away, without another model call. Comments and draft reviews stay in Full diff.
- Choose review focus, always-visible change types and file paths, and custom analysis prompts in Settings.
- Pick your CLI model and reasoning effort, and see them beside the review.
- Analyze the full PR or the commit range selected in GitHub, with source context and saved reviews matched to those commits.
- Skip generated and machine-maintained files (lockfiles, Xcode `project.pbxproj`) by default, with **Review anyway** available for each file.
- Analyze PRs of up to 100 changed files by default; raise or lower the limit (1–300) in Settings. Larger PRs stop before any code is sent, with a message pointing to Full diff.
- Optionally list deleted files without sending their contents to the AI, so PRs that delete many files fit the limit; they show their deleted-line counts and stay in Full diff.
- Retry individual files or the whole-PR review without repeating completed classifications.
- Keep unfinished analysis running across GitHub tab changes and reloads in the same browser tab; reconnect on return to the diff.
- Follow analysis on one toolbar line: steps with a timer, labelled blocks per file, section titles as the model writes them (Claude Code; Codex reports its phase), and an estimate once a model has three earlier reviews. A hidden tab's title shows when the review is ready or needs attention.
- See how much each Guide section covers: its files and changed lines out of the whole PR, and how many lines are folded; Full diff always shows everything.
- Mark files with GitHub’s **Viewed** checkbox or **Reviewed by you** in Guide file headers and the file list, with your progress shown separately from AI analysis.
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
4. Open a GitHub PR's changes view and choose **Analyze PR**. The result opens in Full diff; choose **Guide** for paired, unified code regardless of GitHub’s diff layout.

The helper uses your existing CLI login. If needed, sign in with `codex login` or `claude auth login`. Chrome starts the helper on demand; no separate service needs to keep running.

See [the extension guide](EXTENSION.md) for review controls, cache behavior, context capture, and troubleshooting boundaries.

## Data and review limits

Analysis starts when you request it. The selected CLI sends the captured PR evidence to its model provider; this uses your account's allowance. Login credentials stay with the CLI. Completed review results and selected excerpts are cached locally in the extension.

Prioritization is a model judgment. Supporting changes remain accessible, and unresolved edits stay visible. You control each file’s Viewed mark; completing AI analysis never sets it. PRiorities doesn't submit comments or approve PRs.

## Development

```sh
npm run verify:extension
```

This builds the extension and runs native-host, background/runtime, and installed-extension browser checks. Tests use public or synthetic GitHub fixtures and fake CLIs; they don't send code to a live model. The browser checks require Google Chrome at its standard macOS installation path. `npm run verify` runs the same suite.

After pulling changes, run `npm ci`, `npm run build:extension`, and `npm run install:cli-host`, then reload the extension in Chrome and refresh the PR tab. The installer updates Chrome’s copied helper; reloading the extension alone does not. Live model progress needs the current helper: without rerunning `npm run install:cli-host`, analysis still works but shows only its steps and timer. Preserve any custom `CODEX_HOME` or `CLAUDE_CONFIG_DIR` when rerunning it.

The earlier standalone prototype and its captured private PR data remain outside this repository. Tests here don't require another repository checkout.

Research notes: [review literature, approach assessment and evaluation plan](review-literature-research.md), [Laya assessment](laya-fit-research.md), and [GitHub integration options](pr-lens-research.md).
