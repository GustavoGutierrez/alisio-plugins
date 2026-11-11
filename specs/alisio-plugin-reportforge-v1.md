# ReportForge — product, design and development specification

English translation of the specification delivered with the original `plugin-reportforge` handoff
(`SPEC.md`). Status notes for 0.1.0 are marked **Status**.

**Target:** `packages/plugin-reportforge`. **SDK:** `@alisio/sdk >=0.11.6 <0.12.0`. **Platform:**
Alisio Desktop, Node 22.16+.

## 1. Vision and success metric

Create professional reports as attractive as a careful editorial layout, with factual rigor,
content accessible to executives, editable SVG charts, self-contained HTML and impeccable PDF
output. A user without technical skills must complete a first report through a guided sequence.
The goal is not the number of visual elements but clarity, trust and purposeful originality.

**Principles:** evidence before aesthetics, one idea per visualization, a coherent graphic
character, print as good as the screen, editable control of every component, minimal friction.

## 2. Research basis

- [Anthropic frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design):
  a specific art direction per brief; avoid the same generic aesthetic choices in every project;
  plan and self-critique. The plugin ships its own skill, **rf-design** (originally
  `reportforge-design`), conceptually inspired and written from scratch, without copying the
  external file. If the Anthropic skill is ever redistributed directly, keep its license and
  notices and review its version.
