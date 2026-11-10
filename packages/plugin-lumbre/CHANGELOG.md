# @alisio/plugin-lumbre

## 0.1.1

### Patch Changes

- 76001e9: Fix "the model's answer was incomplete or malformed" on real models. The builder now answers in delimited file blocks that need no escaping (the old single-JSON answer is still accepted), new projects are planned first and written in batches sized to the output budget, and an answer cut by the output limit is continued automatically (up to three times) while every complete file is kept. When the provider reports no limits, Lumbre assumes a 128,000-token context and a 32,768-token output instead of 32,000/16,000, uses reported limits as they are, and retries once with Alisio's own limit if the provider rejects the estimate. Errors now tell a cut answer (`output_truncated`, keeping the files that arrived as a reviewable partial proposal) from a malformed one and name the provider failure category, and every job shows its model, limits (reported or estimated), token usage and continuations under Details.

## 0.1.0

### Minor Changes

- 4f1184a: Add `@alisio/plugin-lumbre`: a web builder app for Alisio. Describe a landing page or a small app and the model you pick builds it in a chat per project; every change is shown as a reviewable diff (accept all or per file), build errors trigger at most two automatic fix proposals, and the result opens live in your browser from a loopback dev server with hot reload, with a safe static thumbnail inside the app. Stacks: HTML/CSS/JavaScript (optional Tailwind), Vite + Tailwind, React + Vite + Tailwind, Astro + Tailwind and Next.js; pinned versions with committed lockfiles installed by `npm ci --ignore-scripts`, extra packages only from a per-stack allowlist. Projects keep their history in Lumbre's private state and can be exported to the workspace or downloaded as a ZIP. English and Spanish follow Alisio's language.
