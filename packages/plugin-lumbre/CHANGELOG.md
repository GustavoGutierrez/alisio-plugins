# @alisio/plugin-lumbre

## 0.2.0

### Minor Changes

- 6a5b6c3: Add agent mode to Lumbre. A new project's first message proposes a plan with a design token plan (direction, palette swatches, type roles, layout sketch) to approve, edit or discard; Build mode then works in a tool loop (list, read, write, edit, delete files, add allowlisted packages, report progress, finish) inside a private per-job draft, with a live activity card and timeline, two automatic continuations and then a Continue button with an optional goal, an automatic build check of the draft copy with up to two fix rounds, and the usual diff review before anything reaches the project. The tools refuse every call that does not come from a running Lumbre build, and models without tool calling are detected and use the block format. Generated code follows new packaged guidance: `lmb-design` (adapted from Anthropic's and Vercel Labs' frontend-design skills, Apache-2.0), `lmb-tailwind` (adapted from Seth Hobson's tailwind-design-system, MIT) and `lmb-react-next` (adapted from Vercel's react-best-practices, MIT, plus Next.js 16 file conventions), with a fewer-dependencies-first rule. The package allowlists now include common libraries per stack (clsx, tailwind-merge, class-variance-authority, zod, self-hosted fonts; on React and Next.js also lucide-react, react-hook-form, @hookform/resolvers and Radix primitives), and Astro projects can enable React islands through a Lumbre-managed config change.

### Patch Changes

- 76001e9: Fix "the model's answer was incomplete or malformed" on real models. The builder now answers in delimited file blocks that need no escaping (the old single-JSON answer is still accepted), new projects are planned first and written in batches sized to the output budget, and an answer cut by the output limit is continued automatically (up to three times) while every complete file is kept. When the provider reports no limits, Lumbre assumes a 128,000-token context and a 32,768-token output instead of 32,000/16,000, uses reported limits as they are, and retries once with Alisio's own limit if the provider rejects the estimate. Errors now tell a cut answer (`output_truncated`, keeping the files that arrived as a reviewable partial proposal) from a malformed one and name the provider failure category, and every job shows its model, limits (reported or estimated), token usage and continuations under Details.

## 0.1.0

### Minor Changes

- 4f1184a: Add `@alisio/plugin-lumbre`: a web builder app for Alisio. Describe a landing page or a small app and the model you pick builds it in a chat per project; every change is shown as a reviewable diff (accept all or per file), build errors trigger at most two automatic fix proposals, and the result opens live in your browser from a loopback dev server with hot reload, with a safe static thumbnail inside the app. Stacks: HTML/CSS/JavaScript (optional Tailwind), Vite + Tailwind, React + Vite + Tailwind, Astro + Tailwind and Next.js; pinned versions with committed lockfiles installed by `npm ci --ignore-scripts`, extra packages only from a per-stack allowlist. Projects keep their history in Lumbre's private state and can be exported to the workspace or downloaded as a ZIP. English and Spanish follow Alisio's language.
