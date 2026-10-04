# @alisio/plugin-thesis

![Thesis Studio](./cover.webp)

> Español: [README.es.md](./README.es.md). The two READMEs must be updated together.

Thesis Studio for Alisio. It interviews you, plans the research, researches each section into a
verified evidence library, drafts from approved evidence only, reviews the result independently and
typesets a university thesis in the language you choose. Deterministic code decides every gate it
can; child agents only propose. Policy comes from versioned, sourced packs, and your institution's
rules always win.

## Requirements

- Node.js 22.16 or newer and `@alisio/sdk` 0.3 to 0.6. No credentials are needed.
- PDF engine: run `/thesis:setup` once to install the pinned Typst into the cache (SHA-256
  verified). Without Typst, `/thesis:build` falls back to headless Chrome or Chromium, and
  `/thesis:build --html` needs neither.
- Research queries OpenAlex, Crossref and arXiv (fixed origins). Set `ALISIO_THESIS_CONTACT_EMAIL`
  to use their polite pools; it is read from the environment only and never stored or logged.

## Install

```sh
alisio install npm:@alisio/plugin-thesis
```

## Quickstart

```text
/thesis:init                 # create thesis/ and start the interview (language first)
/thesis:design               # draft research/protocol.md; approve Human Gates A and B
/thesis:outline              # draft outline/outline.json; approve the OUTLINE gate
/thesis:research SEC-03      # search, verify, appraise; read evidence/dossiers/SEC-03.md
/thesis:draft SEC-03         # write, edit and check the section; you approve it
/thesis:build                # build the PDF (or /thesis:build --html)
```

`/thesis:status` shows the phase, gates and the next step, and `/thesis:next` runs it. In a headless
session `/thesis:init` returns the questions with their options and the exact `/thesis:answer`
syntax: answers are `id=value` pairs separated by spaces or new lines, or one JSON object; free text
goes in `<id>:text=...`.

## Architecture

![Architecture](./assets/architecture.svg)

Commands, tools and the CLI reach one TypeScript coordinator. It runs read-only child agents, accepts
only validated JSON, writes every file itself, runs the checks and hands a neutral `ThesisDocument`
to the renderer port. A future DOCX adapter is planned and is not shipped.

## Lifecycle

![Lifecycle](./assets/lifecycle.svg)

The thesis moves from intake and design through three human gates to a per-section loop, then
review, finalization (Human Gate C) and a PDF/A build.

### The per-section loop

1. `/thesis:research SEC-id`: search, verify, appraise; you validate the dossier.
2. `/thesis:draft SEC-id`: the writer receives only citable evidence and returns Markdown with claim
   anchors. Code validates citation keys, anchors, labels and figures, writes `chapters/NN-slug.md`
   and `claims/claims.jsonl` and runs the checks. The editor then changes wording only: code compares
   citations, claim anchors, numbers, labels and math before and after and rejects any change. You
   approve, ask for a revision or go back to research. Approval builds the approved sections.
3. When every section is approved the thesis enters review: `/thesis:review all`, fix or dismiss
   findings, then `/thesis:finalize`.

Abstracts are drafted last; the AI-use declaration, dedication and acknowledgments need no research;
the bibliography is generated from the library.

## Commands

