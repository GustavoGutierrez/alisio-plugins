# Spec: `@alisio/plugin-evalua` v1 (Evalúa, math exam generator)

Status: draft, not implemented. Nothing is committed or published; the owner orders both.
Audience: a coding agent implementing the package in this monorepo.
Source material: the owner's brief (Spanish, this conversation), the owner's notes `math.md`
(untracked, Spanish: team roles, phases, item cards, final package), the existing
`packages/plugin-thesis` (methodology-harness pattern, vendored KaTeX, Chrome/CDP PDF path,
workspace packs) and `packages/plugin-wayfinder` (coordinator pattern).
Out of scope for v1: psychometric pilot analysis (`math.md` §5), student bubble/OMR sheets, online
delivery, grade books, DOCX output, trigonometry content (the knowledge base is built so it is added
later as a pack, §6.6), geometry beyond what basic arithmetic needs.

Language: this file and every artifact the package ships (source, prompts, schemas, tests, README)
are English. **Exam content is data**, not code: the Spanish strings a student sees ("Nombre",
"Año lectivo", item templates, intro paragraph) live in locale and knowledge-pack data files (§6.5,
§9.3). Spanish (`es`) is the only complete locale in v1; the locale layer is in place for others.

---

## 1. Goal and non-goals

Ship an independently installable plugin that lets a teacher produce printable school math exams
from a central, extensible knowledge base, through a short guided interview. It must:

1. **Set up the teacher once** per workspace (name, institution, optional logo, subject) and never
   ask again (§5.1).
2. **Interview** for each exam with the minimum questions needed: topic, grade, level
   (básico / intermedio / avanzado / genio), item types, item count, same-exam vs random-from-bank,
   one or two columns, page limit, closing quote preference (§7).
3. **Generate items from a knowledge base** (arithmetic and basic mathematics, algebra) whose
   answers and distractors are computed by code, so correctness is a property and not a hope (§6, §8).
4. **Produce, per exam folder**, a student exam, a teacher answer sheet, a complete solution book,
   and optionally a grading rubric and a version log (§5.3), with consecutive student numbering and
   a stable reference per item that links the three documents (§8.5).
5. **Typeset with KaTeX**, inline and display math, in every PDF (§10).
6. **Fit the page budget deterministically**: fewest legible pages by default, an exact limit when the
   teacher gives one, never overflowing, overlapping or shrinking below a legibility floor (§11).
7. Be **extensible by data**: new knowledge (trigonometry next) is added as a pack, in the package or
   in the workspace, without changing the coordinator, renderer or layout engine (§6.6).

Non-goals:

- Replacing teacher judgment. Two human gates are mandatory (§4.2): approving the exam spec and
  blueprint, and approving the final package.
- Letting an LLM be the source of truth for a mathematical answer. Generated items are solved and
  verified by code; LLM-authored items must carry a code-evaluable check or be flagged (§8.3).
- Inventing quotations or Bible verses. Closing texts come only from a sourced catalogue or from the
  teacher (§9.4).

## 2. Verified current state (2026-10-06)

### 2.1 This repo (read from source, not assumed)

- `packages/plugin-thesis` already contains the precedents this plugin reuses **by duplication**
  (AGENTS.md forbids importing it): a vendored KaTeX browser bundle evaluated in an isolated `vm`
  context for server-side `renderToString` (`src/render/html/katex.ts`, files under
  `templates/html/vendor/katex/`), Chrome-family detection with env overrides and no download
  (`src/chrome/detect.ts`), a dependency-free CDP driver over `--remote-debugging-pipe` calling
  `Page.printToPDF` (`src/render/adapters/chrome-pdf/cdp.ts`), workspace policy packs, an
  interview coordinator, and a standalone CLI.
- `packages/plugin-wayfinder` is the reference for the coordinator-in-code pattern: children return
  strict JSON, code validates it and only then writes artifacts and state.
- Resource prefixes already used: `atlassian-`, `brave-`, `fs-`, `gchat-`, `swarm-`, `thesis-`, `wf-`.
  This plugin takes **`evl-`** (verify again at implementation time with
  `ls packages/*/.agents/agents packages/*/.agents/skills`).
- `scripts/pack-check.mjs` requires skill descriptions to start with `Trigger:` (≤250 chars), agents
  to carry `name` and `description`, the tarball to contain exactly the discovered `.agents` files,
  and, when `src/resources.ts` exists, `dist/resources.js` exporting `loadRoleInstructions`.
- Local machine: Node ≥ 22.16 with global `WebSocket`; `/usr/bin/google-chrome` present.

### 2.2 SDK surface used (`@alisio/sdk`, same surface as thesis spec §2.2)

| Need | API |
|---|---|
| Commands | `api.commands.register(name, handler, { description, argumentHint })` |
| Tools | `api.tools.register({ name, description, inputSchema, effect, execute })`, `effect` in `read`, `write`, `process`, `external` |
| Agents and skills | `api.resources.agents(path)`, `api.resources.skills(path)` |
| Child sessions | `api.sessions.create(spec)`, `api.sessions.run(id, prompt)` |
| Questions | `api.ui.askQuestions({ questions })`: 1–4 questions, 2–4 options each, `recommended`, `textInput`, `multiSelect`; headless answers are `undefined` |
| Progress | `api.ui.status(key, text, detail?)` |
| Paths | `api.paths?.cache` (feature-detect) |

Phase 0 re-verifies the lowest SDK version exposing `askQuestions` with `recommended`/`textInput`
and sets the peer range accordingly (thesis uses `>=0.3.0 <0.7.0`). Resolved: `>=0.3.0 <0.7.0` (§18.1).

### 2.3 Facts to verify in Phase 0 (all resolved on 2026-10-06, see §18.1)

- P0.1 Chrome `Page.printToPDF` page counting: counting `/Type /Page` objects in the PDF bytes is
  reliable for Chrome's output (object streams could hide them). Fallback: `Page.getLayoutMetrics`
  plus an in-page paginator, or `pdf-lib`-free parsing of `/Count` in the page tree.
- P0.2 Which OFL/permissive text font to vendor (candidates: Source Serif 4 + Source Sans 3, or
  Noto Sans) and its license file; system fonts are never used for body text (determinism).
- P0.3 KaTeX version and font set: reuse thesis's pinned version (0.19.0 at time of writing) and ship
  only the `woff2` fonts actually referenced, inlined as data URIs so each PDF build is hermetic.
- P0.4 Cost of one Chrome launch plus N `printToPDF` calls on the fitting ladder (§11.2) against the
  performance target (§11.6).
- P0.5 Chrome flags that block all network and keep `file://` access limited to the build dir.

## 3. Architecture decisions

| ID | Decision | Rationale |
|---|---|---|
| AD-1 | Package `@alisio/plugin-evalua`, plugin id `evalua`, category `methodology-harness`, resource prefix `evl-`. | Follows AGENTS.md; unique prefix. |
| AD-2 | The coordinator is TypeScript code plus one primary conversational agent (`evl-coordinator`). Child agents return JSON; code validates and writes. | Same pattern as Wayfinder and thesis; every gate is reproducible. |
| AD-3 | **Knowledge base = versioned data packs** (YAML) plus a small registry of **item families** (TypeScript, pure, seeded). A pack declares topics, levels, objectives and which families/static items serve them. | Owner wants one central, extensible knowledge structure; trigonometry later must be additive. |
| AD-4 | Answers, distractors and solutions of generated items are computed with **exact rational arithmetic** (BigInt fractions) and a small multivariate rational polynomial type. No floating point in any answer path. | Determinism and correctness. |
| AD-5 | All randomness comes from a seeded PRNG (xoshiro128**), seed derived from `exam id + variant + role`. Items are **frozen** into `items.json`; rebuilding never regenerates. | "Same exam, same questions in the same order" must be literal; reproducibility. |
| AD-6 | PDFs are produced by **Chrome headless** (`Page.printToPDF`, CSS Paged Media) over HTML with **server-side KaTeX**. A fitting ladder measures real page counts in one persistent browser session. | KaTeX is mandatory; Chrome is the only engine that gives real page counts and overflow metrics for HTML+KaTeX. |
| AD-7 | Zero npm runtime dependencies except `yaml`. KaTeX, fonts and any markup helpers are vendored with licenses (`THIRD_PARTY_NOTICES.md`). | AGENTS.md: prefer built-ins; thesis precedent for vendoring. |
| AD-8 | Teacher profile and exams live in a readable workspace folder (default `evalua/`); lifecycle state in `<workspace>/.alisio/evalua/state.json`. | Versionable content, machine-owned state. |
| AD-9 | Workspace knowledge packs are first-class: same loader and schema as shipped packs, `extends`, explicit `overrides: true`. | Teachers/institutions extend without touching the plugin. |
| AD-10 | The student-visible numbering is always 1..N consecutive; each item additionally carries a short stable **reference** printed beside its number and used in the answer sheet and solution book. | Owner requirement. |
| AD-11 | Page limits are hard constraints with legibility floors; failure is explicit, never a silent overflow. | Owner requirement ("follow to the letter"). |
| AD-12 | PDF byte equality is **not** promised (Chrome embeds timestamps). Determinism means identical `items.json`, identical `layout-report.json` and identical extracted text for identical inputs and engine. | Honest, testable contract. |

