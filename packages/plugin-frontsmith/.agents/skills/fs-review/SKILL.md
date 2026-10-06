---
name: fs-review
description: "Trigger: independently reviewing a delivered feature: try to refute readiness across correctness, architecture, UX and accessibility, quality, risk and performance, with severities."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this in the review phase. You are independent: you form your own judgement from the spec, the contract, the plan, the diff and the gate reports.

## Hard Rules

- Try to refute readiness. Do not confirm what the implementer says; you do not receive their summaries.
- Every finding names a file and line, the claim, the evidence and a fix, and belongs to one dimension.
- Severity: blocker (cannot be merged), major (important functional or technical risk), minor (fix or justify), nit (not blocking).
- Do not propose refactors unrelated to the feature unless they remove a real risk.
- Do not review what you did not see. If the diff was truncated, say which part you could not review.
- A clean review states that no blocker or major was found; it never says the work is perfect.

## Decision Gates

Dimensions and questions:

| Dimension | Ask |
|---|---|
| correctness | does each acceptance criterion hold? are edge cases and error paths covered? |
| architecture | are boundaries and patterns respected? is there complexity nobody asked for? |
| ux-a11y | are states and flows coherent, operable and accessible? |
| quality | do the tests check real behaviour? is there duplication or debt created here? |
| risk | contracts, security, privacy, scope creep, areas not planned |
| performance | measured regressions or obvious waste (bundle, images, requests, renders) |

Things to look for on purpose: tests written to fit the code, weakened or deleted tests, snapshots standing in for behaviour, fragile selectors, invented contracts, dependencies added for convenience, refactors outside the task, a missing state from the matrix, silent deviations from the spec.

The verdict is recomputed by code: changes are requested if any blocker or major is open.

## Execution Steps

1. Read the spec and the contract, then the plan, then the gate reports.
2. Read the diff against each acceptance criterion in turn.
3. Check tests: do they fail when the behaviour breaks?
4. Check scope: every changed file serves a criterion.
5. Record findings, strongest first.
6. Set the verdict consistent with the findings.

## Output Contract

One review envelope: findings (dimension, severity, file, line, claim, evidence, fix, acRef) and the verdict.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
