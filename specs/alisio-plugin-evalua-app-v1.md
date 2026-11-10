# Spec: `@alisio/plugin-evalua` app v1 (a web UI for teachers)

Status: **Draft for owner review (2026-11-10). Not implemented.** Owner decisions of 2026-11-10 are
in §3 (O1-O9); the open questions are in §13.
Audience: a coding agent adding a plugin app to `packages/plugin-evalua` with no prior context.
Companion specs: `specs/alisio-plugin-evalua-v1.md` (the plugin's behavior, which this app must not
change) and `specs/alisio-plugin-semantic-v1.md` (newest app precedent).

## 0. How to use this document

1. Read `AGENTS.md`, `.agents/skills/create-alisio-plugin/SKILL.md` and its
   `references/plugin-app.md` first; they win on conflict. Load the release skill only when the owner
   orders a release.
2. Frame references: `packages/plugin-semantic/web/*` (transport, `not_found` recovery, locale, model
   picker, copy controls, Markdown) and `packages/plugin-scribe/web/*` (PDF.js preview, blob
   downloads, single-file HTML build in `scripts/`). Copy their shape, not their product behavior.
3. Labels: **(verified 2026-11-10)** = read in this repo or in the SDK types that day;
   **(unverified)** = must be checked while implementing; **(new)** = does not exist yet.
4. RFC 2119 keywords only where they matter; behavior in EARS (`WHEN <trigger>, the <system> MUST
   <response>`). Strict TDD (red, green, refactor), vitest, offline, no snapshot tests.
5. Phases in §11 are ordered; each ends with `pnpm check` green. **Do not commit or publish until the
   owner asks.**

## 1. Goal and non-goals

### 1.1 Goal

Add one full-page app, registered with `api.apps?.register`, that lets a teacher with no technical
background create a printable math exam end to end: profile, guided interview, Gate A, question
wording, generation, build, preview, download and Gate B. The app is a second front end over the
**same** coordinator: every command (`/evalua:init|new|status|kb|doctor|approve|generate|build`),
tool (`evalua_profile|answer|status|kb|check|exam|generate|build`) and agent keeps working
unchanged, and work started in one surface is visible in the other.

### 1.2 Non-goals (v1)

| Excluded | Reason |
| --- | --- |
| Free-text topic resolution in the app | Owner O3: the topic comes from the catalog list only |
| Editing items one by one, or authored items | Generation stays deterministic; wording is per family (`set-prompts`) |
| Running `evl-math-reviewer` / `evl-language-reviewer` | Not wired in code today **(verified 2026-11-10)**: no reviewer is called by the coordinator; the app MUST NOT imply a review happened |
| Editing knowledge packs | The app browses and checks them only |
| Several active exams | The coordinator has one `activeExamId` **(verified)** |
| A language selector | The UI follows Alisio's locale (O7) |

## 2. Verified current state (2026-11-10)

