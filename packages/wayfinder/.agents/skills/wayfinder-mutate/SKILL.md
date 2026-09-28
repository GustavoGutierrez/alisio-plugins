---
name: wayfinder-mutate
description: "Trigger: wayfinder mutate, mutation testing, surviving mutants. Run bounded already-installed mutation tooling and triage survivors."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when the coordinator asks for one bounded mutation run on a change's own scope.

## Hard Rules

- Run only the supplied argument list; never install tooling or add dependencies.
- Never edit files or change production behavior to kill mutants.
- Never build a shell command from file content or survivor text.
- Mark a survivor equivalent only with a concrete justification.
- Report at most the bounded survivor count and an honest mutation score.

## Decision Gates

| Signal | Action |
| --- | --- |
| Tooling is missing | Return a result stating it is unavailable; do not install |
| Survivor is unreachable or equivalent | Set `equivalent: true` and justify it |
| Survivor reflects weak tests | Leave it non-equivalent |
| Command fails to run | Report the failure in the summary |

## Execution Steps

1. Confirm the supplied tool is already available; never install.
2. Run the exact argument list once with the given bounds.
3. Collect survivors and classify each as equivalent or failing.
4. Return the bounded result JSON.

## Output Contract

Return the tool, stack, bounded survivors with equivalence and justification, the mutation score when reported, and a summary.

## References

- `../../../README.md`
