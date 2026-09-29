# Is PRiorities taking the right approach?

Investigated on 2026-09-29. Follow-up to [the first literature review](review-literature-research.md).

**Assessment: keep the direction, but treat its effectiveness as an open empirical question.** The literature supports helping reviewers understand changes, connecting related edits, and reducing repetitive presentation. It does not establish that LLM-selected folding is the best interface, or that code omitted by a model is safe to skip. Our strongest next step is to measure consequential omissions on real PRs, alongside time and explanation quality.

This note adds seven works to the earlier reading and revisits five of its central papers. The evidence includes controlled experiments, field deployments, surveys, and model benchmarks; these answer different questions. Recommendations below are engineering interpretations, not results demonstrated for PRiorities.

## Scope and search method

I searched for code review attention, refactoring-aware diffs, change decomposition, file ordering, LLM review evaluation, and context selection, prioritizing 2024–2026. I followed references back to older experiments when they tested the interaction more directly. A [Google Scholar query](https://scholar.google.com/scholar?q=%22code+review%22+%22attention%22+%22LLM%22&as_ylo=2024) failed with an access error. Discovery therefore used web search followed by author manuscripts, institutional repositories, and conference records. I did not inspect Scholar citation counts.

This is a targeted follow-up, not an exhaustive systematic review. Vendor rankings and secondary summaries did not supply the findings. I read the methods, relevant results, and limitations identified in the audit below. Where publication status could not be verified beyond an arXiv record, I label the work a preprint. No private PR content entered a search or a model benchmark during this research.

## What the extension actually does

The implementation reference is `c1cdd17`. I inspected the capture, scheduling, prompts, validation, and folding code directly. This is an architectural reading; the cited studies do not validate this implementation's review quality.

| Component | Observed behavior | What it establishes |
| --- | --- | --- |
| [Capture](extension/github.js), `capturePullRequest()` | Captures the complete supported diff and PR description, up to three linked same-repository issues, and full before/after source for the first six eligible changed files within size budgets. It does not follow callers or retrieve unchanged dependency files. | A bounded evidence package; source outside it remains unknown. |
| [Scheduling](extension/background.js), `classifyFile()` / `reviewPullRequest()` | Classifies files separately, then supplies the included PR evidence and classifications to one PR-wide prioritization request. | Separation of change identification from review selection. It does not demonstrate superiority over provisional file results followed by a final check. |
| [Prompts](extension/review-preferences.js) | Classifies mixed edits, distinguishes labels from importance, groups decisions across files, requests before/after behavior and reasons, and asks the model to reconsider supporting changes. There are no presentation quotas. | Instructions about desired reasoning; compliance with their meaning remains a model judgment. |
| [Validation](extension/review-data.js), `validateAnalysis()` | Accounts for every edit exactly once, validates source references, and requires each review topic to cite its own changed code. | Structural coverage and real source locations. Neither complete semantic coverage nor correct explanations follow from these checks. |
| [Folding](extension/review-ui.js), `createNativeFolding()` | Keeps selected excerpts and edits classified `unknown` or matching always-show settings visible. Eligible rows outside those ranges can fold, including unselected lines within a review topic. Unmatched rows and discussion controls stay visible. | Reversible presentation with explicit exceptions. A misclassified consequential edit can still lose visibility. |

The context limit is particularly relevant to complex explanations. Selection currently follows file eligibility and position, not the dependency that a review decision needs. Conversely, giving the model every available file would be an untested response to that limitation.

## Newly examined evidence

### RAID: Tool Support for Refactoring-Aware Code Reviews

**Brito and Valente, ICPC 2021.** This is a close predecessor: a Chrome extension augments GitHub diffs with refactoring information and aligned comparisons. Eight developers used it for three months on four Go projects. Median diff churn for moves fell from 14.5 to 2 lines; the tool exposes edits made within the moved code. However, line count and move distance serve as effort proxies, not measured defect-preservation outcomes. Manual checking also found false refactoring detections. **Implication:** try showing the residual change within a move, with navigation to both locations. Refactoring detection alone cannot justify hiding everything. [Paper, §§II–V](https://homepages.dcc.ufmg.br/~mtov/pub/2021-icpc.pdf), [proceedings contents](https://www.proceedings.com/content/059/059496webtoc.pdf).

### First Come First Served: The Impact of File Position on Code Review

**Fregnan et al., ESEC/FSE 2022.** Alongside repository mining, a controlled experiment assigned 106 participants to different positions for two seeded Java defects. A corner-case defect had 64% lower detection odds when its file appeared last; the missing-break defect showed no significant position effect. This is an odds comparison for one defect, not a general percentage improvement in detection. **Implication:** ordering merits an experiment as an alternative or complement to folding. The study does not identify an optimal ordering algorithm or test LLM rankings. [Paper, §§3.3, 4.2, 5](https://eprints.gla.ac.uk/273443/3/273443.pdf), [institutional publication record](https://eprints.gla.ac.uk/273443/).

### Breaking the Alphabet: Rethinking File Ordering in Code Review

**Rahman et al., ICSE 2026 according to the publication record and manuscript.** A survey analyzed 1,355 responses from developers recruited through 182 projects and snowball sampling. Respondents wanted dependency-aware ordering, module grouping, and links between related files. The evidence concerns reported preferences and difficulties; it does not measure whether a new interface prevents missed bugs. **Implication:** a decision can link its contract, implementation, and tests without requiring the reviewer to reconstruct that relationship from the file list. [Paper, §§3, 4.6, 6](https://arxiv.org/pdf/2609.04207), [publication record](https://arxiv.org/abs/2609.04207).

### RovoDev Code Reviewer: A Large-Scale Online Evaluation of LLM-based Code Review Automation at Atlassian

**Tantithamthavorn et al., ICSE 2026 SEIP.** A deployment across over 1,900 repositories generated over 54,000 comments. PRs receiving comments had a roughly 31% shorter median cycle time; the authors also analyze the rollout as an interrupted time series. Neither design randomly assigns comparable PRs to folding versus full review, so this is encouraging deployment evidence, not a causal speedup estimate for us. Ablations favor review guidelines and actionability filtering; their extra LLM factual-check stage adds little on the measured alignment metric. **Implication:** test additional model passes rather than assuming they improve quality. [Paper, §§3–6](https://arxiv.org/html/2601.01129), [official program](https://conf.researchr.org/details/icse-2026/icse-2026-software-engineering-in-practice/2/RovoDev-Code-Reviewer-A-Large-Scale-Online-Evaluation-of-LLM-based-Code-Review-Autom).

### Human-AI Synergy in Agentic Code Review

**Zhong et al., March 2026 preprint.** The authors analyze 278,790 inline conversations from 300 projects. Agent feedback is more verbose and concentrates on improvements and defects; human feedback also covers understanding and knowledge transfer. Estimated suggestion adoption is 16.6% for agents versus 56.5% for humans. Adoption uses subsequent code changes and similarity, so an unadopted suggestion is not automatically wrong; alternative fixes account for some cases. This observational study does not isolate presentation effects. **Implication:** measure usefulness and understanding, and do not optimize for comment volume or treat ignored advice as a clean negative label. [Paper, §§II, III-A, III-C, V](https://arxiv.org/html/2603.15911).

### High Agreement, Shallow Reasoning: A Mixed-Method Study of LLMs in Refactoring Reviews

**Amorim et al., PROMISE 2026.** The study reports high agreement on 146 Java refactoring pairs, but its sampling retains human-approved refactorings and its operational definition counts choosing the refactored version as alignment. Consequently, the headline agreement is not evidence that a model can distinguish safe refactoring from hidden behavioral changes; always choosing the refactored version would satisfy that definition. The qualitative analysis finds context and reasoning failures, and each model runs only once per pair. **Implication:** our evaluation must include both harmless transformations and plausible-looking refactors containing consequential changes. [Paper, §§3.3–3.4, 4.2, 6](https://homepages.dcc.ufmg.br/~figueiredo/publications/promise2026preprint.pdf), [official program](https://conf.researchr.org/home/promise-2026).

### SWE-PRBench: Benchmarking AI Code Review Quality Against Pull Request Feedback

**Kumar, March 2026 preprint.** The corpus contains 350 PRs; the reported model evaluation uses 100, with deliberate oversampling of context-dependent tasks. All eight tested models perform worse across the paper's progressively enriched input configurations. This is evidence against assuming more context helps. It does not prove retrieval is harmful generally: the configurations use specific small budgets, selective context representations, a prompt targeting 4–6 findings, and model judges. There is no measured human baseline. **Implication:** compare specific evidence packages with the same model and task instead of installing broad retrieval on faith. [Paper, §§4–6, 8](https://arxiv.org/html/2603.26130).

## Rechecked foundations from the first review

**Beyond Summaries (Weiss et al., May 2026 preprint)** remains the nearest match to our staged analysis. Its best labeler configuration uses per-file input, reporting 81% per-hunk precision and 84% recall on just 13 test PRs and 95 hunks. Its second stage extracts structural relationships; it does not select what humans should skip. This supports testing the separation, not borrowing its accuracy as our folding accuracy. [§§3–6](https://arxiv.org/html/2605.26100v1).

**Deep Learning-based Code Reviews: A Paradigm Shift or a Double-Edged Sword? (Tufano et al., ICSE 2025)** studied 29 experienced participants. AI starting reviews concentrated attention on suggested locations, increased minor findings, and did not significantly improve high-severity findings or time. The small Java/Python tasks with seeded issues differ from production PRs. Nevertheless, attention narrowing is directly relevant to hiding code. [§§II–IV](https://arxiv.org/html/2411.11401v3).

**Rethinking Code Review Workflows with LLM Assistance (Aðalsteinsson et al., ESEM 2025)** found useful orientation and contextual explanations in a ten-participant industrial experiment, alongside lengthy output and missing architectural context. Preferences varied with familiarity and risk. These qualitative results support concise, integrated, expandable explanations; they do not quantify a speedup. [§§IV–VI](https://arxiv.org/html/2505.16339v1).

**ContextCRBench (Hu et al., FSE 2026 Industry)** evaluates 1,080 sampled entries from a larger corpus. Intent descriptions help quality estimation; context effects differ for localization and across model families. Historical review-derived labels and similarity metrics limit what this establishes about missed concerns. [§§3–5](https://arxiv.org/html/2511.07017v2).

**AACR-Bench (Zhang et al., 2026 preprint)** compares diff-only, retrieval, and agent approaches on repository-context reviews. One agent configuration raises semantic precision while lowering recall substantially; retrieval does not consistently outperform no retrieval. Ground-truth incompleteness remains a limitation. It reinforces the need to measure relevant concerns missed, not merely the proportion of convincing displayed findings. [§§3–4, 6](https://arxiv.org/html/2601.19494v3).

The context papers are not interchangeable replications. They use different tasks, models, evidence packages, and labels. Their combined lesson is to evaluate context selection, not to conclude that context always helps or always hurts.

## Assessment of our choices

| Choice | Assessment | Next question |
| --- | --- | --- |
| Separate classification from prioritization | A defensible, auditable architecture; not proven optimal. Beyond Summaries evaluates a related but different pipeline. | Does staging reduce consequential omissions compared with one request on the same evidence? |
| Group changes by a review decision | Fits reported needs for relationships and orientation. | Can a reviewer follow the implementation and relevant tests without reconstructing the explanation? |
| Explain what changed and why it matters | Supported by workflow evidence, provided the explanation is correct and quick to verify. | Does reading and checking the explanation save net effort? |
| Fold unselected code | Plausible and reversible, but the highest-stakes unvalidated choice. | Does it cause reviewers to miss consequential decisions or the evidence needed to assess them? |
| Keep `unknown` edits visible | A useful implementation rule. It depends on the classifier admitting uncertainty. | Which important edits receive an unjustifiably ordinary label and still fold? |
| Remove fixed presentation quotas | Matches the product objective. None of the reviewed evidence establishes an ideal universal line count. | Can we preserve all important evidence while removing repetition? |
| Read the included PR jointly before selecting decisions | Enables cross-file reasoning. The new global stage also delays the first finished explanation. | Compare quality, time to first useful explanation, total latency, and result revisions against provisional per-file delivery. |
| Exclude generated files by default | A user-selected scope policy, not a research finding that generated changes are harmless. | Keep excluded files separate from analyzed supporting changes in evaluation and coverage reporting. |

**The correctness of a reference is different from the correctness of its explanation.** A source excerpt can exist, cite a real changed line, and still omit the guard that changes its meaning. Our validators appropriately check the former; the latter needs semantic evaluation. Count both missing decisions and insufficient evidence for otherwise-present decisions.

## What I would investigate next

These are proposed experiments. This research task does not change the extension, its prompts, dependencies, or settings.

**First, evaluate the collapsed remainder.** Build a small, fixed set of maintainer-labelled PR revisions before tuning the prompt further. Include a genuine move, a move with a subtle condition change, a serialized rename, a caller/callee contract change, a test that weakens an assertion, and a dependency change. These are proposed test cases, not observed PRiorities failures. Inspect what the initial focused view makes difficult to discover, including omitted source inside review-priority topics. Use human labels independent of the model's first answer. The attention findings make this a higher priority than maximizing the hidden-line percentage. [Tufano et al.](https://arxiv.org/html/2411.11401v3).

**Then test targeted evidence.** Compare the current capture with small, explicitly connected evidence packages: enclosing scope, relevant caller or callee, related assertion, and requirement text when available. Record why each source matters and pin it to the PR revision. Begin with manually prepared packages for evaluation, so we can find whether the missing evidence changes decisions before building retrieval infrastructure. CodeGraphContext could later supply such evidence; the papers do not establish that this particular backend improves our task. [ContextCRBench](https://arxiv.org/html/2511.07017v2), [SWE-PRBench](https://arxiv.org/html/2603.26130).

**Try structural comparison on move-heavy cases.** Align old and new code so a reader can inspect what changed during the move. Start as an evaluation condition, not a mandatory parser dependency. A detector's move or rename label is still fallible, and structural similarity does not establish equivalence. [RAID](https://homepages.dcc.ufmg.br/~mtov/pub/2021-icpc.pdf).

**Keep orientation compact.** Prefer one useful behavioral explanation and a concrete review question, with the existing detail/source controls providing depth. Compare a guided sequence of related decisions with native file order. Avoid assuming that more explanation is better; its verification time belongs in the cost. [Workflow study](https://arxiv.org/html/2505.16339v1), [file-order experiment](https://eprints.gla.ac.uk/273443/3/273443.pdf).

An independent pass that audits only deferred changes is another candidate, but not an automatic next feature. The existing prompt already requests reconsideration. A second call must demonstrate enough additional recall to justify its latency and noise; RovoDev's ablations caution against treating an extra judge as inherently beneficial. [RovoDev, §5.3](https://arxiv.org/html/2601.01129).

## How to determine which approach is better

I propose a discovery pilot of roughly 20–30 varied PRs, followed by a human comparison sized using the pilot's variance. That count is a practical starting point, not a statistical guarantee. Include small and large changes, familiar and unfamiliar code, clean refactors and mixed changes. Preserve base/head commits, captured context, provider, model, effort, and prompts. Keep prompt-development PRs separate from held-out evaluation PRs.

For ground truth, ask two maintainers to inspect the full evidence independently before seeing PRiorities output, then reconcile disagreements. Record each consequential decision, whether it would affect approval, the source needed to assess it, and unresolved context. Historical comments can seed this work but cannot define the complete set: uncommented code is not a negative label. Measure valid behavior changes and comprehension, not just defects. [AACR-Bench's annotation motivation](https://arxiv.org/html/2601.19494v3).

Separate the interface comparison from the model-pipeline comparison:

| Interface condition | What it isolates |
| --- | --- |
| Native full diff | Baseline review behavior. |
| Full diff with PRiorities explanations | Value and cost of orientation without folding. |
| Same explanations with PRiorities folding | Additional effect of collapsing code; reuse identical model output. |
| Same evidence arranged as connected review decisions | Effect of navigation/order, if the first comparison warrants a further prototype. |

Assign different PRs to each condition for a given participant, balance their order, and distribute each PR across conditions among different participants. Seeing the same bug in an earlier condition would contaminate the comparison. Include codebase familiarity in the analysis. Presentation should use fixed outputs; evaluate repeated model runs separately to expose selection instability.

Measure:

- **Consequential omissions:** maintainer-labelled decisions absent from the focus, and present decisions whose necessary evidence is initially hidden; report by severity and PR type.
- **Human outcome:** important decisions found, correct understanding of the behavior, and whether participants notice concerns the model missed.
- **Noise and effort:** irrelevant or false explanations, active review time including explanation verification, expansion/navigation effort, and perceived workload. Expansion alone is not failure; it may be appropriate investigation.
- **Operational cost:** model usage, total completion time, time to first useful explanation, and variation across repeated runs.

Report uncertainty and individual serious misses, not only an average score. Zero observed critical misses in a small pilot does not prove zero risk. Agree on an acceptable quality difference before looking at comparative results. If folding saves scrolling but increases consequential misses, that is a failed result for the product. If explanations deliver the benefit and folding adds none, retain the evidence for changing the default.

After fixing the interface condition, compare one-pass selection, staged classification/prioritization, and staged analysis with targeted evidence on the same held-out PRs. An optional omission audit can form a later ablation. Do not change models, prompts, retrieval, and layout simultaneously and attribute the result to any one of them.

## Reading audit

| Work | Full-text portions inspected in this round |
| --- | --- |
| RAID | UI and architecture §§II–III; field-study setup/results §IV, especially the effort proxies; validity §V. |
| First Come First Served | Randomized task and participant selection §3.3; detection and visible-file results §4.2; limitations §5. |
| Breaking the Alphabet | Survey recruitment/analysis §3; demographics and ordering preferences §§4.1/4.6; self-report and sampling limits §6. |
| RovoDev | Components §3; deployment cohort and time-series analysis §4; prompt/check ablations §5; validity §6. |
| Human-AI Synergy | Sampling and labeling §II; feedback and suggestion adoption §§III-A/III-C; threats §V. |
| High Agreement, Shallow Reasoning | Selection and operational definition §§3.3–3.4; disagreement analysis §4.2; single-run and construct limitations §6. |
| SWE-PRBench | Dataset/evaluation sample §§3.6/6.1; context construction §4; prompt/judges §5; results and limitations §§6/8. |
| Beyond Summaries | Label and relationship definitions §§3–4; dataset and Tables 2–3 §5; discussion/future scope §§6–7. |
| Double-Edged Sword | Participants and seeded tasks §II; attention, severity, timing §§III-A–III-C; validity §IV. |
| Workflow study | Ten-participant, two-PR protocol §IV-B; observed usability and contextual findings §V-B; implications §VI. |
| ContextCRBench | Evaluation sampling §3; context comparisons §4, including task/model differences. |
| AACR-Bench | Annotation rationale and evaluation setup §§3–4; precision/recall comparisons and context-level differences. |

**Decision:** continue with contextual, reversible focused review. The most useful next evidence would come from a local omission-and-comprehension evaluation, then targeted context experiments. This reading does not justify claiming PRiorities is the best approach, installing a graph backend automatically, or using fewer visible lines as the success metric.
