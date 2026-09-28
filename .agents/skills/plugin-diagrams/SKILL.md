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
- Sources: `diagrams/<target>/*.mmd` at the repository root. Output: `packages/<target>/assets/*.svg` by
  default. The root split keeps sources out of the workspace glob (`packages/*`) and the published
  tarball. A default target needs a matching `packages/<target>` directory; a typo is an error.
- A target may render to a repository-level directory instead: place a `diagram.config.json` beside
  its sources declaring `{"output": "<dir relative to the repository root>"}`. Then no package is
  required and the SVGs go there. The declaration is explicit on purpose — there is no silent
  fallback and an output outside the repository is rejected. Repository-level diagrams live in
  `diagrams/repository/` and write the shared `assets/` directory; those SVGs are embedded from the
  root `README.md` / `README.es.md`, not from a package.
- Generated SVGs are never hand-edited. Change the `.mmd` source and re-render.
- Keep each diagram small, legible, and single-concept, with no decorative noise.
- Reference the SVG with a relative path, e.g. `./assets/<name>.svg`.
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
2. Author `diagrams/<target>/<name>.mmd`. For a repository-level output, also add
   `diagrams/<target>/diagram.config.json` with `{"output": "assets"}`.
3. Render one target with `node scripts/render-diagrams.mjs --plugin=<target>`, or all with `pnpm diagrams`.
4. Verify with `pnpm diagrams:check` (mtime-based; no browser needed).
5. Embed the SVG with a relative path and one sentence explaining it: in
   `packages/<target>/README.md` for a package target, or in the root `README.md` / `README.es.md`
   when `diagram.config.json` declares the repository-level output.
6. Commit the source, its config (if any), and its generated SVG in the same work unit.

## Output Contract

Report the source path, the config path (when repository-level), the rendered SVG path, the render
result, and the README reference.

## References

- `references/diagram-types.md` — minimal rendered syntax per type, the common pitfall, and version notes.
- `../../../scripts/render-diagrams.mjs` — renderer, browser detection, `--check`, `mermaid.config.json`
  look/theme support, and `diagram.config.json` repository-level output.
- `../../../AGENTS.md` — repository package rules.