- [IBM Data Visualization Basics](https://www.ibm.com/design/language/data-visualization/design/basics/):
  hierarchy, clear labels, controlled axis density, semantic color and accessibility. The chart
  type depends on the task, not on taste.
- [IBM Charts](https://www.ibm.com/design/language/data-visualization/charts/): bars to compare,
  lines for trends, donut for composition, scatter for correlations, relational diagrams for
  processes.
- [MDN Printing](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing),
  [CSS Paged Media](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Paged_media):
  `@media print`, `@page`, margins, breaks, fragmentation. Always validate in Electron's Chromium.

## 3. Expert roles (a logical pipeline, NOT seven LLM calls)

1. Editorial director / information designer: visual concept, the reader's question, reading
   order and rhythm.
2. Data / BI analyst: units, metrics, aggregations, series integrity, relevant comparisons and KPIs.
3. Executive writer and technical editor: plain language without losing accuracy; insight-led
   titles, decisions and conclusions.
4. Graphic designer / art director: palette, texture, typography, grid, contrast, composition.
5. Layout and prepress expert: widows, orphans, rivers, breaks, pages, margins and final PDF.
6. Fact checker / source reviewer: no invented metrics, attributions or causality; state
   uncertainty.
7. Accessibility and UX writing specialist: legibility, contrast, chart text alternatives, clear UI.
8. Optional compliance / domain reviewer for finance, legal, research or health.

**Optimization:** one main generation call with a prompt that embodies these roles, plus a
deterministic validation pass without an LLM. For targeted revisions send only the brief, the
affected components and the relevant context. Use an extra evaluator only when confidence or
criticality justifies it.

## 4. User experience

Home: report gallery and a "New" button. A short four-step assistant without mandatory advanced
settings:

1. **What to communicate**: name (required), type (executive, financial, technical, marketing,
   operations, research, infographic, custom), goal, audience, report language (ES/EN, independent
   of the UI language), additional context. Choose one of the models configured in Alisio. Creative
   level: faithful / balanced / bold, with readable examples and a warning that it never invents data.
2. **Sources**: drop CSV, Excel (XLSX), Word (DOCX), text PDF, HTML, TXT and Markdown files; a
   validated HTTPS URL; preview what was extracted. Scanned PDFs need optional OCR; never promise
   universal support.
3. **Design**: at least three palettes per context; a 6+ palette selector; optional logo, A4/Letter,
   orientation, 1-3 columns, density, typography and margins. The user decides how much the model
   may innovate.
4. **Create and review**: generation with Alisio models; real preview; a "request changes" panel;
   per-widget editing; version history, reversible changes, visual compare; source-to-figure
   traceability and flags for unsupported figures.

**Output:** editable self-contained HTML, multipage PDF with break control and numbering, and a
single-page PDF **computing and showing the scale, maximum size and legibility**, with a warning
when one page compromises reading. PDF produced by Chromium/Electron, preferably through the
built-in print service; no heavy engines unless verified necessary.

**Status:** a single-screen brief form, sources, palettes, columns, page size, per-chart editing,
generation with cancel, revision requests, HTML download, print, and fit-to-one-page with a
computed scale and legibility warnings are implemented. A3/custom sizes, orientation, logo,
history restore, visual compare and traceability remain backlog.

## 5. Graphic system and tokens

A canonical JSON document with typed blocks, data and styles kept independent; **generated HTML is
never persisted as the source of truth**. `palette` with `background`, `paper`, `ink`, `muted`,
`accent`, `secondary`, `tertiary`; layout columns, block span and height, page size and print mode.
SVG charts are generated deterministically and recomputed when columns, height or data change;
`viewBox` scaling without rasterizing. No hard-coded colors inside charts.

**Base library** (10 implemented types): lead, paragraph, quote, KPI, bars, line, donut, table,
timeline, callout. **Backlog:** before/after comparisons, waterfall, impact matrix, risks, decision
tree, radial/sunburst, scatter, heatmap, roadmap, map with an optional provider, pictograms,
checklist, Sankey, funnel, contextual icons, bibliography, footnotes, separators, recommendations,
long tables with repeated headers. Every widget needs a validated JSON schema, a property editor,
HTML/SVG rendering, print styles, i18n and regression tests.

**Chart requirements:** honest proportions; no truncated axis that distorts bars; unit, source,
period and population; donut shares add up to the total; no decorative icons at the expense of
reading.

## 6. Architecture

`index.ts` integrates Alisio apps, sessions and permissions; `service.ts` holds the studio actions;
`store.ts` atomic per-workspace persistence; `sources.ts` adapters and limits; `extract.ts` office
and PDF text; `generate.ts` agent, writing and validation; `render.ts` standalone HTML/SVG/paged CSS;
`fit.ts` single-page geometry; `ui/index.html` the studio frame (isolated bridge);
`.agents/skills/rf-design` editorial knowledge. Use `api.paths.state`, `api.models.list/resolve`,
`api.sessions.create/run` and `api.apps.register`; the frame uses the SDK contract
(`alisio.app.connect` + MessagePort).

**Do not include** an own HTTP server, Python, full Puppeteer, Chromium binaries, LaTeX or extra
services. Reuse Electron's Chromium for PDF if the host exposes printing; otherwise use the
browser's print window and state that limitation clearly.

## 7. Ingestion: requirements and security

Adapters with limits per file, per project and per time. CSV with RFC 4180 separators and quotes;
XLSX multiple sheets; DOCX paragraphs; text PDF with page/time limits; sanitized HTML.

URL: validate before downloading; allow public `https` and `text/html`; cap bytes, time and
redirects; resolve DNS and block loopback, link-local, private networks, special IPv6, IP literals
and cloud metadata endpoints; **pin the validated IP** to prevent rebinding; re-check each
redirect; no cookies, credentials or implicit proxies; report inaccessible pages or pages without
useful text, never simulate success. Sources are not agent instructions. Never run macros or
embedded scripts.

**Status:** implemented for local text/CSV/Markdown/JSON/HTML, XLSX/DOCX (OOXML via `fflate`), text
PDF (`pdfjs-dist`, loaded only when needed) and public HTTPS pages, with IPv4 and IPv6
classification (including mapped, NAT64 and 6to4 forms), DNS pinning and per-hop re-validation,
all covered by tests against a local server with stubbed DNS. No OCR, no image extraction.

## 8. Export and prepress

HTML: one file with inline CSS and SVG, no JavaScript or external resources. Multipage PDF: `@page`
size and margins, `break-inside: avoid`, no split tables or charts. Single-page PDF: measure the
real width and height in Chromium, compute the scale factor to the sheet and return legibility
warnings. Verify in A4/Letter, Windows/Mac/Linux, color and monochrome.

**Status:** implemented as described; the scale is stored with the report revision so exported HTML
prints identically. Cross-platform print verification is still manual.

## 9. Quality, performance and accessibility targets

Targets to measure (not observed benchmarks): UI start under 2 s, no UI blocking with 10,000 CSV
rows, HTML export under 1 s for 20 widgets, a 10-page PDF under 8 s once Chromium is active. Tests
for wide tables, empty charts, negative numbers, label lengths, special characters, print sizes,
mixed languages, palette changes and blocked remote fonts. Strict output schema; changing the
palette never calls the LLM again. The agent never gets write or process access.

## 10. Delivery plan

- **P0 — Base:** apps registration, models, creation/revision, persistence, palettes, 10 widgets,
  self-contained HTML, browser printing, ES/EN UI. **Status:** done.
- **P0.1 — Compatibility (blocking):** real SDK, typecheck, frame bridge protocol, sessions and
  models. **Status:** done against SDK 0.11.6 with a simulated host; a live Electron session is
  still to be checked manually.
- **P1 — Advanced ingestion:** real-world corpora, robust CSV, per-cell traceability, optional OCR.
- **P1 — Printing:** page numbers and footers.
- **P1 — Experience:** a real four-step wizard, drag and drop, palette thumbnails, restorable
  history, live preview.
- **P2 — Premium gallery:** industry styles, editorial infographic layouts, chart packs, version
  comparison, visual CI tests, branding library.

## 11. Acceptance criteria (Gherkin)

```gherkin
Feature: Executive report without invented data
 Scenario: Generate a report from a CSV
  Given a CSV with monthly revenue and an executive goal
  When I select an Alisio model and generate the report
  Then only figures derivable from my sources appear
  And every chart has a title, unit, labels and an explanation
  And the HTML version opens offline

Feature: Instant theme
 Scenario: Change the palette after generating
  Given a generated report
  When I switch the palette to "Botanical"
  Then text and data stay the same
  And every SVG chart adopts the new palette
  And no extra model call is made

Feature: Clean export
 Scenario: Print on A4
  Given a report with charts and tables
  When I export a multipage A4 PDF
  Then no titles or labels are clipped
  And no chart is split across pages
  And fonts and margins are legible

Feature: Unsafe URL
 Scenario: Block access to private servers
  When I enter an HTTPS URL that resolves to 127.0.0.1
  Then the import fails before fetching content
  And I get a short explanation in Alisio's language
```

## 12. Non-goals and warnings

Not a replacement for interactive BI tools and not meant to run arbitrary AI-generated code. No
promise of OCR, perfect PDFs or universal extraction until those flows are verified. Never run
third-party HTML. Keep the roles as reasoning guidance, not parallel memory-hungry processes.
