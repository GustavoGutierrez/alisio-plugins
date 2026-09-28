---
name: wayfinder-implement
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
- Never edit `.alisio/wayfinder` lifecycle files.
- Run focused commands and report only successful evidence.
- Return explicit changed paths; self-report alone is not completion.
- Do not delegate.

## Decision Gates

| Situation | Action |
| --- | --- |
| Unit cannot be completed safely | Stop without claiming completion |
| Check fails | Fix within scope or report failure |
| Unrelated defect found | Leave a note; do not expand scope |

## Execution Steps

1. Inspect target paths and nearby conventions.
2. Implement the smallest complete change.
3. Run focused checks relevant to the unit.
4. Return the exact structured evidence contract.

## Output Contract

Return unit ID, summary, non-empty changed paths, passed command evidence, and notes.

## References

- `../../../README.md`
