# Spec: `@alisio/plugin-lumbre` v1 (web builder app)

Status: **Implemented, not committed or published.** Owner decisions A-F dated 2026-11-10 are
binding. Audience: a coding agent working in this monorepo. Language: English (repo `AGENTS.md`);
UI strings are `{ en, es }` and the README pair is bilingual.

## 1. Goal

A Lovable/v0-style builder inside Alisio: the user describes a landing page or a small full-stack
app, the Alisio model they pick generates it, and they iterate in a chat. Lumbre is an app-type
plugin (`api.apps`, Alisio >= 0.11.6 for the approval prompt) with plugin id `alisio.lumbre`, app id
`studio` and resource prefix `lmb-`.

## 2. Starting state (audit, verified 2026-11-10)

The owner's draft (untracked) worked end to end but diverged from the monorepo and had safety gaps:
its own `pnpm-lock.yaml`, biome, `@types/node`, TypeScript 5 and `node:test`; a hardcoded version;
`cover.svg` listed but missing next to the owner's 1.7 MB `cover.png`; README links to files that do not
exist; nine type errors under the shared `tsconfig.base.json`; one `{ type: "object" }` schema for
every action; a frame that latched "unavailable" on the first `not_found`, ignored
`message.effect` and dropped the approval notice; a single `state.json` rewritten (and every project
re-materialized) on activation; whole-folder swaps that refused to apply changes while a server ran;
proposals that could not delete files; a model that could rewrite config files; no PID tracking or
orphan reaping; no idle stop (so `busy()` could block eviction forever); and a fixed token budget.

## 3. Owner decisions (2026-11-10)

| Id | Decision | Where |
| --- | --- | --- |
| A | Preview = "Open live in your browser" (loopback dev server with hot reload) plus an in-frame **static thumbnail** rendered in a shadow root with scoped CSS and paint containment, so model CSS cannot overlay Lumbre's UI. No nested `srcdoc` frame. | `web/thumbnail.js`, `src/runtime.ts`, `src/snapshot.ts` |
| B | npm runs as an approved `process` job with `--ignore-scripts`, pinned versions, a committed lockfile per preset and `npm ci`. Extra packages only through a structured `dependencies` field validated against a per-stack allowlist (exact name and version) and shown for approval. The model never edits `package.json`. | `src/presets.ts`, `presets/*/package-lock.json`, `src/runtime.ts` |
| C | v1 stacks: Vanilla (optional Tailwind), Vite + Tailwind, React + Vite + Tailwind, Astro + Tailwind, Next.js (App Router with API routes). No standalone backend. | `src/presets.ts` |
| D | Projects live in Lumbre's private state with history, plus an explicit "Export to my workspace" write action and a ZIP download. | `src/store.ts`, `src/service.ts`, `src/zip.ts` |
| E | Child sessions with a per-project model picker (`models.list`/`resolve`, fallback notice, no-model blocking state); a chat thread per project; an automatic fix-up pass that feeds build/dev-server errors back to the model (at most 2 attempts, visible); a visual diff review (added/changed/deleted, per-file diff, accept all or per file). | `src/generate.ts`, `src/service.ts`, `web/diff.js` |
| F | Constant feedback: staged messages, spinner, progress bar where measurable, elapsed time, Cancel, plain-language success/error messages with the next step, "Waiting for your approval in Alisio…" while approval is pending, `aria-live` announcements; en/es following Alisio. | `web/app.js`, `web/derive.js`, `web/i18n.js` |

Also: safe Markdown for assistant messages, copy controls, the disclaimer under the composer, both
themes, a narrow layout, and Lumbre's own identity (tokens derived from `icon.svg`).

## 4. Architecture

- `src/index.ts`: one runtime per activation (no module globals shared between workspaces); the
  read-only tool `lumbre_projects` and the `help` command (per locale) work without `api.apps`.
- `src/apps.ts`: action lists grouped by effect and one strict `inputSchema` per action
  (`additionalProperties: false`, bounded strings/arrays, no `$ref`/`$id`/`$async`). The handler
  calls `throwIfAborted` inside its `try` and returns error codes only.
