---
name: thesis-figures
description: "Trigger: figures, charts, diagrams, tables, Vega-Lite, Mermaid, palettes, chart type by intent, accessibility, grayscale print."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when drafting or reviewing a chart, a Mermaid diagram or a table for a section.

## Hard Rules

- Choose the form by intent: comparison, bar; trend over time, line; distribution, histogram or box plot; relationship, scatter; composition, stacked bar (pie only for 3 parts or fewer); process or architecture, Mermaid flowchart; timeline or plan, Mermaid gantt; interactions, sequence diagram; data model, ER diagram; lifecycle, state diagram.
- Charts are Vega-Lite JSON specs (`figures/charts/*.vl.json`) with data in `thesis/data/` (`"data": {"url": "file.csv"}`, a plain `.csv` or `.json` file name under `data/`) or inline `data.values`. Only plain marks (bar, line, point, area, circle, square, tick, rect, rule, text, arc, trail) and one `layer` level are supported; no `href`, `url` fields, `image` marks, `lookup`, tooltips or `config` (FIG-001/FIG-002). Use ordinal or nominal types for years. The caption must end with a `Source:` sentence (FIG-004). Do not set colors, fonts or sizes: the build injects them from the palette and font profile (a spec that sets them fails FIG-003).
- No 3D, no dual axes, no truncated bars. Label axes with units. Use redundant encoding (marker shape or dash) so the figure survives grayscale print. At most 7 categories before grouping.
- Palettes (in `templates/palettes.json`): `okabe-ito` (default, color-blind safe), `tol-bright`, `tol-muted` (many categories), `tol-high-contrast` (grayscale-safe, at most 3 series), `viridis` and `cividis` (sequential only). Use the one in `brief.presentation.palette`.
- Size figures to the text block width or half of it. Every figure and table has a caption with its source and attribution; table captions go above, figure captions below. Reference each one in the text with `@fig-id` or `@tbl-id`.
- Labels follow `fig-...`, `tbl-...`, `eq-...` with lowercase letters, digits and hyphens. Code validates and de-duplicates them.
- Never plot invented or smoothed data. Report what the file contains. If the data is missing, ask for it.
- Mermaid diagrams use the neutral or grayscale theme from the brief; do not set colors in the diagram. Keep nodes under 12 words and diagrams under 15 nodes.

## Decision Gates

| Situation | Action |
| --- | --- |
| Comparing a few groups | Bar chart sorted by value, zero baseline |
| Showing change over time | Line chart with markers; one series per color and dash |
| Many categories | Group the tail into Other or use a table |
| Exact values matter | Use a table, not a chart |
| The data is sensitive | Aggregate or anonymize before plotting; ask the user |

## Execution Steps

1. State the message of the figure in one sentence.
2. Pick the form from the intent table; if none fits, use a table.
3. Write the spec or diagram source and the caption with its source line.
4. Check axes, units, categories and redundancy for grayscale; reference the figure in the text.

## Output Contract

Return a `FigureDraft`: `label` (`fig-...` for charts and diagrams, `tbl-...` for tables), `kind` (`chart`, `diagram` or `table`), `spec` (a Vega-Lite object whose `data.url` is a file of `thesis/data/`), `source` (Mermaid) or `table` (a GFM pipe table), a one-line `caption` without brackets that ends in `Source: ...` (Fuente: / Fonte:), optional `width`, and `supports`: the sentence it supports. Code runs the FIG checks and rejects colors, fonts, unknown files and a missing source line.

## References

- `../../../README.md`
- `../thesis-writing/SKILL.md`
- `../thesis-math/SKILL.md`
