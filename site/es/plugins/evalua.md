---
title: "Evalua"
description: "Guides teachers through a short interview for printable school math exams and keeps the teacher profile, workspace and exam numbering."
pageClass: "plugin-detail"
---

<PluginDetail slug="evalua" />

Evalúa helps a teacher prepare printable school math exams through a short, guided interview, with
answers and distractors computed by code and a page budget that is measured, never guessed.

> Status: active development. The teacher profile, workspace and interview, the exact math core, the
> extensible knowledge base, item generation and verification, and the HTML/PDF rendering with the
> layout fit are implemented and tested. The end-to-end `/evalua:generate` and `/evalua:build`
> commands that read an approved exam folder are the remaining work.

## Install

```sh
alisio plugins install @alisio/plugin-evalua
```

Requires Node 22.16 or newer and `@alisio/sdk` `>=0.3.0 <0.7.0`.

## Basic usage

| Command | What it does |
| --- | --- |
| `/evalua:init [dir] [--edit]` | Creates the workspace (default folder `evalua/`) and asks for the teacher profile once. `--edit` re-asks with current values preselected. |
| `/evalua:new [topic]` | Runs the exam interview (topic, grade, level, item types, count, same exam or bank, columns, page limit, time, closing text). The profile is asked first only if `teacher.yaml` is missing. |
| `/evalua:status` | Shows the profile, any pending interview round, the exam draft and the exam folders. |
| `/evalua:kb` | Lists the knowledge base: packs, topics and levels. |
| `/evalua:doctor` | Reports the knowledge-base health and the available print browser. |

In a headless session the pending round is stored in the workspace state. Continue with
`/evalua:new id=value ...` (free text goes in `:text=...`).

Tools for agents: `evalua_profile` (get or set the profile), `evalua_answer` (answer the pending
round), `evalua_status` (read-only state as JSON), `evalua_kb` and `evalua_check` (read-only
knowledge base and checks).

A standalone CLI ships too:

```sh
alisio-evalua check    # the EVL-KB-* report
alisio-evalua kb       # packs, topics and levels as JSON
alisio-evalua doctor   # knowledge health and the print browser
```

## How it works

- **Exact math.** Answers and distractors come from exact rational arithmetic (BigInt fractions) and
  a small multivariate rational polynomial type; randomness is a seeded xoshiro128** so the same exam
  always rebuilds the same questions in the same order.
- **Extensible knowledge base.** Versioned YAML packs declare topics, level calibration and sources
  (item families or static bank items). A workspace pack in `/knowledge-packs/` extends or
  overrides a shipped one with no code change. The loader enforces `EVL-KB-001..007`.
- **Item generation and verification.** A deterministic blueprint (topic x cognitive demand x item
  type) drives candidates from families then bank, with a bounded redraw loop, de-duplication and
  stable references; `EVL-ITM-*` and `EVL-EXM-*` checks gate the result.
- **Rendering and fit.** A typed document model feeds a self-contained HTML emitter (server-side
  KaTeX inlined, no network) and Chrome-family `printToPDF`; a density ladder measures real page
  counts and picks the most legible preset that meets the budget, failing explicitly with
  `EVL-LAY-001` when it cannot.
- **Themes.** Three data-driven themes ship (`classic`, `blue`, `dark`), selected by
  `exam.yaml.template` and extensible from `templates/themes//`.
- **Closing texts.** A sourced catalogue (famous quotes and public-domain Reina-Valera 1909 verses)
  plus a workspace quotes layer for teacher-supplied texts; nothing is written from memory.

## Print browsers

PDFs need a Chromium-compatible browser; nothing is downloaded. Detection accepts Google Chrome,
Chromium, Brave, Microsoft Edge, Vivaldi and Opera on Linux, macOS and Windows, honouring
`ALISIO_EVALUA_CHROME`, `PUPPETEER_EXECUTABLE_PATH` and `CHROME_PATH`. Without a browser the build
still writes the self-contained, KaTeX-typeset HTML files and reports that page limits were not
verified.

## Workspace layout

```
<workspace>/
  .alisio/evalua/state.json     machine-owned state (atomic writes)
  evalua/
    teacher.yaml                teacher profile, safe to edit by hand
    assets/logo.png             optional logo (PNG, JPEG or WebP, up to 2 MB; SVG is rejected)
    knowledge-packs/            optional workspace packs (extend or override the shipped ones)
    quotes/                     optional teacher closing texts
    exams/NN-slug/              created only after the teacher approves the exam spec
```

Exam numbers are consecutive and never reused, even if a folder is deleted by hand.

## Profile fields

`teacherName`, `institution` (printed upper-case), optional `logo`, `subject` (default
Matemáticas), `language` (default `es`) and `paper` (`letter` or `a4`, default `letter`).

## License

MIT. Vendored KaTeX is MIT; see `THIRD_PARTY_NOTICES.md`.
