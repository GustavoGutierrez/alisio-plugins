---
name: fs-fidelity-review
description: "Trigger: reviewing the visual-fidelity report: metric meanings, verdict semantics, classifying review items, ordering repairs by cause and never turning a failure into a pass."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this when the fidelity report has failures or review items. You explain and order; the numbers decide.

## Hard Rules

- You never emit a pass. Aggregation is code: any failure fails, missing evidence blocks, review items need a decision.
- A failure may be classified only as a defect or as needing a human. Only review items may be classified as an acceptable variation or as a conflict with the reference.
- Never ask to change a reference, a baseline, a tolerance or a calibration to make a failure disappear.
- Never diagnose a design as machine-made; describe the observable difference.
- You may open the evidence images, but you cannot rely on seeing them: the report numbers are the source. If an image is not delivered to you, say so and continue with the numbers.
- A repair that makes another metric worse is a bad repair; say which metric it worsens.

## Decision Gates

Metric meanings:

| Metric | Meaning |
|---|---|
| geometry error | largest absolute difference among x, y, width and height of an element, in CSS pixels; always read the vector, not only the maximum |
| relation error | difference in a gap or alignment between two elements, compared with the reference relation |
| typography and colour | exact comparison of resolved values after normalisation |
| line count | approximate (client rectangles grouped by line); a mismatch is a review item |
| region difference | share of differing pixels in a region, excluding masked pixels |
| local density | the largest share of differing pixels in any small window; separates a concentrated defect from scattered noise |
| largest component | area of the biggest connected group of differing pixels |
| overlap and overflow | critical elements covering each other or the page overflowing horizontally |

Verdicts: PASS only when every required rule passed; FAIL when any rule failed; BLOCKED when a required case or oracle is missing; REVIEW when everything ran and a discrepancy needs a decision. A visual region without calibration can only be review. An unseparable region (noise as large as the smallest defect) stays review until the environment is stabilised; raising a tolerance is not a fix.

Repair order: environment and assets (fonts, images, loading), container and geometry, typography, spacing, colour and detail, states. Fix a root cause once and rerun what it affects, then the whole matrix.

## Execution Steps

1. Read coverage first: what ran, what is pending.
2. Group failures by root cause (a wrong container width explains many children).
3. For each review item decide: acceptable variation, conflict with the reference, defect, or needs a human, with a one-line rationale.
4. Build the repair plan: ordered steps, each with the cause, the files and the finding ids it should fix.
5. Add design-direction notes only when a documented signal applies; keep them out of the repair plan.

## Output Contract

One fidelity-review envelope: classifications per finding id, an ordered repairPlan and optional designCritique entries (advisory).

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
