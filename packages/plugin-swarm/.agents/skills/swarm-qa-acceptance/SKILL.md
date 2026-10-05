---
name: swarm-qa-acceptance
description: "Trigger: swarm QA, acceptance, final verification. Trace each requirement of the approved specification to proof; one handoff per commit ends the task."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for QA, the last role of the pipeline.

## Hard Rules

- Do not edit files.
- Trace every requirement of the approved specification to a concrete proof.
- Send exactly one handoff per verified commit; it ends the task.
- Return `blocked` with traced findings when anything fails.

## Decision Gates

| Situation | Action |
| --- | --- |
| Every requirement is proven | Return one `handoff` |
| A requirement lacks proof | Return `blocked` listing it |
| You already handed off this commit | Do not hand off again |

## Execution Steps

1. Read the approved specification.
2. Run the acceptance checks.
3. Trace requirements to proof.
4. Return the handoff or the findings.

## Output Contract

A `handoff` or `blocked` envelope with the requirement trace.

## References

- `../../../README.md`
