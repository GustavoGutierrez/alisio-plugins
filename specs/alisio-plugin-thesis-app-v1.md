# Spec: `@alisio/plugin-thesis` app v1 (Thesis Studio web UI)

Status: **Draft for owner review (2026-11-10).** Not implemented. Spec first, then implementation
(owner decision O1).
Audience: a coding agent adding a plugin app to `packages/plugin-thesis` with no prior context.
Parent spec: `specs/alisio-plugin-thesis-v1.md` (lifecycle, gates, checks, security). This file only
adds the app; every rule of the parent spec still applies.
Language: English, except UI strings (`{ en, es }`) and the bilingual README pair.

---

## 0. How to use this document

1. Read `AGENTS.md`, `.agents/skills/create-alisio-plugin/SKILL.md` and its
   `references/plugin-app.md`. They win over this file on conflict.
2. Frame references: `packages/plugin-semantic/web/*` (newest: safe Markdown, copy controls, model
   picker, `not_found` recovery, locale) and `packages/plugin-scribe/web/*` (PDF.js viewer, single-file
   HTML build, transport tests). Copy their shape, not their product.
3. Labels: **(verified 2026-11-10)** = read in this repo or in the SDK typings that day;
   **(new)** = does not exist yet.
4. RFC 2119 keywords only where they matter for safety or tests. Behavior uses EARS
   (`WHEN <trigger>, the <system> MUST <response>`).
5. Strict TDD (vitest, offline, no snapshots). Phase order (§10) is mandatory; each phase ends with
   `pnpm check` green. **Do not commit or publish until the owner asks.**

---

## 1. Goal and non-goals

### 1.1 Goal

Give non-technical thesis authors a guided, full-page **Thesis Studio** app inside Alisio that
always answers "where am I and what do I do next", and lets them do the whole lifecycle with buttons
instead of slash commands, while every existing command, tool, agent and the chat coordinator keep
working unchanged (O2, O3).

### 1.2 Non-goals (v1)

| Excluded | Reason |
| --- | --- |
| A rich-text or WYSIWYG chapter editor | Chapters are protected by the editor diff guard; changes go through "Request changes" or the user's own editor |
| Replacing chat commands | The app is a second surface over the same coordinator |
| A fallback UI on hosts without `api.apps` | Repo rule: explain the minimum host instead |
| Collaborative or multi-user editing | Alisio is single-user |
| New lifecycle behavior (new gates, checks, roles) | Out of scope; the app only exposes what exists |
| Streaming child output token by token | The SDK gives status text and final results only |

---

## 2. Verified current state (2026-11-10)

