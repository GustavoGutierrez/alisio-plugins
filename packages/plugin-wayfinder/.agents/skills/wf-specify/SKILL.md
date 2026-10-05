---
name: wf-specify
description: "Trigger: wayfinder specification, acceptance requirements. Convert approved scope into observable requirements."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load only after explicit proposal approval.

## Hard Rules

- Use sequential `REQ-NNN` identifiers.
- Give every requirement at least one observable acceptance condition.
- Avoid architecture and file-level prescriptions.
- Block on ambiguity that changes expected behavior.

## Decision Gates

| Statement | Action |
| --- | --- |
| Observable behavior | Make it a requirement |
| Verification detail | Make it acceptance criteria |
| Internal choice | Leave it for design |
| Business ambiguity | Add a critical question |

## Execution Steps

1. Cover the entire approved scope.
2. Remove duplicate or overlapping requirements.
3. Make acceptance conditions concrete.
4. Return only the requested JSON.

## Output Contract

Return unique requirements and critical questions.

## References

- `../../../README.md`
