# Spec: `@alisio/plugin-thesis` v1 (Thesis Studio)

Status: draft, not implemented. Nothing is committed or published; the owner orders both.
Audience: a coding agent implementing the package in this monorepo.
Source material: the owner's architecture notes (`thesis.md`, untracked, Spanish), the existing
`packages/plugin-wayfinder` (methodology-harness pattern) and `packages/plugin-literature-research`
(scholarly API client pattern), and toolchain research dated 2026-10-04 (§2.3).
Out of scope: anything in the Alisio core, multi-user collaboration, plagiarism detection against
closed corpora, a DOCX renderer (the renderer port in §10.0 keeps it a future adapter-only change), country packs other than Colombia.

Language: this file and every artifact the package ships are English. The thesis the plugin
produces is written in the language the user selects (§6.2); that language is data, not code.

---

## 1. Goal and non-goals

Ship an independently installable plugin that turns an Alisio session into a verifiable thesis
workshop for undergraduate degree projects, master's theses and doctoral dissertations. It must:

1. **Interview** the user for the initial metadata, starting with the thesis language, always
   offering options with one recommended answer (§6).
2. **Design** the research: problem, research question, general and specific objectives,
   justification, scope, methodology and ethics triggers (§7.2).
3. **Plan** the document: a logically ordered outline in which every section has a purpose, its
   research topics, the objectives it serves and the evidence it needs (§7.3).
4. **Research** each section into a verified evidence library before any prose exists (§8).
5. Let the user **validate** each section's research, then **draft** it from approved evidence only,
   building a partial document that grows section by section (§7.4).
6. **Build a PDF fast** (target: under 10 s for 150 pages on a warm cache) with formulas, charts,
   diagrams, tables, cross-references, a table of contents, lists of figures and tables, footnotes
   and a bibliography in the selected citation style (§10).
7. **Check deterministically**: every gate that can be decided by code is decided by code, runnable
   as a tool, a command and a standalone CLI (§9).

Non-goals:

- Writing a thesis without the human. Three human gates are mandatory (§7.1) and no section is
  drafted before its research is approved.
- Hiding AI assistance. When the resolved policy requires an AI-use declaration, the build fails
  without one (§9, check `POL-AI-001`).
- Being the source of truth for the law. Policy packs encode versioned, sourced rules; the user's
  institution overrides them (§11).

## 2. Verified current state (2026-10-04)

### 2.1 This repo

- No package renders PDF or uses Typst, LaTeX, KaTeX, Paged.js or puppeteer. The only browser use is
  the dev script `scripts/render-diagrams.mjs`, which detects an installed Chrome-family browser
  (Chrome, Chromium, Brave, Edge; overrides `MERMAID_BROWSER` / `PUPPETEER_EXECUTABLE_PATH`) and
  never downloads one. Its detection logic is the precedent for §10.6.
- `packages/plugin-wayfinder` is the reference for a methodology plugin:
  - `definePlugin({ id, categories: ["methodology-harness"], apiVersion: 1, setup })`;
  - `api.resources.agents("../.agents/agents")` and `api.resources.skills("../.agents/skills")`,
    paths in `src/resources.ts`;
  - commands only (`/wayfinder:<name>`, arguments `<target> -- <text>` parsed by `parseDelimited`);
  - a coordinator that delegates each phase to a fresh child session
    (`api.sessions.create` + `api.sessions.run`), parses strict JSON (`parseChildJson`), validates it
    (`src/validation.ts`) and only then writes Markdown artifacts and state;
  - state in `<workspace>/.alisio/wayfinder/…`, `state.json` with `schemaVersion`, atomic writes
    (`.<uuid>.tmp`, `flag: "wx"`, mode `0600`, `rename`), name and path guards;
  - `api.ui.askQuestions` when `api.ui.interactive()` is true, a slash-command instruction otherwise;
  - offline vitest suite with a fake `PluginAPI` harness (`test/wayfinder.test.ts`).
- `packages/plugin-literature-research` queries OpenAlex, Crossref and arXiv from fixed origins
  with an 8 s timeout, `redirect: "manual"`, a 512 KB response cap, a Crossref single-flight lock and
  3 s arXiv spacing. It returns escaped Markdown only: no structured JSON, BibTeX, citation model or
  state. AGENTS.md forbids importing it; this plugin ships its own client (§8.2), reusing the same
  limits.
- `scripts/pack-check.mjs` requires skills to have `name` and a `description` starting with
  `Trigger:` (≤250 chars), agents to have `name` and `description`, the tarball to contain exactly
  the discovered `.agents` files, and — when `src/resources.ts` exists — `dist/resources.js`
  exporting `loadRoleInstructions`, executed for every agent.
- No package ships templates yet. This one adds `templates/`, `styles/`, `policy-packs/` and
  `typst-packages/` to `files`, resolved with `new URL("../<dir>/…", import.meta.url)`.

### 2.2 SDK surface used (`@alisio/sdk` 0.3.0 typings)

| Need | API | Notes |
|---|---|---|
| Commands | `api.commands.register(name, handler, { description, argumentHint })` | `CommandContext` has only `sessionId`; no abort or progress (same gap as Laya G3). |
| Tools | `api.tools.register({ name, description, inputSchema, effect, execute })` | `effect`: `read`, `write`, `process`, `external`. |
| Agents and skills | `api.resources.agents(path)`, `api.resources.skills(path)` | |
| Child sessions | `api.sessions.create(ChildSessionSpec)`, `api.sessions.run(id, prompt)` | `tools.allow/deny`, `readOnly`, `permission`, `maxTurns`, `timeoutMs`, `maxOutputTokens`. |
| Questions with options | `api.ui.askQuestions({ questions })` | 1–4 questions, 2–4 options each, `recommended`, `textInput`, `multiSelect`. Headless answers are `undefined`. Free text arrives under `"<id>:text"`. |
| Progress | `api.ui.status(key, text, detail?)` | Used during research and builds. |
| Paths | `api.paths?.cache` | Feature-detect; fallback `ALISIO_CACHE_HOME` > `$XDG_CACHE_HOME/alisio` > `~/.cache/alisio`. |

The SDK peer range follows the repo's current packages; Phase 0 confirms the lowest version that
exposes `ui.askQuestions` with `recommended` and `textInput` (P0.1).

### 2.3 Toolchain facts (researched 2026-10-04, unverified here unless marked)

- **Typst 0.15.1** (2026-07-17, Apache-2.0): native math, numbered figures/tables/equations,
  `@label` cross-references, `outline()` (TOC and lists), running headers, footnotes, PDF/A and
  PDF/UA, multiple bibliographies; citations through Hayagriva reading `.bib` and external `.csl`,
  with `apa` and `ieee` built in. Typical compile under 1 s, incremental.
- **`@preview/mitex`** (Typst package, Apache-2.0): renders LaTeX math syntax inside Typst.
- **`@preview/merman` 0.3.0** (MIT/Apache-2.0, WASM, needs Typst ≥ 0.15): Mermaid → SVG at compile
  time, no browser.
- **`@myriaddreamin/typst-ts-node-compiler` 0.7.0** (Apache-2.0): in-process Node compiler with
  per-platform native binaries (linux-x64-gnu ≈ 52 MB). The embedded Typst version is **not
  verified** (P0.2).
- **Vega 6.4.0 / Vega-Lite 6.4.3** (BSD-3): `view.toSVG()` in Node without canvas; text width is
  estimated, so fonts must be explicit.
- **Paged.js 0.4.3** (MIT, last stable 2024-10) + **KaTeX 0.19.0** (MIT): fallback path only.
  Chrome 131+ supports `@page` margin boxes natively but not `target-counter`, so a TOC with page
  numbers still needs Paged.js.
- **CSL**: APA 7 and IEEE styles from `citation-style-language/styles` are CC-BY-SA 3.0. **No
  official CSL exists for ICONTEC NTC 1486**; this package writes and owns one (§10.4).
- Local machine: Node 22.19 with a global `WebSocket`, Google Chrome and Pandoc installed, Typst
  not installed (observed by the research agent).

## 3. Architecture decisions

| ID | Decision | Rationale |
|---|---|---|
| AD-1 | Package `@alisio/plugin-thesis`, plugin id `thesis`, category `methodology-harness`. | Owner decision. |
| AD-2 | **Lean operational v1**: the 15 logical roles of the source notes map to 8 agents (§5.3); the role separations *search ≠ verification*, *writer ≠ citation auditor*, *writer ≠ reviewer*, *formatting ≠ methodology* are preserved. | Owner decision; avoids 15 agents before evidence that splitting pays off. |
| AD-3 | The coordinator is TypeScript code, not an LLM. Children return JSON; code validates and writes. | Same pattern as Wayfinder; makes every gate reproducible. |
| AD-4 | Thesis content lives in a readable workspace folder (default `thesis/`); lifecycle state lives in `<workspace>/.alisio/thesis/state.json`. | Owner decision; content is versionable with git, state is machine-owned. |
| AD-5 | Markdown (a defined dialect, §10.2) is the canonical source. Typst is generated, never edited. | Agents and humans write Markdown well; Typst is an output format. |
| AD-6 | **Typst is the primary PDF engine; Chrome + Paged.js is the fallback** and the HTML preview. | Owner decision; speed, native academic features, no browser on the main path. |
| AD-7 | Charts are **Vega-Lite JSON → SVG** in Node; diagrams are **Mermaid** compiled by merman inside Typst (Chrome fallback). | Owner decision; declarative, schema-checkable specs. |
| AD-8 | **Self-contained academic search** (OpenAlex, Crossref, arXiv) with fail-open use of host web-search tools for grey and official literature. | Owner decision; AGENTS.md forbids importing other plugins. |
| AD-9 | **Policy packs**: agnostic core + `global` pack + seeded `CO` pack; institution rules are user YAML in the project. Resolution is deterministic code. | Owner decision; jurisdiction is data. |
| AD-10 | The package ships its own `icontec-ntc1486-2022.csl` with golden fixtures. | Owner decision; no official CSL exists. |
| AD-11 | Reference verification is done by code against Crossref/OpenAlex, never by an LLM claim. | "No invented reference" must be a property, not a hope. |
| AD-12 | Every deterministic check is also exposed as a CLI bin (`alisio-thesis`). | "Deterministic checks by scripts"; usable in CI and git hooks. |
| AD-14 | **Workspace policy packs**: `thesis/policy-packs/` uses the same layout and rule format as the shipped packs and can add or extend any scope (international, country, regional, institution, faculty, program, writing guide). The shipped Colombia pack works with zero local files. | Owner requirement: never locked into what the plugin ships. |
| AD-15 | **Format-agnostic rendering**: Markdown is parsed into a renderer-neutral document model (`ThesisDocument`); output formats are adapters behind a `Renderer` port. v1 ships `typst-pdf` and `chrome-pdf`; a `docx` adapter is a future version that must need no change outside its adapter. | Owner requirement: PDF now, Word later. |
| AD-13 | **Extensible norms**: workspace CSL styles (`thesis/styles/*.csl`), declarative presentation profiles (`thesis/styles/*.profile.yaml`) and institution rule files are discovered and validated like the shipped ones, and two authoring skills plus `/thesis:style` create them from an institutional guide. | Owner request: institutional and writing norms must be extensible without a package release. |

