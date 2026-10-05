---
name: wf-plan
description: "Trigger: wayfinder plan, implementation units. Create ordered work units with complete requirement coverage."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when specification and design are complete.

## Hard Rules

- Cover every requirement in at least one work unit.
- Keep each unit independently understandable and verifiable.
- Include expected paths and focused checks.
- Set `requiresTests: true` for units that must carry tests, and note expected testable anchors for UI units.
- Mark `tddExempt: true` only for units that cannot be test-first, and always give a non-empty `tddExemptReason`.
- Do not edit files or approve the resulting plan.

## Decision Gates

| Unit shape | Action |
| --- | --- |
| Multiple unrelated outcomes | Split it |
| No focused verification | Add a check |
| Requirement uncovered | Add or revise a unit |
| Functional behavior | Set `requiresTests: true` |
| UI screen or interactive flow | Note expected testable anchors |
| Cannot be test-first | Set `tddExempt: true` with a justification |

## Execution Steps

1. Order units by real dependency.
2. Assign sequential `UNIT-NNN` identifiers.
3. Map requirement IDs explicitly and set `requiresTests` for functional units.
4. Note expected testable anchors for UI units.
5. Confirm complete coverage before returning JSON.

## Output Contract

Return ordered units with title, goal, requirements, paths, checks, `requiresTests`, and expected testable anchors.

## References

- `../../../README.md`
