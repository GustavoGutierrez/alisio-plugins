---
name: swarm-mutation-hardening
description: "Trigger: swarm mutation testing, surviving mutants, harden tests. Triage surviving mutants and kill them with behaviour tests, or report equivalents."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for the hardener when mutation score applies.

## Hard Rules

- Run differential mutation testing on changed code only.
- Kill a surviving mutant with a behaviour test, never with an implementation-coupled assertion.
- Report an equivalent mutant with a written justification.
- Change test files only; never change production behaviour.

## Decision Gates

| Situation | Action |
| --- | --- |
| A mutant survives | Add a test that fails on the mutant |
| A mutant is equivalent | Report it with justification |
| The tool is unavailable | Return `blocked` with the reason |

## Execution Steps

1. Run the mutation command on the changed files.
2. List the survivors.
3. Triage each one.
4. Add tests and re-run.
5. Hand off with the final score.

## Output Contract

A `handoff` envelope with evidence for each killed and each equivalent mutant.

## References

- `../../../README.md`
