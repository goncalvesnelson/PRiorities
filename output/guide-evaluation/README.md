# Guide reading evaluation

This is a separate reading exercise, not the installed extension's Guide implementation. It compares unchanged model output in the proposed Guide layout with the complete captured diff. GitHub comments and review controls are absent from both views.

**Status:** All four human reading sessions are complete. The user read the #5881 and #5895 baselines in `reading-comparison-restart-20260930T121223Z.html`; the original run remains separate. #5881 passed final validation on attempt 3 after two incomplete answers. Both selected outputs have separate code accuracy audits; their wording remains unchanged in the exercise. The article-informed content direction is approved. Three revised-prompt comparisons have since run; their checkpoint is recorded below. The existing `pilot-reading-comparison.html` uses the rejected small example and is retained only as a pilot artifact.

The selected public examples are Undici [#5881](https://github.com/nodejs/undici/pull/5881) and [#5895](https://github.com/nodejs/undici/pull/5895). The smaller #5893 run is retained as a pilot accuracy audit but excluded from the reading exercise at the user's request. Private PR #477 was not sent to the CLI for this evaluation.

The four sessions are A Guide, B Full captured diff, A Full captured diff, B Guide. The start screen asks familiarity and withholds content until Start. The timer includes reading, answer entry, and external visits; unrelated interruptions can be recorded separately. Later sessions are repeat readings and cannot establish first-time comprehension. Questions, answers, elapsed time, destinations and interruptions are saved in the browser, with a Download results action. No human results are filled in automatically.

Open `reading-comparison.html` in Chrome. Select your familiarity, start each session, read until you can answer the five questions, then submit to advance. Use the page's external-visit and interruption controls when needed. Download results after all four sessions. Avoid opening the audit notes before finishing.

The Guide preserves the returned titles, wording, order and source excerpts. It adds no file-role notes or short navigation labels. Supporting sections without excerpts show their assigned changed rows. This template evaluates content; it does not implement the proposed production folding rules. Full captured diff shows every captured diff row and the additional source that was supplied to the model.

After the timed evaluation, the user requested paired before/after code and one review checkbox per continuous changed block. `pr-5881-guide.html` now demonstrates this behavior: one panel per file, unified removed/added rows, shared block state across sections, and file completion only after every block is checked. “Show all blocks” exposes changes outside the selected section. Checkbox state is an in-memory preview, resets on reload and does not update GitHub. The original untimed rendering is retained as `pr-5881-guide-separate.html`. The timed pages and their saved results remain the original baseline, so this new mock has no measured comprehension result.

Both runs use the user's configured Claude Code model `claude-opus-5-5`, medium effort, Selective focus, and default review preferences. The production capture, prompt constructors, schemas, CLI client, native host and validators are used. A temporary driver supplies Chrome's native-port transport and mirrors the existing classification queue. There is one classification per included file, at most three concurrent, followed by the whole-PR assessment.

Raw inputs, exact prompts, native responses, validation failures, timings, and claim audits are stored outside the repository under `/private/tmp/priorities-guide-evaluation/`. Model runtime is not human reading time. The audit notes and answer keys are kept out of the exercise.

## Human reading results

The restarted run recorded these sessions on 2026-09-30. Times include reading and answer entry. Both PRs were marked unfamiliar at the start of this run; exposure before the restart was not measured.

| Session | PR | View | Reading order | Elapsed | Recorded departures |
| --- | --- | --- | --- | --- | --- |
| 1 | #5881 | Guide | First in this run | 4:58 | 1 |
| 2 | #5895 | Full captured diff | First in this run | 2:03 | 0 |
| 3 | #5881 | Full captured diff | Repeat | 3:45 | 0 |
| 4 | #5895 | Guide | Repeat | 2:20 | 0 |

The strongest finding is confirmed reader friction: related code was split between Guide sections in #5881. The reader described Full diff as easier because the code appeared together, then explicitly identified the section split as the difficulty. The baseline introduces callers in sections 1 and 2 while placing the retirement implementation in section 3. Reordering alone may still require jumps between parts of one mechanism.

Both first readings conveyed the headline behavior. The later answers described file roles more clearly; #5895's Guide answer also supplied a useful implementation-before-documentation reading sequence. Those improvements may reflect learning as well as presentation. The results do not establish that Guide is faster, and the different PRs cannot be treated as comparable timed tasks.

The last question failed as an evaluation instrument. The reader repeatedly said they did not understand what “still needs checking before you would accept this change” meant. Do not score those answers as a failure to recognize risks. A proposed replacement is: “Is anything still unclear, or is there a behavior you would want to test?” Evidence answers generally endorsed the displayed code rather than identifying decisive lines, so statement-level verification effort remains unmeasured. The single recorded source visit opened `pool-base.js` after lines 29–41; no interruptions were recorded.

The separate code audit also fails the content gate. For example, #5881 says the supplied tests never call `pool.close()`, but the TTL test calls it at line 213. The narrower claim that no supplied connection-error test calls it is supported. Keep that distinction explicit; the current wording can mislead a reader. Audit totals count repeated statements separately and are not human comprehension scores.

The approved content experiment uses the existing fields: keep each behavior's shared implementation and callers together, introduce prerequisites first, explain participating files' roles in existing prose, and scope negative claims to the captured evidence. Rerun the same inputs and audit the new output before production UI work. This run does not establish a need for separate file-role notes, short navigation labels or sentence-level source links. No new schema fields were introduced.

The original saved answers and timestamps are preserved outside the repository in `/private/tmp/priorities-guide-evaluation/user-reading-results-restart-20260930T121223Z.json`. The qualitative answer assessment and the user's follow-up clarification are in `user-reading-assessment-restart-20260930T121223Z.json`. No numerical answer score was defined before the exercise, so none is assigned retrospectively.

## Revised-prompt implementation checkpoint

Both production prompt sources now request behavior-based explanations, prerequisite order, implementation and callers together, and factual claims limited to supplied evidence. The schema, model, effort and two-stage pipeline remain unchanged. The default prompt contract change increments the saved-review identity version to 5.

Three revisions were evaluated against the same pinned public snapshots, reusing classifications only after matching the actual classification prompt, schema, settings and input. Revision one’s #5895 result cited an uncaptured gap and was rejected. Revision two validated structurally but still fragmented #5881’s helper/callers and asked whether every failure creates a client, despite an existing-client reuse branch. The user chose another prompt-only iteration, retaining one whole-PR assessment and the existing schema.

Revision three passes the material behavior and grouping gate. #5881’s one section covers all 19 edits, the retirement helper, both connection-error callers and tests. It distinguishes dispatcher reuse from creation and correctly scopes the destroy test to an in-flight replacement request. Its statement audit records 118 supported statements. #5895 groups the runtime class, throw site and tests together, with typings/docs in a separate section. Its audit records 75 supported statements and two partly supported scope/attribution qualifications, without a material wrong runtime claim. Secondary details can require expanding captured source; human verification time and any general speed/reliability improvement remain unmeasured.

Raw experiments and audits are under `/private/tmp/priorities-guide-evaluation/case-{b,c}-guide-revised-3/`; the earlier `-2` and unnumbered revisions remain preserved. The paired-code mocks display the unchanged accepted output: [#5881](pr-5881-guide-revised.html), [#5895](pr-5895-guide-revised.html). Their checkboxes remain preview-only. The timed pages and original answers are unchanged. Production Guide implementation and automated verification are complete. The schema and existing assessment pipeline remain unchanged.

The native interaction spike passed four layout fixtures. Keep GitHub's list mounted, place Guide before it, and restore Full diff before resolving a native target. Hidden deferred content may need restoration and scrolling before it loads. Commit-source links remain separate from discussions. The public read-only browser exposed classic pages; logged-in React virtualization remains unverified. See `/private/tmp/priorities-guide-evaluation/guide-native-spike.md`.

## Production verification

`npm run verify:extension` passes after implementation, including native-host, runtime and installed-Chrome checks. Coverage includes section-focused folding, shared block identity, durable progress, native Viewed synchronization, unavailable controls, native discussions and drafts, generated-file opt-in, keyboard focus, cache and revision boundaries. The browser regression reproduced and now prevents a delayed native confirmation from clearing newer partial progress in another tab. The final log is `/private/tmp/priorities-guide-evaluation/guide-implementation-complete-verify.log`.

Both accepted outputs were also fed unchanged into the production renderer through a temporary transport fixture. Every displayed file retains its exact captured changed rows, block IDs and original ordering. Wide and narrow layout checks pass, and the installed-browser checks cover light/dark themes. The report is `production-content-check.json` under the temporary evaluation directory, beside `pr-5881-production-guide.png`, `pr-5895-production-guide.png` and their mobile screenshots. These checks make no model calls and do not alter GitHub reviews. They establish rendering and workflow behavior, not better human comprehension. A fresh reader or unfamiliar PR is still needed for another timed comparison.

## Capture fix discovered during setup

Merged #5895 consistently reported target-branch commit `328ab8435079ca6edc1236a29e45a46915456502` in `comparison.fullDiff.baseOid`, while every file diff used merge base `762f3b5a743af24db00093f0478873f2afdd97b2`. GitHub's comparison API confirmed the merge base. The unchanged capture incorrectly reported that the PR had changed.

The fix uses the file diff's merge base for a full PR's source identity and preserves explicit base/head pairs for selected ranges. File entries must still agree with that identity. Existing browser coverage now exercises divergent full-PR histories, mixed base/head rejection, pinned before/after source, deferred loading, and selected ranges. `npm run verify:extension` passed. Its first attempt stopped at an existing fake-CLI startup-file read race in `verify-native-host.mjs:94`; the complete retry passed without changing that test.

The same live public capture that previously failed then succeeded, using the actual merge base. At that checkpoint, prompts and the analysis schema were unchanged; the later prompt experiment below changes the prompts only.

## Rebuild

```sh
node output/guide-evaluation/generate.mjs \
  /private/tmp/priorities-guide-evaluation/case-c-baseline/snapshot.json \
  /private/tmp/priorities-guide-evaluation/case-c-baseline/analysis.json \
  /private/tmp/priorities-guide-evaluation/case-b-baseline/snapshot.json \
  /private/tmp/priorities-guide-evaluation/case-b-baseline/analysis.json \
  output/guide-evaluation/reading-comparison.html
```

The generator validates each analysis against its snapshot and rejects different commit pairs or duplicate PRs. Changing the dataset changes the measurement storage key; earlier results are not reused as new readings.

## Final-assessment reliability finding

For #5881, four file classifications completed successfully. Final attempt 1 returned 18 of the required 19 classifications; edit `2-0-10` was missing. Its topics otherwise assigned all 19 edits. A normal retry reused those four classifications. Final attempt 2 classified all 19, but returned only the supporting test topic and omitted 18 implementation edits from topic assignment. Its prose refers to two review topics that are absent from the returned array. Both responses were rejected by the existing validators. Neither was hand-repaired or used to generate the Guide.

Attempt 3 used a temporary executable wrapper to record the CLI's stdin, system instructions, arguments, complete JSON envelope and exit status. It forwarded the original arguments and streams unchanged. The same request produced all 19 classifications and four topics assigning every edit exactly once. Production validation passed, so this is the #5881 baseline used in the exercise.

The investigation established these boundaries:

- All three final native requests are identical, including the full evidence, 19 initial classifications, prompt, schema, model and effort. The diagnostic wrapper also confirmed exact stdin and system-instruction matches.
- Both failed answers satisfy the JSON Schema sent to Claude. That schema describes array item shapes but does not require every supplied edit ID to appear. `validateAnalysis()` enforces that separate requirement after the CLI finishes. Claude's documented schema validation cannot enforce a coverage rule absent from the supplied schema. See [structured output validation](https://code.claude.com/docs/en/agent-sdk/structured-outputs).
- The saved native responses equal the objects passed to the validator. On attempt 3, the full CLI `structured_output` also equals that object. The helper does not filter classifications or topics. The two failed objects are complete JSON and well below transport limits.
- Attempt 3 exited successfully with `terminal_reason: completed`, `stop_reason: tool_use`, and 6,454 output tokens. The installed Claude Code 2.1.285 implements schema output through its internal `StructuredOutput` tool. The original two CLI envelopes were not saved, so their individual stop reasons are unknown; the successful diagnostic run cannot establish them retrospectively.
- Retry final starts a fresh request with the same prompt. It preserves completed classifications but supplies no missing-ID feedback from the rejected answer.

The demonstrated failure is incomplete coverage in the CLI result, accepted by the generic schema and caught by the application validator. The exact cause of each model omission is unproven. A successful third attempt does not resolve reliability: this example has two rejected final answers out of three attempts. Do not extrapolate a general failure rate from this sample. No production prompt, schema, retry behavior or model setting was changed during diagnosis. Strengthening completeness constraints or adding a validation-feedback retry remains a separate decision.

The failure records are `/private/tmp/priorities-guide-evaluation/case-c-validation-failures.json`; exact raw responses and prompts are under `case-c-baseline/assessment/attempts/001`, `002` and `003`. The complete diagnostic CLI envelope is `cli-diagnostics/run-clSixi/stdout.txt`, with boundary checks summarized in `incomplete-output-diagnosis.json`. Accuracy findings and answer keys are in `case-b-audit.json` (#5895) and `case-c-audit.json` (#5881), outside the reading page. Human reading measurements appear above; no numerical answer score is assigned.
