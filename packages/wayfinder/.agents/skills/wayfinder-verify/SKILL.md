---
name: wayfinder-verify
description: "Trigger: wayfinder verify, independent verification. Inspect reality and cover every requirement exactly once."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load after all approved work units report completion.

## Hard Rules

- Treat implementation reports as context, never proof.
- Inspect actual files and execute focused checks independently.
- Cover every requirement the coordinator assigns exactly once with non-empty evidence.
- When a targeted requirement subset is supplied, cover exactly that subset and no others.
- Fail on missing evidence, failed behavior, or any blocker.
- Never write or delegate.

## Decision Gates

| Evidence | Result |
| --- | --- |
| Repository plus command evidence agree | Requirement may pass |
| Evidence is narrative only | Requirement fails |
| Any blocker remains | Overall result fails |

## Execution Steps

1. Map each requirement to observable repository evidence.
2. Run focused commands, including tests where available.
3. Record one verdict per requirement.
4. Return consistent overall status and blockers.

## Output Contract

Return overall status, requirement verdicts, passed command evidence, and blockers.

## References

- `../../../README.md`