- `src/store.ts`: one directory per project (`meta.json`, `revisions/<id>.json` manifests,
  content-addressed `blobs/<sha256>`, `chat.json`, `proposal.json`, `snapshot.json`). Activation
  reads each `meta.json` once; a corrupt project is listed as damaged and never breaks the others.
  Every write is atomic (temp file + rename, mode 0600).
- `src/workdir.ts`: syncs `work/` to a revision in place (changed files only, removed files
  deleted, `node_modules` and build output untouched), so a running dev server hot-reloads.
- `src/runtime.ts`: child processes with a minimal environment; an explicit free port and strict
  port for every stack; readiness checked on that port; PID files reaped on the next activation
  (only after the command line is verified to belong to the project); `dispose` kills process
  groups synchronously; idle auto-stop after 20 minutes without frame activity. Vanilla uses an
  in-process loopback static server with live reload; Tailwind for vanilla runs the Tailwind CLI.
- `src/generate.ts`: prompt building with chat memory, a token budget derived from the model's
  context window, output parsing and validation (owned files and unknown packages are dropped and
  reported, never applied).
- `src/service.ts`: projects, chat, proposals, jobs with stages, apply/discard, export, fix-up.

Preset-owned files (`package.json`, lockfiles, `vite`/`astro`/`next`/`postcss`/`tailwind` configs,
`jsconfig.json`) are generated by Lumbre and read-only for the model and the editor.

## 5. Actions

| Action | Effect | Input (all also `additionalProperties: false`) | Result |
| --- | --- | --- | --- |
| `status` | read | `{}` | version, minimum host, stacks with allowlists |
| `models.list` | read | `{}` | `{ models, active, available }` |
| `projects.list` | read | `{}` | project summaries (damaged ones flagged) |
| `projects.get` | read | `projectId` | files, history, chat, proposal summary, server, job |
| `files.get` | read | `projectId`, `path` | file content |
| `proposal.get` | read | `projectId` | proposal with before/after per file |
| `preview.snapshot` | read | `projectId` | sanitized-in-frame HTML + CSS, revision, stale flag |
| `jobs.get` | read | `jobId` | job with stage, progress, elapsed, error |
| `server.status` | read | `projectId` | server state (also counts as activity) |
| `project.zip` | read | `projectId` | base64 ZIP |
| `projects.create` | write | `title`, `stack`, `tailwind?`, `model?` | project |
| `projects.update` | write | `projectId`, `title?`, `model?`, `archived?` | project |
| `projects.delete` | write | `projectId` | `{ deleted }` |
| `chat.send` | write | `projectId`, `text`, `locale?` | `{ jobId }` |
| `chat.clear` | write | `projectId` | project |
| `proposal.apply` | write | `projectId`, `proposalId`, `files`, `deletes`, `dependencies` | project |
| `proposal.discard` | write | `projectId`, `proposalId` | project |
| `files.save` / `files.delete` | write | `projectId`, `path`, `content?`, `baseRevision` | project |
| `revisions.restore` | write | `projectId`, `revisionId` | project |
| `jobs.cancel` | write | `jobId` | `{ cancelled }` |
| `project.export` | write | `projectId`, `folder` | `{ folder, files }` |
| `preview.check` | process | `projectId`, `fixAttempt?` | `{ jobId }` (install, build or probe, fix-up) |
| `server.start` / `server.stop` | process | `projectId` | `{ jobId }` / server |
| `server.open` | process | `projectId` | `{ opened }` |
| `deps.install` | process | `projectId` | `{ jobId }` |

## 6. Acceptance matrix

