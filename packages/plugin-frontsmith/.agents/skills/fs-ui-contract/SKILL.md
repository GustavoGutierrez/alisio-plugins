---
name: fs-ui-contract
description: "Trigger: writing the UI contract envelope from a spec and design references: state matrix, viewports, elements, fidelity rules with provenance, masks and tolerances."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this in the ui-contract phase. Input: the approved spec, the reference inventory and its metadata, the token and component inventories, and the mode (replicate, refine, redesign or build). Output: a ui-contract envelope.

## Hard Rules

- A reference image is not a specification. Record its original size, export scale, CSS viewport, theme and state; a 2880 px export at 2x is 1440 CSS px, not 2880.
- Label each fidelity rule's provenance: specified, measured, inferred or pending. A rule that blocks acceptance must not be pending.
- Never state an exact font family from a screenshot; say it is pending until a font file or a token names it.
- Masks hide volatile content only. A mask never covers a call to action, an error, a label or any content a person needs.
- Mode replicate needs at least one reference file; without it, say so as a question.
- Every state of the spec has a row in the state matrix, and every row names the test level that will verify it.
- Tolerances come from a source (the design system, a measured uncertainty, a stated product choice), never from a wish for green.
- No business rules in the contract.

## Decision Gates

| Question | Answer |
|---|---|
| Value read from a design file | specified |
| Value you measured on a capture | measured, with the uncertainty in the requirement text |
| Value you deduced | inferred |
| Value nobody can tell | pending, plus an open question when it blocks |
| Element has no accessible name | Use a test id locator and flag the missing name as a question; avoid CSS locators |
| Two references disagree with the contract | Do not choose silently; ask |

Vocabulary to turn adjectives into data: hierarchy (title 28/36, one primary action), grid (columns, gutter, max width), gap versus padding, alignment (shared edge), baseline, proximity (label to field 8, field to next group 24), density (row 48, padding 12), leading, tracking, measure, affordance, feedback, intrinsic sizing, focal point. "Modern", "clean" or "premium" are directions, never specifications.

## Execution Steps

1. List surfaces (id, route, purpose: operate, decide, read or explore).
2. Build the state matrix: state, trigger, UI, actions, accessibility notes, test level.
3. Choose viewports from the breakpoints: one width below, at and above each breakpoint, and a 320 px reflow check.
4. Give every element that matters a stable id and an accessible locator (role and name, then label, then test id).
5. Map design components to existing code components; mark each reuse, extend or new.
6. Write interactions with keyboard behaviour and the focus order.
7. Write fidelity rules: geometry (x, y, width, height), relations (gaps, alignments, columns), typography, colour, content, assets, overflow, regions and focus. Each has a property, expected value, unit, tolerance, severity, provenance and verification method.
8. Declare regions for pixel comparison, masks with reasons, cases (surface, state, viewport, theme, setup) and the tokens needed.
9. Link each reference file to a case.

Responsive rule format: "The actions block becomes one column up to 599 px inclusive; from 600 px it shares the row with the title and the title may grow without overlapping it."

Interpretation rule: a layout is a set of relations (columns, gap, alignment, proportion), not coordinates copied from a picture. The contract expresses relations; the code realises them with flow.

## Output Contract

One ui-contract envelope. The code adds render defaults, the unknown-background policy, allowed origins and calibration settings itself after validation; do not emit those keys.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
