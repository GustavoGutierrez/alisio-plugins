---
name: fs-implement-ui
description: "Trigger: implementing one UI task contract: build order, test-first cycle and its exemptions, CSS layout rules, prevention of common conversion errors, and forbidden edits."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this when you implement a task of the ui layer. You receive one contract and write the code that satisfies it, nothing more.

## Hard Rules

- Read before you write: the spec excerpt, the UI contract excerpt, the plan entry and equivalent existing code.
- Stay inside the task's files and criteria. No unrelated refactors, no new dependency the plan does not list.
- Never edit references, tolerances, fixtures, masks, baselines, rule packs, waivers, the contract, or anything under `.frontsmith/`.
- Never weaken, skip or delete a test; never update a snapshot or baseline.
- Never invent decoration, icons, copy, assets or flows; never replicate a design with a background image; never replace an asset with an approximation.
- Never fix an overflow with `overflow-x: hidden`; find the cause.
- Report only what you ran. The coordinator re-runs your commands.

CSS layout rules: inspect the reset, cascade and existing component styles first; use `box-sizing: border-box` consistently; Grid for two dimensions and Flexbox for one; `minmax(0, 1fr)` and `min-width: 0` where content must shrink; absolute positioning only for deliberate overlap; express relations (max width, columns, gap, ratio, alignment), not accumulated offsets; no fixed heights on text blocks unless growth, truncation and expansion are defined; DOM order matches reading and keyboard order; fix family, file, weight, size, line height and letter spacing and wait for fonts; define minimum control widths, wrapping and long-word handling; define hover, pressed, focus-visible, disabled and loading where they exist; define layers, scroll owner and sticky behaviour and make sure focus is not hidden behind a header; version breakpoints and check the width before, at and after.

## Decision Gates

| Situation | Do this |
|---|---|
| Task requires test-first | Write the test, run it, keep the failing output, then implement, then keep the passing output |
| Task is exempt from test-first | Say so in the summary; rely on component, visual or accessibility checks named in the plan |
| The contract is wrong or incomplete | Return `needs_clarification` with the exact question |
| The task needs a file outside its list | Return `blocked`; do not widen the scope |
| A gate report from a previous bounce is attached | Fix exactly those findings first |

Prevention list (typical conversion errors): omitting or simplifying elements; positioning the page by coordinates; fixed heights with hidden overflow; shrinking everything proportionally for responsive; validating only the nominal width; visual order different from semantic order; arbitrary values instead of tokens; compensating a wrong font with padding; a `div` instead of a button; interactions that only look real; only the ideal state; removed focus; clipped modals; a mobile layout that deletes functions; a dark theme by inversion; contradictory CSS or dynamic class names; code that depends on libraries that are not installed; repeated markup with drifting variants; approving by self-description.

## Execution Steps

1. Locate and read the equivalent code; note tokens, primitives and patterns to reuse.
2. Build in this order: primitives and layout, semantic structure, data states, interactions, tokens and styles, responsive behaviour, focus and keyboard, non-happy states.
3. Follow the test-first cycle where required: failing test for one criterion, minimal change, nearby tests, refactor without changing behaviour, related suite.
4. Run the validation commands of the task, the cheapest first: nearby test, typecheck and lint of the area, the feature tests.
5. Compare with the contract: states, tokens, accessibility names, long content.
6. Write the task result.

## Output Contract

One task-result envelope: status, summary, changedPaths, commands with exit codes, testFirst evidence when required, acceptance with the files that satisfy each criterion, deviations, questions and new dependencies.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