## 4. Contracts

### 4.1 Identifiers

| Kind | Pattern | Example |
|---|---|---|
| Section | `SEC-\d{2}(\.\d{2}){0,2}` | `SEC-03.02` |
| Objective | `OBJ-G` (general), `OBJ-\d{2}` (specific) | `OBJ-02` |
| Evidence | `EVD-\d{5}` | `EVD-00231` |
| Claim | `CLM-\d{4}` | `CLM-0048` |
| Figure / table / equation | `fig-[a-z0-9-]{1,48}`, `tbl-…`, `eq-…` | `fig-adoption-rate` |
| Finding | `FND-\d{4}` | `FND-0007` |
| Citation key | `[a-z][a-z0-9]{1,30}\d{4}[a-z]?` (author + year + disambiguator) | `perez2021b` |

IDs are allocated by code from counters in `state.json`; children propose content, never IDs,
except labels for figures, tables and equations, which code validates and de-duplicates.

### 4.2 Project brief (`thesis/thesis.yaml`, human-editable)

```yaml
schemaVersion: 1
language: es-CO            # BCP-47; drives drafting, Typst lang/region, CSL locale, labels
secondaryAbstractLanguage: en   # null when not required
searchLanguages: [es, en]  # languages used for search queries
workType: undergraduate_thesis  # undergraduate_thesis | degree_project | monograph | master_thesis | doctoral_dissertation
title: "…"
subtitle: null
authors: [{ name: "…", id: null }]
advisors: [{ name: "…", role: advisor }]
institution: { name: "…", faculty: "…", program: "…", city: "…", country: CO }
year: 2026
domain: { primary: computer_science, secondary: [] }
approach: mixed            # quantitative | qualitative | mixed | design_science | theoretical | systematic_review
studyDesign: null          # optional; routes reporting guidelines. Values: rct (alias randomized_trial) | observational | qualitative_interview (alias interviews_or_focus_groups) | systematic_review | scoping_review | case_study (alias case_report) | experiment | survey | health_economic_evaluation | diagnostic_accuracy | prediction_model | quality_improvement | other
citationStyle: auto        # auto | apa-7 | ieee | icontec-ntc1486-2022 | id of a workspace style in thesis/styles/ (§10.4.1)
presentation:
  standard: auto           # auto | icontec-ntc1486-2022 | apa-7 | generic
  paper: letter            # letter | a4
  fontProfile: serif       # serif | sans | institutional (fonts in thesis/fonts/)
  palette: okabe-ito       # §10.5
  diagramTheme: neutral    # neutral | grayscale
targets: { pages: 80, words: null }
aiUse: { assisted: true, declaration: auto }   # auto follows the policy
```

`thesis.yaml` is parsed with the `yaml` package, then validated by a hand-written schema validator
(no JSON Schema dependency); unknown keys are errors, so typos fail loudly.

### 4.3 Machine artifacts

| File | Format | Writer | Content |
|---|---|---|---|
| `compliance-profile.json` | JSON | resolver (code) | Resolved rules with `ruleId`, source and precedence trail (§11.3). |
| `research/protocol.md` | Markdown + front matter | coordinator from methodologist JSON | Problem, question, objectives, justification, hypotheses, scope, methodology, ethics answers. |
| `outline/outline.json` | JSON | coordinator from architect JSON | Section tree (§7.3). |
| `evidence/library.jsonl` | JSONL | coordinator | `EvidenceRecord` per line (§8.3). |
| `evidence/rejected.jsonl` | JSONL | coordinator | Rejected candidates with reason codes. |
| `evidence/search-log.jsonl` | JSONL | coordinator | Every query: source, query, filters, timestamp, hit count, selected IDs. |
| `evidence/dossiers/SEC-xx.md` | Markdown | coordinator | Per-section research synthesis shown to the user for validation. |
| `claims/claims.jsonl` | JSONL | coordinator | `ClaimRecord` (§8.5). |
| `bibliography/references.bib` | BibTeX | code, generated from the library | Never hand-edited; regenerated deterministically (sorted by key). |
| `styles/<id>.csl`, `styles/<id>.profile.yaml` | CSL XML, YAML | user or `/thesis:style` | Workspace citation styles and presentation profiles (§10.4.1). |
| `styles/fixtures/<id>.expected.json` | JSON | `/thesis:style` | Approved expected renderings used as golden tests for that style. |
| `reviews/FND-*.json` | JSON | coordinator from reviewer JSON | Findings with severity, target role and status. |
| `build/` | generated | build | `main.typ`, `figures/*.svg`, `thesis.pdf`, `check-report.json`, cache. Git-ignored. |

All JSON is written with sorted keys and a trailing newline so that diffs are stable.

### 4.4 State (`<workspace>/.alisio/thesis/state.json`)

```ts
interface ThesisState {
  schemaVersion: 1;
  root: string;                       // workspace-relative, default "thesis"
  phase: "intake" | "design" | "outline" | "sections" | "review" | "final" | "submitted";
  humanGates: Record<"A" | "B" | "OUTLINE" | "C", { status: "pending" | "approved"; at?: string; notes?: string }>;
  sections: Record<SectionId, SectionState>;
  pendingQuestions?: PendingQuestions;  // headless interview continuation
  counters: { evidence: number; claim: number; finding: number };
  lastCheck?: { at: string; errors: number; warnings: number };
  lastBuild?: { at: string; engine: "typst-cli" | "typst-node" | "chrome"; pdf: string; ms: number };
}
type SectionStatus = "planned" | "researching" | "research_review" | "research_approved"
  | "drafting" | "draft_review" | "approved" | "revising";
```

Validation, normalization and atomic writes follow Wayfinder's `storage.ts` exactly (§12).

### 4.5 Child output envelopes

Every child returns one JSON object (strict JSON or a single fenced `json` block) whose shape is
embedded in the prompt. The coordinator rejects, and retries at most once with the validation
errors, when: the JSON is malformed; a required field is missing; a citation key, evidence ID or
section ID is unknown; a status outside the allowed enum appears; or text fields exceed their caps.
A second failure leaves the section in its previous status and reports the errors to the user.
Envelopes are defined in `src/schemas.ts` with one validator per envelope:
`IntakeDraft`, `ProtocolDraft`, `OutlineDraft`, `SearchPlan`, `CandidateSet`, `AppraisalSet`,
`Dossier`, `SectionDraft`, `EditPass`, `FigureDraft`, `ReviewReport`.

## 5. Package design

### 5.1 Manifest (`packages/plugin-thesis/package.json`)

- `name: "@alisio/plugin-thesis"`, keywords `["alisio-plugin", "thesis", "academic-writing", "research"]`.
- `description`: "Plans, researches, drafts and typesets university theses with verified evidence,
  deterministic quality gates and fast Typst PDF builds in the language you choose."
- ESM, `engines.node >=22.16`, `exports["."]` → `dist/index.{js,d.ts}`,
  `bin: { "alisio-thesis": "dist/cli.js" }`.
- `files`: `dist`, `.agents`, `templates`, `styles`, `policy-packs`, `typst-packages`, `assets`,
  `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `cover.svg`.
- `repository` (with `directory: "packages/plugin-thesis"`), `homepage`, `bugs` as in Wayfinder.
- `@alisio/sdk` as peer and dev dependency.

Runtime dependencies (each justified per AGENTS.md):

| Package | License | Why it earns its place |
|---|---|---|
| `markdown-it` 15.x | MIT | Correct CommonMark/GFM parsing; hand-rolling a parser for tables and nesting is a bug farm. |
| `markdown-it-footnote` | MIT | Footnotes are mandatory in many styles; tiny. |
| `yaml` | ISC | Human-edited YAML with line-numbered errors; zero dependencies. |
| `vega`, `vega-lite`, `vega-interpreter` | BSD-3 | Chart rendering to SVG; the interpreter avoids `Function` code generation for untrusted specs (P0.4). `d3-dsv` (ISC) is used directly for `csvParseRows`. |

No `optionalDependencies` in v1: P0.2 showed `@myriaddreamin/typst-ts-node-compiler` 0.7.0 embeds
Typst 0.14.2 (merman needs 0.15) and has no package-path option (§16). Fallback-only assets (Paged.js and KaTeX browser bundles) are
vendored as files under `templates/html/vendor/` with their licenses, not installed as packages.

### 5.2 Module layout

```
packages/plugin-thesis/
  src/
    index.ts            definePlugin, registration
    cli.ts              alisio-thesis bin (check, build, bib, doctor)
    version.ts
    resources.ts        loadRoleInstructions, roleSkills (pack-check contract)
    types.ts            ids, records, state
    schemas.ts          child envelopes + validators
    storage.ts          atomic IO, guards, state
    brief.ts            thesis.yaml parse/validate
    intake.ts           interview rounds (§6)
    coordinator.ts      phase machine, delegation, human gates
    policy/
      resolver.ts       pack loading, precedence, compliance profile
      ethics.ts         ethics trigger questionnaire → requirements
    research/
      client.ts         OpenAlex/Crossref/arXiv HTTP (fixed origins, caps)
      verify.ts         DOI/metadata verification, retraction, duplicates
      library.ts        evidence library CRUD, statuses
      bibtex.ts         library → references.bib
    checks/
      index.ts          runner, report, gate grouping
      brief.ts outline.ts evidence.ts citations.ts claims.ts crossrefs.ts
      figures.ts compliance.ts writing.ts language.ts hygiene.ts
    render/
      dialect.ts        Markdown dialect extensions (labels, captions, figure refs)
      parse.ts          Markdown → ThesisDocument (renderer-neutral model, §10.0)
      model.ts          ThesisDocument types
      port.ts           Renderer interface, capabilities
      registry.ts       adapter registry
      charts.ts assets.ts  format-neutral asset services
      adapters/
        typst-pdf/      emitter.ts (model → Typst, escaping), runner.ts (engine), setup.ts
        chrome-pdf/     detect.ts, cdp.ts, html-emitter.ts
      build.ts          assembly, scopes, cache
  .agents/agents/*.md   8 agents (§5.3)
  .agents/skills/*/SKILL.md  15 skills (§5.4)
  templates/typst/      thesis.typ, profiles/*.typ, i18n/*.yaml
  templates/html/       fallback template + vendor/
  templates/palettes.json
  styles/               apa.csl, ieee.csl, icontec-ntc1486-2022.csl, LICENSE-CSL
  policy-packs/         global/, countries/CO/ (§11)
  typst-packages/       vendored preview/mitex, preview/merman with licenses
  test/                 *.test.ts, fixtures/
```

### 5.3 Agents (`.agents/agents/*.md`, Wayfinder frontmatter contract)

| Agent | Logical roles covered (source notes §2) | Tools | Mode |
|---|---|---|---|
| `thesis-coordinator` | 1 Orchestrator, 2 Policy resolver (explains resolved policy) | `thesis_status`, `thesis_check`, `thesis_build` | primary |
| `thesis-methodologist` | 3 Methodologist, 7 Ethics/legal (trigger questionnaire), 6 SME lens | read tools | subagent, read-only |
| `thesis-librarian` | 4 Research librarian | `thesis_scholar_search`, `thesis_scholar_resolve`, optional `web_search`, `web_fetch`, `brave_*` | subagent, read-only |
| `thesis-evidence-auditor` | 5 Evidence appraisal, 11 Citation integrity | `thesis_scholar_resolve`, read tools | subagent, read-only |
| `thesis-architect` | 9 Synthesis and argumentation (outline, argument map, claims) | read tools | subagent, read-only |
| `thesis-writer` | 10 Academic writer, 8 Data analyst (figure/table drafts from user data) | read tools | subagent, read-only |
| `thesis-editor` | 12 Language and style editor, 13 Technical publishing, style and norms authoring (§10.4.1) | read tools | subagent, read-only |
| `thesis-reviewer` | 14 Independent examiner, 15 Final QA (judgment part), 6 SME lens | read tools, `thesis_check` | subagent, read-only |

All subagents deny `task`, `delegate`, `subagent`, `sessions_create` and have `permission.write: false`;
only the coordinator code writes. Profiles: `maxTurns` 8–20, `timeoutMs` 180 s (librarian 300 s),
`maxOutputTokens` 6000 (writer 12000). The reviewer never receives the writer's instructions or
reasoning, only the built artifacts — this enforces *writer ≠ reviewer*.

### 5.4 Skills (`.agents/skills/thesis-*/SKILL.md`, Wayfinder heading contract)

`thesis-intake`, `thesis-policy`, `thesis-methodology`, `thesis-outline`, `thesis-search`,
`thesis-evidence`, `thesis-writing`, `thesis-citations`, `thesis-figures`, `thesis-math`,
`thesis-editing`, `thesis-review`, `thesis-build`, `thesis-csl-authoring`,
`thesis-institution-norms`. Each has `## Activation Contract`,
`## Hard Rules`, `## Decision Gates`, `## Execution Steps`, `## Output Contract`, `## References`,
and a `Trigger:` description ≤ 250 characters. `roleSkills` maps agents to skills; the same files
are loaded as child instructions by `loadRoleInstructions`.

