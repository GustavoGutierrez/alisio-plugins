# Spec: Lumbre 0.2.0 agent mode

Status: **Approved; owner answered §9 on 2026-11-10 with every recommended option.** Builds on `alisio-plugin-lumbre-v1.md` (0.1.0 and
the 0.1.1 fix). Language: English; UI strings `{ en, es }`. 

## 1. Goal

Lovable/v0-style building: instead of one answer that must hold the whole site, a Lumbre child
session works in a **tool loop** for many turns. It reads, writes, edits and deletes files in a
**per-job draft**, reports progress on a live timeline, and says when it is done. Lumbre then checks
the draft (build), feeds errors back for an automatic fix, and turns the draft into the existing
**diff review**. Nothing touches the project until the user applies the review.

Two modes, selectable per message in the composer:

- **Plan:** the agent reads the project and answers with a plan (goal, pages/sections, files to
  create or change, packages). The plan is shown as a card with **Build this plan** / **Edit** /
  **Discard**. No file is written.
- **Build:** the tool loop described below. It is the default; a new project's first message may
  start with a plan step (§9 Q3).

## 2. Verified host facts (alisio `main`, 2026-11-10)

| Fact | Consequence |
| --- | --- |
| Plugin tools are registered as `p_<sha256(pluginId)[:10]>_<name>`; for `alisio.lumbre` the prefix is `p_1515755981`. A child's `tools.allow` matches the **prefixed** name. | Lumbre computes the prefix the same way and lists exactly its own tools; a test pins the formula. |
| A read-only child drops tools with effect `write`, `process` and `external`; `internal` is downgraded to `external` for plugins. | Draft tools must be `effect: "read"` to run in a read-only child (§9 Q1). |
| A tool's `ctx.session` is the calling session (the child, in a Lumbre run). | Tools look up the job by child id; any other caller gets an error. |
| `sessions.run(childId, prompt)` again continues the same conversation; `usage` accumulates per child. | **Continue** is another run on the same child. |
| `maxTurns` bounds tool-loop turns per run (host default 100); hitting it returns `turnsExceeded` with the partial text, not a failure. | A paused job can be continued. |
| A child's `maxOutputTokens` is sent to the provider as an explicit limit (never clamped by the host). | Use the 0.1.1 budget rules unchanged. |
| App actions time out after 30 s; jobs run in the background and are polled. `busy()` blocks idle eviction. | §6. |

## 3. Tools (registered once per activation; usable only inside a Lumbre job)

All tools: `effect: "read"`, strict schemas, results are short JSON, errors are codes. Each one first
resolves `ctx.session` → running Lumbre job; **otherwise it returns `not_in_lumbre_job` and does
nothing**, so a call from the main chat is harmless. Names (unprefixed):

| Tool | Input | Effect on the job |
| --- | --- | --- |
| `lumbre_list_files` | `{}` | Paths and sizes of base revision + draft; managed files marked read-only. |
| `lumbre_read_file` | `path`, `offset?`, `limit?` | Draft content if changed, else base; bounded to 60,000 characters per call. |
| `lumbre_write_file` | `path`, `content` | Validates path (0.1.0 rules), refuses managed/generated files and limits (150 files, 400 KB/file, 3 MB). Stores in the draft. Timeline: "Writing index.html". |
| `lumbre_edit_file` | `path`, `find`, `replace` | Exact, unique search/replace in the draft (cheap for small changes). Fails with `not_unique`/`not_found`. |
| `lumbre_delete_file` | `path` | Marks deleted in the draft. |
| `lumbre_add_dependency` | `name`, `version` | Allowlist check (exact); queued for the review. |
| `lumbre_progress` | `message` (≤ 200 chars) | Timeline entry ("Adding the menu section…"). |
| `lumbre_done` | `summary`, `message` | Ends the build loop; the message becomes the chat reply. |

Plan mode allows only `lumbre_list_files` and `lumbre_read_file`.

## 4. Draft and job model

- **Draft:** `projects/<id>/drafts/<jobId>.json` = `{ base, files: {path: content | null}, deps,
  timeline }`, written atomically after each tool call (debounced ≤ 500 ms). One running build job
  per project; starting a new one while a draft is unreviewed asks to discard it.
- **Job states:** `running` → `checking` → `fixing` → `review` (draft became a proposal) | `paused`
  (turns ran out or the model stopped without `lumbre_done`) | `failed` | `cancelled`.
- **Timeline:** entries `{ at, kind: thinking|read|write|edit|delete|dependency|progress|check|fix|error,
  path?, text? }`, capped at 300, polled by the frame with the job.
- **Review:** at `review` the draft is converted to the existing proposal format (files, deletes,
  dependencies, ignored, `partial` when paused and reviewed early), so the diff review, per-file
  accept, apply and history are reused unchanged. The user can also **Review the draft now** from a
  paused job.

## 5. Build loop, Continue and autofix

