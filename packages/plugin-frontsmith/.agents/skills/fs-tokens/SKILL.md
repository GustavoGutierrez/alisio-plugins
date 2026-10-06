---
name: fs-tokens
description: "Trigger: designing design tokens in the tokens envelope: layers, naming grammar, theme resolution, required contrast pairs and catalog strategy; never colour values."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this in the tokens phase, or whenever token roles, names or themes must be decided. Input: the tokens the UI contract needs, existing token files, the styling approach and the palette families of the catalog.

## Hard Rules

- Never write colour values for new roles. A deterministic solver selects values from the catalog or answers unsatisfiable; you choose roles, families and constraints.
- Keep the project's existing vocabulary. Rename nothing just to adopt a convention.
- Name by function, not appearance or position: `--color-action-bg`, not `--blue-button` or `--left-box-color`. Primitives may carry a colour name.
- Required pairs are edges of a graph, never all pairs. Name only the foreground and background combinations that really occur, with the states they occur in.
- Contrast is evaluated on unrounded values at the configured target; a pair that fails is unsatisfied, never relaxed.
- A locked colour is an input the solver must respect; if it violates a pair the answer is unsatisfiable and a person decides.
- Never infer a dark theme by inverting a light one: roles are resolved per theme.

## Decision Gates

| Question | Answer |
|---|---|
| Project already has tokens | strategy `none` for existing roles, `catalog` only for new roles; reuse names |
| New project, no system | strategy `catalog`, family from the brief (identity first, then roles) |
| Brand colour is fixed | pass it as a locked value |
| Unsupported colour format in existing files | report it; the check will mark it for review |
| Component needs its own variation | add a component-layer token that points to a semantic one |

Layers: primitive or reference (`--ref-blue-600`, `--space-4`), semantic or system (`--color-bg-canvas`, `--color-text-primary`, `--color-action-bg`) and component (`--button-bg`). The flow is component, then semantic role, then value. Not every property needs all three layers.

Naming grammar: `--[namespace-][category]-[role]-[variant]-[state]`; omit segments you do not need and keep one order. States: hover, active, disabled, selected, invalid, focus. Use a namespace for embeddable libraries.

Dictionary: backgrounds `bg-canvas|surface|subtle`; text `text-primary|secondary|inverse`; links `link`, `link-hover`; actions `action-bg|fg|hover|active`; borders `border-subtle` (decoration) and `border-control` (functional boundary); `selection-bg|fg`; `focus-ring`; feedback `success|warning|danger|info` each as bg and fg; typography families, sizes, weights; spacing, radius, shadow, duration, easing; layers `z-header|popover|dialog`.

## Execution Steps

1. Inventory the tokens that exist and the ones the contract needs; mark each existing or new.
2. Decide the layer and name of each new role with the grammar above.
3. List the required pairs: text on canvas, surface and subtle; links; action foreground on action background and its states; selection and feedback pairs; control borders and focus ring on the three backgrounds. Mark each normal text, large text or non-text.
4. Choose the themes. Separate preference (`system`, `light`, `dark`) from the resolved mode (`data-theme`), brand and density; `system` is a policy, not a third palette.
5. Pick the generation strategy and the family; add locked values only for colours the project already owns.
6. Explain the choice in the rationale in plain words.

## Output Contract

One tokens envelope: namespace, roles, requiredPairs, themes, generation (strategy, family, locked) and rationale. The solver output, `tokens.json` and the theme CSS are produced by code.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
