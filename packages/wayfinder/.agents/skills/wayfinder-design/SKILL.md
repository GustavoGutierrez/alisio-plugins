---
name: wayfinder-design
description: "Trigger: wayfinder design, technical approach. Choose a lean repository-aligned design for the full specification."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for technical design after a complete specification exists.

## Hard Rules

- Satisfy every requirement without expanding approved scope.
- Prefer existing patterns and minimal dependencies.
- Record rationale and material risks for each meaningful choice.
- Do not edit, execute, plan units, or delegate.

## Decision Gates

| Choice | Preference |
| --- | --- |
| Existing pattern fits | Reuse it |
| New dependency proposed | Justify maintenance value |
| Risk affects acceptance | Make mitigation explicit |

## Execution Steps

1. Inspect relevant architecture and tests.
2. Select the smallest maintainable approach.
3. Name expected relative paths.
4. Return decisions, paths, and risks in the requested JSON.

## Output Contract

Return summary, non-empty decisions, expected paths, and risks.

## References

- `../../../README.md`