| Fact | Evidence |
| --- | --- |
| Peer `@alisio/sdk >=0.9.0 <0.12.0`, devDependency `0.11.4`; no `web/`, no app | `packages/plugin-evalua/package.json`, `src/index.ts` |
| `registerEvalua(api)` builds one `EvaluaCoordinator` per `setup` (closures, no module-level runtime) | `src/index.ts` |
| State `<ws>/.alisio/evalua/state.json`, atomic `wx`+`rename` writes, **no lock**: every command/tool does read-modify-write | `src/storage.ts`, `src/coordinator.ts` |
| Rounds `profile`, `1` (topic, grade, level, kind), `2` (types multi, count, distribution, columns), `2b` (bank only: bank_size, variants), `3` (pages, time, closing, numbering); at most 4 questions each; free text in `<id>:text`, max 200 chars; validators: count 1-100, bank_size 1-400 (≥ count+5), variants 1-8, pages 1-20, time 5-480 min | `src/interview.ts` |
| Interview question text is Spanish only | `src/interview.ts` |
| The chat offers only the first 3 catalog suggestions plus "Otro tema" (free text, resolved by `resolveTopic`); `buildDraft` takes a catalog `fullId` as the topic and its label from `suggestions(grade)` | `src/interview.ts`, `src/knowledge/catalog.ts` |
| Draft lives in `state.draft` until Gate A; `approve a` allocates `exams/NN-slug/`, writes `exam.yaml`, sets `activeExamId`, phase `approved-a` | `src/coordinator.ts` |
| Phases `approved-a` → `generated` → `built` → `approved-b`; the coordinator does **not** guard phase order (e.g. `approve b` works in any phase) | `src/coordinator.ts` |
| `set-prompts` writes `exam.yaml.itemPrompts` per family id; `applyPrompts` replaces the first stem line and fills `{expr}` from its `$…$` formulas, so a template **without `{expr}` drops the math**; family default stems are Spanish; shipped topics have no prompts | `src/generate.ts`, `src/families/*.ts`, `knowledge/packs` |
| `generate` is pure and deterministic (seed = exam id) and writes `items.json` | `src/coordinator.ts`, `src/generate.ts` |
| `build` fits a 7-preset density ladder (one Chrome print each, ≤ 120 s per print) then prints 4 PDFs; writes `01_examen_estudiante`, `02_hoja_respuestas`, `03_solucionario_completo`, `04_rubrica_calificacion` (`.html`, `.pdf`), `layout-report.json`, `00_plan_proyecto.md`, `05_control_versiones.md`; no signal, no progress callback | `src/build.ts`, `src/chrome/cdp.ts`, `src/layout/presets.ts` |
| No browser → HTML only + warning `EVL-LAY-000`; page limits unverified | `src/build.ts` |
| Logo: copied from a filesystem path; PNG/JPEG/WebP by magic bytes, ≤ 2 MB, SVG rejected, stored `assets/logo.<kind>` | `src/profile.ts` |
| Only `knowledge/locales/es.yaml` ships: a profile with `language: en` fails at build ("locale missing") | `knowledge/locales`, `src/coordinator.ts` |
| Exam fonts: themes name `Source Serif 4` / `Source Sans 3` with Georgia/Arial fallbacks, but **no font file is vendored** (only KaTeX fonts, 604 KB) | `templates/themes/*`, `templates/html/vendor/katex` |
| Math is typeset server-side by vendored KaTeX (`output: "html"`) | `src/katex.ts` |
| Package README states `@alisio/sdk >=0.3.0 <0.7.0` (stale) | `README.md` |

**SDK / host facts (verified in the published SDK types 0.9.0, 0.11.0, 0.11.4-0.11.7):**
`api.models.list/resolve` and `CompletionRequest.model` already exist in **0.9.0**; `api.apps` first
appears in **0.11.5**; the `not_permitted` response with `effect` (the approval prompt) first appears
in **0.11.6**; `PLUGIN_APP_LIMITS` (identical in 0.11.6/0.11.7): html 8 MiB, request 37 MiB, result
90 MiB, 30 s timeout, 8 in flight. Frame CSP: `default-src 'none'`, nonce scripts, `connect-src
blob:`, `data:` images (Scribe), sandbox `allow-scripts allow-downloads allow-modals allow-popups`
(`site/developing-plugins.md`). Whether `font-src data:` and `style` attributes are allowed is
**(unverified)**.

**Real minimum host for the app: Alisio 0.11.6** (apps + approval prompt). On 0.11.5 the app loads
but every write/process action fails unless the session already grants it; below 0.11.5 there is no
app and the chat flow is unchanged.

## 3. Owner decisions (2026-11-10)

