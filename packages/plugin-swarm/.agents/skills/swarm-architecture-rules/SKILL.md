---
name: swarm-architecture-rules
description: "Trigger: swarm architecture, modules, boundaries, dependency direction. Partition modules, isolate policy from details, and refactor structure with tests green."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for the architect and refactorer when shaping structure.

## Hard Rules

- Tests are green before and after every structural change.
- Partition code into cohesive modules with clear boundaries.
- Dependencies point toward high-level policy, never toward details.
- Preserve behaviour; moving code is not a reason to rewrite it.
- Fix local errors before handing off.

## Decision Gates

| Situation | Action |
| --- | --- |
| A module depends on a detail | Introduce an interface at the boundary |
| Two modules change together | Merge or re-draw the boundary |
| A move breaks a test | Revert and retry smaller |

## Execution Steps

1. Map the current modules.
2. Choose one structural improvement.
3. Apply it and run the tests.
4. Repeat; then hand off.

## Output Contract

A `handoff` envelope with evidence describing each structural change and the passing test run.

## References

- `../../../README.md`
