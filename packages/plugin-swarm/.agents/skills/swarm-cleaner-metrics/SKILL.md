---
name: swarm-cleaner-metrics
description: "Trigger: swarm cleaning, CRAP, complexity, duplication. Read coverage, complexity and CRAP reports, refactor worst-first, and remove duplication."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for the cleaner and refactorer when metric thresholds apply.

## Hard Rules

- Confirm unit and acceptance tests are green before refactoring.
- CRAP is `CC^2 * (1 - coverage)^3 + CC`; lower complexity or raise coverage to reduce it.
- Thresholds come from the pack; do not change them.
- Refactor in small steps and re-run the tests after each one.
- Remove duplication rather than hiding it.

## Decision Gates

| Situation | Action |
| --- | --- |
| A function is over the complexity limit | Split it |
| CRAP is high with low coverage | Add behaviour tests, then refactor |
| A step turns tests red | Revert that step |

## Execution Steps

1. Run the metric commands.
2. Pick the worst function.
3. Refactor one step.
4. Re-run tests and metrics.
5. Hand off when every threshold holds.

## Output Contract

A `handoff` envelope whose evidence quotes the before and after metric values.

## References

- `../../../README.md`