| Command | Purpose |
| --- | --- |
| `/thesis:init [dir] [--lang <bcp47>] [--presentation]` | Create the workspace and run the interview |
| `/thesis:answer -- <id=value ...\|json>` | Answer pending interview questions headlessly |
| `/thesis:status` | Phase, gates, sections and the next step |
| `/thesis:next` | Run the next recommended step |
| `/thesis:check [gate...]` | Run deterministic checks, write `build/check-report.json` |
| `/thesis:design`, `/thesis:outline` | Draft the protocol or the outline and ask the human gates |
| `/thesis:approve <target> [-- notes]` | Record an approval: `A`, `B`, `OUTLINE`, `C`, `SEC-id`, `FND-id`, `ETH-id`, `norms`, `style:id` |
| `/thesis:revise <target> -- <feedback>` | Send feedback to the role that owns the target |
| `/thesis:research <SEC-id\|next> [-- ...]` | Research a section; `-- add <DOI or URL; title; year; type>` verifies a source you have |
| `/thesis:draft <SEC-id\|next> [-- feedback]` | Draft, edit, check and ask for approval |
| `/thesis:figure <SEC-id> -- <request>` | Draft a chart, diagram or table (returns Markdown to insert) |
| `/thesis:review [SEC-id\|all]` | Independent review; findings go to `reviews/FND-*.json` |
| `/thesis:finalize` | G9 and G10, Human Gate C, PDF/A build, `build/submission/` |
| `/thesis:build [full\|approved\|SEC-id] [--pdfa] [--html]` | Build the PDF or the HTML preview |
| `/thesis:setup` | Install the pinned Typst engine (checksum verified) |
| `/thesis:pack new\|list\|check\|explain` | Create, list, check and explain policy packs |
| `/thesis:style new\|list\|check` | Author, list and check citation styles and profiles |
| `/thesis:norms import -- <guide text\|URL\|path>` | Turn a guide or rubric into a workspace pack (you approve it) |
| `/thesis:doctor` | Report engines, vendored packages and packs; changes nothing |

Arguments use `<target> -- <text>`. Guide URLs are fetched only through a host `web_fetch` tool.

## Tools

| Tool | Purpose |
| --- | --- |
| `thesis_scholar_search` | Search OpenAlex, Crossref or arXiv |
| `thesis_scholar_resolve` | Resolve a DOI or identifier to a scholarly record |
| `thesis_status` | Summarize the workspace |
| `thesis_check` | Run the deterministic checks |
| `thesis_build` | Build the thesis |

## CLI

```sh
alisio-thesis check [dir] [--json] [--gate G0,G7] [--no-write]
alisio-thesis build [dir] [full|approved|SEC-id] [--pdfa] [--json]
alisio-thesis bib [dir] [--check]
alisio-thesis doctor [--json]
alisio-thesis style list|check [dir] [--json]
```

`check` exits 0 when no check fails, 1 when a check fails and 2 on usage or environment errors, so it
works in CI and git hooks.

## Workspace layout

```text
thesis/
  thesis.yaml              # project brief (human-editable)
  compliance-profile.json  # resolved rules with their ruleId trail
  research/protocol.md     outline/outline.json
  evidence/                # library.jsonl, rejected.jsonl, search-log.jsonl, dossiers/
  claims/claims.jsonl      bibliography/references.bib   (generated, never hand-edited)
  chapters/  chapters/annexes/
  figures/{charts,diagrams,images}/   data/
  styles/                  # workspace .csl, .profile.yaml, fixtures/
  policy/  policy-packs/   # simple overrides and workspace packs
  reviews/FND-*.json
  build/                   # generated, git-ignored: PDF, HTML, check report, submission/
.alisio/thesis/state.json  # lifecycle state
```

## Markdown dialect

| Construct | Syntax |
| --- | --- |
| Section label | `## Methodology {#sec-methodology}` |
| Citation | `[@perez2021]`, `[@perez2021, p. 17]`, `[@a2020; @b2021]`; narrative `@perez2021` |
| Cross-reference | `@fig-x`, `@tbl-x`, `@eq-x`, `@sec-x` |
| Math | inline `$x^2$`; display `$$ ... $$ {#eq-x}` |
| Figure | `![Caption. Source: ...](figures/charts/x.vl.json){#fig-x width=100%}` (`.vl.json`, `.mmd`, `.svg`, `.png`, `.jpg`) |
| Table | GFM pipe table followed by `Table: Caption {#tbl-x}` |
| Footnote | `[^1]` |
| Claim anchor | `<!-- claim:c3 -->` at paragraph start (consumed by checks) |

Raw HTML, raw Typst and unknown attributes are `HYG-001` errors. Charts are Vega-Lite specs whose
`data.url` names a `.csv` or `.json` file under `thesis/data/`; the plugin renders them itself with
palette-driven colors. Mermaid diagrams take a theme generated from the palette.

## Languages

The thesis is written in any BCP-47 language you choose. Generated labels (cover, headings, captions)
ship in English and Spanish; other languages use the English labels. `LNG-001` detects English,
Spanish, Portuguese and French. A second-language abstract is optional.

## Citation styles, workspace styles and profiles