## 4. Roles, phases and gates

### 4.1 Mapping `math.md` roles to this package

| `math.md` role | v1 realization |
|---|---|
| Coordinador de evaluación | `evl-coordinator` agent + TypeScript coordinator: scope, interview, phase control, approvals, plan/RACI/approval record |
| Experto en matemáticas | Deterministic solvers and checks (§8, §12) + `evl-math-reviewer` agent for authored items |
| Didáctica + diseñador de evaluación | `evl-assessment-designer` agent: level calibration, blueprint (tabla de especificaciones) |
| Redactor técnico, accesibilidad | `evl-language-reviewer` agent: clarity, ambiguity, notation, bias; deterministic lint (§12) |
| Autor de ítems | `evl-item-author` agent, only for topics without a generator family (§8.3) |
| Maquetador | Deterministic layout engine (§11); no agent |
| Corrector independiente | Deterministic checks (§12) + `evl-math-reviewer`, which never sees the author's reasoning, only item + key |
| Control de versiones | Code: `05_control_versiones.md`, per-exam frozen `items.json`, revision counter |
| Psicometría, pilotaje | Deferred (non-goal v1) |

Author ≠ reviewer is preserved: `evl-item-author` output is reviewed by `evl-math-reviewer` and by code,
never by itself.

### 4.2 Phase machine

| # | Phase | Output | Gate |
|---|---|---|---|
| 0 | Profile (first run in a workspace only) | `teacher.yaml` | — |
| 1 | Intake | `exam.yaml` draft | — |
| 2 | Ficha técnica + blueprint | `exam.yaml` (frozen spec), `blueprint.json` | **Human gate A**: teacher approves spec and blueprint |
| 3 | Item generation / authoring | `items.json` (bank or fixed list) | code checks `EVL-ITM-*` |
| 4 | Review | `review.json` | code checks + `evl-math-reviewer` + `evl-language-reviewer` on authored items |
| 5 | Layout fit | `layout-report.json` | code checks `EVL-LAY-*` |
| 6 | Package | PDFs, `00_plan_proyecto.md`, `05_control_versiones.md` | **Human gate B**: teacher approves the final package (acta) |

The coordinator never skips a phase and never advances past a failed deterministic check. The
approval record (acta de aprobación) in `00_plan_proyecto.md` stores gate, timestamp and the
teacher's decision text. The plan, schedule (phase list with status and timestamps, no invented
durations) and responsibility matrix (§4.1 table rendered with the actual executors) are generated
from state, not written by an LLM.

## 5. Workspace layout and contracts

### 5.1 Teacher profile (`<root>/teacher.yaml`, human-editable)

```yaml
schemaVersion: 1
teacherName: "Ana Pérez"
institution: "INSTITUTO CRISTIANO LAWRENCE"   # printed upper-cased
logo: "assets/logo.png"                        # optional; copied into the workspace
subject: "Matemáticas"                         # asked once, default Matemáticas
language: "es"                                 # locale of student-facing text
paper: "letter"                                # letter | a4; default letter, edit by hand
```

- If `teacher.yaml` is missing, **every** entry point (`/evalua:new`, the coordinator agent, tools)
  runs the profile interview first (§7.1). If present and valid, those questions are never asked.
- Logo: PNG, JPEG or WebP, ≤ 2 MB, magic-byte checked, copied to `<root>/assets/`. SVG is rejected
  in v1 (script surface). A missing logo is valid and simply omits the image.
- `/evalua:init --edit` re-runs the interview with current values preselected.

### 5.2 Exam spec (`<root>/exams/<NN-slug>/exam.yaml`)

```yaml
schemaVersion: 1
id: "e01"
number: 1
slug: "01-numeros-racionales-septimo"
title: "EVALUACIÓN DE MATEMÁTICAS - GRADO SÉPTIMO"   # generated from subject + grade
theme: "CONJUNTO DE LOS NÚMEROS RACIONALES (Q)"      # printed as "TEMA: …"
grade: "Séptimo"
level: basico | intermedio | avanzado | genio
packs: [basic-math]                                  # resolved knowledge packs
topics: [basic-math/rational-numbers]                # topic ids, from the interview
itemTypes:                                           # counts sum to questionCount
  single_choice: 8
  multiple_choice: 0
  open: 0
  practice: 2
questionCount: 10
distribution: same | bank
bank: { size: 30, variants: 2 }                      # only when distribution is bank
columns: 1 | 2
template: classic | blue                             # visual design; default classic (§10.5)
maxPages: auto | <integer>                           # auto = fewest legible pages
durationMinutes: 120
instrument: "pencil"                                 # pencil | pen | any
calculator: false
introOverride: null                                  # optional teacher-written paragraph
closing: { kind: none | quote | bible, pinned: null }   # pinned = catalogue id or teacher text
schoolYear: 2026                                     # current year at creation, frozen
status: draft | approved-a | built | approved-b
```

`schoolYear` is the current calendar year from an injectable clock, frozen at creation.

### 5.3 Per-exam folder

```
<root>/
  teacher.yaml
  assets/logo.png
  knowledge-packs/                  # optional workspace packs (§6.6)
  exams/
    01-numeros-racionales-septimo/
      exam.yaml
      blueprint.json
      items.json                    # frozen bank or fixed list, with seeds
      review.json
      layout-report.json
      00_plan_proyecto.md           # plan, schedule, responsibility matrix, approval record
      01_examen_estudiante.pdf
      02_hoja_respuestas.pdf        # teacher answer key: number → reference → answer → points
      03_solucionario_completo.pdf  # full worked solutions
      04_rubrica_calificacion.pdf   # only when open/practice items exist
      05_control_versiones.md
```

With `distribution: bank` and `variants > 1`, files 01–04 carry a variant suffix
(`01_examen_estudiante_A.pdf`, …); `items.json` stores the bank and each variant's drawn list.

Folder numbering: `NN` is the next integer after the highest existing `NN-*` folder (zero-padded to
2 digits, 3 beyond 99); numbers are never reused, even if a folder is deleted by hand while a later
one exists. The slug is generated by code from the theme and grade (ASCII, lowercase, hyphens,
≤ 48 chars), proposed to the teacher in the interview, and validated (§13).

### 5.4 State (`<root-parent>/.alisio/evalua/state.json`)

`schemaVersion`, workspace `root`, active exam id, per-exam phase, gate decisions with timestamps,
pending interview round (for headless continuation), revision counters. Atomic writes
(`.<uuid>.tmp`, `flag: "wx"`, mode `0600`, `rename`), tolerant reader that rejects unknown
`schemaVersion` with an actionable message.

### 5.5 Item record (`items.json`)

```json
{
  "id": "basic-math/fractions/add-unlike#s=1f2e3d4c",
  "ref": "FRA-7F3A",
  "topic": "basic-math/fractions",
  "family": "fraction-add-unlike",
  "source": "generator | bank | authored",
  "type": "single_choice",
  "level": "basico",
  "cognitive": "apply",
  "stem": ["Calcula: $\\dfrac{3}{4}+\\dfrac{5}{6}$"],
  "options": [{"key": "A", "text": "$\\dfrac{19}{12}$", "correct": true, "error": "none"}],
  "answer": {"canonical": "19/12", "display": "$\\dfrac{19}{12}$"},
  "solution": ["$\\mathrm{mcm}(4,6)=12$", "$\\dfrac{9}{12}+\\dfrac{10}{12}=\\dfrac{19}{12}$"],
  "points": 1,
  "estimatedSeconds": 90,
  "check": { "kind": "recomputed", "verifiedBy": "family-solver" }
}
```

`ref` = `<TOPICCODE>-<4 hex>` where the hex is the first 4 chars of SHA-256 over the canonical item
JSON without `ref`; it is extended to 6 chars on collision inside an exam. `error` names the
misconception a distractor encodes (sign error, omitted step, wrong common denominator …), mirroring
the distractor catalogue in `math.md` §3 Phase 5.

Item content (stem, options, solution lines) is a **mini markup**: plain text with `$…$` inline math,
`$$…$$` display math, and block objects `{ "table": { "head": [...], "rows": [[...]] } }`. The
renderer tokenizes it itself (no Markdown dependency); text is HTML-escaped, math goes to KaTeX in
`strict` mode (§10.2).

## 6. Knowledge base

### 6.1 Principle

One central structure answers "what does the plugin know": a tree of **topics**, each with
objectives, level calibration, cognitive demands and a way to produce items. Everything the
interview offers (exam kinds, topics, grades) is read from it, never hard-coded.

### 6.2 Layout shipped in the package (`knowledge/`)

```
knowledge/
  packs/
    basic-math/
      pack.yaml
      topics/*.yaml
      items/*.yaml        # optional static items
    algebra/
      pack.yaml           # requires: [basic-math]
      topics/*.yaml
      items/*.yaml
  quotes/
    quotes.yaml           # §9.4
    bible-rvr1909.yaml
  locales/
    es.yaml               # student-facing labels and intro template
```

### 6.3 `pack.yaml`