| ID | Decision |
| --- | --- |
| O1 | Spec first, then implement |
| O2 | UI for non-technical users (teachers): plain language, one decision per screen, no ids or paths in the main flow |
| O3 | Keep all current functionality; the topic is chosen from the knowledge-base catalog list (no free-text resolution) |
| O4 | Model selection in the UI; question wording (`set-prompts`) is drafted by the chosen model via `api.model.complete({ model, … })`, shown for review and editable before approval |
| O5 | Evalua identity: navy gradient `#071635`→`#163a86`, sheet `#f8fafc`, header bar `#3b5bdb`, bubbles `#cbd5e1`, gold `#f5b82e` (`icon.svg`); no network fonts |
| O6 | Feature-detect `api.apps`; keep peer `>=0.9.0 <0.12.0` if feasible; devDependency `0.11.7` |
| O7 | UI language follows Alisio's locale (`en`/`es`) |
| O8 | The app works without a model ("write it myself") and without a browser (HTML preview) |
| O9 | Evalua README is bilingual: update `README.md` and `README.es.md` together |

## 4. Design decisions (binding)

| ID | Decision | Consequence |
| --- | --- | --- |
| D1 | The app calls the coordinator through a thin `EvaluaAppService` (new); no logic is duplicated. Additive seams only: `buildExam`/`fitDocuments` gain optional `onProgress(step, total)` and `signal` (checked between prints); `profile.ts` gains `saveLogoBytes(root, bytes)` sharing `copyLogo`'s checks; the catalog gains `topic(fullId)` lookup | Chat output and tool texts stay byte-identical (§12 EVL-APP-AC-01) |
| D2 | One async mutex per coordinator wraps **every** state read-modify-write (commands, tools, app actions). Each app mutation sends `expectedRevision` (= `state.updatedAt`); mismatch returns `state_changed` without writing | WHEN the chat changed the state, the frame shows "This exam changed in the chat. We reloaded it." and re-reads |
| D3 | WHILE a build job runs, chat `generate`/`build`/`approve`/`set-prompts` and app mutations return "A build is running in the Evalua app; try again when it finishes" (`busy`) | No half-built folder is regenerated under the job |
| D4 | The wizard does not use parked rounds. The frame collects all answers, then `draft.create` validates them round by round with the same `buildRound` + `acceptAnswers`, with `topic` set to the catalog `fullId`, and calls `buildDraft` | Same validation as the chat; title uses the topic's catalog name, never the id |
| D5 | Model choice is stored **per workspace** in `<ws>/.alisio/evalua/app.json` (new, atomic, schema `{ schemaVersion: 1, model: string \| null, wording: {…}, lastBuild: {…} }`); `teacher.yaml` and `state.json` schemas do not change. The model used for a draft is shown with it | One teacher per workspace; no schema migration for chat users |
| D6 | Before each draft, `api.models.resolve(ref)`; on failure fall back to the session's model (omit `model`, pass `sessionId`) and return `fallback: true` (frame notice). WHEN `api.models.list()` is empty, drafting is disabled and the wording step shows "Write it myself" only | No-model state never blocks the rest of the app |
| D7 | Model output is untrusted: strict JSON `{ "<familyId>": ["template", …] }`; unknown families dropped; ≤ 5 templates per family; each 1-200 printable chars, contains `{expr}` at least once, no `$`, no `<`/`>`; invalid entries dropped with a count. Saving (model or teacher text) applies the same rules | A template can never drop the formula or inject markup |
| D8 | Gate A, Gate B and every mutation rely on the host effect gate only; handlers never re-check `api.sessions.capabilities` | Matches the plugin-app rules |
| D9 | App-level phase guards (frame + service, not the chat): wording before build, generate after Gate A, build after generate, Gate B only in `built`. Saving wording in `generated`/`built` re-runs generate in the same action and drops the phase to `generated` | The teacher cannot approve stale documents |
| D10 | Documents' language comes from the profile and is limited to shipped locales (`es` today); the UI locale is independent | Avoids the build-time "locale missing" failure |
| D11 | UI fonts: system stack (`ui-serif, Georgia, serif` for headings echoing the exam; `system-ui` for text). No font is bundled for the UI | Frame stays small; no network |
| D12 | `PLUGIN_APP_LIMITS` MUST NOT be imported as a runtime value (missing on a 0.9.0 host SDK would break module linking); limits are local constants checked in a test against the dev SDK | Peer stays `>=0.9.0 <0.12.0` |