| Fact | Evidence |
| --- | --- |
| Package `@alisio/plugin-thesis` 0.5.3, peer `@alisio/sdk >=0.9.0 <0.12.0`, devDependency `0.11.4`, build `tsc` only, no `web/` | `package.json` **(verified)** |
| Phases `intake → design → outline → sections → review → final → submitted`; Human Gates `A`, `B`, `OUTLINE`, `C` | `src/types.ts` `phases`, `gateNames` **(verified)** |
| Section statuses `planned, researching, research_review, research_approved, drafting, draft_review, approved, revising` | `src/types.ts` **(verified)** |
| Approve targets `A\|B\|OUTLINE\|C\|SEC-id\|FND-id\|ETH-id\|norms\|style:id`; revise targets `A\|B\|OUTLINE\|SEC-id\|FND-id\|norms\|style:id` | `src/index.ts`, `coordinator.ts` **(verified)** |
| 20 commands (`init, answer, status, check, pack, style, norms, design, outline, approve, revise, research, draft, figure, review, finalize, build, setup, next, doctor`) and 6 tools (`thesis_answer, thesis_scholar_search, thesis_scholar_resolve, thesis_status, thesis_check, thesis_build`) | `src/index.ts` **(verified)** |
| Commands resolve the workspace from `sessionId` via `api.sessions.workspace` | `coordinator.ts:157` **(verified)** |
| Inline gates use `api.ui.askQuestions` only when `api.ui.interactive()`; otherwise they return the decision as text (`/thesis:approve X` or `/thesis:revise X -- …`) | `workflow.ts:300`, `:459`, `context.ts:askOne`, `draft.ts:911`, `research/flow.ts:332`, `finalize.ts:132`, `authoring.ts:332,640`, `coordinator.ts:261` **(verified)** |
| Interview parks a round as `state.pendingQuestions` (SDK `Question[]`) when headless; `answerFromChat` validates and applies answers | `coordinator.ts` `advance`, `applyAnswers`, `answerFromChat` **(verified)** |
| Children: `Delegator` creates read-only child sessions (`parentId` = caller session), 180 s (librarian 300 s), one retry on an invalid envelope; progress via `api.ui.status("phase", …)` | `src/delegate.ts` **(verified)** |
| `buildRun` accepts an `AbortSignal` and reports progress through `api.ui.status("build", …)`; `/thesis:setup` installs pinned Typst | `coordinator.ts` **(verified)** |
| Approving a section runs a partial build (`scope: "approved"`); `finalize` builds PDF/A | `draft.ts:partialBuild`, `finalize.ts:170` **(verified)** |
| State `<workspace>/.alisio/thesis/state.json`, written atomically; `validateState` keeps unknown keys (spread); no lock exists | `src/storage.ts` **(verified)** |
| User-editable files: `thesis/thesis.yaml`, `thesis/policy/*.yaml`, `thesis/policy-packs/**`, `thesis/styles/*.csl`, `thesis/styles/*.profile.yaml`, `thesis/data/*.csv` | README "Workspace layout", "Policy packs" **(verified)** |
| `api.apps?` and `PluginAppContext { sessionId, workspace, signal, idempotencyKey? }` first appear in SDK **0.11.5**; the approval prompt for app `write`/`process` actions in **0.11.6**; 0.11.7 only adds semantic ports | diff of SDK typings 0.11.4–0.11.7 **(verified)** |
| `api.models.list/resolve`, `api.sessions.model(id)` and `ChildSessionSpec.model` already exist in SDK **0.9.0** (`sessions.create` "resolves an optional model selector") | SDK 0.9.0 typings **(verified)** |
| `PLUGIN_APP_LIMITS`: html 8 MiB, timeout 30 s, 8 in flight (request/result sizes in the typings) | SDK 0.11.7 **(verified)** |

**Consequence:** the real minimum host for the app is **Alisio 0.11.6** (0.11.5 shows the app but
never prompts, so `write`/`process` actions fail with `not_permitted` unless already granted). The
model picker needs nothing newer. The peer range stays `>=0.9.0 <0.12.0`; the devDependency moves to
`0.11.7` (O7).

---

## 3. Owner decisions (2026-11-10)

| ID | Decision |
| --- | --- |
| O1 | Spec first, then implement |
| O2 | UI for non-technical users, easy to understand |
| O3 | Keep all current functionality: commands, tools, agents and the chat coordinator keep working unchanged |
| O4 | Model selection from the UI |
| O5 | Thesis's own identity: gradient `#0b3fae → #3fa9ff`, white, under-band `#cfe6ff`, gold accent `#ffd166` (from `icon.svg`) |
| O6 | UI follows Alisio's locale (`es*` → Spanish, else English); no own language selector |
| O7 | App feature-detected (`api.apps?`); peer range compatible (`>=0.9.0 <0.12.0`); devDependency `0.11.7`; README states the real minimum host (0.11.6) |

---

## 4. Design decisions (binding)