Content requirements that skills must encode (abridged; full text is a deliverable):

- `thesis-writing`: write in `brief.language`; cite only keys present in the provided evidence
  packet; one claim per paragraph topic sentence; mark every non-trivial claim with a claim anchor
  (§10.2); never invent numbers; hedge in proportion to evidence status; no first-person plural
  unless the policy allows it.
- `thesis-figures`: chart choice by intent (comparison → bar; trend → line; distribution →
  histogram/box; relationship → scatter; composition → stacked bar, pie only for ≤ 3 parts;
  process/architecture → Mermaid flowchart; timeline/plan → Mermaid gantt; interactions → sequence;
  data model → ER; lifecycle → state). Rules: no 3D, no dual axes, units on axes, redundant encoding
  (marker or dash) so figures survive grayscale print, palette from `brief.presentation.palette`,
  text-block width or half width, caption with source and attribution.
- `thesis-csl-authoring`: derive a CSL 1.0.2 independent style from an institutional or writing
  guide the user provides (text, excerpt or URL fetched by host tools). Prefer `<link rel="independent-parent">`-free
  independent styles; start from the closest shipped style (APA, IEEE, ICONTEC) and change only what
  the guide prescribes; record every guide rule that drove a change in a `<!-- rule: … -->` comment
  with its source; set `<info>` (`id` = `thesis-<slug>`, title, `<rights>` CC-BY-SA 3.0, `updated`),
  `default-locale` from the brief language; cover the eight fixture types (§10.4); never invent a
  rule the guide does not state — list ambiguities as questions for the user instead.
- `thesis-institution-norms`: turn an institutional regulation, faculty guide or rubric into
  rule files in the §11.2 format (`level`, `source`, `verification.basis`) and, when it prescribes
  layout, into a declarative presentation profile (§10.4.1); classify each requirement by level;
  quote the source location for every rule; mark rules inferred from examples as
  `secondary_source`.
- `thesis-math`: LaTeX math syntax in `$…$` and `$$…$$`; every displayed equation that is referenced
  gets `{#eq-…}`; define every symbol at first use.

### 5.5 Tools

| Tool | Effect | Input | Output |
|---|---|---|---|
| `thesis_scholar_search` | external | `{ query (1–512), source: openalex\|crossref\|arxiv, limit? 1–25, fromYear?, toYear?, language? }` | JSON `{ results: ScholarRecord[] }` |
| `thesis_scholar_resolve` | external | `{ identifier }` (DOI, arXiv id, OpenAlex `W…`, URL of an allowlisted official domain) | JSON `ScholarRecord` + `retraction` + `verification` |
| `thesis_status` | read | `{}` | JSON summary of phase, gates, section statuses, next step |
| `thesis_check` | read | `{ gates?: string[], section?: SectionId }` | JSON `CheckReport` (§9.1) |
| `thesis_build` | process | `{ scope: full\|approved\|section, section?, format: pdf\|html, pdfa?: boolean }` | JSON `{ path, engine, ms, pages, warnings }` |

`ScholarRecord` is structured JSON (`id`, `doi`, `title`, `authors[{family, given, orcid}]`, `year`,
`containerTitle`, `type`, `publisher`, `issn`, `language`, `url`, `oaUrl`, `license`, `abstract`
(≤ 2000 chars), `source`), with every string control-character-stripped and length-capped.

### 5.6 Commands (`/thesis:<name>`, arguments `<target> -- <text>`)

| Command | Purpose |
|---|---|
| `init [dir]` | Create the workspace tree, run the interview (§6), write `thesis.yaml`, resolve policy, run G0. |
| `answer -- <text\|json>` | Answer pending interview questions headlessly. |
| `status` | Phase, gates, per-section table, next recommended command. |
| `next` | Run the next recommended step. |
| `design` | Methodologist drafts `research/protocol.md`; asks Human Gates A and B. |
| `outline` | Architect drafts `outline/outline.json` and renders `outline/outline.md`; asks the OUTLINE gate. |
| `research <SEC-id\|next>` | Search, verify, appraise; write the dossier; ask the user to validate it. |
| `draft <SEC-id\|next>` | Draft from approved evidence; run citation checks; editor pass; ask for approval. |
| `figure <SEC-id> -- <request>` | Draft a chart, diagram or table spec for a section. |
| `approve <A\|B\|OUTLINE\|C\|SEC-id> [-- notes]` | Record a human approval (also reachable through the interactive prompts). |
| `revise <target> -- <feedback>` | Route feedback to the right role (§7.5). |
| `check [gate…]` | Run deterministic checks; print the report. |
| `build [full\|approved\|SEC-id] [--html] [--pdfa]` | Produce the PDF (or HTML preview). |
| `review [SEC-id\|all]` | Independent review; findings in `reviews/`. |
| `finalize` | G9 + G10, Human Gate C, PDF/A build, submission package. |
| `style new <id> -- <guide text\|URL\|path>` | Author a workspace CSL (and optional presentation profile) from a guide; render fixtures; ask the user to approve each sample. |
| `style check [id]` | Validate workspace styles and re-render their golden fixtures. |
| `style list` | List shipped and workspace styles and profiles with their source. |
| `norms import -- <guide text\|URL\|path>` | Turn an institutional guide or rubric into `thesis/policy/*.yaml` rules; re-resolve the compliance profile. |
| `pack new <scope> <id>` / `pack list` / `pack check` / `pack explain <ruleId\|value>` | Create, list, validate and explain workspace policy packs (§11.1.1). |
| `doctor` | Report engines, versions, vendored packages, fonts, Chrome, network reachability. |
| `setup` | Install the pinned Typst CLI into the cache when no engine is available (§10.6). |

## 6. Intake interview

### 6.1 Mechanics

The interview runs in rounds of ≤ 4 questions through `api.ui.askQuestions`. Every question has
2–4 options; exactly one is marked `recommended` when a defensible default exists; options that
need free text use `textInput`. When `api.ui.interactive()` is false, the command stores the round
in `state.pendingQuestions` and returns the full question text with the `/thesis:answer` syntax;
answers are validated against the same option domain. Answers already present in `thesis.yaml` are
not asked again. Rounds 1–2 are mandatory before any other phase; round 3 is mandatory before
`design` completes; round 4 can be deferred until the first figure or build.

### 6.2 Rounds

**Round 1 — language and frame** (always first)

| id | Question | Options (recommended first) |
|---|---|---|
| `language` | In which language will the thesis be written? | The user's conversation language (recommended, detected from the invoking message when available); Spanish; English; Other (`textInput`, BCP-47 validated) |
| `workType` | What kind of work is it? | Undergraduate thesis / degree project (recommended); Master's thesis; Doctoral dissertation; Monograph |
| `country` | In which country will it be submitted? | Colombia (recommended when `language` starts with `es` and no other signal); Other (`textInput`, ISO 3166-1 alpha-2) |
| `secondaryAbstract` | Does it need an abstract in a second language? | Yes, English (recommended unless `language` is `en`); No; Other language (`textInput`) |

**Round 2 — institution and style**

| id | Question | Options |
|---|---|---|
| `institution` | University, faculty and program | Enter them (`textInput`, recommended); Not decided yet |
| `citationStyle` | Which citation style does your program require? | Let the policy decide (recommended); APA 7; IEEE; ICONTEC NTC 1486:2022 |
| `domain` | Primary research domain | Detected from the topic (recommended); Engineering/Computer science; Health sciences; Social sciences/Education (+ `textInput`) |
| `approach` | Research approach | Recommended from the domain; Quantitative; Qualitative; Mixed (+ design science, systematic review via `textInput`) |

**Round 3 — research intent**

| id | Question | Options |
|---|---|---|
| `title` | Working title | Enter it (`textInput`); Propose three titles from my topic (recommended when blank) |
| `topic` | Topic and problem in a few sentences | Enter it (`textInput`, recommended) |
| `objective` | General objective | Enter it (`textInput`); Draft it with the methodologist (recommended) |
| `justification` | Justification | Enter it (`textInput`); Draft it with the methodologist (recommended) |

**Round 4 — presentation**

| id | Question | Options |
|---|---|---|
| `paper` | Paper size | Letter (recommended for CO/US); A4 |
| `palette` | Chart palette | Okabe-Ito (recommended, color-blind safe); Paul Tol Bright; Paul Tol Muted (many categories); Grayscale-safe high contrast |
| `fontProfile` | Typeface | Serif (recommended); Sans; Institutional (fonts in `thesis/fonts/`) |
| `aiDeclaration` | AI-use declaration | Follow the policy (recommended); Always include; Never include (rejected at build if the policy requires one) |

## 7. Workflow

### 7.1 Phase machine and gates

```
intake ──G0──► design ──[Human A]──[Human B]──G1──► outline ──[Human OUTLINE]──G4a──►
sections (per-section loop, any order) ──all approved──► review ──G9──► final ──G10──[Human C]──► submitted
```

`build` and `check` are allowed in every phase after `intake`; they never change the phase.

### 7.2 Design

The methodologist receives the brief, the compliance profile summary and round-3 answers, and
returns `ProtocolDraft`: problem statement, research question(s), general objective, 2–6 specific
objectives (each with an action verb from an approved list per language, an object, and a
verifiable deliverable), justification (relevance, novelty, feasibility, beneficiaries), scope and
limitations, hypotheses when the approach is quantitative, methodology (design, population/corpus,
instruments, analysis plan, applicable reporting guideline such as PRISMA/STROBE/COREQ from the
global pack), and answers to the ethics trigger questionnaire (§11.4). The user approves Human Gate
A (topic, problem, question, objectives) and Human Gate B (methodology, ethics, scope) separately;
`revise` sends feedback back to the methodologist.