## 5. Package changes

Manifest: `files` adds `dist/embedded.html` (already under `dist`); `build` becomes
`tsc -p tsconfig.json && node scripts/build-ui.mjs`; devDependencies add `@alisio/sdk 0.11.7`,
`esbuild 0.28.2`, `pdfjs-dist 6.5.438`, `jsdom 31.0.0` (Scribe's pins). App id `evalua`, label per Q1.

```text
src/app/register.ts   # api.apps?.register; action map grouped READ/WRITE/PROCESS
src/app/service.ts    # EvaluaAppService: actions -> coordinator, revision checks, guards
src/app/wizard.ts     # pure: answers -> validated rounds -> draft (D4)
src/app/wording.ts    # pure: prompt builder + output parser/validator (D7)
src/app/jobs.ts       # in-memory jobs per activation (build, wording)
src/app/prefs.ts      # app.json read/write (D5)
src/lock.ts           # async mutex (D2)
web/{index.html,app.js,i18n.js,derive.js,icons.js,copy.js,pdf-viewer.js,style.css}
scripts/{embedded-html.mjs,build-ui.mjs}   # single HTML, KaTeX CSS + fonts and PDF.js inlined
```

## 6. Screens

| Screen | Content | Rules |
| --- | --- | --- |
| Home | Header bar `#3b5bdb` with icon; "New exam" card; exam cards (number, title, grade, phase as a plain step "Waiting for your approval / Questions ready / Documents ready / Approved"); a "Continue" card when a draft or chat interview is pending | Non-active exams are read-only (preview, download) — see Q3 |
| Teacher profile | Name, institution, subject, paper (Letter/A4), document language (shipped locales only); logo upload with preview, "Remove logo" | Shown first when no profile exists; logo: PNG/JPEG/WebP, ≤ 2 MB, checked in the frame (size, type) and again by magic bytes in the backend |
| Wizard (5 steps max, mirrors rounds) | 1 Topic: grade first, then a searchable list of catalog topics filtered by grade (name, pack, "also for" grades); level as 4 cards with the descriptions from `interview.ts`. 2 Questions: item types (checkboxes), count (10/15/20/other number), same exam vs. random bank, columns. 2b Bank (only for bank): bank size, variants. 3 Format: page limit, time + instrument + calculator, closing, numbering | Plain labels in `en`/`es` mapped to the same option values; "other" options are number fields serialized to `<id>:text`; a live summary panel (sticky on wide, collapsible under 900 px) shows the draft as the teacher goes; Back keeps answers |
| Review & Gate A | The draft summary (the "ficha técnica"), blueprint preview from `buildBlueprint`, proposed folder name in plain words ("Exam no. 3") | "Approve and create the exam" → `exam.approveA`; "Change answers" returns to the wizard |
| Wording | Per family in the exam: a sample question with the default wording, the current templates, "Draft with AI" (model chosen in Settings), editable text areas with `{expr}` shown as a chip "the math goes here", "Write it myself", "Use the default wording" | Permanent disclaimer: "AI-drafted wording can contain mistakes. Read every sentence before you approve it." Copy control per family block |
| Questions | `exam.generate`, then the item list: number, type, stem with math rendered by the same KaTeX output as the exam, options, correct answer (toggle "show answers") | Generation errors listed in plain words with the finding id small; "Generate again" |
| Build | "Create the documents" → job with progress "Fitting pages (3 of 7)", "Printing documents (2 of 4)", Cancel | No browser: notice "PDFs need Chrome, Chromium, Edge, Brave, Vivaldi or Opera. You can still preview and print the HTML." |
| Documents | 4 tabs (Student exam, Answer sheet, Solutions, Rubric); PDF via PDF.js (Scribe's viewer) or HTML preview; "Download PDF/HTML" as `blob:`; findings (page limit not reached, legibility) in plain words | Copy control on findings text |
| Gate B | Summary + "Approve the final package" | WHEN the last build had errors, the teacher must confirm the listed problems (Q2) |
| Settings | Model picker (`models.list`, "Alisio's current model" default, fallback notice); knowledge base browser (packs, topics, grades, levels) and "Check the knowledge base" (`kb.check`); Doctor (browser found/missing, KB status) | Technical details (ids, paths) live only here |

## 7. Actions

Every input schema: `type: object`, `additionalProperties: false`, no `$ref`/`$id`/`$async`; strings
have `maxLength`; ids match `^e[0-9]{2,3}$` (exam) or `^[a-z0-9]{12}$` (job). Every mutation takes
`expectedRevision` (string ≤ 40) and the request id as `idempotencyKey`. Errors are codes only
(`invalid_input`, `state_changed`, `busy`, `phase_mismatch`, `not_found`, `no_model`,
`model_failed`, `file_too_large`, `bad_image`, `operation_failed`), never echoed input.

| Action | Effect | Input bounds | Result |
| --- | --- | --- | --- |
| `status` | read | — | `{ revision, initialized, profile?, logo? (data: URL), draft?, chatInterview?: { round }, exams[{ id, folder, title, grade, phase, gates, docs: { html, pdf } }], activeExamId, job? }` |
| `catalog.list` | read | `grade?` ≤ 40 | `{ topics[{ id, name, pack, grades, levels, supports }], packs[{ id, name }] }` |
| `kb.check` | read | — | `{ ok, findings[{ id, severity, subject, message }] }` (= `evalua_check`) |
| `doctor` | read | — | `{ browser: "found" \| "missing", source, kbOk, kbErrors }` |
| `models.list` | read | — | `{ models[{ reference, label, provider }], chosen, available }` |
| `draft.get` | read | — | `{ draft, blueprint, folderNumber }` or `null` |
| `wording.get` | read | — | `{ families[{ id, sample, templates, draft? }], model? }` |
| `items.get` | read | `offset` 0-400, `limit` 1-50 | `{ total, items[{ n, type, stemHtml, options[], answerHtml }] }` |
| `docs.get` | read | `examId`, `doc` ∈ exam/sheet/book/rubric, `format` ∈ pdf/html | `{ name, mime, base64 }` (≤ 90 MiB) |
| `jobs.get` | read | `jobId` | `{ kind, state, step, total, phase, result?, error? }` |
| `profile.save` | write | teacherName 1-100, institution 1-150, subject 1-80, paper ∈ letter/a4, language ∈ shipped locales | `{ profile }` |
| `profile.setLogo` | write | `dataBase64` ≤ 2 796 208 chars, `mime` ∈ png/jpeg/webp | `{ logo }`; SVG or mismatch → `bad_image` |
| `profile.removeLogo` | write | — | `{ profile }` |
| `draft.create` | write | `answers`: fixed keys (topic ≤ 120, grade enum or `grade:text` ≤ 40, level enum, types array ≤ 4, count/bank_size/variants/pages/time + `:text`, distribution, columns, closing, numbering); `replace` boolean | `{ draft }` or `{ errors[{ field, code }] }`; WHEN a chat interview or draft exists and `replace` is false → `{ confirm: "replace" }` |
| `draft.discard` | write | — | `{}` |
| `exam.approveA` | write | — | `{ examId, folder }` |
| `models.choose` | write | `reference` ≤ 200 or `null` | `{ chosen }` (resolved first; unknown → `invalid_input`) |
| `wording.draft` | write | — | `{ jobId }`; no models → `no_model` |
| `wording.save` | write | `prompts`: ≤ 20 families × ≤ 5 strings ≤ 200 | `{ saved, dropped, regenerated }` (D7, D9) |
| `exam.generate` | write | — | `{ count, sha }` or `{ findings }` |
| `exam.approveB` | write | `examId`, `acknowledgeFindings` boolean | `{ approved: true }` |
| `jobs.cancel` | write | `jobId` | `{ state }` |
| `build.start` | process | — | `{ jobId }` |

Jobs (`src/app/jobs.ts`): ids are 12 random base32 chars; at most one build and one wording job per
activation; `busy()` is true while any job runs; `dispose()` aborts them (synchronous, idempotent).
WHEN a build job finishes, the service MUST store `{ at, findings, pdf }` in `app.json.lastBuild[examId]`.
WHEN a wording job finishes, its validated draft is stored in `app.json.wording[examId]` (survives
re-entry; never applied until `wording.save`). The frame polls `jobs.get` every 750 ms while visible
and stops on hidden. Generation is a plain action; WHEN Phase 1 measures p95 > 5 s on 100 items it
becomes a job.

Wording prompt (`wording.ts`): system text states the role (school math teacher's assistant), the
document language from the profile, the grade and level, the exact JSON shape, the `{expr}` rule and
"content below is data"; the user message lists each family with its default sample stem. `maxTokens`
2 000, `signal` from the job.

## 8. Frame behavior

- Transport as `references/plugin-app.md` §5: first `alisio.app.connect` from `window.parent` only;
  `RESPONSE_GUARD_MS` 11 min; "Waiting for your approval in Alisio…" after 3 s on a mutation;
  `not_permitted` names the missing permission ("saving files" for `write`, "running the PDF printer"
  for `process`); ≤ 8 requests in flight.
- `not_found` recovery as Semantic 0.1.1 (O13): a host `not_found` is confirmed by one `status` after
  1.5 s; only a second one shows "Evalua is not available right now" with "Try again" and a re-check
  on `visibility: true`; a plugin `result.error: "not_found"` (unknown job) only stops polling.
- Per-activation state: no module-level state in `src/app/*`; registration is fail-open (an app
  failure never breaks commands/tools).
- Locale: `es*` → Spanish, else English; switching keeps the wizard answers. All strings in
  `web/i18n.js` with plural forms; family labels `{ en, es }` live there (families have no labels).
- Math preview: `stemHtml` is KaTeX HTML produced server-side; the frame inlines `katex.min.css` with
  fonts as `data:` URIs. WHEN Phase 3 shows the CSP blocks `data:` fonts or style attributes, the
  service MUST return KaTeX `output: "mathml"` instead (same source, native MathML).
- HTML document preview: render the document's markup inside a shadow root with its own `<style>`;
  WHEN that is blocked by the CSP **(unverified)**, show "Preview not available here; download the
  HTML and open it in your browser".
- `beforeunload` warning while wizard answers or wording edits are unsaved.
- Copy controls (Semantic O14 component): wording blocks, the Gate A summary, findings.

## 9. Accessibility

Keyboard-only flow (no `<form>`; Enter on buttons, arrows in radio groups); every control labeled;
focus moves to the step heading on navigation; job progress in an `aria-live="polite"` region;
errors tied to fields with `aria-describedby`; targets ≥ 44 px; meaning never by color only; text
contrast ≥ 4.5:1 in both themes (gold `#f5b82e` only as accent on navy, never as text on `#f8fafc`);
`prefers-reduced-motion` honored; PDF viewer pages have a text alternative ("Page 2 of 3").

## 10. Persistence

| Data | Where | Writer |
| --- | --- | --- |
| Profile, logo | `<root>/teacher.yaml`, `<root>/assets/logo.*` | coordinator (unchanged formats) |
| Draft, active exam, phases, gates | `.alisio/evalua/state.json` | coordinator (unchanged schema) |
| Wording | `exam.yaml.itemPrompts` | coordinator `set-prompts` |
| Model choice, pending wording drafts, last build summary | `.alisio/evalua/app.json` (new, atomic) | `prefs.ts` |
| Wizard answers in progress | frame memory only (warned on unload) | — |

## 11. Phases

1. **Backend** — `lock.ts`, seams of D1, `src/app/{service,wizard,wording,jobs,prefs,register}.ts`,
   actions without the frame. Closes EVL-APP-AC-01..16.
2. **Frame** — `web/*`, `scripts/*`, HTML build, visual check in `alisio serve` 0.11.6+ (handshake,
   locale switch, approval prompt, denial message, hidden-tab pause, both themes, narrow layout, with
   and without a browser, with and without a model). Closes EVL-APP-AC-17..24.
3. **Docs** — `README.md` + `README.es.md` together (app section, minimum Alisio 0.11.6 for the app,
   correct peer range, no-browser and no-model behavior, AI wording disclaimer), help text of the
   commands mentions the app, `THIRD_PARTY_NOTICES.md` (PDF.js), Changeset `minor`
   (`@alisio/plugin-evalua` 0.12.0), site catalog refresh if applicable. Closes EVL-APP-AC-25.

## 12. Acceptance matrix

| ID | Case | Required result | Test file |
| --- | --- | --- | --- |
| EVL-APP-AC-01 | Every command and tool on a fixture workspace, before and after the change | Same texts and files (deterministic clock, fake printer) | `test/plugin.test.ts` |
| EVL-APP-AC-02 | Host without `api.apps` | No app; commands/tools registered; no throw | `test/app-register.test.ts` |
| EVL-APP-AC-03 | Action map | Effects as §7; schemas closed, no `$ref`/`$id`/`$async`; errors without echoed input | `test/app-register.test.ts` |
| EVL-APP-AC-04 | Chat tool and app mutation interleaved | Serialized by the mutex; stale `expectedRevision` → `state_changed`, nothing written | `test/lock.test.ts` |
| EVL-APP-AC-05 | Chat `build` while an app build job runs | `busy` text; job unaffected | `test/app-jobs.test.ts` |
| EVL-APP-AC-06 | `draft.create` with the same answers as a chat interview | Identical `ExamDraft` (except `createdAt`); title uses the catalog name | `test/app-wizard.test.ts` |
| EVL-APP-AC-07 | Invalid answers: count 0, bank_size < count+5, variants 9, time "abc", topic not in catalog | Field errors; state untouched | `test/app-wizard.test.ts` |
| EVL-APP-AC-08 | Draft pending in the chat, `replace: false` | `{ confirm: "replace" }`; with `true` replaced | `test/app-wizard.test.ts` |
| EVL-APP-AC-09 | Logo: 2 MB + 1 byte, SVG, PNG bytes declared as JPEG, valid WebP | `file_too_large` / `bad_image` / stored by magic bytes / stored | `test/app-profile.test.ts` |
| EVL-APP-AC-10 | Wording parser: extra prose, unknown family, missing `{expr}`, `$`, `<b>`, 6 templates, 201 chars | Only valid templates kept, counts of dropped | `test/app-wording.test.ts` |
| EVL-APP-AC-11 | Model: chosen ref resolves / fails / list empty | Passed as `model` / fallback flag, no `model` / `no_model`, other steps work | `test/app-wording.test.ts` |
| EVL-APP-AC-12 | `wording.save` in `built` | `set-prompts` applied, generate re-run, phase `generated` | `test/app-service.test.ts` |
| EVL-APP-AC-13 | Guards: generate before Gate A, build before generate, Gate B before build | `phase_mismatch` | `test/app-service.test.ts` |
| EVL-APP-AC-14 | Build job with fake printer: progress, cancel between prints, no browser | Steps 1..11; `cancelled` after current print; HTML only + `EVL-LAY-000` and `pdf: false` | `test/app-jobs.test.ts` |
| EVL-APP-AC-15 | `docs.get` with `../`, unknown exam, missing PDF | `invalid_input` / `not_found` / `not_found` | `test/app-service.test.ts` |
| EVL-APP-AC-16 | Two activations, close one; `dispose` twice; `busy()` during a job | Other keeps app and tools; idempotent; true then false | `test/app-lifecycle.test.ts` |
| EVL-APP-AC-17 | Embedded HTML builder | ≤ 8 MiB; nonce on every script, no `src`; no `<form>`, `<link>`, `@import`, external URL | `test/frame.test.ts` |
| EVL-APP-AC-18 | Frame sources scan | No `https?://`, fetch/XHR/WebSocket/EventSource, `eval`, `new Function`, `WebAssembly` | `test/frame.test.ts` |
| EVL-APP-AC-19 | Handshake (jsdom + MessageChannel) | Ignores non-parent and second connect; shaped requests with `idempotencyKey`; `not_permitted` + effect message | `test/frame.test.ts` |
| EVL-APP-AC-20 | Transient vs persistent host `not_found`; plugin `not_found` | Recovers / unavailable with retry / polling stops only | `test/frame-recovery.test.ts` |
| EVL-APP-AC-21 | Locale `es-CO`, `en`, `fr`, switch mid-wizard | es / en / en; answers kept | `test/locale.test.ts` |
| EVL-APP-AC-22 | Derive: wizard step list (2b only for bank), phase → next step, no-model wording state, no-browser documents state | Correct view state | `test/ui.test.ts` |
| EVL-APP-AC-23 | Copy controls | Plain text and fallback chain as Semantic | `test/copy.test.ts` |
| EVL-APP-AC-24 | Local limits constants vs dev SDK `PLUGIN_APP_LIMITS`; no runtime import of it | Equal; static check passes | `test/app-register.test.ts` |
| EVL-APP-AC-25 | `pnpm check` | Green, pack:check includes `dist/embedded.html`, both READMEs | CI |

Not tested: PDF.js internals, CSS details. Real-Chrome tests stay behind the existing skip guard.

## 13. Open questions (each with a recommended answer)

| ID | Question | Recommended |
| --- | --- | --- |
| Q1 | App menu label | `{ en: "Evalua", es: "Evalúa" }` (matches the plugin and the icon) |
| Q2 | Gate B when the last build has errors (e.g. page limit unreachable): block or allow with confirmation? | Allow after the teacher confirms the listed problems (the chat already allows it; a teacher may accept 3 pages) |
| Q3 | Older, non-active exams: read-only, or "Make active" to rebuild them? | Read-only (preview, download) in v1; reopening changes the one-active-exam rule |
| Q4 | One topic per exam (as the chat), or several from the list? | One in v1; the draft supports a list, but blueprint balance across topics is untested |
| Q5 | English exam documents: hide `en` (no `en.yaml`), or ship `knowledge/locales/en.yaml` with this change? | Hide in the app now; English documents as a separate change (it also needs English family stems) |

## 14. Risks

| Risk | Decision |
| --- | --- |
| A build can take minutes (7 + 4 prints, ≤ 120 s each) | Job with progress and cancel (D1, §7); `busy()` keeps the workspace alive |
| Chat and app write the same state | Mutex + revision check (D2, D3) |
| The model writes wrong or unsafe wording | Validator (D7), mandatory review, disclaimer, editable text |
| The frame CSP blocks KaTeX fonts or shadow-root styles | MathML fallback and download-only fallback (§8), verified in Phase 2 |
| Old hosts lack the SDK value exports | No runtime import of `PLUGIN_APP_LIMITS` (D12); `api.apps` feature-detected |
| Teachers on 0.11.5 see mutations rejected | README and help text state Alisio 0.11.6; denial message names the permission |
| The `en` profile option in the chat fails at build | Out of scope here (Q5); the app never offers it |
