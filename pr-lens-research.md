# How PR Lens appears inside GitHub

Source inspected on 2026-09-27 at [`coldteadotai/pr-lens` commit `6e7c0d7`](https://github.com/coldteadotai/pr-lens/tree/6e7c0d7db8bdd9358a6078062021b2668ce5deed). No dependencies installed, code executed, or GitHub content posted.

PR Lens puts its GitHub experience in a normal pull-request conversation comment. Its public source demonstrates images, native collapsible sections, and API updates to that comment. The richer interactive canvas lives at `prlens.dev`. Nothing inspected demonstrates modification of GitHub's native Files changed interface.

## Observed implementation

- **Images carry the visual design.** The comment composer emits `<img>` inside `<picture>`, with separate dark/light SVG assets and a link to the image. The diagram's appearance therefore does not require custom CSS or JavaScript in GitHub's page. [Composer, lines 177–202](https://github.com/coldteadotai/pr-lens/blob/6e7c0d7db8bdd9358a6078062021b2668ce5deed/packages/cli/src/comment.ts#L177-L202).
- **Expansion is native HTML.** Each nested view becomes `<details><summary>…</summary>…</details>`, containing its summary, image, and child views. [Composer, lines 236–257](https://github.com/coldteadotai/pr-lens/blob/6e7c0d7db8bdd9358a6078062021b2668ce5deed/packages/cli/src/comment.ts#L236-L257).
- **Animation is inside the image.** The renderer uses SVG `animateMotion`; the renderer documentation specifies self-contained SVGs without scripts or external resources. This is an image feature, not page-script injection. [Pulse source](https://github.com/coldteadotai/pr-lens/blob/6e7c0d7db8bdd9358a6078062021b2668ce5deed/packages/renderer/src/svg/pulse.ts#L25-L48), [renderer explanation](https://github.com/coldteadotai/pr-lens/blob/6e7c0d7db8bdd9358a6078062021b2668ce5deed/packages/renderer/README.md#L31-L42).
- **The public Action updates one comment.** It checks ownership and a marker, then uses GitHub's issue-comment API to PATCH the existing body or POST a new body. Its SVGs are published under a PR/head-commit path on a data branch. These details establish the Action's implementation; they do not establish the hosted App's storage architecture. [Comment writer](https://github.com/coldteadotai/pr-lens/blob/6e7c0d7db8bdd9358a6078062021b2668ce5deed/packages/action/scripts/comment.sh#L61-L86), [asset publishing](https://github.com/coldteadotai/pr-lens/blob/6e7c0d7db8bdd9358a6078062021b2668ce5deed/packages/action/scripts/publish.sh#L12-L61).

## Checkboxes: documented behavior, incomplete public implementation

The schema explicitly defines checkbox support as task-list boxes whose toggles reach a webhook, and enables that capability for GitHub. The project's English end-to-end specification describes changing a view checkbox and rerendering from a stored graph without repeating model analysis. [Provider capability](https://github.com/coldteadotai/pr-lens/blob/6e7c0d7db8bdd9358a6078062021b2668ce5deed/packages/schema/src/provider.ts#L77-L102), [behavior specification](https://github.com/coldteadotai/pr-lens/blob/6e7c0d7db8bdd9358a6078062021b2668ce5deed/e2e.md#L1-L15).

The inferred interaction is: toggle a GitHub task-list box → comment-body edit → webhook to the hosted service → service rerenders → service updates the comment. No hosted webhook handler was found in this public checkout, so its exact event processing, permissions, and state handling remain unverified. The English specification is explicitly a TODO test list, not evidence of a passing live test. The public Action's comment is deliberately static and omits these controls. [Action documentation](https://github.com/coldteadotai/pr-lens/blob/6e7c0d7db8bdd9358a6078062021b2668ce5deed/packages/action/README.md#L73-L75).

## Offsite canvas and relevance to our prototype

The README explicitly sends full-size pan/zoom interaction to a linked canvas on `prlens.dev`. The public canvas documentation provides a client/server protocol, not the hosted server implementation. [README](https://github.com/coldteadotai/pr-lens/blob/6e7c0d7db8bdd9358a6078062021b2668ce5deed/README.md#L114-L120), [protocol scope](https://github.com/coldteadotai/pr-lens/blob/6e7c0d7db8bdd9358a6078062021b2668ce5deed/docs/canvas-api.md#L1-L9).

We can use the same comment surface for our two prioritized review decisions, short source excerpts, explanations, native collapsed supporting evidence, and links to pinned code. That gives an in-GitHub focused review without a browser extension. It does not carry over our whole custom viewer or collapse rows in GitHub's native diff. Those are separate product surfaces. A backend is needed for model analysis and comment updates; ordinary `<details>` expansion itself needs no backend round trip.