| ID | Decision | Consequence |
| --- | --- | --- |
| D1 | App id `studio`, label `{ en: "Thesis Studio", es: "Estudio de tesis" }`, registered after all commands and tools, only `if (api.apps)` | Older hosts lose nothing. Thesis has no help command, so `/thesis:status` appends one line: the app's name when registered, else "Thesis Studio needs Alisio 0.11.6 or newer" |
| D2 | **One coordinator, two surfaces.** App actions call the same `ThesisCoordinator`/`Workflow` methods as commands. No lifecycle logic is duplicated in `src/app/` | Behavior parity by construction |
| D3 | **Produce-then-decide.** App work runs through a job-scoped API facade (`src/app/facade.ts`) whose `ui.interactive()` is `false`, `ui.askQuestions` resolves every id to `undefined`, `ui.status` feeds the job progress, `sessions.create` injects the chosen `model` and records child ids, `sessions.run` injects the job signal. The existing non-interactive branches then park decisions; the app shows them as buttons that call `approve`/`revise` | No `askQuestions` prompt ever appears in the chat because of the app; no change to `workflow.ts` gate code |
| D4 | **Single writer per workspace.** A new in-process `WorkspaceLock` (`src/lock.ts`) wraps every state-mutating command, the `thesis_answer` tool and every app `write`/`process` action. Read actions and read tools never lock | WHEN the lock is held, a command MUST return `Blocked: Thesis Studio is running <job label>; wait or cancel it there.` and an app action MUST return `{ error: "busy", holder: "chat" \| "app", label }`. Only behavior change for chat, and only on a conflict that was a silent race before |
| D5 | **Revision guard.** `status` returns `revision` = SHA-256 of `state.json` bytes. Every decision action (`approve`, `revise`, `files.write`, `settings.setModel`) requires `revision`; a mismatch returns `conflict` and the frame refreshes | A decision is never applied to a state the user has not seen (e.g. changed from chat) |
| D6 | **Jobs for long work.** Any action that can exceed 2 s returns `{ jobId }`; one running job per workspace (it holds the lock); jobs are kept per activation (last 20) | Respects the 30 s action timeout; `busy()` is true while a job runs |
| D7 | **Model per project** stored as `state.settings.model` (`provider/model` reference, ≤ 200 chars) **(new)**, applied by the `Delegator` to every child (chat and app), resolved with `api.models.resolve` before each child; on failure the child inherits Alisio's active model and the job/command reports "the chosen model is not available; used <active>". The setting is never cleared automatically | One model for all roles in v1 (Q2); older plugin versions keep the key (spread in `validateState`) |
| D8 | **Effects are honest and minimal.** File-writing or child-spawning actions are `write`; anything that runs a process (Typst build, setup, doctor probes, finalize PDF/A) is `process`. Section approval from the app is `write` and **does not** run the partial build inside the action; the frame then starts `build.run { scope: "approved" }` (`process`) | Same outcome as the command (approval then partial build) with a correct approval prompt per effect; a denied build leaves the approval recorded |
| D9 | The host is the only permission gate: handlers never call `api.sessions.capabilities` | Matches the repo rule |
| D10 | Structured read models (`src/app/views.ts`) read state and files directly; command result text is shown only as a collapsible "Details" block | The UI is localized and structured even though command text is English |
| D11 | PDF preview with bundled PDF.js (Scribe's `pdf-viewer.js`, `isEvalSupported: false`, `useWasm: false`, worker from `blob:`); download through a `blob:` URL | No network, works in the opaque-origin frame |

---

## 5. Screens (`web/`)

Global frame: header with the Thesis icon, project title and phase badge; left navigation (tabs
under 900 px); a persistent job bar ("Writing SEC-03…", elapsed time, Cancel); a footer disclaimer
(§7.4). Colors from O5 on Alisio-like neutral surfaces, both themes.

| Screen | Content and controls |
| --- | --- |
| **Home (guided)** | Horizontal stepper over the 7 phases (done / current / locked) with plain-language names ("Project details", "Research plan", "Chapter plan", "Write chapters", "Final review", "Final document", "Submitted"). One large **Next step** card from `nextStep` (§6.2) with a single primary button and a one-sentence "why". Gate cards (A, B, OUTLINE, C) with status. Empty state: "Start a thesis" (`project.init`, optional folder and language) |
| **Interview** | Wizard over `pendingQuestions`: one question per step, options as radio/checkbox cards with the recommended one marked, optional free text, Back/Next, "Save answers" (`interview.answer`); progress "Round 2 of 3". Validation errors shown next to the question. "Presentation settings" entry after rounds 1–2 |
| **Plan review** | Tabs "Research plan" (`research/protocol.md`, Gates A and B) and "Chapter plan" (`outline/outline.md` + tree from `outline.json`, Gate OUTLINE). Rendered Markdown, the G1/G4 findings, buttons **Approve** and **Request changes** (dialog with a feedback textarea). "Create draft" when none exists |
| **Chapters board** | One card per section (id, title, status chip, dependency hint from `sectionNext`). Card actions by status: Research / Search more / Add a source I have / Approve research / Write draft / Request changes / Approve / Add figure. Opening a card shows the dossier or the chapter rendered, its checks and claims |
| **Evidence library** | Table from `evidence/library.jsonl` (title, authors, year, type, status chip, sections), filters (section, status, text), detail drawer (verification method, retraction flag, appraisal, DOI/URL as copyable text, never a link); rejected records and the search log in a secondary tab |
| **Review** | Findings from `reviews/FND-*.json` grouped by severity: **Fix** (`revise FND-id` with feedback), **Dismiss with reason** (`approve FND-id -- reason`), status filter; "Run review" (all or one section); blocking count |
| **Build & submit** | Last check report (`build/check-report.json`) with "Run checks"; build options (full / approved / one section, PDF/A, HTML) and **Build**; PDF.js preview of the last or final PDF with page navigation and zoom; **Download PDF**; Gate C card (approve) and **Finalize**; submission summary (`build/submission/manifest.json`) |
| **Settings** | **Model** picker (§7.1); **Rules and styles**: packs list/check/explain, new pack, styles list/check, "New style from a guide", "Import norms from a guide", pending norms/style approval with open questions; ethics requirements (`ETH-*`) with a resolution text; **Files**: editors (§7.2); **Setup**: Typst status (`doctor.run`), "Install Typst" (`engine.setup`) |

Every decision button explains the consequence in one line ("Approving locks the research plan;
you can still request changes later with …" only where the coordinator allows it).

---

## 6. Backend

### 6.1 Module layout (new)

```text
src/lock.ts            WorkspaceLock (async mutex keyed by resolved workspace; holder + label)
src/model-choice.ts    resolveChildModel(api, workspace) -> { model?: string; notice?: string }
src/app/index.ts       registerStudioApp(api, coordinator): actions map, html, busy, dispose
src/app/actions.ts     READ_ACTIONS / WRITE_ACTIONS / PROCESS_ACTIONS, input schemas
src/app/service.ts     action logic over ThesisCoordinator (testable without a host)
src/app/jobs.ts        per-activation job registry (start, get, cancel, progress, result, error code)
src/app/facade.ts      job-scoped PluginAPI facade (D3)
src/app/views.ts       structured read models + nextStep()
web/                   index.html, app.js, i18n.js, derive.js, markdown.js, copy.js, icons.js, pdf-viewer.js, style.css
scripts/embedded-html.mjs, scripts/build-ui.mjs
```

`build` becomes `tsc -p tsconfig.json && node scripts/build-ui.mjs`; `dist/embedded.html` ships
(already under `dist`). New devDependencies only: `esbuild 0.28.2`, `pdfjs-dist 6.5.438` (bundled
into the frame, as Scribe), `jsdom` if not already available to tests.

### 6.2 `nextStep(state)` (new, pure)

Returns `{ action, target?, phase, reasonKey }` with the same decision table as
`Workflow.nextCommand` (`workflow.ts:742`), e.g. `{ action: "approve", target: "A" }`,
`{ action: "draft.run", target: "SEC-03" }`, `{ action: "interview" }`. A test asserts that for every
fixture state `nextStep` and `nextCommand` name the same operation and target.

### 6.3 Actions

Every schema: `type: "object"`, `additionalProperties: false`, bounded strings/arrays, ids with the
`idPatterns` regexes, no `$ref`/`$id`/`$async`. Handlers take workspace and session from `ctx`,
return error **codes** only, honor `ctx.signal`, use `ctx.idempotencyKey` for mutations (a repeated
key returns the first result or job id).

| Action | Effect | Input (bounds) | Result / maps to |
| --- | --- | --- | --- |
| `status` | read | — | `statusSummary` + `nextStep`, `revision`, running job, model choice, `minHost: "0.11.6"`, lock holder |
| `interview.get` | read | — | `pendingQuestions`, completed rounds, language hint |
| `artifact.get` | read | `{ kind: protocol\|outline\|chapter\|dossier, section? }` | Markdown text ≤ 1 MiB + findings for its gate |
| `evidence.list` | read | `{ section?, status?, text? ≤ 200, offset, limit ≤ 200 }` | records page + totals |
| `claims.list` / `findings.list` | read | `{ section? }` / `{ status? }` | claims / findings |
| `check.last` | read | — | last `CheckReport` or null |
| `packs.list` / `packs.explain` / `styles.list` | read | — / `{ query ≤ 120 }` / — | text from `listPacks` / `explain` / `listStyles` |
| `files.list` / `files.read` | read | — / `{ path }` (allowlist §7.2) | editable files / text ≤ 256 KiB + `revision` |
| `pdf.get` | read | `{ which: last\|final }` | `{ base64, bytes, pages }`; `too_large` above 60 MiB with the relative path |
| `models.list` | read | — | `{ models: [{ reference, name, provider }], active, chosen, chosenAvailable }` |
| `jobs.get` | read | `{ jobId }` | `{ state, label, progress[] (≤ 20 lines), elapsedMs, result?, error? }` |
| `project.init` | write | `{ dir?, lang?, presentation? }` | `init` (parks rounds, D3) |
| `interview.answer` | write | `{ answers: map ≤ 20 × 2 000 chars }` | `applyAnswers` path of `answerFromChat`; next questions |
| `approve` | write | `{ target, notes? ≤ 4 000, revision }` | `approve`; SEC targets skip the inline partial build (D8) |
| `revise` | write | `{ target, feedback 1..4 000, revision }` | `{ jobId }` → `revise` |
| `design.run` / `outline.run` | write | — | `{ jobId }` → `design` / `outline` |
| `research.run` | write | `{ section\|"next", more? ≤ 1 000, add? ≤ 1 000 }` | `{ jobId }` → `research` |
| `draft.run` | write | `{ section\|"next", feedback? ≤ 4 000 }` | `{ jobId }` → `draft` |
| `figure.run` | write | `{ section, request 1..2 000 }` | `{ jobId }` → `figure` |
| `review.run` | write | `{ target: "all"\|SEC-id }` | `{ jobId }` → `review` |
| `next.run` | write | — | `{ jobId }` → `next` (non-interactive) |
| `check.run` | write | `{ gates?: G0..G10[] }` | `check` (writes the report) |
| `packs.new` / `packs.check` | write / read | `{ scope, id }` / — | `newPack` / `checkPacks` |
| `styles.new` / `norms.import` | write | `{ id, guide ≤ 50 000 }` / `{ guide ≤ 50 000 }` | `{ jobId }` |
| `files.write` | write | `{ path, content ≤ 256 KiB, revision }` | atomic write; `thesis.yaml` re-runs G0 and returns findings |
| `settings.setModel` | write | `{ model: string ≤ 200 \| null, revision }` | resolved first; `unknown_model` if it does not resolve |
| `jobs.cancel` | write | `{ jobId }` | aborts signal + `api.sessions.cancel` on recorded children |
| `build.run` | process | `{ scope, section?, pdfa?, format? }` | `{ jobId }` → `buildRun` |
| `finalize.run` | process | — | `{ jobId }` → `finalize` (Gate C must be approved via `approve C` first) |
| `engine.setup` / `doctor.run` | process | — | `{ jobId }` → `setup` / `doctor` |

Error codes: `invalid_input`, `not_initialized`, `not_found`, `busy`, `conflict`, `blocked` (with the
coordinator's reason text, which never contains input or absolute paths), `no_model`,
`unknown_model`, `too_large`, `path_not_allowed`, `cancelled`, `child_rejected`, `operation_failed`.

### 6.4 Jobs and concurrency (EARS)

- WHEN a long action starts, the service MUST acquire the lock, register the job and return
  `{ jobId }` within 2 s; the work continues after the action returns.
- WHEN the lock is held by chat or another job, the action MUST return `busy` with the holder label
  and start nothing.
- WHEN a child or the build calls `ui.status`, the job MUST append the text as a progress line
  (deduplicated, ≤ 20 kept, role names mapped to plain labels in the frame: "Librarian is searching…").
- WHEN `jobs.cancel` is called, the job MUST abort its signal and cancel every child it created; the
  coordinator's atomic writes mean no half-written file; the result is `cancelled`.
- WHEN a job ends, it MUST release the lock in `finally`, store `{ result text, error code }` and
  keep the record until the activation ends (last 20).
- WHEN the activation is disposed, `dispose()` MUST cancel running jobs and release locks
  synchronously and idempotently; `busy()` MUST be true exactly while a job runs.

---

## 7. Cross-cutting behavior

### 7.1 Model choice

- `models.list` returns `api.models.list()` (≤ 1 000 entries, errors → empty) and
  `api.sessions.model(ctx.sessionId)` as `active`.
- Picker options: "Alisio's active model (<active>)" (default, stores `null`) and every listed
  model grouped by provider. Saving calls `settings.setModel`, which resolves first.
- WHEN a child is created (chat or app), `Delegator` MUST call `resolveChildModel`; WHEN the chosen
  model does not resolve, the child MUST inherit the active model and the outcome MUST carry the
  fallback notice; the stored choice is kept and Settings shows "not available".
- WHEN `models.list` is empty **and** `active` is empty, every child-spawning action MUST return
  `no_model` and the frame MUST show a blocking "Connect a model in Alisio to continue" state on the
  affected buttons; reading, editing, checks and builds stay available. Re-checked on `visibility`.

### 7.2 Editable files

| File | In-app |
| --- | --- |
| `thesis/thesis.yaml` | Text editor with line numbers; YAML parsed before writing (syntax error → not written, line shown); after saving, G0 findings shown |
| `thesis/policy/*.yaml`, `thesis/data/*.csv` | Plain text editor, 256 KiB cap |
| `thesis/styles/*.csl`, `*.profile.yaml`, `thesis/policy-packs/**`, chapters | Read-only viewer + "Open in your editor" panel with the workspace-relative path and a copy button (styles and norms are authored through their guided flows) |

`files.read`/`files.write` accept only paths matching the allowlist after `assertRelativePath` and
`ensureInside` (parent spec §12); anything else returns `path_not_allowed`.

### 7.3 Transport and lifecycle

Repo frame rules apply: nonce on every inline script, no `<form>`, no network or external URLs, no
`eval`/`new Function`/WebAssembly; first `alisio.app.connect` from `window.parent` only; ≤ 8 requests
in flight; response guard 11 min; "Waiting for your approval in Alisio" notice after 3 s on a
mutation; `not_permitted` names the missing permission from `effect` (fallback: the action's known
effect); polling `jobs.get` every 1 s while visible, paused when hidden, refreshed on visible.
**`not_found` recovery** (semantic O13): a host `not_found` is confirmed with `status` after a short
delay before the "app unavailable" screen, which retries and re-checks on `visibility`; a plugin
`not_found` (unknown job or file) only stops that poll. All runtime state is per activation; no
module-level runtime.

### 7.4 Rendering, copy, locale, disclaimer

- Markdown (protocol, outline, dossiers, chapters, details) through semantic's safe renderer: escape
  first, links as text, footnotes and `[@key]` citations shown as chips; claim anchor comments hidden.
- Copy control on every generated block: "Copy text" (Markdown source) and "Copy formatted" (safe
  HTML), Clipboard API → `execCommand` → manual-copy dialog.
- Locale from connect and `locale` messages (`es*` → Spanish); state kept on switch; plural forms.
  The thesis content stays in the thesis language.
- Permanent footer: "Thesis Studio can make mistakes. Check every source and claim before you
  submit." / "Thesis Studio puede cometer errores. Verifica cada fuente y afirmación antes de
  entregar." Never added to copied content.

### 7.5 Persistence

Everything the app shows is read back from durable files (`state.json`, workspace files, reports);
nothing lives only in the frame except UI conveniences (current tab, filters). Job progress is
in-memory by design; the job's effect is durable through the coordinator's own writes.

### 7.6 Privacy and network

The frame never touches the network. Research jobs reach OpenAlex, Crossref and arXiv (and host web
tools when present) from the plugin and the librarian child, exactly as the commands do; the Research
button says "searches public scholarly databases with your topic". Thesis text goes to the chosen
model. `/thesis:setup` downloads Typst from GitHub (checksum verified).

### 7.7 Accessibility

Every control reachable by Tab with visible focus; stepper as an ordered list with
`aria-current="step"`; status chips carry text, not only color; `aria-live="polite"` for job progress;
dialogs are native `<dialog>` with focus return; contrast ≥ 4.5:1 for text on the gradient and gold
(gold used for accents, never for body text); targets ≥ 40 px; works at 200 % zoom.

---

## 8. Security

| Concern | Measure |
| --- | --- |
| Path traversal from the frame | Allowlist + `assertRelativePath` + `ensureInside` (§7.2) |
| Approving something the user has not seen | Revision guard (D5); approvals only from explicit buttons |
| Model approving on the user's behalf | Unchanged: `thesis_answer` still rejects approvals; the app is a human surface |
| Oversized results | Caps per action; PDF > 60 MiB returns `too_large` |
| Error leakage | Codes only; `blocked` reasons are coordinator text without inputs or absolute paths (tested) |

---

## 9. Acceptance matrix

| ID | Case | Required result | Test file |
| --- | --- | --- | --- |
| THA-AC-01 | Host without `api.apps` | All 20 commands and 6 tools registered; no app; no error | `test/app-plugin.test.ts` |
| THA-AC-02 | Action map | Effects exactly as §6.3; schemas `additionalProperties: false`, no `$ref/$id/$async` | `test/app-plugin.test.ts` |
| THA-AC-03 | `design.run` through the facade while `api.ui.interactive()` is true | `askQuestions` never called; Gates A/B stay pending; `status.nextStep` = approve A | `test/app-service.test.ts` |
| THA-AC-04 | `approve` with stale `revision` | `conflict`; state unchanged | `test/app-service.test.ts` |
| THA-AC-05 | `approve SEC-id` from the app | Section approved; no build process spawned in the action | `test/app-service.test.ts` |
| THA-AC-06 | Command while an app job holds the lock, and app action while a command runs | `Blocked: Thesis Studio is running …` / `busy` with holder `chat` | `test/lock.test.ts` |
| THA-AC-07 | Long job | `{ jobId }` < 2 s; progress lines from `ui.status`; `busy()` true then false | `test/app-jobs.test.ts` |
| THA-AC-08 | `jobs.cancel` mid-child | Signal aborted, `sessions.cancel` called for each recorded child, `cancelled`, lock released | `test/app-jobs.test.ts` |
| THA-AC-09 | Chosen model resolves / does not resolve | `ChildSessionSpec.model` set / omitted with fallback notice; choice kept | `test/model-choice.test.ts` |
| THA-AC-10 | No models and no active model | Child-spawning actions `no_model`; `build.run`, `files.write` work | `test/model-choice.test.ts` |
| THA-AC-11 | Chat command after `settings.setModel` | Its children use the chosen model (parity) | `test/model-choice.test.ts` |
| THA-AC-12 | `nextStep` vs `nextCommand` on every fixture state | Same operation and target | `test/app-views.test.ts` |
| THA-AC-13 | `interview.answer` invalid / valid | Errors per question, nothing written / round advanced, next questions | `test/app-service.test.ts` |
| THA-AC-14 | `files.read`/`write` with `../x`, absolute, `chapters/x.md`, symlink escape | `path_not_allowed`; nothing written | `test/app-files.test.ts` |
| THA-AC-15 | `files.write thesis.yaml` with a YAML syntax error | Not written; line reported | `test/app-files.test.ts` |
| THA-AC-16 | `pdf.get` | base64 of the last PDF; `too_large` over the cap | `test/app-service.test.ts` |
| THA-AC-17 | Error results | Codes only; no input, no absolute path | `test/app-plugin.test.ts` |
| THA-AC-18 | `dispose` twice with a running job | Idempotent; job cancelled; lock free | `test/app-jobs.test.ts` |
| THA-AC-19 | Embedded HTML | ≤ 8 MiB; nonce on every script, no `src`; no `<form>`, `<link>`, `@import`, external URL | `test/frame.test.ts` |
| THA-AC-20 | Frame sources scan | No `https?://`, fetch/XHR/WebSocket/EventSource, `eval`, `new Function`, `WebAssembly` | `test/frame.test.ts` |
| THA-AC-21 | Handshake (jsdom + MessageChannel) | Non-parent and second connect ignored; shaped requests; `not_permitted` + effect; `not_found` confirmed before unavailable | `test/frame.test.ts` |
| THA-AC-22 | Derive logic | Stepper states per phase, card actions per section status, finding groups, job label mapping, `no_model` disabling | `test/ui.test.ts` |
| THA-AC-23 | i18n | Every key has `en` and `es`; `es-CO` → Spanish, `fr` → English; disclaimer not in copied text | `test/ui.test.ts` |
| THA-AC-24 | Existing suite | All current tests pass unchanged | existing `test/*.test.ts` |
| THA-AC-25 | `pnpm check` | Green, including `pack:check` (embedded HTML in the tarball, no `web/`) | CI |

Not tested: PDF.js internals, CSS details, the host approval UI (checked visually in Phase 2).

---

## 10. Phases

1. **Backend (actions and jobs).** `lock.ts` (and wiring into commands/`thesis_answer`),
   `model-choice.ts` + `Delegator` change + `state.settings` validation, `src/app/*` without frame
   (`html` returns a minimal placeholder in tests only). Closes THA-AC-01..18, 24.
2. **Frame.** `web/*`, `scripts/*`, PDF.js bundle, registration with the real HTML. Visual check in
   `alisio serve` ≥ 0.11.6: handshake, both locales, approval prompt on write and process, denial
   message, hidden-tab pause, both themes, narrow layout, keyboard only. Closes THA-AC-19..23.
3. **Docs and release prep.** `README.md` and `README.es.md` in the same change (new "Thesis Studio
   app" section: what it does, minimum Alisio 0.11.6, effects and approval prompts, model choice,
   network note, disclaimer), screenshot-free; `THIRD_PARTY_NOTICES.md` (PDF.js); a Changeset
   (`minor`); site catalog refresh only if the owner orders a release. Closes THA-AC-25.

---

## 11. Risks

| Risk | Decision |
| --- | --- |
| A future call site uses `askQuestions` without checking `interactive()` (today all are guarded, e.g. `pack-commands.ts:375,409`) | The facade's `askQuestions` returns `undefined` for every id, so such a path degrades to "no answer"; THA-AC-03 covers the gates; `packs.new` always passes scope and id |
| Command text is English inside a Spanish UI | Structured views (D10); text only in "Details" |
| Jobs lost on host restart | Effects are durable; the frame shows "the last run did not finish; run it again" when state shows `drafting`/`researching` without a job |
| Lock blocks a user who forgot a running job | Job bar always visible with Cancel; command text tells the user where to cancel |
| Very large PDFs | 60 MiB cap and the relative path to open it outside |
| 0.11.5 hosts without prompts | README and `status.minHost`; `not_permitted` names the permission |

---

## 12. Open questions for the owner

| ID | Question | Recommended |
| --- | --- | --- |
| Q1 | App label: "Thesis Studio" / "Estudio de tesis"? | **Yes**: matches the plugin name already shown in the catalog |
| Q2 | Model choice: one model for every role, or per role (e.g. a stronger writer)? | **One model per project in v1**; per-role as an "Advanced" option later, the state key can grow to `settings.models` |
| Q3 | Should `thesis.yaml` get a guided form instead of a text editor? | **Text editor with validation in v1** plus the interview for initial values; a form duplicates the interview and its validation |
| Q4 | Concurrency conflict: block the second writer (D4) or queue it? | **Block with a clear message**; queuing hides which surface is changing the thesis |
