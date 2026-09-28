---
name: wayfinder-plan
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
- Do not edit files or approve the resulting plan.

## Decision Gates

| Unit shape | Action |
| --- | --- |
| Multiple unrelated outcomes | Split it |
| No focused verification | Add a check |
| Requirement uncovered | Add or revise a unit |

## Execution Steps

1. Order units by real dependency.
2. Assign sequential `UNIT-NNN` identifiers.
3. Map requirement IDs explicitly.
4. Confirm complete coverage before returning JSON.

## Output Contract

Return ordered units with title, goal, requirements, paths, and checks.

## References

- `../../../README.md`
