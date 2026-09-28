# Research on focused, contextual code review

Investigated on 2026-09-28. This is a targeted reading list for the extension's central question: can we direct a reviewer to a few consequential decisions, explain the surrounding behavior, and reduce the code they need to inspect?

## Search method and limits

A direct [Google Scholar query for LLM code review since 2024](https://scholar.google.com/scholar?q=%22large+language+models%22+%22code+review%22&as_ylo=2024) returned an internal access error in the browsing tool. No Scholar result pages or citation counts were successfully inspected. Discovery continued through web searches for combinations of “code review”, “LLM”, “context”, “prioritization”, “benchmark”, and years 2024–2026, followed by reading author manuscripts, publisher records, and official conference programs. This is not a systematic or exhaustive literature review.

Publication status below follows the publisher or official program where available. An arXiv manuscript's conference template is not treated as evidence of acceptance. Experimental findings belong to their tested models and datasets; they are not performance claims about this extension.

## Studies read for the prototype

### Beyond Summaries: Structure-Aware Labeling of Code Changes with Large Language Models

**Weiss et al.; May 2026 arXiv preprint; conference publication unverified.** This is the closest match to selecting and filtering a diff. A first pass labels changes; a second connects moves, renames, and their attributes across hunks. Its strongest configuration reports 81% per-hunk precision and 84% recall. The test set contains only six natural and seven fabricated PRs, mostly Java, totaling 95 hunks. Per-file input usually outperformed both individual hunks and entire patches. The authors leave richer intent classification and reviewer benefits to future work. **Implication, inferred:** distinguish change classification from attention selection, preserve mixed and unresolved changes, and group dependent edits. Those figures do not measure safe folding. [Full paper, §§3–6 and appendices A–B](https://arxiv.org/html/2605.26100v1), [publication record](https://arxiv.org/abs/2605.26100).

### Rethinking Code Review Workflows with LLM Assistance: An Empirical Study

**Aðalsteinsson et al.; ESEM 2025.** A field study at WirelessCar compared upfront AI reviews with assistance requested during review. The experimental phase involved ten participants. Developers valued orientation and contextual explanations, but reported lengthy output, minor findings, missing architectural context, and friction from leaving familiar tools. Preferences depended on familiarity and review risk. This provides unusually direct evidence about the experience we are building. The study is qualitative and comes from one company; it does not establish a measured productivity gain. **Implication, inferred:** keep the initial view short, attach file/line evidence, and make deeper explanation available on demand. [Publisher record](https://ieeexplore.ieee.org/document/11323409/), [author manuscript, §§IV–VI](https://arxiv.org/html/2505.16339v1).

### Deep Learning-based Code Reviews: A Paradigm Shift or a Double-Edged Sword?

**Tufano et al.; ICSE 2025; preprint November 2024.** A controlled experiment with 29 experienced participants found that an initial automated review concentrated attention on the locations it named. Assisted reviewers identified more minor issues, but not more high-severity issues than manual reviewers. Time and confidence differences were not statistically significant. The experiment used Java/Python programs with injected issues, so its results do not directly establish the effects of collapsing production PRs. **Implication, inferred:** measuring how much code disappears is insufficient; evaluate consequential issues missed in the collapsed portion and whether reviewers independently examine it. [Official conference entry](https://conf.researchr.org/details/icse-2025/icse-2025-research-track/72/Deep-Learning-based-Code-Reviews-A-Paradigm-Shift-or-a-Double-Edged-Sword-), [author manuscript, §§II–IV](https://arxiv.org/html/2411.11401v3).

### From Overload to Insight: Bridging Code Search and Code Review with LLMs

**Rao, Vasilescu, and Holmes; FSE Companion 2025, Ideas, Visions and Reflections.** This is a close conceptual match: an assistant retrieves information from code, history, tests, and documentation, then presents change-specific insights. Its proposed prioritization groups similar changes, including refactorings, and related changes, including definitions and call sites. It proposes tailoring their presentation to reviewer familiarity. The paper describes a research vision, not a controlled evaluation showing that the proposed assistant works. **Implication, inferred:** organize around connected behavioral changes and supporting evidence rather than assuming each file is an independent review task. [Author-hosted paper, Figure 1 and Table 1](https://cmustrudel.github.io/papers/fse2025nier.pdf), [official conference program](https://conf.researchr.org/details/fse-2025/fse-2025-ideas-visions-and-reflections/28/From-Overload-to-Insight-Bridging-Code-Search-and-Code-Review-with-LLMs).

### Benchmarking LLMs for Fine-Grained Code Review with Enriched Context in Practice

**Hu et al.; FSE 2026 Industry; preprint November 2025.** ContextCRBench contains 67,910 entries, combining linked issue/PR descriptions with surrounding functions or classes. The model evaluation uses a stratified 1,080-entry subset. It separates hunk assessment, line localization, and comment generation. Across eight tested models, textual intent context generally helped more than surrounding code alone; results vary by task and model. Labels come from filtered historical reviews, including LLM filtering, and comment scoring uses text similarity. This does not prove that uncommented code is harmless. **Implication, inferred:** retrieve the requirement explaining a change, then evaluate selection, source localization, and explanation separately. [Official FSE program](https://conf.researchr.org/details/fse-2026/fse-2026-industry-papers/33/Benchmarking-LLMs-for-Fine-Grained-Code-Review-with-Enriched-Context-in-Practice), [author manuscript](https://arxiv.org/html/2511.07017v2).

### AACR-Bench: Evaluating Automatic Code Review with Holistic Repository-Level Context

**Zhang et al.; January 2026 arXiv preprint; later publication status unverified.** The benchmark covers 200 PRs from 50 repositories and ten languages, with 1,505 curated review comments. It compares retrieval strategies and agent-based reviews. Extra context did not consistently improve results. In one tested setup, Claude 4.5 Sonnet's agent review achieved 39.90% semantic precision but 10.10% recall. This illustrates a tradeoff, not a general ranking of models or tools. The authors acknowledge incomplete ground truth. **Implication, inferred:** compare targeted retrieval against diff-only input, and measure missed issues alongside relevance when making the extension more selective. [Author manuscript, §§3–4 and Table 3](https://arxiv.org/html/2601.19494v3), [version/publication record](https://arxiv.org/abs/2601.19494).

## Additional useful reading

- **Understanding Large-scale Codebase Refactoring through Semantic-aware Differencing — Deknop et al., SANER 2024.** Checks trace equivalence on control-flow graphs in an industrial refactoring case. This offers a much stronger kind of evidence than recognizing that code looks moved or renamed, within the technique's supported scope. The institutional record identifies COBOL as the application domain; it is not an immediately transferable JavaScript equivalence checker. [Author's institutional record and manuscript](https://research.dial.uclouvain.be/entities/publication/a6a399c0-5c89-40a5-839d-cc46eb0d16ff).
- **Does Order Matter? An Empirical Investigation into the Impact of File Ordering on Code Review Effectiveness — Rahman et al., September 2026 preprint.** Studies 330,343 multi-file PRs. Associations between position and later bug-fixing activity are small. Its defect label assumes a file touched by a subsequent bug-fixing PR contained a defect missed in the preceding review; it does not establish which change introduced a defect. Useful motivation for testing presentation order, not causal evidence that reordering prevents bugs. [Methods §4.4.2 and results §5](https://arxiv.org/html/2609.22610v1).
- **Context-aware Code Summary Generation — Su et al., Journal of Systems and Software 231, January 2026; preprint 2024.** Uses summaries of callers to explain a method's purpose. Its human preference study concerns Java method summaries, not review selection or semantic equivalence. The journal introduction states that the reported advantage over the compared commercial models was not statistically significant. **Implication, inferred:** explanations should state a method's role in a flow when caller evidence is available. [Journal paper](https://www.sciencedirect.com/science/article/abs/pii/S0164121225002493), [earlier author manuscript](https://arxiv.org/abs/2408.09006).
- **The effects of change decomposition on code review—a controlled experiment — di Biase et al., PeerJ Computer Science, 2019.** Older but directly relevant: 28 developers reviewed coherent smaller changes or a composite changeset. Decomposition reduced false reports but did not improve detected-defect counts or understanding of the change rationale. Grouping alone does not settle our question. [Full paper](https://pmc.ncbi.nlm.nih.gov/articles/PMC7924728/).
- **CodeReviewQA: The Code Review Comprehension Assessment for Large Language Models — Lin et al., Findings of ACL 2025.** Assesses change-type recognition, localization, and solution identification through 900 curated examples across nine languages. Useful for separating comprehension failures; its multiple-choice refinement task does not measure whether a human reviewer can safely skip code. [Publisher record and paper](https://aclanthology.org/2025.findings-acl.476/).
- **Understanding the Limits of Automated Evaluation for Code Review Bots in Practice — Karakaya et al., accepted to EASE 2026 according to the authors' arXiv record.** On 2,604 industrial bot comments, automated judges agreed with developer fixed/wontFix labels only about 44–62%. Such actions also reflected organizational constraints. Useful when designing feedback: “ignored” is an ambiguous quality label. [Author manuscript](https://arxiv.org/html/2604.24525v1), [acceptance statement](https://arxiv.org/abs/2604.24525).
- **From Static to Dynamic: Benchmarking Real-World Code Review with MCR-Bench — Zheng et al., accepted to ISSTA 2026 according to the authors' arXiv record.** The August 2026 manuscript covers 2,269 multi-round tasks with defect-state labels and reports difficulty tracking defects over successive revisions. Relevant to re-analysis after new commits; it does not evaluate focused-diff interfaces. [Author manuscript](https://arxiv.org/html/2608.27442v1), [acceptance statement](https://arxiv.org/abs/2608.27442).
- **A Roadmap for Modern Code Review: Challenges and Opportunities — Yang et al., ACM TOSEM 35(9), article 271, published 21 August 2026.** A broad synthesis of 2013–2025 research, including change understanding and prioritization. Useful for terminology and further references, rather than direct evidence for this extension. Bibliographic details and abstract were accessible in indexed publisher text; direct publisher opening failed. [Publisher record](https://doi.org/10.1145/3800963).

## What to test in this prototype

The following is our proposed evaluation, informed by the studies above, not a result they establish:

1. Have maintainers identify the consequential decisions in a small, varied set of real PRs, including concerns absent from historical comments.
2. Compare full diff, the current focused view, and focused review supplied with linked requirement/issue context. Keep the model and PR revision fixed.
3. Measure the consequential decisions found, consequential decisions hidden, time to understand the change, correctness of explanations, and how often reviewers expand supporting code.
4. Inspect errors separately: selection of the wrong change, insufficient context, incorrect reasoning, and evidence pointing at the wrong source.

None of the works reviewed here establishes that an LLM's omission is reliable evidence that code has no behavioral effect. Reversible folding is a useful interaction to test; its safety and usefulness still require a study of the decisions reviewers miss.

## Design implications

These are engineering interpretations, not proven improvements:

- **Give each review decision a reason and a bounded source trail.** A concise before/after behavioral statement should link to the changed lines and identify what remains uncertain. The reviewer should be able to check the explanation without searching the full PR. This follows the interaction findings and contextual-review vision above.
- **Treat suppressed changes as an explained remainder.** Keep an inspectable account of changes judged supporting, mechanical, or uncertain. Do not equate low review priority with proven behavioral equivalence. This addresses the attention bias observed by Tufano et al.
- **Fetch intent selectively.** Add verified linked issue text and relevant surrounding scope when available; attach provenance and disclose missing context. Test this against existing input before adding broad retrieval. ContextCRBench and AACR-Bench support examining context selection, but do not justify indiscriminately enlarging prompts.
- **Separate scope coverage from confidence.** Every changed unit can be assigned to a topic without establishing that every risk was found. Preserve that distinction in the prompt, validation, and interface. Evaluate whether important behavior is omitted, independently of how convincing the displayed explanation sounds.

## Applied to extension 0.2.0

| Reading takeaway | Implemented change | Behavior checked |
| --- | --- | --- |
| Separate change understanding from presentation | One classification request labels every edit; one prioritization request reads the labels and the original evidence. Mixed labels and reasons survive in the result. | Exact two-request order; missing, duplicated, invented or unexplained labels stop before prioritization. |
| Uncertainty must not disappear behind a concise answer | Any edit labelled `unknown` keeps its changed lines visible in GitHub. Its labels, reasoning and missing evidence can be opened under the edit. | An unresolved edit remains visible even when the second pass assigns it to a supporting topic. |
| Relevant intent helps explain a change | Capture up to three same-repository issues from the original PR description, with source URLs, bounded text and visible limits. | Deduplication, issue budget, unavailable issues, blocked redirects, ignored external references and later comments. |
| Concise orientation needs evidence | Show before/after behavior and uncertainty with each review decision; require an excerpt intersecting that decision's assigned changed code. | Reject missing or unrelated evidence; preserve verbatim source and inspectable supporting edits. |
| Attention limits must not become risk limits | Open the first four decisions; show additional decision titles separately from supporting topics. Keep their selected native diff lines visible. | Five independent concerns retain review priority, with disclosure, source navigation and full restoration. |
| All edits accounted for does not mean all risks found | Prompts ask for a second inspection of deferred changes, separate observed facts from conditional risks, and reject equivalence claims from appearance alone. | Coverage and evidence constraints are checked mechanically; reasoning quality still needs human evaluation. |

This adapts the papers' ideas; it does not replicate their experiments. In particular, Beyond Summaries' second stage refines structural labels and its strongest results use per-file calls. Our approved design uses two PR-wide requests: classification, then review prioritization. Its reported accuracy cannot be transferred to this implementation.

The [Laya assessment](laya-fit-research.md) records source-level constraints and the missing code-review evidence. No Laya dependency or model was added. The first-stage label inventory provides a concrete target for a later comparison against human-labelled edits.

The automated checks use supplied model responses. They establish request flow, evidence handling and UI behavior; they do not establish better review decisions, fewer missed defects, latency or cost on real PRs. Those require a live API key and the maintainer evaluation described above. No private PR content was sent to a model during this work.

Validation on 2026-09-28: `npm run verify:extension` and `npm run verify` passed. The extension suite loads the unpacked extension into Chrome and intercepts Anthropic responses. The original private fixture still displays 19 selected source lines across two decisions; the extra-decision fixture preserves five decisions. These are presentation fixtures, not a measured model benchmark.

## Full-text reading audit

The main summaries above were grounded in these full-text sections, in addition to venue records:

| Work | Sections inspected |
| --- | --- |
| Beyond Summaries | §§3–4 taxonomy and two-stage method, §5 small natural/synthetic benchmark and Tables 2–3, §6 tradeoffs, appendices A–B definitions and prompts |
| Rethinking Code Review Workflows | §§IV methodology, V field observations and interaction findings, VI implications, VII conclusion |
| Double-Edged Sword | §II participants and experimental design; §III issue discovery, attention, timing, confidence; §IV validity threats |
| From Overload to Insight | Introduction, Figure 1, §3 information sources, Table 1 proposed actions |
| ContextCRBench | §2 construction/filtering, §3 metrics and 1,080-item evaluation subset, §4 context comparisons and Tables 4–6, §5.4 validity threats |
| AACR-Bench | §3 construction and human annotation, §4 retrieval setup and Tables 3–4, §6 ground-truth limitations |

The additional-reading entries are shorter leads. They should not be treated as a full methodological appraisal of those papers.