Shipped CSL styles: `apa-7`, `ieee` and a provisional `icontec-ntc1486-2022` (numbered footnotes with
Ibid./Op. cit.; no official CSL exists, so confirm it with your program). Put your own `<id>.csl` and
`<id>.profile.yaml` in `thesis/styles/` and select the id in `thesis.yaml`. Profiles are declarative
YAML with a closed schema (`extends` a shipped profile, then override margins, fonts, headings,
captions, page numbers, cover); unknown keys fail `PRF-001`. `/thesis:style check` validates them
(`CSL-001`, `PRF-001`, `CSL-010`). `/thesis:style new` drafts a style from a guide and asks you to
approve it first.

## Policy packs

![Policy resolution](./assets/policy-resolution.svg)

Shipped `global` and `CO` packs and your workspace packs and simple overrides feed one resolver. It
orders rules by level and scope, replaces a shipped rule only with `overrides: true` and records the
`ruleId` trail of every value in the compliance profile.

Extend it without modifying the plugin. Add packs under `thesis/policy-packs/` (`international/`,
`countries/`, `institutions/<CC>/<slug>/` with `faculties/` and `programs/`, `writing/`), each with a
`manifest.yaml` (`packId`, `scope`, `version`, optional `appliesWhen` and `extends`). `/thesis:pack new
<scope> <id>` scaffolds a commented pack, `/thesis:pack check` validates it (`PCK-001` to `PCK-004`,
`PCK-010`) and `/thesis:pack explain <ruleId|value>` prints a resolution trail. For simple overrides
without a manifest, put rule files in `thesis/policy/` (`institution.yaml`, `faculty.yaml`,
`program.yaml`, `rubric.yaml`, `writing-*.yaml`). Rules marked `basis: secondary_source` should be
confirmed with your program.

## Evidence

![Evidence pipeline](./assets/evidence-pipeline.svg)

Candidates from the scholarly sources are verified by code (DOI resolution, title similarity,
retraction status, official domains) before an auditor appraises them. Only library records can be
cited, and rejected candidates stay in `evidence/rejected.jsonl`.

## Deterministic checks

Checks are pure functions grouped in gates G0 to G10: brief and policy (`BRF`, `POL`, `CSL`, `PRF`),
design and outline (`DSN`, `OUT`), evidence (`EVD`), citations and claims (`CIT`, `CLM`), cross-references,
figures and math (`XRF`, `FIG`, `MTH`), language and writing (`LNG`, `WRT`, `HYG`), ethics and AI use
(`ETH`, `POL-AI`), build (`BLD`), review (`REV`) and finalization (`FIN`). Run `/thesis:check` or
`alisio-thesis check`.

## Without Typst

`/thesis:build` prefers the pinned Typst. When none is available it falls back to headless Chrome or
Chromium (`ALISIO_THESIS_CHROME` selects a binary, `off` disables the fallback) and warns that the
layout differs: citations use a built-in approximation of the selected style, and PDF/A needs Typst.
`/thesis:build --html` writes `build/thesis.html`. Everything the page uses is vendored; Chrome runs
with a temporary profile and every network request blocked.

## Agents and skills

Eight read-only agents (coordinator, methodologist, librarian, evidence auditor, architect, writer,
editor, reviewer) and fifteen focused skills ship in `.agents/`. Only the coordinator code writes
files.

## Security

- Every user- or child-supplied path stays inside the workspace; child output is untrusted JSON,
  validated and capped.
- No shell: processes use argv arrays and timeouts. Typst runs with its root set to the build
  directory, never from raw Typst in Markdown, and only vendored packages.
- Vega runs with `vega-interpreter` (no code generation) and reads only `thesis/data/`.
- Network use is limited to the scholarly origins, the `/thesis:setup` release download and host tools.
- State and generated files are written atomically with restrictive modes.

## Licensing

MIT. Vendored Typst packages, browser libraries (Paged.js, KaTeX, Mermaid) and their licenses are
listed in `THIRD_PARTY_NOTICES.md`. The `apa.csl` and `ieee.csl` styles come from the Citation Style
Language repository under CC BY-SA 3.0; `apa.csl` is a documented modified derivative (a date-macro fix)
and keeps the same license. Policy-pack rules cite their sources.