```yaml
schemaVersion: 1
id: algebra
version: 1
name: { es: "Álgebra", en: "Algebra" }
code: ALG                       # 2–4 uppercase letters, unique per pack
requires: [basic-math]
extends: null                   # or a pack id (workspace packs)
overrides: false                # must be true to replace an id from a lower layer, else KB-002
levels:                         # calibration shared by the pack's topics (topics may refine)
  basico:     { steps: [1, 2], coefficientRange: [-9, 9],   cognitiveMix: { recall: 50, apply: 40, reason: 10 }, secondsPerItem: 60 }
  intermedio: { steps: [2, 3], coefficientRange: [-15, 15], cognitiveMix: { recall: 30, apply: 50, reason: 20 }, secondsPerItem: 100 }
  avanzado:   { steps: [3, 5], coefficientRange: [-30, 30], cognitiveMix: { recall: 20, apply: 45, reason: 35 }, secondsPerItem: 150 }
  genio:      { steps: [4, 8], coefficientRange: [-60, 60], cognitiveMix: { recall: 10, apply: 35, reason: 55 }, secondsPerItem: 240 }
```

Level semantics (the coordinator explains them to the teacher): **básico** direct, routine,
single concept; **intermedio** routine with 2–3 steps and mixed concepts; **avanzado** multi-step,
modeling and justification; **genio** non-routine, olympiad-style multi-concept problems with
reasoning-heavy demand. `steps` bounds solution length, `coefficientRange` bounds numbers
(`EVL-ITM-006` enforces both), `cognitiveMix` is the default blueprint share (recall/apply/reason as
in `math.md` §3 Phase 3).

### 6.4 Topic file (`topics/<id>.yaml`)

```yaml
id: linear-equations
name: { es: "Ecuaciones lineales de una variable" }
code: ECU
grades: ["Séptimo", "Octavo", "Noveno"]       # indicative; free text matched by the interview
prerequisites: [basic-math/integers, algebra/algebraic-expressions]
objectives:
  - id: solve-one-step
    text: { es: "Resuelve ecuaciones lineales de un paso." }
    levels: [basico]
  - id: solve-both-sides
    text: { es: "Resuelve ecuaciones con términos en ambos lados." }
    levels: [intermedio, avanzado]
keywords: [ecuación, incógnita, despejar]
supports:                                    # which item types the topic can produce
  single_choice: true
  multiple_choice: true
  open: true
  practice: true
sources:                                     # how items are produced for this topic
  - { kind: family, family: linear-equation, levels: [basico, intermedio, avanzado, genio], params: { forms: [one-step, two-step, both-sides, fractional] } }
  - { kind: bank, file: items/linear-equations.yaml }
```

### 6.5 Initial content (v1 scope)

- **`basic-math`** (code `BAS`): natural numbers and place value, integers, order of operations,
  divisibility (multiples, divisors, prime factorization, gcd/lcm), fractions (equivalence,
  simplification, four operations, mixed numbers), decimals, rational numbers Q (the owner's example
  exam), ratio and proportion, percentages, powers and roots (integer), simple word problems.
- **`algebra`** (code `ALG`): algebraic expressions and evaluation, like terms, laws of exponents,
  polynomials (add/subtract/multiply, special products), factoring, linear equations (one variable),
  linear inequalities, systems of two linear equations, rational expressions (simplify/operate),
  quadratic equations (factoring and formula), radicals, linear functions (slope, intercepts),
  word problems modelled with equations.

Each topic ships at least one family or ≥ 12 static items per supported level. The exact
topic list and items are an implementation deliverable reviewed in Phase 3; this spec fixes the
structure and the minimum families (§8.2), not every topic file.

### 6.6 Extensibility

1. **Data-only extension (no code):** a pack in `<root>/knowledge-packs/<id>/` (same schema) may add
   topics whose `sources` are `bank` items or reuse existing families with different `params`,
   and may `extend` a shipped pack. Precedence by layer: workspace > shipped; an id collision
   without `overrides: true` is `EVL-KB-002`.
2. **New mathematics needing new computation (trigonometry):** add a pack `trigonometry`
   (`requires: [algebra]`) plus new families registered in `src/families/` (exact values table,
   identities, right-triangle solving, with exact arithmetic over a `√`/`π` extension of the
   rational type). The coordinator, interview, blueprint, renderer and layout engine do not change:
   they enumerate packs and topics from the registry. This is an acceptance test (§15): a fixture
   pack with only static items for a new topic must appear in the interview, generate, check and
   build with zero source changes.
3. Pack validation is deterministic (`EVL-KB-*`, §12): schema, unique ids/codes, `requires` closure
   without cycles, every referenced family exists, every `bank` file parses and every static item
   passes its own check.

The interview's "exam kind" choice (`Matemática básica` / `Álgebra` / other discovered packs) is the
list of packs with at least one topic whose `grades` or keywords match the teacher's description.

## 7. Interview

### 7.1 Mechanics

- Uses `api.ui.askQuestions` when `api.ui.interactive()`; otherwise persists the pending round in
  `state.json` and instructs the user to continue with `/evalua:new <answers>` (headless
  continuation like thesis).
- Every closed question offers 2–4 options with exactly one `recommended` and a `textInput` escape.
  Questions are asked **only when the answer is not already known** (profile) or **derivable**
  (e.g. same/bank is not asked when `questionCount` is 1; bank size is asked only for `bank`).
- One round never exceeds 4 questions. Free-text answers arrive under `"<id>:text"`.
- Every answered value is echoed back in the ficha técnica for Gate A; nothing is silently defaulted.

### 7.2 Profile round (only if `teacher.yaml` is missing; asked once ever per workspace)

| Id | Question | Options |
|---|---|---|
| `teacher_name` | Teacher's name | text only |
| `institution` | Educational institution | text only |
| `logo` | Institution logo (optional) | "No logo" (recommended), "Provide a file path" + text |
| `subject` | Subject | "Matemáticas" (recommended), + text |

### 7.3 Exam rounds (minimal, at most three)

Round 1, **what**:

| Id | Question | Options |
|---|---|---|
| `topic` | What is the exam about? | suggestions from the knowledge base matching the grade (recommended: best match), + text |
| `grade` | Grade | Sexto, Séptimo, Octavo, Noveno + text |
| `level` | Level | Básico (rec.), Intermedio, Avanzado, Genio |
| `kind` | Knowledge base | Matemática básica / Álgebra / mixed topics; asked only if `topic` does not resolve to one pack |

Round 2, **shape**:

| Id | Question | Options |
|---|---|---|
| `types` | Item types (multi-select) | Selección única (rec.), Selección múltiple, Abiertas, Ejercicio de práctica (resolver con procedimiento) |
| `count` | Number of questions | 10 (rec.), 15, 20 + text |
| `distribution` | Same exam for everyone, or random draws from a bank? | Same questions in the same order (rec.), Bank with random draws per exam |
| `columns` | Question columns | One (rec.), Two |

When `bank` is chosen, one follow-up question asks bank size (default `3 × count`, minimum
`count + 5`) and number of variants. When several types are chosen, counts per type default to a
proportional split by type weight (`single_choice` 2, `multiple_choice` 1, `practice` 2, `open` 1)
and are shown, editable, at Gate A.

Round 3, **print and tone**:

| Id | Question | Options |
|---|---|---|
| `pages` | Page limit | Fewest legible pages (rec.), 1 page, 2 pages, + number |
| `time` | Time and instrument | "2 hours, pencil" style presets + text: minutes, pencil/pen, calculator yes/no |
| `closing` | Closing text after the last question | A famous phrase, A Bible verse, None (rec.) |

### 7.4 Name and folder

After round 1 the coordinator proposes the exam title lines and folder name derived by code:
`title = "EVALUACIÓN DE <SUBJECT UPPER> - GRADO <GRADE UPPER>"`, `theme = "TEMA: <topic title upper>"`,
slug per §5.3. The teacher confirms or edits them at Gate A; no folder is created before Gate A
(the draft lives in state until then), so a cancelled interview leaves no empty folders.

## 8. Item generation and verification

### 8.1 Pipeline

`blueprint → draw targets → produce candidates → verify → freeze`.

1. **Blueprint** (`blueprint.json`): a table of topic × cognitive demand × item type with counts that
   sum to `questionCount` (or bank size). Built by code from the topics and the level's
   `cognitiveMix`, then offered for edit at Gate A. For `bank`, the blueprint is built for the bank
   size and each variant draws proportionally from every cell (stratified), so every variant keeps
   the same blueprint shape.
2. **Candidates**: for each cell, produce items from the topic's `sources` in order
   `family → bank → authored`, seeded (AD-5). A candidate is rejected and redrawn (bounded 50
   attempts per slot, then `EVL-ITM-009`) on any failed check.
3. **Verify** (§12.2) every candidate; **de-duplicate** by canonical stem + answer.
4. **Freeze** into `items.json`. `same` mode freezes exactly `questionCount` items, order fixed
   by blueprint order (sections by item type, then topic, then ascending difficulty). `bank` mode
   freezes the bank; each variant's list is drawn with `seed(examId, variantLetter)`, stratified by
   blueprint cell, without repeating an item within a variant, then ordered with the same section
   rule.

### 8.2 Item families (v1 minimum, `src/families/*.ts`)

