---
name: wf-test-design
description: "Trigger: test design, happy path, unhappy path, negative testing, data-testid, UI testability. Design positive/negative tests and stable UI selectors."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when planning, implementing, or verifying functional tests, or when a unit changes UI paths.

## Hard Rules

- Cover every functional scenario with at least one happy-path (positive) test and one unhappy-path (negative, error, boundary, or valid-alternative) test.
- Derive scenarios from requirements and use cases (functional black-box), combinable with white-box path coverage.
- Query the UI as a user would: role/accessible name > label > placeholder > visible text/display value > alt/title > `data-testid` last.
- Name ids `feature-element-variant` (for example `login-email-input`); stable, semantic, never random or internal-detail based.
- Follow the project's existing convention (`data-cy`, `data-test`, or a typed `test-ids` module) instead of inventing a competing one.
- Never anchor tests on implementation classes or deep DOM chains (`div > section > div:nth-child(3)`); never use copy/i18n text as the primary anchor.
- Keep ids out of business logic; when the project strips them at build, follow that flag.

## Decision Gates

| Situation | Action |
| --- | --- |
| Scenario has several valid variants | Add one happy plus one alternative |
| Invalid input, failing dependency, permission, boundary | Add an unhappy-path test |
| Element has a role and accessible name | Query by role/name; no test id |
| Element has no meaningful text (icon, wrapper, dynamic row) | Add a semantic `data-testid` |
| Project standardizes a test attribute | Use it and the project's id module |

## Execution Steps

1. List functional scenarios from requirements and use cases.
2. For each scenario, name at least one happy and one unhappy test.
3. Prefer accessible queries; add `data-testid` only where semantics cannot carry the query.
4. Name ids `feature-element-variant` and centralize them if the project already does.
5. Report scenario coverage, test names, and any test ids used.

## Output Contract

Return `testDesign` entries `{ scenario, happy[], unhappy[] }` and, for UI changes, `testability` `{ testIds[], accessibleOnlyReason? }`. Accessibility comes first; a test id never substitutes for a correct role or accessible name.

## References

- `../../../README.md`