### 7.3 Outline

The architect returns `OutlineDraft`: an ordered tree of sections, each with
`{ title, purpose (≤ 300 chars), objectives: OBJ-ids, researchTopics: string[1–8],
questionsToAnswer: string[], evidenceNeeds: ("empirical"|"theoretical"|"normative"|"statistical"|"methodological")[],
targetWords, dependsOn: SEC-ids }`. Required sections come from the compliance profile (cover,
abstract(s), introduction, problem, objectives, justification, theoretical framework or state of
the art, methodology, results, discussion, conclusions, references, annexes, AI declaration when
required). Code enforces: every specific objective is covered by at least one section; required
sections exist and appear in the order the profile prescribes; `dependsOn` is acyclic. The rendered
`outline/outline.md` is what the user reads before approving the OUTLINE gate.

### 7.4 Per-section loop

1. `research`: librarian returns a `SearchPlan` (queries per topic per search language, sources,
   year range) → code executes the queries (logging each to `search-log.jsonl`) → librarian returns
   a `CandidateSet` → code verifies every candidate (§8.4) → auditor returns an `AppraisalSet`
   (status, relevance, limitations, `supports` topics, location) for verified candidates only →
   code writes records → architect returns a `Dossier` (synthesis per research topic, proposed
   claims with evidence IDs, gaps). Status `research_review`; the user validates with options
   *Approve research* (recommended when no gap is critical) / *Search more on …* (`textInput`) /
   *Add a source I have* (`textInput`: DOI or URL).
2. `draft`: writer receives the section plan, the dossier, the approved claims and an evidence
   packet (citation key, full reference, permitted use, location, limitations) for citable records
   only; returns `SectionDraft` `{ markdown, claims: [{ anchor, text, evidence: EVD-ids }], figures: FigureDraft[] }`.
   Code validates keys and anchors, writes `chapters/NN-<slug>.md` section block and `claims.jsonl`,
   runs checks G5 for the section; on errors the writer gets one correction attempt with the
   report. Then the editor returns an `EditPass` (revised Markdown; it may not add, remove or change
   citations, claim anchors, numbers or labels — code diffs these and rejects violations).
3. Status `draft_review`; the user approves (*Approve section* recommended / *Revise with feedback*
   / *Re-research*). Approval triggers a partial build (`scope: approved`) and reports the PDF path.

Sections can proceed in any order that respects `dependsOn`; `next` picks the first planned section
in document order whose dependencies are approved.

### 7.5 Review and correction routing

The reviewer reads the built Markdown, the outline, the protocol and the check report and returns
`ReviewReport` findings `{ severity: critical|major|minor, category, target: SEC-id, evidence, routeTo }`
where `routeTo` follows the source notes §23: source → evidence-auditor, concept → methodologist
(SME lens), method → methodologist, statistics → writer (data role), argument → architect,
wording → editor, format → build/template. `revise` executes the routed role. G9 passes when no
`critical` or `major` finding is open.

## 8. Research and evidence

### 8.1 Source hierarchy (from the policy pack)

Level A (primary/official) → Level A/B (peer-reviewed, indexed) → grey authoritative → contextual
(theses, preprints, conference abstracts) → discovery-only (Google Scholar, general web). Discovery
engines can find a source; only verification can make it citable.

### 8.2 Client

`research/client.ts` mirrors plugin-literature-research limits: fixed origins
`https://api.openalex.org`, `https://api.crossref.org`, `https://export.arxiv.org`; 8 s timeout;
`redirect: "manual"`; 1 MB response cap; Crossref single-flight; arXiv 3 s spacing; fixed error
strings. Optional polite-pool contact from `ALISIO_THESIS_CONTACT_EMAIL` (never persisted, never
logged). Web search for grey and official literature uses host tools by name only when present in
the child's tool list; absence is reported, never fatal.

### 8.3 Evidence record

```ts
interface EvidenceRecord {
  id: EvidenceId; citeKey: string;
  type: "journal_article" | "book" | "chapter" | "conference_paper" | "thesis" | "report"
      | "standard" | "law" | "dataset" | "web_page" | "preprint";
  title: string; authors: { family: string; given?: string; orcid?: string }[];
  year: number; containerTitle?: string; volume?: string; issue?: string; pages?: string;
  publisher?: string; doi?: string; isbn?: string; issn?: string; url?: string;
  language?: string; retrievedAt: string;              // ISO date
  verification: { method: "crossref" | "openalex" | "arxiv" | "official_domain" | "user_supplied";
                  metadataMatch: number;                // 0..1 title similarity
                  retracted: boolean; checkedAt: string };
  status: "VERIFIED_PRIMARY" | "VERIFIED_PEER_REVIEWED" | "VERIFIED_AUTHORITATIVE_GREY"
        | "CONTEXTUAL_ONLY" | "UNVERIFIED" | "REJECTED";
  appraisal: { relevance: "high" | "medium" | "low"; evidenceType: string;
               limitations: string[]; supports: string[]; location?: string };
  permittedUse: ("background" | "argument" | "method" | "results_comparison")[];
  sections: SectionId[];
}
```

### 8.4 Deterministic verification (`research/verify.ts`)

