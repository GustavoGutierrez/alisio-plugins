---
name: plugin-diagrams
description: "Trigger: mermaid diagram, diagram svg, render diagram, README image, diagram type. Choose a Mermaid diagram type, author it, and render it to SVG in the shared repository layout."
license: Apache-2.0
metadata:
  author: "alisio-contributors"
  version: "1.1"
---

## Activation Contract

Load this skill before choosing a diagram type, authoring, updating, or rendering any Mermaid diagram or generated SVG.

## Hard Rules

- Author diagram labels in ENGLISH by default. Use another language only when explicitly requested; identifiers,
  file names, code, and paths stay English.
- Sources: `diagrams/<plugin-name>/*.mmd` at the repository root. Output: `packages/<plugin-name>/assets/*.svg`.
  The root split keeps sources out of the workspace glob (`packages/*`) and the published tarball.
- Generated SVGs are never hand-edited. Change the `.mmd` source and re-render.
- Keep each diagram small, legible, and single-concept, with no decorative noise.
- Reference the SVG from the package README with a relative path, e.g. `./assets/<name>.svg`.
- Toolchain: `@mermaid-js/mermaid-cli@12.0.0` is the lowest CLI rendering all ten types (`usecase-beta` needs
  Mermaid 12). An optional `mermaid.config.json` beside the sources sets look/theme; Wayfinder pins
  `look: classic` because Mermaid 12 changed the default look.

## Decision Gates

| Type | Use it for (recommended when) | Do NOT use for (use instead) |
| --- | --- | --- |
| `flowchart` | Processes, pipelines, decisions | Time-ordered messages (`sequenceDiagram`) |
| `sequenceDiagram` | Ordered interaction between actors over time | Branching business logic (`flowchart`) |
| `classDiagram` | Object models, type structure, interfaces | Database schemas (`erDiagram`) |
| `stateDiagram-v2` | An entity's lifecycle and legal transitions | Service topology (`flowchart`, C4) |
| C4 (`C4Context`…) | Architecture at a stated level (context/container/component/dynamic/deployment) | Code-level detail (`classDiagram`) |
| `erDiagram` | Relational data models and cardinality | Application architecture (C4, `flowchart`) |
| `usecase-beta` | Actors, system scope, functional requirements | Implementation flow (`flowchart`) |
| `gantt` | Schedules and dependencies over calendar time | Effort estimation without dates (`mindmap`) |
| `mindmap` | Exploring and decomposing ideas | Precise technical relationships (`flowchart`, `classDiagram`) |
| `gitGraph` | Branching, merge, release strategy illustration | Dumping real repository history (link the repository instead) |

## Execution Steps

1. Pick the type from the table, then read `references/diagram-types.md` for minimal syntax.
2. Author `diagrams/<plugin>/<name>.mmd`.
3. Render one plugin with `node scripts/render-diagrams.mjs --plugin=<plugin>`, or all with `pnpm diagrams`.
4. Verify with `pnpm diagrams:check` (mtime-based; no browser needed).
5. Embed the SVG in `packages/<plugin>/README.md` with one sentence explaining it.
6. Commit the source and its generated SVG in the same work unit.

## Output Contract

Report the source path, the rendered SVG path, the render result, and the README reference.

## References

- `references/diagram-types.md` — minimal rendered syntax per type, the common pitfall, and version notes.
- `../../../scripts/render-diagrams.mjs` — renderer, browser detection, `--check`, config support.
- `../../../AGENTS.md` — repository package rules.