1. Start (app action `agent.build`, effect `write`, approval as today): create the child with
   `tools.allow` = the prefixed Lumbre tools, `readOnly: true`, `maxTurns` = 40, `timeoutMs` = 15 min,
   0.1.1 output budget. The prompt carries the stack rules, managed files, allowlist, chat memory and
   the file list (not contents; the agent reads what it needs).
2. Run. When the run ends:
   - `lumbre_done` was called → step 3.
   - `turnsExceeded`, or ended without `lumbre_done` → **auto-continue** up to 2 more runs ("Continue
     until done"), then `paused` with a **Continue** button (and an optional goal note from the user).
   - The run wrote nothing and its text contains 0.1.1 blocks → **fallback**: models without tool
     calling are handled by the 0.1.1 pipeline (blocks, plan/batches, continuations) writing into the
     same draft.
3. **Check** (app action `agent.check`, effect `process`, started by the frame automatically when the
   job reaches `checking`, so the user approves processes as today): materialize base + draft into
   `projects/<id>/draft-work/` (in-place sync, `node_modules` linked from `work/` when packages are
   unchanged, installed otherwise) and build (or a syntax-only check for plain HTML/CSS/JS).
4. Errors → `fixing`: the build log goes back to the **same child** as another run, at most 2 fix
   rounds, each visible on the timeline. Still failing → `review` with a warning badge.
5. **Cancel** at any time: cancels the child run, keeps the draft, job `cancelled` (draft reviewable).

## 6. Turns, timeouts, approvals, busy and eviction

- Approvals: starting a build = one `write` approval; checks/installs = `process` approvals (as in
  0.1.x). Draft tools need none: they only change Lumbre's private draft. Applying the review stays
  the only write to the project.
- `busy()` is true while a job is `running`, `checking` or `fixing` (bounded by `timeoutMs` per run,
  3 runs + 2 fix rounds, and an overall job cap of 45 min). `paused`/`review` jobs never keep the
  workspace busy.
- On eviction or `dispose`: cancel child runs (synchronously), the draft is already on disk; on the
  next activation a `running` job is shown as `paused` and **Continue** starts a new run on the same
  child id, or on a new child seeded with the draft's file list if the old one is gone.
- Diagnostics (0.1.1) gain: runs, turns, tool calls by kind, fix rounds.

## 7. Frame

- Composer gets a **Plan / Build** toggle. The plan card has **Build this plan**, **Edit** (puts the
  plan into the composer) and **Discard**.
- **Activity card** (replaces the job card for agent jobs): current step text, spinner, elapsed
  time, counters (files written/edited/deleted), **Cancel**; collapsible **timeline** with icons per
  entry and file links that open the draft content. Paused: **Continue**, optional goal field,
  **Review the draft now**. All announcements through `aria-live`, en/es.

## 8. Acceptance matrix

| Id | Criterion | Test |
| --- | --- | --- |
| AGT-AC-01 | Tools refuse (code only, no state change) when `ctx.session` is not a running Lumbre job's child, including calls from the main chat | `test/agent-tools.test.ts` |
| AGT-AC-02 | The child gets exactly the prefixed Lumbre tools, read-only, deny write/process; plan mode gets list/read only | `test/agent.test.ts` |
| AGT-AC-03 | Write/edit/delete/dependency enforce 0.1.0 path, managed-file, allowlist and size rules in the draft | `test/agent-tools.test.ts` |
| AGT-AC-04 | Draft persisted atomically; the project is unchanged until the review is applied | `test/agent.test.ts` |
| AGT-AC-05 | `turnsExceeded` / no `done` → up to 2 auto-continues, then `paused`; Continue resumes on the same child | `test/agent.test.ts` |
| AGT-AC-06 | A model that answers with 0.1.1 blocks instead of tool calls still produces a draft | `test/agent.test.ts` |
| AGT-AC-07 | Check runs on `draft-work`, never on `work`; errors go back to the same child, max 2 rounds | `test/agent.test.ts` |
| AGT-AC-08 | Cancel keeps the draft; eviction/dispose cancels runs; next activation shows `paused` | `test/agent.test.ts`, `test/plugin.test.ts` |
| AGT-AC-09 | `busy()` only while running/checking/fixing; overall job cap enforced | `test/agent.test.ts` |
| AGT-AC-10 | Plan card, activity card, timeline, Continue, review hand-off in en/es, both themes, narrow | `test/frame-agent.test.ts`, Playwright |
| AGT-AC-11 | Opt-in real run: one Build per stack with a tool-calling model reaches `review` and builds | `test/integration.test.ts` (opt-in) |

## 9. Owner decisions (2026-11-10: the recommended option of each question)

| Id | Question | Decided | Rejected alternative |
| --- | --- | --- | --- |
| Q1 | Effect of the draft tools | `read`: they only change Lumbre's private draft, so they run in a read-only child with no approval per file; applying the review stays the one approved write | `write` in a non-read-only child: an approval prompt for every file the agent writes |
| Q2 | The tools are also listed in the main chat (the host has no per-session registration) | Accept: they refuse outside a Lumbre job, with descriptions that say so | One multiplexed `lumbre_draft` tool (less clutter, weaker tool use by models) |
| Q3 | When to plan first | Plan step (shown for approval) only for the first message of a new project; afterwards Build directly; the Plan/Build toggle is always available | Always plan first; or never unless the user picks Plan |
| Q4 | "Continue until done" | 2 automatic continuations, then pause with a Continue button and optional goal | Continue automatically until `done` or the 45 min cap |
| Q5 | Autofix before review | Build the draft in `draft-work` (packages linked from `work`) and fix up to 2 rounds before the review | Keep 0.1.x: check only after the user applies |
| Q6 | Include `lumbre_edit_file` (search/replace) | Yes: far fewer output tokens for small changes | Whole-file writes only |
| Q7 | Models without tool calling | Detect automatically (no tool calls + 0.1.1 blocks) and use the 0.1.1 pipeline | A per-project "simple mode" switch |
| Q8 | Tool name prefix | Compute `p_<sha256(id)[:10]>` like the host and pin it with a test | Ask the host for an API that returns registered tool names (needs an Alisio change) |

## 10. Further owner decisions (2026-11-10) and what was built

| Id | Decision | Where |
| --- | --- | --- |
| D1 | Design skill `lmb-design`, adapted and combined from Anthropic's and Vercel Labs' `frontend-design` skills (Apache-2.0; LICENSE.txt shipped). The design token plan (direction, 4-6 named colors, type roles, layout with an ASCII wireframe, principles) is a `<<<LUMBRE-DESIGN>>>` block shown in the plan card with swatches. Used in plan and build passes and the block fallback, not in fixes. The person's brief always wins. | `.agents/skills/lmb-design/`, `src/output.ts` (`readDesign`), `web/app.js` (`planCardHtml`) |
| D2 | `lmb-react-next`: Vercel's react-best-practices condensed (MIT, Copyright (c) Vercel, Inc.) plus original Next.js 16 file conventions based on the Next.js docs (MIT), checked against the docs shipped in next@16.4.3 (`proxy`, not `middleware`; the export is still `config`; `params` is a Promise). Used for React and Next.js; Next conventions also for Next plans. | `.agents/skills/lmb-react-next/` |
| D3 | `lmb-tailwind`, adapted from wshobson/agents' tailwind-design-system (MIT, Copyright (c) 2024 Seth Hobson). Every directive and variant it teaches was compiled with Tailwind 4.3.3. Used in build passes of every Tailwind stack. | `.agents/skills/lmb-tailwind/` |
| D4 | Allowlists widened (versions published at least two weeks before pinning; each stack's full set resolved with `--strict-peer-deps` by `scripts/update-preset-locks.mjs --check-extras`). Vite and Astro: `clsx`, `tailwind-merge`, `class-variance-authority`, `zod`, `date-fns`, self-hosted fonts. React and Next.js: those plus `lucide-react`, `motion`, `react-hook-form`, `@hookform/resolvers` and Radix `react-slot`, `react-dialog`, `react-dropdown-menu`, `react-tabs`, `react-accordion`, `react-popover`, `react-tooltip`, `react-label`. HTML/CSS/JS + Tailwind: none (no bundler). `tailwindcss-animate` is never allowed. Extra packages resolve their transitive versions when the person approves them, and the resulting lockfile is then frozen per project, so every later install is `npm ci`. | `src/presets.ts` |
| D5 | Astro may enable React islands: approving `@astrojs/react` (7.1.1) makes Lumbre add `react`/`react-dom` at the preset's version, regenerate its managed `astro.config.mjs` with the integration (a vetted transform; the model's own config edits are still dropped), and allow the React-only packages for that project. | `src/presets.ts` (`allowlistFor`, `ownedFiles`) |
| D6 | Fewer dependencies first: native elements and plain components before packages; a package only when it clearly helps, with the reason stated; Astro pages stay zero-JS unless interactivity is needed. In every skill and agent that writes code, and in the prompt. | skills, agents, `packageNote` |

Additional acceptance:

| Id | Criterion | Test |
| --- | --- | --- |
| AGT-AC-12 | Skills present with the `lmb-` prefix and attribution; licenses shipped; instructions include each skill only for the modes and stacks it applies to | `test/skills.test.ts`, `pnpm pack:check` |
| AGT-AC-13 | Every package the Tailwind skill imports is allowed where the skill is used; Vite/Astro never get React-only packages | `test/skills.test.ts` |
| AGT-AC-14 | Astro without the feature has no React; with it, the integration comes from Lumbre's transform and React packages are allowed | `test/astro-react.test.ts`, `test/service.test.ts` |