Each family is a pure module `generate(rng, level, params) → ItemDraft` with its own solver and
distractor model (named misconceptions). Minimum set: `integer-ops`, `order-of-operations`,
`gcd-lcm`, `prime-factorization`, `fraction-simplify`, `fraction-ops`, `mixed-numbers`,
`decimal-ops`, `rational-compare`, `percent`, `proportion`, `powers-roots`, `expression-evaluate`,
`like-terms`, `polynomial-ops`, `special-products`, `factoring`, `linear-equation`,
`linear-inequality`, `linear-system-2x2`, `rational-expression`, `quadratic-equation`,
`linear-function`, `word-problem-linear` (template-driven, locale strings from pack data).
Families receive only data (level calibration, params) and an RNG; they never touch the filesystem.

Shared primitives in `src/math/`: `Rational` (BigInt), `Poly` (multivariate, rational
coefficients, canonical form, equality), expression printer to LaTeX (minimal parentheses by
precedence, never ambiguous signs), `solveLinear`, `solveQuadratic` over rationals with exact
discriminant classification.

### 8.3 Item sources

| Source | Correctness proof | Allowed types |
|---|---|---|
| `generator` | family solver + independent substitution/recompute check | all |
| `bank` (static, in packs) | `check` expression evaluated by code at load time (`EVL-KB-007`) | all |
| `authored` (`evl-item-author`) | must return a `check` the code can evaluate (e.g. `substitute`, `equivalent-polynomials`, `numeric-equal`) **and** passes `evl-math-reviewer`; items without a machine-checkable key (typically `open`) are marked `needsTeacherReview: true` and listed on the solution book cover | all |

LLM output never replaces a code check; a failing check discards the item and consumes one attempt.

### 8.4 Types

| Type | Student marks / writes | Correctness |
|---|---|---|
| `single_choice` | exactly one of 4 options (A–D) | exactly one correct |
| `multiple_choice` | one or more of 4–5 options; the stem states "marca todas las correctas" | ≥ 2 correct, ≥ 1 incorrect; all-or-nothing per item |
| `open` | written answer or short justification in ruled space | reference answer + rubric criteria |
| `practice` | full procedure in a grid/ruled space; "ejercicio sin procedimiento no es válido" | final answer + steps in solution + 2–4 rubric criteria |

Choice items: options are shuffled by seeded RNG with correct keys spread (no key used more than
`ceil(n/2)` times; no adjacent identical keys more than twice); "ninguna/todas las anteriores" is
never used (accessibility and ambiguity, `math.md` §4).

### 8.5 Numbering and references

Students see `1…N` consecutive per variant. Beside each number the exam prints the item's `ref`
in a small muted style (e.g. `1 · FRA-7F3A`). The answer sheet is a table
`# | ref | type | answer | points`, plus a second index sorted by `ref`. The solution book repeats
`# · ref` as each solution heading. Because of variants, every PDF names its variant letter and
exam number in the footer so a loose sheet can be matched to its key.

## 9. Document content

### 9.1 Student exam structure (in this order, no exceptions)