| Id | Criterion | Test |
| --- | --- | --- |
| LMB-AC-01 | Package conventions: root lockfile only, typescript 7.0.2, vitest 5.0.4, `src/version.ts`, peer `>=0.11.6 <0.12.0`, owner cover shipped as an optimized 1600×900 `cover.webp` (declared in `alisio.cover`, 165 KB; the owner keeps the original outside the repo) + `icon.svg` | `pnpm check` (`pack:check`), `test/plugin.test.ts` |
| LMB-AC-02 | Every action has a strict schema, a declared effect and code-only errors; aborts return `cancelled` | `test/apps.test.ts` |
| LMB-AC-03 | Help text follows the locale; the tool works without `api.apps`; dispose is idempotent | `test/plugin.test.ts` |
| LMB-AC-04 | Per-project storage: corrupt project isolated; activation rewrites nothing; blobs content-addressed | `test/store.test.ts` |
| LMB-AC-05 | Applying writes changed files in place, deletes removed ones, keeps `node_modules`; allowed while a server runs | `test/workdir.test.ts`, `test/service.test.ts` |
| LMB-AC-06 | The model cannot change preset-owned files or add packages outside the allowlist; it may delete files | `test/generate.test.ts`, `test/service.test.ts` |
| LMB-AC-07 | Token budget follows the model's context window; chat history is included and bounded | `test/generate.test.ts` |
| LMB-AC-08 | Child env carries no provider credentials; explicit port + strict port for every stack; readiness on that port | `test/runtime.test.ts` |
| LMB-AC-09 | PID files written, orphans reaped only when verified; dispose kills; idle auto-stop clears `busy()` | `test/runtime.test.ts` |
| LMB-AC-10 | Fix-up: a failing build triggers at most 2 automatic fix proposals, each visible | `test/service.test.ts` |
| LMB-AC-11 | Export writes inside the workspace only and refuses non-empty folders; ZIP is valid | `test/service.test.ts`, `test/zip.test.ts` |
| LMB-AC-12 | Frame: first connect from parent only; transient `not_found` verified once, persistent shows "Try again"; `not_permitted` names `message.effect`; approval notice stays until the response | `test/frame.test.ts` |
| LMB-AC-13 | Thumbnail: scripts/handlers/external URLs removed, `html`/`body`/`:root` selectors scoped, paint contained | `test/ui.test.ts` |
| LMB-AC-14 | Feedback: stage texts, progress, elapsed time and errors with next steps exist in en and es | `test/ui.test.ts`, `test/frame.test.ts` |
| LMB-AC-15 | Markdown is escaped before formatting; copy controls on assistant messages; disclaimer present | `test/ui.test.ts`, `test/frame.test.ts` |
| LMB-AC-16 | Opt-in real run (`LUMBRE_INTEGRATION=1`): every preset installs with `npm ci`, builds and serves | `test/integration.test.ts` (not in `pnpm check`) |
| LMB-AC-17 | Visual check in a stand-in host: both locales and themes, wide and narrow | `.playwright-mcp/lumbre-*.png` |

## 7. Non-goals (v1)

Publishing/hosting, domains, managed auth or databases, GitHub import, binary uploads, visual
element selection, collaboration, a standalone backend stack, and an OS sandbox: generated apps run
as the user, after the host's process approval.

## 8. 0.1.1: long answers (owner bug, 2026-11-10)

Symptom: with `opencode-go/deepseek-v4.1-flash`, whose catalog reports no limits, every landing
request failed with `invalid_output`. 0.1.0 assumed a 32,000-token context and a 16,000-token
output, and needed the whole project as one escaped JSON object, so one cut lost everything.

| Id | Criterion | Test |
| --- | --- | --- |
| LMB-AC-18 | Answers are delimited blocks; prose and fences are tolerated; the 0.1.0 JSON form still works; a cut answer keeps every complete block | `test/output.test.ts` |
| LMB-AC-19 | Unknown limits: 128,000 context and 32,768 output; reported limits are used as they are (never above the catalog value) | `test/generate.test.ts`, `test/generation.test.ts` |
| LMB-AC-20 | New projects (or large requests, or small budgets) are planned, then written in batches sized to the output budget, on one child session | `test/generation.test.ts` |
| LMB-AC-21 | A cut answer is continued up to 3 times; when it still stops, the complete files become a partial proposal with a notice; with no complete file the job fails with `output_truncated` | `test/generation.test.ts` |
| LMB-AC-22 | `agent_failed` carries a failure category (never the provider's text); an estimated output limit the provider rejects is retried once without it | `test/generation.test.ts` |
| LMB-AC-23 | Every generation job records model, context and output budget (reported or estimated), usage, batches, continuations and reason; the error card shows them under Details (en/es) | `test/generation.test.ts`, `test/frame-details.test.ts` |

A child's `maxOutputTokens` is sent to the provider as an explicit limit (the host does not clamp it
to `limits.maxOutputTokens` or to the catalog maximum), so Lumbre never asks for more than the
catalog reports.