- A DOI must resolve on Crossref (or OpenAlex) and the normalized title similarity (token Jaccard
  after lowercasing, accent folding and stop-word removal for the record's language) must be ≥ 0.85,
  and the first author's family name and year (±1) must match; otherwise `UNVERIFIED`.
- Retraction: Crossref `update-to`/`relation` retraction entries or OpenAlex `is_retracted` →
  `REJECTED` with reason `retracted`.
- Duplicates: same DOI, or same normalized title + year → merged; the record keeps the oldest ID.
- `VERIFIED_PRIMARY` requires a URL whose host matches the policy pack's official-domain allowlist
  (e.g. `funcionpublica.gov.co`, `suin-juriscol.gov.co`, `minciencias.gov.co`) and type `law`,
  `standard`, `report` or `dataset`.
- `VERIFIED_PEER_REVIEWED` requires a journal-article or conference-paper type from Crossref or
  OpenAlex metadata; the auditor may downgrade but never upgrade beyond what code allows.
- Citable statuses: the first three. `CONTEXTUAL_ONLY` becomes citable for a section only after an
  explicit user approval recorded in the section state.

### 8.5 Claims

`ClaimRecord { id, section, anchor, text (≤ 400), kind: "background"|"argument"|"result"|"conclusion",
evidence: EVD-ids, results?: string[], objectives: OBJ-ids }`. A `conclusion` claim must reference
at least one `result` claim or evidence; every objective must be reached by at least one
`result` or `conclusion` claim before G10.

## 9. Deterministic checks

### 9.1 Report

```ts
interface CheckReport { at: string; ok: boolean; counts: { error: number; warning: number; info: number };
  findings: { code: string; gate: Gate; severity: "error" | "warning" | "info";
              file?: string; line?: number; message: string; hint?: string }[] }
```

Written to `build/check-report.json`; the CLI exits `1` when `ok` is false, `2` on usage or
environment errors. Messages are English; the coordinator explains them to the user in the
conversation language.

### 9.2 Check catalog (v1)

| Gate | Code | Severity | Rule |
|---|---|---|---|
| G0 | `BRF-001…` | error | `thesis.yaml` valid; language is valid BCP-47; citation style and presentation standard resolve; required metadata for the work type present. |
| G0 | `POL-001` | error | Compliance profile resolved; every rule has a source and `lastChecked`. |
| G1 | `DSN-001` | error | Protocol has problem, question, general objective, 2–6 specific objectives, justification, methodology. |
| G1 | `DSN-002` | warning | Specific-objective verbs are in the per-language approved list (Bloom-style; e.g. *comprender* flagged as not verifiable). |
| G4 | `OUT-001…` | error | Unique section IDs; acyclic `dependsOn`; every specific objective covered; required sections present and ordered. |
| G2 | `EVD-001…` | error | Records schema-valid; no duplicate DOI; citable statuses only via verification rules (§8.4); no retracted citable record. |
| G2 | `EVD-010` | warning | Section with `research_approved` has fewer than N citable records (N from the policy by work type). |
| G5 | `CIT-001` | error | Every `[@key]` in chapters exists in the library. |
| G5 | `CIT-002` | error | Every cited record is citable for that section. |
| G5 | `CIT-003` | warning | Library records never cited (only from the review phase on). |
| G5 | `CIT-004` | error | `references.bib` is byte-identical to a fresh generation. |
| G3/G4 | `CLM-001…` | error | Claim anchors in text match `claims.jsonl` both ways; claims cite existing evidence; conclusions trace to results; objectives reached (G10). |
| G0 | `CSL-001…` | error | Every workspace style: well-formed XML, CSL 1.0.2 root (`version="1.0"`), `<info>` with `id`, `title`, `updated`, `<rights>`; `<citation>` and `<bibliography>` present; no external `<link rel="independent-parent">` outside shipped styles; id unique across shipped and workspace styles; no DTD/entities (XXE guard). |
| G0 | `CSL-010` | error | Workspace style renders its approved fixtures byte-identically to `styles/fixtures/<id>.expected.json` (engine required; skipped with a warning otherwise). |
| G0 | `PRF-001` | error | Workspace presentation profile validates against the declarative profile schema (§10.4.1). |
| G8 | `XRF-001` | error | Every `@fig-/@tbl-/@eq-/@sec-` reference resolves; labels unique. |
| G8 | `XRF-002` | warning | Figure or table never referenced in text. |
| G8 | `FIG-001…` | error | Chart spec parses and validates against the supported Vega-Lite subset; data files exist inside `thesis/data/`; colors are in the selected palette; caption and source present. |
| G8 | `MTH-001` | error | Balanced math delimiters; no `\input`, `\include`, `\write` or other non-math LaTeX commands. |
| G7 | `LNG-001` | warning | Each section's language (stop-word ratio over the brief language vs. English/Spanish/Portuguese/French) matches `brief.language`; abstracts match their declared language. |
| G7 | `WRT-001…` | warning | Section word count within ±25 % of target; abstract word limit from policy; sentences over 45 words; repeated paragraph openings. |
| G7 | `HYG-001` | error | No placeholders (`TODO`, `TBD`, `XXX`, `[citation needed]`, `{{…}}`), no raw HTML, no raw Typst, no absolute local paths. |
| G6 | `ETH-001` | error | Ethics questionnaire answered; every triggered requirement has a recorded resolution. |
| G6 | `POL-AI-001` | error | AI-use declaration present when the resolved policy requires it. |
| G8 | `BLD-001` | error | Last build succeeded with zero Typst errors for the requested scope. |
| G9 | `REV-001` | error | No open `critical`/`major` findings. |
| G10 | `FIN-001` | error | All human gates approved, all sections approved, all errors above zero, PDF/A build succeeded. |

Each check is a pure function `(project: LoadedProject) => Finding[]` with unit tests for a passing
and a failing fixture.

## 10. Rendering

### 10.0 Renderer port (format agnosticism)

```ts
interface ThesisDocument {             // renderer-neutral, produced once per build
  meta: ResolvedMeta;                  // brief + compliance profile values the layout needs
  frontMatter: Block[];                // cover fields, abstracts, declarations, dedication…
  body: Section[]; annexes: Section[];
  figures: Map<Label, FigureAsset>;    // chart SVG, Mermaid source, raster/vector images
  bibliography: { entries: EvidenceRecord[]; styleId: string; cslPath: string };
  strings: I18nStrings;
}
type Block = Paragraph | Heading | List | Table | Figure | Equation | Quote | CodeBlock | Footnote…;
type Inline = Text | Emph | Strong | Code | MathInline | Citation | CrossRef | Link | FootnoteRef;

interface Renderer {
  readonly id: "typst-pdf" | "chrome-pdf" | (string & {});   // future: "docx", "html", "latex"
  readonly format: "pdf" | "html" | "docx" | (string & {});
  capabilities(): RendererCapabilities;  // math, mermaid, footnotes, toc, pdfa, crossrefs…
  available(env): Promise<Availability>; // engine detection, reason when unavailable
  render(doc: ThesisDocument, opts: RenderOptions, ctx): Promise<RenderResult>;
}
```

- `render/dialect.ts` + `render/parse.ts` turn Markdown into `ThesisDocument`; nothing format-specific
  happens before this point. Validation checks (XRF, FIG, MTH, CIT) run on the document model, not on
  any renderer's output.
- Adapters live in `render/adapters/<id>/` and are registered in `render/registry.ts`. Formats are
  chosen with `build --format pdf|html` (and later `docx`); `RendererCapabilities` lets the build
  degrade explicitly (e.g. a future DOCX adapter rendering Mermaid as SVG/PNG images and math as OMML)
  and report what it could not represent instead of dropping it.
- Shared assets that every format needs (chart SVG, citation rendering inputs, palettes) are
  produced by format-neutral services (`render/charts.ts`, `render/assets.ts`).
- Presentation profiles (§10.4.1) are format-neutral data; each adapter maps them (Typst settings
  now, DOCX styles later).
- Acceptance (Phase 4): a test adapter `test-json` registered only in tests renders the fixture
  document model to JSON, proving the port is sufficient without Typst-specific types; the two real
  adapters import nothing from each other.

### 10.1 Pipeline (`typst-pdf` adapter)

```
chapters/*.md ─► markdown-it (+footnote, +dialect) ─► token stream ─► typst-emitter ─► build/main.typ
figures/charts/*.vl.json ─► vega-lite compile ─► vega (interpreter, sandboxed loader) ─► build/figures/*.svg
figures/diagrams/*.mmd ─► copied into build/ ─► merman (inside Typst)
bibliography/references.bib + styles/<style>.csl ─► Typst bibliography()
templates/typst/thesis.typ + profile + i18n ─► imported by main.typ
typst compile --root build --package-path <pkg>/typst-packages main.typ thesis.pdf
```

### 10.2 Markdown dialect

| Construct | Syntax | Typst output |
|---|---|---|
| Section label | `## Methodology {#sec-methodology}` | heading + `<sec-methodology>` |
| Citation | `[@perez2021]`, `[@perez2021, p. 17]`, `[@a2020; @b2021]`, narrative `@perez2021` | `@perez2021`, `@perez2021[p. 17]`, `#cite(...)` |
| Cross-reference | `@fig-x`, `@tbl-x`, `@eq-x`, `@sec-x` | `@fig-x` … |
| Inline / display math | `$…$`, `$$…$$ {#eq-x}` | `#mi("…")`, `#mitex(\`…\`)` in a labeled `math.equation` (P0.3) |
| Figure | `![Caption. Source: …](figures/charts/x.vl.json){#fig-x width=100%}` (`.vl.json`, `.mmd`, `.svg`, `.png`, `.jpg`) | `#figure(image(...)/merman(...), caption: [...]) <fig-x>` |
| Table | GFM pipe table followed by `Table: Caption {#tbl-x}` | `#figure(table(...), caption: [...], kind: table) <tbl-x>`, caption above |
| Footnote | `[^1]` | `#footnote[...]` |
| Claim anchor | `<!-- claim:c3 -->` at paragraph start | dropped from output; consumed by checks |
| Page break / annex | `\newpage` is rejected; annexes are files under `chapters/annexes/` | handled by the template |

Anything else (raw HTML other than claim anchors, raw Typst, unknown attributes) is a `HYG-001`
error, not silently dropped. The emitter escapes every text node for Typst markup special characters
(`#`, `$`, `*`, `_`, `` ` ``, `<`, `>`, `@`, `[`, `]`, `\`, `/` at line start, `=`, `-`/`+` at line start),
with golden tests for each.

### 10.3 Templates

`templates/typst/thesis.typ` exposes `#show: thesis.with(brief, profile, strings)` and implements:
cover page from brief fields; preliminaries with roman page numbers (dedication and acknowledgments
optional, abstract(s) with keywords, AI declaration when required); TOC and lists of figures and
tables via `outline()`; arabic numbering from the introduction; per-chapter numbering of figures,
tables and equations (`3.2`); table captions above and figure captions below; running headers with
the current chapter; bibliography; annexes with letter numbering. Profiles:
`generic`, `apa-7`, `ieee`, `icontec-ntc1486-2022` set margins, spacing, heading styles, caption
labels and cover layout. Profile values that come from a policy rule cite its `ruleId` in a comment.
The `icontec-ntc1486-2022` profile follows P0.6 (§16.2): letter paper, 2 cm margins, 12 pt,
justified text, arabic page numbers throughout (cover and title page counted, not printed), decimal
headings to level 4, table **and figure** captions above with the source line below. Values the
2022 guides disagree on (font family Arial vs. Times New Roman, body line spacing 1.0 vs. 1.5,
level-2 heading case, reference-list heading) are not defaulted: when this profile is selected the
interview asks them (round 4, extra questions `icontecFont`, `icontecSpacing`) unless an
institution rule sets them.
`templates/typst/i18n/{en,es,pt}.yaml` hold labels (Figure/Figura, Table/Tabla, Contents/Contenido,
List of figures/Lista de figuras, Abstract/Resumen, …); other languages fall back to `en` with a
`LNG-002` warning that asks the user to supply `thesis/i18n.yaml`.

### 10.4 Citation styles

**ICONTEC CSL status (P0.6):** only one 2022-edition guide documents the citation and reference
format, so `icontec-ntc1486-2022.csl` ships as **provisional**: its `<info>` carries
`<category citation-format="note"/>`-appropriate metadata plus a `provisional` flag in
`styles/catalog.json`; selecting it emits warning `CSL-020` in every check report and the interview
asks the user to confirm it against their program's guide; dataset references have no source and
fall back to the closest type with warning `CSL-021`. A user who owns the standard can replace it
with a workspace style (§10.4.1) authored with `basis: official_text`.

`styles/apa.csl` and `styles/ieee.csl` are copied from the CSL repository with their `<rights>`
notice; `styles/LICENSE-CSL` carries CC-BY-SA 3.0. `styles/icontec-ntc1486-2022.csl` is written for
this package from public university library guides of NTC 1486:2022 (sources listed in its
`<info>` block), licensed CC-BY-SA 3.0 for compatibility, with golden fixtures for journal article,
book, chapter, thesis, law, standard, web page and dataset in Spanish. `THIRD_PARTY_NOTICES.md`
lists every vendored file and license.

### 10.4.1 Workspace styles and profiles (extensibility)

- **Discovery.** `thesis/styles/*.csl` and `thesis/styles/*.profile.yaml` are scanned at every
  `check`/`build`. A style's id is its `<info><id>` (must match the filename stem); workspace ids
  may not shadow shipped ids. `brief.citationStyle` and `presentation.standard` accept any
  discovered id; policy rules may also name them (`requirement: { kind: citation_style, values: { id } }`).
- **Loading.** The selected CSL is copied into `build/` and passed to Typst `bibliography(style: …)`
  (and to citeproc in the Chrome fallback). The XML is parsed by a minimal non-entity-expanding
  reader before use; anything with a DOCTYPE is rejected (`CSL-001`).
- **Declarative presentation profiles.** No raw Typst from the workspace. A profile is YAML with a
  closed schema mapped by the template to Typst settings:
  `paper`, `margins {top,bottom,inside,outside}`, `binding`, `font {body, headings, mono, size}`,
  `lineSpacing`, `paragraph {indent, spacing, justify}`, `headings[1..4] {size, weight, case, numbering, align, spaceBefore, spaceAfter, newPage}`,
  `captions {figurePosition, tablePosition, labelStyle, separator}`, `pageNumbers {front, body, position}`,
  `cover {fields[], layout: centered|left}`, `frontMatter[]` order, `footnotes {size}`,
  `extends: <shipped profile id>`. Unknown keys are errors (`PRF-001`); every value may carry a
  `ruleId` for traceability.
- **Authoring flow (`/thesis:style new`).** The editor child (with `thesis-csl-authoring` and,
  when layout is prescribed, `thesis-institution-norms`) returns `{ csl, profile?, questions[], ruleTrace[] }`
  → code validates (`CSL-001`, `PRF-001`) → renders the eight fixture references plus in-text
  citations in the brief language → shows them to the user, who approves (*Approve style*
  recommended / *Correct with feedback* / *Answer open questions*) → on approval code writes the
  style, its `fixtures/<id>.expected.json`, and records the style in `state.json`. Unanswered
  `questions` block approval. A style is never applied to the thesis before approval.
- **Sharing.** Workspace styles are plain files; users can copy them between theses or contribute
  them upstream to the CSL repository. Phase 7 documents how to promote a well-tested workspace style
  into the shipped `styles/` set.

### 10.5 Palettes (`templates/palettes.json`)

| Name | Colors |
|---|---|
| `okabe-ito` (default) | `#000000 #E69F00 #56B4E9 #009E73 #F0E442 #0072B2 #D55E00 #CC79A7` (yellow excluded for lines) |
| `tol-bright` | `#4477AA #EE6677 #228833 #CCBB44 #66CCEE #AA3377 #BBBBBB` |
| `tol-muted` | `#CC6677 #332288 #DDCC77 #117733 #88CCEE #882255 #44AA99 #999933 #AA4499 #DDDDDD` |
| `tol-high-contrast` (grayscale-safe, ≤ 3 series) | `#004488 #DDAA33 #BB5566` |
| `viridis` (sequential) | `#440154 #3B528B #21918C #5EC962 #FDE725` |
| `cividis` (sequential) | `#00204D #414D6B #7C7B78 #BCAF6F #FFEA46` |

`charts.ts` injects a Vega-Lite `config` (font family from the font profile, 9 pt labels, 0.75 pt
strokes, `range.category` from the palette, point markers on lines, no gridline clutter) so agents
never set styling themselves; a chart spec that sets colors or fonts fails `FIG-003`. Mermaid
diagrams get a theme block generated from the palette (`neutral` or `grayscale`).

### 10.6 Engines and setup

`typst-runner.ts` resolves the engine in this order and reports which one it used:

1. `ALISIO_THESIS_TYPST` (path to a binary) — must report `typst ≥ 0.15.0` via `typst --version`.
2. `typst` on `PATH` with the same version check.
3. The cached binary installed by `/thesis:setup`.
4. Chrome fallback (§10.7) with a warning that output differs from the Typst layout.

`/thesis:setup` downloads the pinned Typst release asset for the platform from
`github.com/typst/typst/releases` (version and SHA-256 per platform pinned in `src/typst-pins.ts`),
verifies the checksum before extraction, extracts with the system `tar` (argv array, no shell) into
`<cache>/thesis/typst/<version>/`, and runs `--version`. No silent download ever happens outside this
command. Typst is always invoked with argv arrays, `--root <build dir>`, `--package-path` pointing at
the vendored packages, `--ignore-system-fonts` only when the font profile says so, and a 120 s
timeout.

### 10.7 Chrome fallback and HTML preview

`chrome/detect.ts` ports the detection from `scripts/render-diagrams.mjs` (overrides
`ALISIO_THESIS_CHROME`, `PUPPETEER_EXECUTABLE_PATH`). `html-emitter.ts` renders the same token
stream to HTML with KaTeX (vendored browser bundle) and Mermaid (vendored), using
`templates/html/thesis.css` (CSS Paged Media) and vendored Paged.js. `cdp.ts` launches Chrome with
`--headless=new --remote-debugging-pipe` (or port 0), drives it with Node's global `WebSocket`/pipe
(no puppeteer), waits for a `window.__thesisReady` flag set from Paged.js's `after` hook (timeout
120 s), and calls `Page.printToPDF` with `preferCSSPageSize: true`. Chrome runs with a temporary
user-data dir and `file://` access limited to the build dir; the page loads no network resources.

### 10.8 Performance

- Chart SVGs and copied assets are cached by SHA-256 of spec + data + config in `build/cache/`.
- `scope: approved` emits only approved sections plus the front matter and bibliography of cited
  keys; `scope: section` emits one section with its figures and a local bibliography.
- Targets measured in Phase 4: warm full build of the 150-page fixture < 10 s with the Typst CLI;
  partial build < 3 s; Chrome fallback < 60 s.

## 11. Policy packs

### 11.1 Layout (shipped in the package)

```
policy-packs/
  global/
    manifest.yaml
    academic-integrity.yaml  evidence-quality.yaml  academic-writing.yaml
    reporting-guidelines.yaml        # PRISMA, STROBE, CONSORT, COREQ: when they apply
    work-types.yaml                  # required sections and evidence minimums per work type
  countries/CO/
    manifest.yaml
    higher-education/ley-30-1992.yaml
    academic-standards/ntc-1486-2022.yaml
    research-integrity/minciencias-res-0314-2018.yaml
    copyright/ley-23-1982.yaml  ley-1915-2018.yaml  decision-andina-351.yaml
    privacy/ley-1581-2012.yaml
    domains/health/resolucion-8430-1993.yaml
    official-domains.yaml           # allowlist for VERIFIED_PRIMARY
```

### 11.1.1 Workspace packs (extensibility without modifying the plugin)

`thesis/policy-packs/` mirrors the shipped layout and is loaded after the shipped packs:

```
thesis/policy-packs/
  international/<id>/manifest.yaml + *.yaml     # e.g. a funder or journal-family rule set
  countries/<CC>/manifest.yaml + **/*.yaml       # a new country, or additions to a shipped one
  institutions/<CC>/<institution-slug>/manifest.yaml + faculties/<slug>/programs/<slug>/*.yaml
  writing/<id>/manifest.yaml + *.yaml            # house writing guides
```

- Every `manifest.yaml` declares `{ packId, scope: international|country|region|institution|faculty|program|writing, appliesWhen, version, extends?: packId, description, maintainer? }`.
- A workspace pack may **add** rules to a shipped pack (`extends: CO`) or **override** a shipped rule
  by declaring the same `ruleId` with `overrides: true`; an override without the flag is error `PCK-002`
  (prevents accidental shadowing). Overrides keep the shipped rule in the resolution trail.
- Precedence (§11.3) is by rule `level` and pack `scope`, never by load order; equal precedence
  conflicts are error `PCK-003` with both sources listed.
- `requirement.kind` must be one of the closed vocabulary (§16.2); a pack may introduce new kinds
  only under `x-<name>`, which the resolver carries through to the compliance profile and the agents'
  instructions but no deterministic check consumes (`PCK-010` info).
- The brief selects packs with `policy: { packs: auto | [packId…] }`; `auto` loads `global`, the
  country pack matching `institution.country`, every workspace pack whose `appliesWhen` matches,
  and the institution pack matching `institution.name` (slug).
- Checks: `PCK-001` (manifest/rule schema, unique `ruleId` per pack, source and `lastChecked`
  present), `PCK-002`, `PCK-003`, `PCK-004` (a rule with `basis: secondary_source` older than 365 days
  → warning to re-verify).
- Help: commands `/thesis:pack new <scope> <id>` (scaffolds a commented manifest and an example rule
  file, asking scope and `appliesWhen` with options and a recommendation), `/thesis:pack list`
  (shipped + workspace packs, active or not and why), `/thesis:pack check`, `/thesis:pack explain <ruleId|value>`
  (prints the resolution trail for a resolved value), and `/thesis:norms import` (§5.6) that writes
  into `thesis/policy-packs/`. The skill `thesis-institution-norms` covers authoring packs of every scope.
- Out of the box: with no `thesis/policy-packs/` folder, a Colombian thesis resolves a complete
  compliance profile (layout, ethics, privacy, copyright, integrity, AI declaration, reporting
  guidelines, objective verbs, official domains) from the shipped packs alone; acceptance tests
  prove this (Phase 1 and Phase 4).

Simple overrides without a manifest remain supported: `thesis/policy/institution.yaml`, optionally `faculty.yaml`, `program.yaml`,
`rubric.yaml`, writing-guide files (`writing-*.yaml`, level `STYLE_GUIDE`, e.g. person and voice,
abbreviations, number formatting, maximum sentence length), each in the same rule format. They can
be written by hand or produced by `/thesis:norms import` (skill `thesis-institution-norms`), which
shows the extracted rules for approval before writing them. Writing-guide rules feed the writer and
editor packets and the `WRT-*` checks where they are machine-checkable.

### 11.2 Rule format

```yaml
ruleId: CO.NTC1486.2022.FORMAT.MARGIN.01
level: TECHNICAL_STANDARD   # LAW | REGULATION | INSTITUTIONAL_RULE | PROGRAM_RULE | TECHNICAL_STANDARD | STYLE_GUIDE | METHODOLOGY_GUIDELINE | RECOMMENDATION
authority: { organization: ICONTEC }
document: { id: NTC-1486, version: "2022" }
status: active
appliesWhen: { presentationStandard: icontec-ntc1486-2022 }
requirement: { kind: page_margins, values: { … } }
source: { reference: "…", url: "…", retrievedAt: "2026-10-04" }
verification: { lastChecked: "2026-10-04", basis: secondary_source }  # official_text | secondary_source
supersedes: []
```

`basis: secondary_source` is mandatory when the rule comes from university guides rather than the
paid standard text; the build report lists such rules so the user can confirm them with the program.

### 11.3 Resolver

Pure function `resolve(brief, packs, overrides) → ComplianceProfile`. Precedence (highest first):
law → regulation → institution → faculty → program → rubric → institutional template → selected
style → global default. `citationStyle: auto` and `presentation.standard: auto` resolve from the
highest-precedence rule that sets them, or `apa-7` / `generic` when none does (and the profile says
so explicitly, prompting the user in round 2 to confirm). Each resolved value records its
`ruleId` trail. Colombia never auto-enables ICONTEC: without an institutional rule, the user's
round-2 answer decides (source notes §11).

### 11.4 Ethics trigger questionnaire

Yes/no questions (human participants, minors, identifiable personal data, sensitive data,
intervention, risk above minimal, biological samples, animals, communities, clinical research,
additional institutional rules). The plugin never tells a user that consent is unnecessary
(Ley 1581/2012 art. 10(d) is not a research exemption); only an ethics committee can waive it. Each `yes` maps to requirements from the packs (e.g. personal data in CO →
Ley 1581/2012 consent and data-handling section; health domain → Resolución 8430/1993 risk
classification; human participants → ethics committee approval evidence in annexes). Requirements
become `ETH-001` items the user resolves with `approve`.

## 12. Security model

- Path guards on every user- and child-supplied path: workspace-relative, no `..`, no absolute
  paths, no backslashes or NUL, resolved path must stay under `thesis/` (or `build/` for outputs).
- Child output is untrusted: strict envelope validation, length caps, control-character stripping;
  unknown IDs rejected; the editor's diff guard (§7.4).
- No shell: every process uses `spawn` with argv arrays and timeouts.
- Typst runs with `--root` set to the build dir; the emitter never emits raw Typst from Markdown;
  Typst packages come only from the vendored path (no network fetch at compile time; P0.3 confirms
  the flag that disables `@preview` downloads or the vendored path satisfies all imports).
- Vega runs with `vega-interpreter` (no `Function` codegen) and a custom loader that only reads
  files under `thesis/data/` and rejects any URL scheme.
- Network: only the fixed scholarly origins, `/thesis:setup`'s GitHub release URL, and host tools.
  `redirect: "manual"`; response caps.
- No credentials are needed. The optional contact email is read from the environment only.
- State and generated files are written atomically with mode `0600` (directories `0700`).
- `leak:check` must pass for every fixture (fixtures use synthetic names and no local paths).

## 13. Test strategy (vitest, offline)

- Fake `PluginAPI` harness as in Wayfinder: commands, tools, scripted child outputs,
  `ui.askQuestions` (interactive and headless).
- Unit tests: brief validation, ID allocation, resolver precedence (CO with and without
  institution override), ethics mapping, verification rules (DOI match, title similarity
  thresholds, retraction, duplicates) against recorded JSON fixtures for Crossref/OpenAlex/arXiv,
  BibTeX generation determinism, every check (pass + fail fixture), emitter golden files per
  construct and per escaping case, chart config injection and palette enforcement, Vega loader
  sandbox (rejects `http:`, `file:` outside `data/`, `..`).
- Typst is invoked with an empty per-build package cache dir and `HTTPS_PROXY`/`https_proxy`/`ALL_PROXY`
  set to `http://127.0.0.1:9`, so any non-vendored import fails instead of downloading (P0.3).
- Lifecycle test: intake → design → outline → one section research → draft → approve → partial
  build stubbed at the engine boundary.
- Engine integration tests run only when an engine is available (`describe.skipIf(!typst)`), and
  are mandatory in CI if P0.2 makes the npm compiler available: build the fixture thesis and assert
  PDF exists, page count > 0, and Typst emitted zero errors (unresolved references are errors in
0.15.1). CI installs the pinned Typst CLI with the same pins as `/thesis:setup`.
- CSL golden tests for `icontec-ntc1486-2022.csl` via the Typst engine (same skip rule) and a plain
  XML schema-shape test that always runs.
- Fixture thesis `test/fixtures/sample-es/`: Spanish, 2 chapters, 1 displayed equation with a
  reference, 1 Vega-Lite chart from CSV, 1 Mermaid flowchart, 1 table, 1 footnote, 6 references
  (journal, book, law, standard, thesis, web page), APA and ICONTEC builds.

## 14. Phases, deliverables and acceptance criteria

### Phase 0 — prerequisites (verification only, no package code)

| ID | Verify | Decides |
|---|---|---|
| P0.1 | Lowest `@alisio/sdk` version with `ui.askQuestions` `recommended`/`textInput` and `paths`. | Peer range. |
| P0.2 | Typst version embedded in `@myriaddreamin/typst-ts-node-compiler` 0.7.0; platform coverage. | Whether it is an optional dependency and the CI engine. |
| P0.3 | mitex and merman: licenses, vendoring layout under `--package-path`, offline compile, labeled equations with mitex, Typst 0.15 compatibility. | Math and diagram strategy; fallback to native Typst math conversion if mitex fails. |
| P0.4 | `vega-interpreter` works with Vega 6.4 `toSVG` in Node 22; text measurement with explicit fonts. | Chart sandbox. |
| P0.5 | Typst release asset names and checksums for linux-x64/arm64, macOS x64/arm64, windows-x64; system `tar` handles `.tar.xz`/`.zip`. | `/thesis:setup` pins. |
| P0.6 | CO pack: each rule's official URL reachable; NTC 1486:2022 rules collected from at least two university library guides; Res. 0314/2018, Ley 1581/2012, Ley 23/1982, Ley 1915/2018, Decisión Andina 351, Res. 8430/1993 links. | Pack content and `basis`. |

Acceptance: a dated note appended to this spec (§16) with each result and its source.

### Phase 1 — skeleton, storage, intake, policy (G0)

Deliverables: package manifest, `index.ts`, `resources.ts`, `storage.ts`, `brief.ts`, `intake.ts`,
`policy/*`, `checks` runner with G0 checks, `/thesis:init|answer|status|check|doctor`, CLI `check`
and `doctor`, the 8 agents and 15 skills (content complete), global + CO packs.
Phase 1 also delivers workspace pack loading (§11.1.1) with `PCK-*` checks and `/thesis:pack list|check|explain|new`.
Acceptance: `pnpm check` passes; a Colombian brief with no `thesis/policy-packs/` resolves a complete
profile from shipped packs; a workspace pack adds an institution and overrides one shipped rule with
`overrides: true` (and fails `PCK-002` without it); `/thesis:init` in an empty workspace creates the tree, asks
round 1 first (language) with a recommended option, writes a valid `thesis.yaml` and
`compliance-profile.json`; headless init followed by `/thesis:answer` reaches the same files;
`alisio-thesis check` exits 0 on the fixture and 1 on a broken brief.

### Phase 2 — design and outline (G1, G4, human gates A, B, OUTLINE)

Deliverables: coordinator phase machine, methodologist and architect delegation, `protocol.md`
and `outline.json/.md` renderers, `approve`/`revise`, DSN and OUT checks.
Acceptance: scripted children produce a protocol and an outline; malformed child JSON is retried
once then reported; an outline missing an objective's coverage fails `OUT-003`; gates cannot be
skipped (`outline` before A and B returns the blocking reason).

### Phase 3 — research and evidence (G2, G5 partial)

Deliverables: client, tools `thesis_scholar_search|resolve`, verify, library, BibTeX, dossier,
`/thesis:research`, EVD and CIT-004 checks.
Acceptance: recorded fixtures prove DOI mismatch → `UNVERIFIED`, retraction → `REJECTED`, duplicate
merge, official-domain primary classification; `references.bib` is deterministic across runs;
search log records every executed query.

### Phase 4 — rendering (G8)

Deliverables: dialect, Typst emitter, templates and profiles, i18n (en, es, pt), CSL styles,
workspace style and profile discovery (§10.4.1), charts, engine runner, `/thesis:setup`,
`/thesis:build`, `/thesis:style list|check`, CLI `build`, `bib` and `style check`,
XRF/FIG/MTH/HYG/BLD/CSL/PRF checks.
Acceptance: the fixture thesis builds to PDF with cover, TOC with page numbers, lists of figures
and tables, numbered and referenced equation/figure/table, footnote, APA bibliography; switching
`citationStyle` to `icontec-ntc1486-2022` and `ieee` rebuilds without edits; a workspace
`thesis/styles/thesis-test.csl` fixture is discovered and applied, and one with a DOCTYPE or a
shadowed id fails `CSL-001`; a workspace profile changing margins and heading case is applied and an
unknown key fails `PRF-001`; warm build time
recorded in §16 meets §10.8 or the gap is documented.

### Phase 5 — drafting, editing, review, finalize (G3, G5, G6, G7, G9, G10, human gate C)

Deliverables: `/thesis:style new`, `/thesis:norms import` (scripted editor child, approval flow,
fixture snapshot), `/thesis:draft|figure|review|finalize|next`, writer/editor/reviewer delegation, claims,
editor diff guard, CLM/LNG/WRT/ETH/POL-AI/REV/FIN checks, PDF/A final build, submission package
(`build/submission/` with PDF/A, `references.bib`, protocol, check report).
Acceptance: lifecycle test passes end to end with scripted children; an editor pass that changes a
citation is rejected; a conclusion without results fails `CLM-003`; `finalize` refuses with any
open major finding.

### Phase 6 — Chrome fallback and HTML preview

Deliverables: `chrome/*`, HTML emitter, vendored KaTeX/Mermaid/Paged.js with notices,
`/thesis:build --html` and the engine-5 fallback.
Acceptance: with no Typst engine and Chrome present, the fixture builds a PDF with a TOC with page
numbers and numbered figures; with neither, `/thesis:build` returns an actionable message naming
`/thesis:setup`.

### Phase 7 — docs, catalog, release

Deliverables: package `README.md` (English) **and `README.es.md` (neutral professional Spanish)**,
kept in sync and linking to each other (owner request; recorded as a package-level exception in the
AGENTS.md language policy), covering basic usage, the workflow, engine requirements, workspace packs
and styles, and licensing of CSL and vendored packages; `cover.svg` (1600×900); explanatory diagrams
authored as Mermaid under `diagrams/plugin-thesis/` and rendered to SVG in `assets/` (diagram labels
in English per AGENTS.md), embedded in both READMEs — at minimum: (1) system architecture (commands
→ code coordinator → child agents → workspace artifacts → checks → renderer port → adapters),
(2) thesis lifecycle with human gates and the per-section research → validate → draft → approve loop,
(3) evidence verification pipeline (search → verify → appraise → library → citation), (4) policy
resolution (shipped + workspace packs → precedence → compliance profile); `assets` in `files`; repo
README/README.es updated together; **documentation site pages `site/plugins/thesis.md` and
`site/es/plugins/thesis.md`** (VitePress, mirroring the structure of existing plugin pages such as
`site/plugins/wayfinder.md` if present, otherwise `laya.md`), each embedding the same rendered
diagrams, linking to its mirror, and listed in the plugin index/sidebar of both languages;
`pnpm docs:scan` refreshed so `docs:check` and `docs:build` pass; changeset.
Acceptance: `pnpm check` and `pnpm diagrams:check` pass; the release preflight passes.

## 15. Risks

| Risk | Mitigation |
|---|---|
| Emitter edge cases (escaping, nested lists in tables, spans) | Reject unsupported constructs loudly; golden tests per construct. |
| typst-ts lags Typst; merman needs 0.15 | Engine order prefers the CLI; `/thesis:setup` pins a version. |
| NTC 1486:2022 text is paid; rules come from secondary sources | `basis: secondary_source`, listed in every build report; institution override wins. |
| Owned ICONTEC CSL drifts from what programs accept | Golden fixtures; users can drop a program-provided `.csl` into `thesis/styles/`. |
| Scholarly API rate limits during research | Single-flight, spacing, cached resolves in `build/cache/scholar/` (24 h). |
| LLM drafts unsupported claims | Evidence packet only, claim anchors, CIT/CLM checks, independent reviewer. |
| Long child runs without progress (no command abort, SDK gap) | One section per command; `ui.status` updates between steps. |
| LLM-authored CSL misrenders edge cases | Mandatory fixture approval by the user, `CSL-010` golden check on every build, open questions block approval. |
| Fonts required by institutions (Arial, Times) not installed | `institutional` font profile reads `thesis/fonts/`; `doctor` reports missing fonts. |

## 16. Phase results

### 16.1 Phase 0, P0.1–P0.5 (2026-10-04, scratchpad experiments)

- **P0.1 SDK.** npm has 0.1.0-alpha.2 … 0.4.3. `textInput` since 0.1.0; `api.paths` since 0.3.0;
  `PluginAPI` identical in 0.3.0 and 0.4.3; `Effect` also includes `"internal"`. Decision: peer
  `>=0.3.0 <0.7.0`, dev pin `0.3.0`; still feature-detect `api.paths`.
- **P0.2 node compiler.** typst-ts 0.7.0 embeds Typst 0.14.2 (fails on merman 0.3.0); 0.8.0-rc3
  embeds 0.15.0; no package-path option. Decision: not shipped in v1; re-evaluate at 0.8.0 stable.
- **P0.5 Typst 0.15.1 pins** (SHA-256 matches GitHub digests):

  | Platform | Asset | SHA-256 |
  |---|---|---|
  | linux-x64 | `typst-x86_64-unknown-linux-musl.tar.xz` | `a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c` |
  | linux-arm64 | `typst-aarch64-unknown-linux-musl.tar.xz` | `5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee` |
  | darwin-x64 | `typst-x86_64-apple-darwin.tar.xz` | `7f9fdd9584866245de9a79e0add8f9236fae6f40a8a45e2c4771ccc14db4e0fa` |
  | darwin-arm64 | `typst-aarch64-apple-darwin.tar.xz` | `48f62ed034aa3a7978309579ac6ca00045e2ef0da73114e8af27cfd8e74dc05a` |
  | win32-x64 | `typst-x86_64-pc-windows-msvc.zip` | `19ce3551153c2fe7ee9fa2f95208310c8f4d3209fedb699e0333faf8913f6736` |

  GNU tar extracts `.tar.xz`; `.zip` relies on Windows' bundled bsdtar (untested here).
- **P0.3 packages.** `@preview/mitex` 0.2.7 (Apache-2.0, 392 KB), `@preview/merman` 0.3.0
  (MIT OR Apache-2.0, 8.0 MB, bundles ELK under EPL-2.0 and other notices that must ship). Offline
  compile of equation + inline math + Mermaid figure + external CSL bibliography: 0.48 s, no
  diagnostics. No Typst flag disables downloads; vendored `--package-path <root>/preview/<name>/<version>/`
  plus the proxy guard (§13) makes it offline. mitex: unknown commands are hard errors, a backtick in
  `\text{}` breaks the build, unbalanced `\frac{1}{` renders silently — so `MTH-001` checks balance,
  backticks and a length cap before emitting. Emitter contract:

  ```typst
  #import "@preview/mitex:0.2.7": mitex, mi
  #import "@preview/merman:0.3.0": mermaid
  #set math.equation(numbering: "(1)")
  #show figure.where(kind: table): set figure.caption(position: top)
  Inline #mi("\\alpha^2").
  #mitex("E = mc^2") <eq-x>
  #figure(mermaid(read("figures/diagrams/flow.mmd"), width: 80%), caption: [...]) <fig-flow>
  #figure(table(columns: 2, ...), caption: [...], kind: table) <tbl-x>
  @perez2021[p. 17]  #cite(<smith2019>, form: "prose")
  #bibliography("refs.bib", style: "apa.csl", title: [References])
  ```
- **P0.4 Vega.** vega 6.4.0, vega-lite 6.4.3, vega-interpreter 2.3.2 (BSD-3). `ast: true` + interpreter
  renders SVG with codegen blocked, but Vega's CSV parsing uses `new Function` and fails silently;
  loader rejections are only logged; a throwing `sanitize` crashes on `href`. Decision: the plugin
  reads `thesis/data/` itself (realpath containment, no schemes, no `..`), parses CSV with
  `csvParseRows`, inlines `data.values`; Vega gets a deny-all loader and a logger that turns any
  warn/error into a failure; specs with `image` marks, `href`/`url` fields or `data.url` are rejected
  (`FIG-002`). Text width is estimated (0.8 × size × chars), so fonts are always explicit.
- Full evidence (commands, outputs, scripts) was produced in the session scratchpad and summarized
  here; it is not committed.

### 16.2 Phase 0, P0.6 (2026-10-04)

- CO legal sources verified from official text and in force: Ley 30/1992 (arts. 28, 29, 109:
  institutions set thesis requirements), Res. 0314/2018 (policy framework; misconduct list §5.3 used
  for integrity rules), Ley 23/1982 arts. 30–32 (unmodified by Ley 1915/2018), Decisión Andina 351
  arts. 11, 21, 22(a), Ley 1581/2012 (Decreto 1377/2013 now compiled in Decreto 1074/2015; silence is
  never consent), Res. 8430/1993 (three risk categories, 11-element consent, only the committee waives
  consent). Watch item: a MinSalud draft replacing Res. 8430 Títulos I–II is in consultation
  (secondary sources only).
- NTC 1486:2022: three 2022 guides (Pascual Bravo, USTA Villavicencio, EAFIT). Layout rules backed by
  ≥ 2 guides are encoded with `basis: secondary_source`; citation/reference format has one source
  (ICONTEC CSL provisional, §10.4); disputed values are asked, not defaulted (§10.3).
- Official-domain allowlist: `gov.co` suffix and listed hosts, `comunidadandina.org`,
  `icontec.org` (standards only); SciELO, Publindex, Scienti are indexing-only, never primary;
  `edu.co` is never primary. Several gov.co hosts have broken TLS chains, so §8.4 matches hosts
  offline and never tests reachability.
- Global pack: 14 reporting-guideline rules (incl. CONSORT 2025, SPIRIT 2025), work-type core sections,
  evidence minimums from Hernández-Sampieri as overridable warnings (no recency quota exists), ICMJE
  (Jan 2026) AI-disclosure and evidence-quality rules, objective verbs for es/en/pt (warning only).
- Requirement `kind` vocabulary (closed, in `global/manifest.yaml`): `institutional_authority`,
  `paper`, `page_margins`, `font`, `line_spacing`, `text_alignment`, `pagination`,
  `front_matter_order`, `required_section`, `heading_format`, `caption_position`, `citation_style`,
  `reference_format`, `length_limit`, `ethics_trigger`, `risk_classification`, `consent_requirement`,
  `data_protection`, `quotation_rule`, `attribution_rule`, `integrity_rule`, `ai_declaration`,
  `source_quality`, `evidence_minimum`, `reporting_guideline`, `objective_verbs`,
  `official_domain_allowlist`. `appliesWhen` keys: `country`, `language`, `workType`, `approach`,
  `studyDesign`, `domain`, `presentationStandard`, `citationStyle`, `ethicsTrigger`, `aiUse`.
- Integration (Phase 1): drafts installed under `policy-packs/` with `scope` added to both
  manifests; the CLI `check` writes only `build/check-report.json`, while `/thesis:check` and
  `/thesis:init` also write `compliance-profile.json`.
- Open (not encoded): second NTC 2022 citation source; ethics approval for human participants outside
  health (no national rule; institutions may add it); animals (Ley 84/1989) not researched; `mil.co`
  primary status; Sentencia C-748/2011 conditions on minors' data.

### 16.3 Phases 1–3 (2026-10-04, as built, uncommitted)

- Phase 1: 129 tests; `pnpm check` green through `pack:check` (`docs:check` pending Phase 7).
  Deviations: `presentation.standard: auto` without a rule derives the standard from the resolved
  citation style when a matching profile ships (marked as default); the conversation-language hint
  comes from `--lang` or `LANG` because commands do not receive the invoking message; title,
  authors and advisors may be empty with warnings (no round asks for authors/advisors); policy
  errors are `PCK-*`, with `POL-001` as a summary.
- Phases 2–3: 259 tests. Deviations accepted:
  1. The architect addresses sections by `key`/`children`/`requiredKey`; code assigns SEC ids and
     maps `dependsOn` keys.
  2. `protocol.md` front matter is authoritative; the body is a rendering.
  3. `resumen` or `abstract` satisfies one required section; template-generated sections (cover,
     contents) are not outline sections; `ai_declaration` is required when the profile requires it.
  4. `EVD-010` applies to theoretical-framework / state-of-the-art sections (the policy minimum is
     per framework, §16.2).
  5. Status mapping: books, chapters, reports, datasets and standards with a verified DOI →
     `VERIFIED_AUTHORITATIVE_GREY`; theses, preprints and other types → `CONTEXTUAL_ONLY`;
     `UNVERIFIED`/`REJECTED` go to `rejected.jsonl`, never the library.
  6. After a Crossref hit, OpenAlex `is_retracted` is also consulted; user-supplied official URLs
     use `URL; title; year; type`.
  7. Crossref requests queue (single-flight) rather than reject.
  8. Additions: `SEC-xx.json` dossier sidecar; `/thesis:approve SEC -- contextual EVD-…`;
     revising the protocol during the outline phase discards the derived outline.
- Open: the 24 h scholar resolve cache (§15) is not built yet.

### 16.4 Phase 4 (2026-10-04, as built, uncommitted)

- 4a: renderer port, neutral `ThesisDocument`, `typst-pdf` and test-only `test-json` adapters
  (import isolation enforced by a test), vendored mitex/merman, `/thesis:setup` with pinned SHA-256
  (also allows the `release-assets.githubusercontent.com` redirect host). Sample (10 pages) warm build
  ≈ 0.4–0.7 s; synthetic 338 pages with 40 Mermaid figures ≈ 5.4 s.
- 4b: Vega-Lite charts per P0.4 (codegen blocked, tested), palette-driven Mermaid themes, shipped
  `apa.csl`/`ieee.csl` and provisional note-based `icontec-ntc1486-2022.csl`, workspace styles and
  profiles with CSL-*/PRF-* checks, short captions in lists, run-in level-3/4 headings, `XRF-003`,
  24 h scholar cache. 443 tests with the engine.
- Deviations accepted: figure/table/equation numbers are computed by the emitter (Typst counters
  misnumbered forward references); `frontMatter` is a list of typed sections; chapter files carry YAML
  front matter (`role`, `section`, `lang`, `keywords`); shipped profiles are neutral YAML in
  `templates/profiles/*.profile.yaml` mapped only by the Typst adapter (strengthens §10.0); chapters
  map to `@inbook`; `urldate` emitted from `retrievedAt`; narrative citations in note styles become
  footnotes; CSL-010 runs in `style check` and builds of a selected workspace style; new codes
  BLD-002/003/004.
- Known defect handed to Phase 5: shipped APA prints "(2012,)" for law/standard/webpage/dataset
  under Hayagriva.

### 16.5 Phase 5 (2026-10-04, as built, uncommitted)

- Drafting with pre-write validation and one retry, editor diff guard (citations, cross-references,
  claim anchors, numbers, labels, math, link/image targets, footnote marks), independent review with
  verbatim-quote findings and routing, finalize with PDF/A-2b (`--pdf-standard a-2b`, verified
  `pdfaid` part 2 B, OutputIntent, embedded fonts) and `build/submission/` with a manifest;
  `/thesis:figure`, `/thesis:style new`, `/thesis:norms import`, interactive `/thesis:pack new`.
  546 tests with the engine.
- APA "(2012,)" fixed by a minimal date-macro patch; `styles/apa.csl` is a documented derivative.
- Deviations accepted: SectionDraft claims carry `kind`, `results`, `objectives`; figures placed
  with `[[figure fig-x]]`; chapter files `NN-slug.md` / `NNNN-slug.md`; abstract, AI declaration,
  dedication and acknowledgments need no research and abstracts are drafted last; the bibliography
  section is auto-approved at the OUTLINE gate; POL-AI-001, ETH-001 resolutions, CLM-004, CIT-003 and
  FIN-001 are warnings before the review phase and errors from it on; CLM-003 requires a `result`
  claim (an `argument` claim suffices for theoretical and systematic-review approaches); extra
  approve/revise targets `FND-x`, `ETH-…`, `norms`, `style:<id>`; finalize requires a fresh
  `/thesis:review all`; authoring drafts wait in `build/authoring/`; `style new` needs the engine.
- Open: guide URLs are fetched only through a host `web_fetch` tool (PDF guides rejected); a norms
  profile must still be selected in `thesis.yaml`.

### 16.6 Phase 6 (2026-10-04, as built, uncommitted)

- `chrome-pdf` (pipe transport by default, `ALISIO_THESIS_CDP=websocket` alternative, temporary
  profile, every request except `file://` under the build dir blocked) and `html-preview` adapters;
  shared HTML code in `src/render/html/`; numbering moved to the neutral `src/render/numbering.ts`
  used by both Typst and HTML. Vendored (MIT, hashes in THIRD_PARTY_NOTICES): Paged.js 0.4.3, KaTeX
  0.19.0 (+ fonts), Mermaid 11.16.1. Fallback build of the 12-page sample ≈ 1.0 s (≈ 3.8 s end to
  end with Chrome startup).
- Deviations accepted: KaTeX runs in Node in an isolated `vm` (math pre-typeset, no page script);
  `runtime.js` writes folios, TOC numbers and footnote numbers after pagination because Paged.js 0.4.3
  counters misnumber in current Chrome; CSS leaders; classes instead of `+` selectors; fallback and
  citation approximation reported as `BLD-004` warnings; PDF/A always requires Typst; a broken
  `ALISIO_THESIS_TYPST` falls back to Chrome with a warning; `ALISIO_THESIS_CHROME=off` disables the
  fallback; package-local `biome.json` excludes vendored files.
- Open: institutional fonts not wired into the Chrome CSS; Windows/macOS pipe transport not exercised.

### 16.7 Phase 7 and final verification (2026-10-04, uncommitted)

- Four diagrams (`architecture`, `lifecycle`, `evidence-pipeline`, `policy-resolution`) in
  `diagrams/plugin-thesis/` rendered to `packages/plugin-thesis/assets/`; `README.md` and
  `README.es.md` mirrored; site pages generated by `docs:scan`; cover `cover.webp` (owner art);
  changeset `plugin-thesis-initial` (minor → 0.1.0).
- Deviations accepted: `docs:scan` gained optional `readmeEs` support so `site/es/plugins/thesis.md`
  is generated from `README.es.md`; the cover test accepts `cover.webp`; package `biome.json`
  excludes `assets`.
- Final: repository `pnpm check` exits 0; `pnpm diagrams:check` passes; plugin tests 569/569 with the
  Typst 0.15.1 engine (540 + 29 engine-gated skips without it).
