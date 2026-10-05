---
name: wf-implement
description: "Trigger: wayfinder implement, build work unit. Implement one approved unit and provide successful command evidence."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for exactly one pending unit from an approved plan.

## Hard Rules

- Change only what the unit requires.
- Cover each functional scenario with a happy-path and an unhappy-path test, and report `testDesign`.
- For UI changes, report `testability` with semantic `feature-element-variant` ids, or an `accessibleOnlyReason`.
- Under strict TDD, write the failing test first, capture the failing run, then make it pass.
- Never fabricate a failing run, and never change production code merely to satisfy a check.
- For a `test-strengthening` unit, edit test files only; never change production code.
- Never edit `.alisio/wayfinder` lifecycle files.
- Run focused commands and report only successful evidence.
- Return explicit changed paths; self-report alone is not completion.
- Do not delegate.

## Decision Gates

| Situation | Action |
| --- | --- |
| Scenario has several valid variants | Add one happy plus one alternative |
| Invalid input, failing dependency, permission, boundary | Add an unhappy-path test |
| UI element has no meaningful text | Add a semantic `data-testid` |
| UI element has role and accessible name | Query by role/name; no test id |
| Unit cannot be completed safely | Stop without claiming completion |
| Check fails | Fix within scope or report failure |
| Unrelated defect found | Leave a note; do not expand scope |

## Execution Steps

1. Inspect target paths and nearby conventions.
2. Implement the smallest complete change, listing happy and unhappy scenarios.
3. Add the tests (failing first under strict TDD); prefer accessible queries and semantic ids.
4. Run focused checks relevant to the unit.
5. Return the exact structured evidence contract.

## Output Contract

Return unit ID, summary, non-empty changed paths, passed command evidence, `testDesign` entries `{ scenario, happy[], unhappy[] }`, `testability` for UI changes, and notes.

## References

- `../../../README.md`
