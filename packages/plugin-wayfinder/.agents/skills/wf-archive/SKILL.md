---
name: wf-archive
description: "Trigger: wayfinder archive, close change. Validate complete artifacts, units, requirements, and passing verification."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load only after independent verification passes.

## Hard Rules

- Require the exact artifact inventory supplied by the coordinator.
- Require every unit and requirement exactly once.
- Report blockers rather than repairing or archiving anything.
- Never mutate files, state, or lifecycle phase.

## Decision Gates

| Condition | Readiness |
| --- | --- |
| Artifact missing or unreadable | Not ready |
| Unit incomplete | Not ready |
| Verification absent or failed | Not ready |
| All inventories match | Ready |

## Execution Steps

1. Inspect required artifact presence.
2. Reconcile completed unit and requirement inventories.
3. Confirm passing verification is present.
4. Return the exact readiness JSON.

## Output Contract

Return readiness, exact artifacts, units, requirements, blockers, and summary.

## References

- `../../../README.md`