1. **Institutional header** (centered): optional logo (left, max 18 mm tall), institution name
   (upper-case, bold), then
   `EVALUACIÓN DE MATEMÁTICAS - GRADO SÉPTIMO` and `TEMA: CONJUNTO DE LOS NÚMEROS RACIONALES (Q)`
   (the owner's example shape, produced from `title` and `theme`).
2. **Information table**: Año lectivo (`schoolYear`, prefilled), Asignatura (profile subject,
   prefilled), Periodo (blank line), Estudiante (blank), Grado (blank when the exam is not tied to a
   single grade, otherwise prefilled and still writable), Fecha (blank), and a bordered
   **Nota / Calificación** box labelled for the teacher.
3. **Intro paragraph** (§9.2), one short paragraph.
4. **Questions**, numbered `1…N`, grouped in sections (one per item type) only when more than one
   type is present; section headings are one line; tables inside items are supported.
5. **Closing text** (§9.4) after the last question, with visible vertical space before it, on the
   last page; omitted when `closing.kind` is `none`.

Answer space per type: choice items render options inline or in a 2×2 grid chosen by option length
(deterministic rule); `open`/`practice` render a bordered area whose height comes from the item's
`estimatedSeconds` and the current density preset (§11.2), never below a floor of 3 ruled lines for
`open` and 6 grid lines for `practice`.

### 9.2 Intro paragraph

Generated by code from the locale template, never by an LLM, overridable by `introOverride`:

> "Este examen cuenta con {n} preguntas. El tiempo máximo para resolverlo es de {duration}, a {instrument}.
> Los ejercicios sin procedimiento no son válidos. Marca con cuidado las opciones de selección y
> resuelve de forma clara."

Clauses are dropped when not applicable (no procedure clause without `practice`/`open`, no
selection clause without choice items, calculator clause only when `calculator` is true or
explicitly false and non-default). Maximum 70 words (`EVL-DOC-004`).

### 9.3 Locale file (`knowledge/locales/es.yaml`)

Data only: field labels, section names, intro template and clause map, duration formatting ("2
horas", "90 minutos"), ordinals for grades, option letters. Adding a language is a new locale file.

### 9.4 Closing text (quote, Bible verse, none)

- Catalogue files `quotes.yaml` and `bible-rvr1909.yaml` hold entries
  `{ id, text, author|reference, source, translation?, tags[], language }`. Bible entries use a
  public-domain translation (Reina-Valera 1909); the text is transcribed from a primary public-domain
  source during Phase 3 and each entry stores that source. **No entry is written from memory**:
  CI test asserts every entry has `source` and `text` of non-trivial length.
- Selection is deterministic: filter by `kind` and language, score by tag overlap with the exam's
  topic keywords and level (tags such as `perseverance`, `wisdom`, `diligence`, `logic`,
  `knowledge`), break ties by `sha256(examId + entry.id)`. The teacher may pin an entry id or supply
  their own text (stored verbatim, marked `teacher-provided`).
- Candidate Bible references to transcribe and verify: Proverbios 2:6, 3:13, 4:7, Eclesiastés 9:10,
  Colosenses 3:23, Santiago 1:5.
- The agents may propose pinning but may not author text outside the catalogue or the teacher's own.
- Shipped v1 catalogue: three sourced famous quotes and the twenty-two Reina-Valera 1909 verses from
  §9.4, transcribed verbatim from eBible.org's public-domain `spaRV1909` release (source recorded per
  entry). A workspace quotes layer (`<root>/quotes/*.yaml`, precedence workspace > shipped) lets a
  teacher add their own closing texts — including a copyrighted version they are licensed to use —
  without the package shipping them.

### 9.5 Answer sheet, solution book, rubric, control log

- `02_hoja_respuestas.pdf`: header identical to the exam (marked "Hoja de respuestas — uso docente"),
  the §8.5 table, total points, and the blueprint summary. Goal: one page.
- `03_solucionario_completo.pdf`: per item `# · ref`, statement (math rendered), final answer, numbered
  procedure steps, the misconception behind each distractor for choice items, and
  `needsTeacherReview` flags. Two-column when the item count exceeds 12 and `columns` is `2`.
- `04_rubrica_calificacion.pdf`: per `open`/`practice` item criteria and point split
  (e.g. correct setup, procedure, result, units).
- `05_control_versiones.md`: exam id, revision, seed(s), pack ids and versions, plugin version,
  engine (Chrome version), SHA-256 of `items.json`, gate decisions, last build time.

## 10. Rendering

### 10.1 Pipeline

`items.json + exam.yaml + teacher.yaml + locale → document model → HTML (one file per PDF) →
Chrome (persistent session) → measure + fit (§11) → printToPDF → PDF`.

The document model is a typed tree (header, info table, intro, section, item, answer area, quote).
The HTML emitter is the only place that knows CSS; all spacing comes from a **density preset**
(CSS custom properties), so fitting changes numbers, not markup.

### 10.2 KaTeX

- Vendored KaTeX (same pinned version as thesis, MIT) evaluated in an isolated `vm` context like
  `src/render/html/katex.ts`; `renderToString` with `output: "html"`, `strict: "error"`,
  `trust: false`, `maxExpand` capped, `throwOnError: false` only to collect the error and then fail
  the build gate (`EVL-ITM-011`): **a formula that KaTeX rejects never reaches a PDF**.
- Inline `$…$` and display `$$…$$` both supported in stems, options, solutions, table cells, header
  text (theme may contain `(Q)` and formulas).
- KaTeX CSS and a core set of nine `woff2` fonts are inlined (data URIs; §18.1 P0.3); the HTML never references the network.
- Display math wider than its column is scaled down to fit (`transform: scale`, floor 0.85) and, if
  still wider, the item is flagged `EVL-LAY-004` so the fitter can switch to one column or break the
  formula (items may supply `aligned` multi-line display forms).

### 10.3 Fonts and print CSS

A vendored text font (Source Serif 4 body, Source Sans 3 labels; §18.1 P0.2) with explicit `@font-face`; `@page` size from `paper` (Carta or A4),
margins from the density preset, `print-color-adjust: exact`, black-and-white-safe styling (no
color needed for meaning), muted `ref` tags in gray ≥ 45 % black for photocopy legibility.

### 10.4 Engine availability

Chrome-family detection ported from thesis (`ALISIO_EVALUA_CHROME`, `PUPPETEER_EXECUTABLE_PATH`,
known paths, `PATH`); nothing is downloaded. Without a browser: `doctor` reports it, `build` writes
the self-contained print-ready HTML files (still KaTeX-typeset) and returns a clear error that PDFs
need a Chrome-family browser, without having validated page limits (`EVL-LAY-000` warning). The
browser runs with a temporary profile, no network (`--host-resolver-rules="MAP * ~NOTFOUND"` plus CDP `Fetch` interception), file access limited to the build dir (only the `Fetch` allow-list can do this; Chrome has no flag for it), a 120 s
timeout, and is always killed and cleaned.

### 10.5 Themes (templates)

The four documents can be typeset in more than one visual design, selected per exam and extended
by data without touching code.

- Two themes ship in v1: **`classic`** (default) is sober and formal, black-and-white-safe, with the
  Source Serif/Sans pairing of §10.3 and no colour needed for meaning; **`blue`** is print-friendly
  with a restrained blue accent for headers, rules and the Nota box, still legible in grayscale
  (the accent never carries meaning alone). Both honour the §11.2 floors unchanged.
- A theme is **data**: a `theme.yaml` with a schema (id, name, and a token map of CSS custom
  properties such as body font, accent colour, rule weight, header style) plus optional small
  markup variants. The HTML emitter consumes the tokens; it is the only code that knows CSS.
- Themes are discovered from `templates/themes/<id>/` in the package and from
  `<root>/templates/themes/<id>/` in the workspace, with the same precedence and `overrides`
  rule as knowledge packs (§6.6). Adding a theme is a new data folder; the renderer, layout
  engine and interview do not change.
- Selection: `exam.yaml.template` (default `classic`), chosen in the interview or editable at
  Gate A. An unknown id is `EVL-DOC-005`. The density ladder, audit and page limits are
  theme-independent: a theme may change tokens and typography, never the floors.

## 11. Layout fitting (the page budget)

### 11.1 Contract

- `maxPages: auto` → the minimum number of pages reachable **at or above the legibility floor** is
  chosen, preferring the most comfortable density that achieves that minimum.
- `maxPages: k` → page count must be ≤ k; the most comfortable preset that satisfies it is chosen.
- If no preset satisfies it → the build **fails** with `EVL-LAY-001` and a report listing the smallest
  page count reached and concrete options (fewer items, allow +1 page, switch columns, reduce
  `practice` answer space). It never emits an overflowing or illegible PDF and never silently
  exceeds `k`.

### 11.2 Density ladder (deterministic data in `src/layout/presets.ts`)

| Preset | Body pt | Line height | Margins mm | Item gap | Practice space | Header |
|---|---|---|---|---|---|---|
| `comfortable` | 11 | 1.45 | 20 | 7 mm | 100 % | full |
| `regular` | 10.5 | 1.35 | 16 | 5 mm | 80 % | full |
| `compact` | 10 | 1.25 | 13 | 3.5 mm | 60 % | tight |
| `tight` | 9.5 | 1.18 | 11 | 2.5 mm | 45 % | tight, info on 2 rows |
| `minimum` | 9 | 1.15 | 10 | 2 mm | 35 % (not below §9.1 floors) | tight |

**Floors, never crossed:** body ≥ 9 pt, line height ≥ 1.15, margins ≥ 10 mm, rendered math ≥ 85 %
of body size, answer space ≥ §9.1 floors. Columns follow the teacher's choice; the fitter may
**propose** the other column count in the failure report but never changes it silently.

### 11.3 Algorithm

1. Build the HTML once and keep one Chrome page open.
2. For presets in ladder order (page count is monotone non-increasing along the ladder; measured
   cost makes a linear scan of all five presets cheaper than any search, §18.1 P0.4): set `data-density`, wait for fonts and layout, run the
   in-page audit (§11.4), call `Page.printToPDF`, count pages (§2.3 P0.1).
3. Select per §11.1; write `layout-report.json` (chosen preset, pages per preset tried, audit
   results, engine version). Re-run the audit on the chosen preset's final PDF render.
4. Orphan control: item blocks use `break-inside: avoid`; section headings `break-after: avoid`;
   the closing text must not sit alone on a page with fewer than one item above it (the fitter moves
   the last item with it, `EVL-LAY-006`).

### 11.4 In-page audit (run per preset, deterministic JS shipped with the package)

| Check | Rule |
|---|---|
| Horizontal overflow | no element's `scrollWidth` exceeds its box; no text clipped |
| Overlap | no two sibling item boxes intersect (`getBoundingClientRect`), no text over the logo or the Nota box |
| Min size | computed font size of every text node ≥ floor |
| Math fit | KaTeX display width ≤ column width after scaling |
| Page edge | nothing painted outside the margin box |
| Answer space | every `open`/`practice` area ≥ its floor |

### 11.5 One-sheet requests

"One sheet or less" is `maxPages: 1` (a sheet counted as one printed side by default; "front and
back" is `maxPages: 2`). The fitter reduces density, answer space and gaps within floors; the intro
paragraph and header may use their tight variants. A request the floors cannot satisfy fails per
§11.1 rather than breaking legibility.

### 11.6 Performance target (measured in Phase 4)

One Chrome launch per build; ≤ 5 `printToPDF` calls per document on the ladder (linear scan); target
< 6 s for a 25-item exam with all four documents on a warm machine, < 15 s cold; HTML for the four
documents is generated in parallel, Chrome work is serialized in one browser.

## 12. Deterministic checks

### 12.1 Report

`evalua_check` returns `{ ok, results: [{ id, severity: error|warning, subject, message,
fix? }] }`; errors block the next phase and the final build. Exposed as a tool, a command and a
standalone CLI (`alisio-evalua check`).

### 12.2 Catalog (v1)

| ID | Sev | Rule |
|---|---|---|
| EVL-KB-001 | error | Pack/topic YAML fails schema or exceeds size caps |
| EVL-KB-002 | error | Id or code collision without `overrides: true` |
| EVL-KB-003 | error | `requires`/`extends` unresolved or cyclic |
| EVL-KB-004 | error | Topic references an unknown family or missing bank file |
| EVL-KB-005 | error | Level calibration missing or inconsistent (`steps`, ranges, mix ≠ 100) |
| EVL-KB-006 | warning | Topic lacks objectives for a level it declares |
| EVL-KB-007 | error | Static bank item fails its own `check` |
| EVL-ITM-001 | error | `single_choice` has ≠ 1 correct option |
| EVL-ITM-002 | error | `multiple_choice` has < 2 correct or no incorrect option |
| EVL-ITM-003 | error | Two options equivalent after canonicalization (Rational/Poly equality) |
| EVL-ITM-004 | error | Recomputed answer differs from the stored key |
| EVL-ITM-005 | error | Duplicate item (canonical stem + answer) in an exam |
| EVL-ITM-006 | error | Coefficient or steps outside the level calibration |
| EVL-ITM-007 | error | Forbidden option text ("todas/ninguna las anteriores") or key distribution rule violated |
| EVL-ITM-008 | error | Missing solution steps, points, reference or level |
| EVL-ITM-009 | error | Slot could not be filled within the attempt budget |
| EVL-ITM-010 | error | Authored item without a machine-checkable key and not flagged `needsTeacherReview` |
| EVL-ITM-011 | error | KaTeX rejects a formula in the item |
| EVL-EXM-001 | error | Item type counts ≠ `questionCount` or blueprint sums mismatch |
| EVL-EXM-002 | error | Numbering not consecutive 1..N, or reference missing/duplicated in the answer sheet or solution book |
| EVL-EXM-003 | error | `same` mode: item list differs from the frozen list; `bank` mode: variant draws violate stratification |
| EVL-EXM-004 | error | Cognitive mix deviates from the blueprint by more than 1 item per cell |
| EVL-EXM-005 | error | Exam folder name invalid, duplicated or not `NN-slug` |
| EVL-DOC-001 | error | Header field missing (institution, title, theme, año lectivo, asignatura, periodo, estudiante, grado, fecha, nota) |
| EVL-DOC-002 | error | Section order violated (§9.1) |
| EVL-DOC-003 | error | Closing text not from the catalogue or teacher-provided when `closing.kind` ≠ `none` |
| EVL-DOC-004 | warning | Intro paragraph > 70 words |
| EVL-DOC-005 | error | `template` names an unknown theme, or the theme file fails its schema |
| EVL-LAY-000 | warning | PDF built without a browser: page limit unverified |
| EVL-LAY-001 | error | Page limit unreachable above the floors |
| EVL-LAY-002 | error | In-page audit found overflow, overlap or sub-floor text |
| EVL-LAY-003 | error | Chosen preset's final PDF page count differs from the measured one |
| EVL-LAY-004 | warning | Display formula needed scaling below 100 % |
| EVL-LAY-006 | error | Closing text orphaned on its own page |

`evl-language-reviewer` findings (ambiguity, negations, bias, notation) are recorded in
`review.json` and block only when marked `severity: error` and unresolved; they are advisory
otherwise.

## 13. Security model

- All names, slugs and paths are validated: workspace root containment (realpath), no `..`, no
  absolute paths from child output, slug regex `^[a-z0-9][a-z0-9-]{0,47}$`, folder numbering by code.
- YAML via `yaml` with core schema only (no custom tags/anchors bomb: alias count and file size
  capped); every pack, locale and profile file is schema-validated before use.
- Child-session output is parsed as strict JSON and validated against schemas before any write;
  agents never write files. Tool `effect` values are accurate (`write` for exam writes, `process`
  for Chrome).
- Logo: allow-listed raster formats only, size cap, magic-byte check, copied (not referenced).
- Chrome: temp profile, no network, file access limited to the build dir, hard timeout, always killed.
- No credential, no local machine path in any committed file or packed tarball (`leak:check`,
  `pack:check`); test fixtures use synthetic paths such as `/scratch/p`, never a session-specific
  temporary path or a personal home path.
- Persist atomically (`wx` temp file + `rename`), mode `0600` for state, `0644` for exam outputs.

## 14. Package design

### 14.1 Manifest

Name `@alisio/plugin-evalua`, keyword `alisio-plugin`, `repository.directory`
`packages/plugin-evalua`, `homepage` and `bugs` per AGENTS.md, MIT, `type: module`, Node `>=22.16`,
`bin: { "alisio-evalua": "dist/cli.js" }`, `files`: `dist`, `.agents`, `knowledge`, `templates`,
`assets`, `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `cover.webp`. Dependencies: `yaml` only.
Peer and dev: `@alisio/sdk`. Changeset for the first release; diagram sources under
`diagrams/plugin-evalua/`.

### 14.2 Modules (`src/`)

```
index.ts            definePlugin, registration of resources, tools, commands
resources.ts        loadRoleInstructions, agent/skill paths
coordinator.ts      phase machine, gates, delegation, state transitions
interview.ts        rounds (§7), headless continuation
profile.ts          teacher.yaml read/write/validate, logo copy
workspace.ts        root resolution, exam numbering, slugging, path guards
knowledge/          loader, schema, registry, layering, validation (EVL-KB-*)
math/               rational.ts, poly.ts, latex.ts, solvers.ts, rng.ts
families/           one file per family + index registry
blueprint.ts        blueprint build and variant draws
generate.ts         candidates, redraw loop, freeze
verify.ts           item checks (EVL-ITM-*)
checks.ts           exam/doc/layout checks aggregation
quotes.ts           catalogue selection
markup.ts           mini markup tokenizer, table blocks
katex.ts            vendored KaTeX in vm
model.ts            document model builders (exam, sheet, book, rubric)
html/               emitters, css presets, in-page audit script
themes.ts           theme loader (classic, blue) and token schema (§10.5)
chrome/             detect.ts, cdp.ts (duplicated precedent)
layout.ts           density ladder, fit search, report
plan.ts             00_plan_proyecto.md and 05_control_versiones.md
cli.ts              alisio-evalua check|build|doctor|kb
types.ts, schemas.ts, storage.ts
```

### 14.3 Agents (`.agents/agents/evl-*.md`)

| Agent | Mode | Role |
|---|---|---|
| `evl-coordinator` | primary | The conversational Evaluation Coordinator: runs the interview in plain prose (never raw JSON), explains levels, proposes name/folder, presents Gate A/B, calls tools. Frontmatter and prose follow the thesis-coordinator fix (no subagent "return one JSON" rules; answers persisted via a `evalua_answer` tool). |
| `evl-assessment-designer` | subagent | Calibrates levels for unusual topics and edits the blueprint; returns JSON. |
| `evl-item-author` | subagent | Authors items for sourceless topics with machine-checkable keys; returns JSON. |
| `evl-math-reviewer` | subagent, read-only | Independent review of item + key only; returns JSON verdicts. |
| `evl-language-reviewer` | subagent, read-only | Clarity, ambiguity, notation, bias; returns JSON findings. |

### 14.4 Skills (`.agents/skills/evl-*/SKILL.md`)

`evl-intake` (interview and defaults), `evl-knowledge-base` (reading and authoring packs),
`evl-blueprint` (levels, cognitive mix, distribution), `evl-item-writing` (item card, distractor
catalogue from `math.md` §3 Phase 5, checks), `evl-math-review`, `evl-language-review`, `evl-layout`
(density ladder and floors), `evl-closing-text` (catalogue rules). Descriptions start with
`Trigger:` and are ≤ 250 chars (`pack-check`).

### 14.5 Tools

| Tool | Effect | Purpose |
|---|---|---|
| `evalua_profile` | write | get/set teacher profile (validated) |
| `evalua_kb` | read | list packs, topics, levels, objectives |
| `evalua_answer` | write | persist an interview answer for the pending round |
| `evalua_exam` | write | create/approve spec, allocate folder (after Gate A), status |
| `evalua_generate` | write | blueprint + generate + verify + freeze items |
| `evalua_check` | read | run deterministic checks, return the report |
| `evalua_build` | process | layout fit and PDF/HTML emission |
| `evalua_status` | read | phase, gates, next action |

### 14.6 Commands (`/evalua:<name>`, arguments parsed like Wayfinder)

`init [--edit]`, `new [description]`, `status`, `generate`, `check`, `build`, `approve <a|b>`,
`regenerate [--items | --variant <L>]` (explicitly discards frozen items, bumps revision), `kb`,
`doctor`. `regenerate` is the only way to change frozen items.

## 15. Tests (vitest, offline, deterministic)

- **Math core**: Rational/Poly identities; solver round-trips (substitute the solution back);
  property tests over seeds per family (answer verifies, distractors distinct, ranges respected).
- **Determinism**: same inputs → byte-identical `items.json`; `same` mode order stable; `bank`
  variant draws stable and stratified; different seeds differ.
- **Knowledge base**: schema, layering, `overrides`, `requires` closure, EVL-KB-* negatives;
  **extension fixture**: a workspace pack with a new static-item topic appears in the interview,
  generates, checks and builds with no source change (AD-3 acceptance).
- **Interview**: first-run profile asked exactly once; second run asks none of the profile questions;
  bank-only follow-up; headless continuation; ≤ 4 questions per round.
- **Workspace**: numbering gaps, no reuse, slug rules, path traversal and symlink escapes, logo
  validation (SVG rejected, wrong magic bytes rejected).
- **Document model**: header/info/intro/section/quote order; Año lectivo from injected clock; intro
  clauses and 70-word cap; reference present in exam, key and book; consecutive numbering.
- **KaTeX**: inline/display render, bad formula blocks the build, no network references in HTML.
- **Layout (fake CDP and, gated by an env flag, real Chrome)**: ladder selection, monotone page
  counts, floors never crossed, `EVL-LAY-001` failure report content, one-page request on a 10-item
  fixture passes with real Chrome, audit detects injected overflow/overlap.
- **Quotes**: catalogue integrity (every entry sourced), deterministic selection, teacher text
  verbatim, `none` omits.
- **Packaging**: `pnpm check`, `pack:check` tarball contains `knowledge/`, `templates/`, vendored
  KaTeX with license, `dist/resources.js` exporting `loadRoleInstructions`.

## 16. Phases, deliverables and acceptance criteria

| Phase | Deliverables | Acceptance |
|---|---|---|
| 0 Verification | §2.3 P0.1–P0.5 resolved and recorded in §18 | font license, Chrome page counting, SDK range decided |
| 1 Skeleton and profile | package scaffold, resources, storage, profile, workspace numbering, interview rounds, state | profile asked once; folder numbering tests; `pnpm check` green |
| 2 Math core and KB | `math/`, knowledge loader and validation, `basic-math` pack, first families | EVL-KB-* and property tests green; extension fixture passes |
| 3 Algebra, items, blueprint | `algebra` pack, all v1 families, blueprint, generate/verify/freeze, bank draws, quotes catalogue | EVL-ITM-* and EVL-EXM-* green; determinism tests green |
| 4 Rendering and fit | markup, KaTeX, HTML emitters, CDP, ladder, audit, four documents, themes (`classic`, `blue`) and the theme loader | one-page fixture fits with real Chrome; themes selectable and extensible by data; EVL-LAY-* and EVL-DOC-005 tests; performance measured |
| 5 Coordinator and agents | `evl-*` agents and skills, tools, commands, plan/RACI/acta, gates A and B, CLI | end-to-end fake-session test from empty workspace to approved package |
| 6 Docs and release | README, cover, diagrams, site page (EN + ES per language policy), changeset | `pnpm check` green; `pnpm diagrams:check` after diagrams |

The README is English only per AGENTS.md; a Spanish README or site page requires the owner to add
the plugin to the bilingual exception list first (ask before creating them).

## 17. Risks

| Risk | Mitigation |
|---|---|
| Chrome not installed on the teacher's machine | HTML fallback with clear message (§10.4); `doctor` explains; no download |
| Font/KaTeX metric differences between machines change page counts | vendored fonts only, report records engine version; limits re-verified at build time |
| Generator breadth (≈ 25 families) is large | Phase 3 ships the minimum per topic first; a topic with no family can use `bank` items; stated honestly in `evalua_kb` output |
| Bible/quote misattribution | catalogue-only, sourced entries; agents cannot author text |
| Floors too strict for "one sheet" requests | explicit failure report with concrete alternatives, never silent shrinking |
| Pack schema churn once trigonometry arrives | `schemaVersion`, additive-only changes inside v1; families registry is the only code-level extension point |
| Exact arithmetic for irrationals (trig, radicals) | v1 restricts radicals to perfect-square simplification; trig pack introduces the `√`/`π` extension type |

## 18. Phase results

Each phase appends "as built" notes with dates, measured numbers and decisions.

### 18.1 Phase 0 results (2026-10-06)

Environment: Chrome 154.0.8037.97 headless (`--headless=new`, pipe transport), Node 22.19, KaTeX 0.19.0
(from the thesis vendor directory). Experiments ran outside the repo; nothing was vendored.

**P0.1 Page counting (resolved).** 12 configurations (A4 and Carta, three densities, one and two
columns, 40 items) plus 5, 40 and 400 items. Chrome's PDF has no object streams and no xref streams,
so `/Type /Page` objects are never hidden. Counting `/Type /Page` not followed by `s` (leaf pages) and
the maximum `/Count` in the page tree agreed in every run (e.g. 400 items: 45 pages, 7 nested `/Pages`
nodes). Decision: primary count is the leaf-page regex; cross-check with the maximum `/Count`, and
treat disagreement as a build error. In-page measurement is a complement, not a replacement:
`getBoundingClientRect` showed no overlaps and `scrollWidth > clientWidth` detected a forced overflow
(1512 px vs 780 px), but the default viewport is 780 px, not the print content width, so the audit
must run with the viewport set to the print content width (to be verified in Phase 4) and the PDF
count stays authoritative.

**P0.2 Text font (resolved).** Network access works. Source: npm `@fontsource/source-serif-4`,
`@fontsource/source-sans-3`, `@fontsource/noto-sans` (all 5.3.0, license field `OFL-1.1`; each
`LICENSE` is the SIL OFL 1.1 text with no Reserved Font Name clause). Latin-subset `woff2` sizes:
Source Serif 4 regular 20 088 B, italic 20 092 B, bold 21 716 B; Source Sans 3 regular 15 696 B,
bold 15 596 B; Noto Sans regular 13 120 B, bold 13 464 B. A render check confirmed every Spanish
character tested (accents, `ñ`, `ü`, `¿`, `¡`, guillemets, curly quotes, dashes, ellipsis, euro,
degree, superscripts, `½`, `×`, `÷`) in the Source Serif 4 latin subset; only `≤` is absent (math
goes through KaTeX). Decision: Source Serif 4 (400, 400 italic, 700) for body and Source Sans 3 (400,
700) for headers and labels, about 93 KB raw; Noto Sans is the fallback choice. Vendor the OFL text
next to the fonts at implementation time and re-check the copyright header then.

**P0.3 KaTeX (resolved).** Version 0.19.0, MIT. A typical algebra page (fractions, radicals, `\pm`,
inequalities, `\left(...\right)`, bold) loads `Main-Regular`, `Main-Bold`, `Math-Italic` and
`Size1`; adding `\mathbb`, nested fractions and `\sqrt` over fractions adds `AMS` and `Size4`.
Decision: inline a core set of nine fonts (`Main-Regular`, `Main-Bold`, `Main-Italic`, `Math-Italic`,
`Size1` to `Size4`, `AMS`): 132 328 B raw, about 176 KB as data URIs (all 20 fonts: 259 792 B raw,
about 346 KB inlined; the KaTeX CSS rules are 24.8 KB). Other families (`\mathbb` is covered by AMS;
Script, Fraktur, Typewriter, Caligraphic) are added only when the rendered HTML uses their classes.

**P0.4 Timing (resolved).** Chrome launch plus attach: 170 to 195 ms. 25-item exam on the 5-step
ladder, switching the density stylesheet in one open page: layout 10 to 33 ms and `printToPDF`
about 30 ms per step; the whole ladder takes about 0.25 s cold and warm alike (page counts 5, 4, 3, 3,
2). Initial load 21 to 34 ms; full process 1.2 s. Binary search over presets is not worthwhile: a
linear scan of all five presets costs less than 0.3 s and also gives the complete
pages-per-preset table for `layout-report.json`. The §11.6 targets (6 s warm, 15 s cold for four
documents) are met by a wide margin. Profile cleanup needs retries (`rm` hit `ENOTEMPTY` once while
Chrome was still flushing its cache).

**P0.5 Chrome flags (resolved).** `--headless=new` with a temporary `--user-data-dir` works.
`--host-resolver-rules="MAP * ~NOTFOUND"` blocked every HTTP request from the page, loopback included
(zero server hits for image, stylesheet and `fetch`), whereas with no flags all three reached a local
server. `--proxy-server` is worse: the browser still opened connections to the proxy. No flag limits
`file://`: with the resolver rule alone, `../` and absolute `file://` images outside the build dir
still loaded. Decision: use the resolver rule as a first layer and CDP `Fetch.enable` with an
allow-list (only `file://<build dir>/...`, no `..`) as the enforcing layer; with it, outside files
and all network URLs failed with `BlockedByClient`.

**SDK range (resolved).** `@alisio/sdk` typings checked for 0.1.0, 0.2.0, 0.2.1, 0.3.0 and 0.4.4
(latest published). `ui.askQuestions` with `recommended`, `textInput` and `multiSelect` exists from
0.1.0; `api.paths` (`state`, `config`, `cache`) first appears in 0.3.0. Decision: peer range
`>=0.3.0 <0.7.0`, same as thesis, swarm and frontsmith; `@alisio/sdk` stays a dev dependency.

**Spec changes made.** §2.3 heading and §2.2 note marked resolved; §10.2 and §10.3 name the core KaTeX
font set and the chosen text fonts; §10.4 names the exact network and file isolation mechanism;
§11.3 and §11.6 replace the optional binary search with a linear scan of the ladder.

### 18.2 Phase 1 (as built, uncommitted)

Date: 2026-10-06. Nothing is committed or published. `pnpm check` is green (lint, leak:check,
typecheck, test, build, pack:check, docs:check, docs:build); the package has 80 tests across 6 files,
written before the code. One unrelated `plugin-laya` test (`ENOTEMPTY` while cleaning a temp dir)
failed once on the first full run and passed on the rerun.

**What exists** (`packages/plugin-evalua`): `package.json` per section 14.1 (version `0.0.0`, a
`minor` Changeset takes it to 0.1.0; `yaml` is the only runtime dependency; peer
`@alisio/sdk >=0.3.0 <0.7.0`, dev `0.3.0`), `tsconfig.json`, `biome.json`, MIT `LICENSE`, English
`README.md`, `cover.svg`, and `src/`: `types`, `schemas`, `storage` (atomic `wx` + rename writes,
`state.json` with `schemaVersion`, tolerant reader that drops unknown fields and refuses unknown
versions), `clock` (injectable, `schoolYear`), `profile` (`teacher.yaml` read, write and validate with
the core YAML schema and no aliases; logo copy with magic-byte check, SVG rejected, 2 MB cap),
`workspace` (root validation, realpath containment, slug rules, `NN-slug` numbering, `allocateExamFolder`),
`interview` (rounds `profile`, 1, 2, 2b, 3; at most 4 questions per round; free-text escape;
headless `id=value` parsing; draft builder), `coordinator`, `index` (plugin id `evalua`, category
`methodology-harness`, apiVersion 1). Registered: tools `evalua_profile`, `evalua_answer`,
`evalua_status`; commands `/evalua:init [dir] [--edit]`, `/evalua:new`, `/evalua:status`. No `.agents`
directories and no resource registration yet (Phase 5).

**Decisions and deviations**

- Exam numbering uses `max(existing folders, state.lastExamNumber) + 1`, so a number freed by deleting
  the highest folder is still never reused. Nothing calls `allocateExamFolder` yet: no folder exists
  before Gate A, and the interview ends with `state.draft` (the ficha tecnica) and a stated "Gate A
  arrives later" message.
- The SDK requires 2 to 4 options per question, so a text-only question is `enter` (recommended, with
  text input) plus `stop` (pause); in `--edit` mode `stop` becomes a recommended `keep`. A bare value
  that is not an option on a text-capable question is taken as that option's free text.
- Grade offers Sexto, Séptimo (recommended), Octavo and "Another grade" (text), so Noveno is typed;
  the SDK caps options at four.
- Topic suggestions, the `kind` question and pack resolution come from an injectable `TopicCatalog`.
  Phase 1 ships an empty catalog (topic is text-only, `kind` is never asked); Phase 2 plugs in the
  knowledge base. Tests cover the catalog path with a fake.
- `/evalua:new <text>` pre-fills the topic and skips that question. With a pending round, `id=value`
  arguments answer it; `/evalua:new` or `/evalua:init` with no arguments resumes it. A new `/evalua:new`
  replaces an unapproved draft.
- The profile is written the moment its round completes (so it is asked once ever); an invalid logo
  re-asks only the logo question. Logo paths are user-provided and may live outside the workspace;
  the copy target is containment-checked.
- `teacher.yaml` `logo` accepts any `assets/<name>.png|jpg|jpeg|webp`, not only `logo.*`.
- Time answers: presets `120-pencil`, `90-pencil`, `60-pen` or free text such as `90 pen calculator`.
- Item-type split uses largest remainder on weights 2/1/2/1; for all four types at 10 questions it
  gives 3/2/2/3 (single, multiple, open, practice).
- `scripts/scan-plugins.test.mjs` requires every package to have a cover, so a simple original
  `cover.svg` was added (the spec's "cover.webp only if required" became SVG, 16:9 viewBox).
  `pnpm docs:scan --offline` was run, which added the catalog entry, two generated site pages,
  the committed cover copy and `site/.vitepress/data/plugins.json` changes; `pnpm-lock.yaml` also
  changed. These generated files are untracked or modified, not committed.
- `leak:check` scans tracked files only, so new untracked files were also grepped for local paths and
  credential shapes (none); `pack:check` scans the tarball and passed. Tests use temp directories from
  the OS API and synthetic strings such as `/scratch/p`.

### 18.3 Phase 2 (as built, uncommitted)

Date: 2026-10-06. Nothing is committed or published. `pnpm check` is green end to end: lint
(`biome check`, 949 files, no fixes), `leak:check` clean (1614 tracked files), `typecheck`,
tests, `build`, `pack:check` (`OK @alisio/plugin-evalua@0.0.0`), `docs:check` (18 plugins, 42
pages, 76 links, 68 images) and `docs:build`. `packages/plugin-evalua` has **165 tests across 15
files** (up from 80 in Phase 1) plus 46 script tests; the new suites are `test/math/*` (36),
`test/families/families.test.ts` (28 property tests), `test/knowledge/loader.test.ts` (17),
`test/knowledge/catalog.test.ts` (3) and `test/knowledge/extension.test.ts` (1). The unrelated
`plugin-laya` cleanup race noted in 18.2 surfaced twice under the parallel `pnpm -r test` and
passed on the isolated run (337 tests) and on the final full run.

**What exists**

- `src/math/`: `rational.ts` (exact `bigint` fractions, canonical, `pow`, `sqrtExact`), `poly.ts`
  (multivariate rational polynomial: canonical form, a small recursive-descent parser, arithmetic,
  `evaluate`, `termList`), `latex.ts` (`latexRational`, `latexPoly` with minimal parentheses and
  unambiguous signs), `rng.ts` (xoshiro128** with a SHA-256 four-word seed and `examSeed(examId,
  variant, role)`), `solvers.ts` (`solveLinear`; `solveQuadratic` with exact discriminant
  classification: two rational roots, one double root, irrational, or none).
- `src/knowledge/`: `types`, `report` (`CheckCollector` -> `{ ok, results }`), `schema`
  (EVL-KB-001/005 field validators), `check-item` (EVL-KB-007: `rational-equal` and `poly-equal`
  checks evaluated at load), `registry` (layering workspace > shipped, `overrides`, `requires` /
  `extends` resolution with cycle detection, per-file byte caps, `maxAliasCount: 0`, pack/topic
  count caps), `catalog` (the interview's `TopicCatalog` adapter) and `package` (shipped path).
  Emits EVL-KB-001 through EVL-KB-007.
- `knowledge/packs/basic-math/`: `pack.yaml` with the four levels exactly as 6.3, and eight topics
  (integer-ops, order-of-operations, gcd-lcm, fraction-simplify, fraction-ops, decimal-ops and
  percent backed by families; natural-numbers and powers-roots backed by static items). Static
  items carry a Spanish stem, a named misconception per option and a `check` the loader evaluates.
- `src/families/`: the seven families, each a pure module with its own solver, a structured
  `problem` re-solved independently, a named distractor model and level-scaled solution lines.
- The coordinator loads the catalog once per workspace from the shipped packs plus
  `<root>/knowledge-packs` (cached; injected catalog still wins in tests), so topic suggestions,
  pack resolution and the draft read the knowledge base with no interview changes.
- `package.json` `files` now includes `knowledge`; `scripts/pack-check.mjs` asserts every
  `knowledge/` file is present in the packed tarball.
- Cover: the Phase 1 `cover.svg` was replaced by the owner's `cover.webp` (1672x941); `files` lists
  it, and `pnpm docs:scan --offline` republished `site/public/covers/evalua.webp` and the catalog
  entry (`docs:check` confirms no orphan).

**Decisions and deviations**

- Family stems are pure math markup with no natural language, so families stay locale-neutral;
  Spanish exam content lives only in data (pack/topic names, objectives and static bank items).
- `stepCount` is the solution length and every family builds that many genuine lines within the
  level's `steps` band, so `EVL-ITM-006`'s step bound is already exercised by the property tests.
- Decimal items use only `+`, `-`, `*` (division would produce repeating decimals not representable
  as a finite decimal string).
- The Phase 2 acceptance property test asserts, for every family x level x 30 seeds: the answer
  equals the independent `solve`, there are exactly four distinct canonical options with one
  correct, every `numericValues` entry lies inside `coefficientRange`, and the solution length lies
  inside `steps`.
- `basic-math` ships 3 static items per bank topic now; 6.5's ">= 12 static items per supported
  level" and the remaining v1 families, the `algebra` pack and blueprint/generate/verify/freeze are
  Phase 3.
- The extension fixture writes a workspace pack (`aa-custom` with a `volume` bank topic) into
  `<root>/knowledge-packs`, then proves it validates, appears in the interview's topic question and
  reaches the coordinator with no source change.
- Tests use OS temp directories at runtime and synthetic strings such as `/scratch/p`; because
  `leak:check` scans tracked files only, the new untracked files were also grepped for local paths
  and credential shapes (none).
- Spec change (owner request, 2026-10-06): new 10.5 "Themes (templates)" and the Phase 4 deliverable
  now require two data-driven themes, `classic` (default, sober/formal) and `blue` (print-friendly),
  selected by `exam.yaml.template` and extensible from `templates/themes/<id>/` with no code change;
  an unknown id is `EVL-DOC-005`.

### 18.4 Phase 3 (as built, uncommitted)

Date: 2026-10-06. Nothing is committed or published. `pnpm check` is green: lint (`biome check`,
973 files, no fixes), `leak:check` clean (1714 tracked files), `typecheck`, tests, `build`,
`pack:check` (`OK @alisio/plugin-evalua@0.0.0`), `docs:check` (18 plugins, 42 pages, 76 links, 68
images) and `docs:build`. `packages/plugin-evalua` has **253 tests across 17 files** plus 46 script
tests. The unrelated `plugin-laya` race of 18.2 surfaced once more under the parallel `pnpm -r test`
and passed on the rerun.

**What exists**

- The full v1 family set: **24 families** in `src/families/` (the seven of Phase 2 plus
  prime-factorization, mixed-numbers, rational-compare, proportion, powers-roots,
  expression-evaluate, like-terms, polynomial-ops, special-products, factoring, linear-equation,
  linear-inequality, linear-system-2x2, rational-expression, quadratic-equation, linear-function and
  word-problem-linear). `Family.solve` now returns a rational, a polynomial or canonical text, so
  polynomial and interval answers are first-class.
- The **`algebra` pack** (`requires: [basic-math]`, code `ALG`) with ten topics and Spanish
  word-problem templates as data.
- `src/blueprint.ts`: `buildBlueprint` apportions each item type across topics and the level's
  cognitive mix by largest remainder; deterministic and summing to the total.
- `src/generate.ts`: candidates from `family -> bank`, a bounded 50-attempt redraw loop, de-duplication
  by canonical stem + answer, `EVL-ITM-009` on an unfilled slot, key spreading by a seeded round-robin
  (spec 8.4), and a stable `ref` = topic code + first 4 (6 on collision) hex of the SHA-256 of the
  canonical item JSON.
- `src/verify.ts`: `EVL-ITM-001..010` for drafts and frozen items, plus `checkKeyDistribution`.
- `src/checks.ts`: `EVL-EXM-001..004`.
- `src/quotes.ts`: the closing catalogue loader, a deterministic tag-overlap selection with a
  `sha256(examId + id)` tie-break, teacher text and pinned ids, and a **workspace quotes layer**
  (`loadQuotesLayers`, precedence workspace > shipped). Shipped: three sourced famous quotes and 22
  Reina-Valera 1909 verses transcribed from eBible.org's public-domain `spaRV1909` release.

**Decisions and deviations**

- Families emit `single_choice`; `generate` adapts a family core to `open`/`practice` (no options).
  `multiple_choice` cannot be derived from a single-answer family, so it is filled from bank items
  only and an unfilled slot is the explicit `EVL-ITM-009`.
- `EVL-ITM-011` (KaTeX) is deferred to Phase 4, where KaTeX is vendored; `EVL-EXM-003` bank
  stratification is a basic length/identity check for now.
- Bible licensing (owner request): the Reina-Valera 1960 and the RVC, RVR1995 and NVI editions are
  copyrighted (© Sociedades Bíblicas Unidas / United Bible Societies / Biblica), so none is shipped.
  The package ships only public-domain text (RVR1909, transcribed from a named source); a teacher who
  wants a copyrighted version adds it to the workspace quotes layer, which never travels in the
  package.
- Spec change: §9.4 records the shipped catalogue and the workspace layer; §13 no longer writes the
  literal machine path that `leak:check` rejected once the spec became tracked.

**Still open in Phase 3 / next**

- `EVL-ITM-011` (KaTeX) belongs to Phase 4; wiring the quotes into the documents (the closing text of
  the exam and solution book) is Phase 4; the blueprint/generate pipeline is not yet called from a
  coordinator tool (Phase 5).
