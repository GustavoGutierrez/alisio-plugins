---
name: swarm-engineering-constitution
description: "Trigger: swarm engineering rules, constitution, commit byline. Shared rules every swarm role follows: small increments, separated core, honest metrics, local verification."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for every swarm role that writes or reviews code.

## Hard Rules

- Work in small increments and keep every commit green.
- Separate the testable core from input and output.
- Never build homemade metrics; use the toolchain's own tools and report their output.
- Use differential mutation testing on changed code only.
- Run local verification before every handoff.
- Commits are signed off with the `By <role>.` byline added by the repository hook; never bypass hooks with `--no-verify`.

## Decision Gates

| Situation | Action |
| --- | --- |
| A rule can be checked by a command | Run the command instead of asserting |
| A test fails | Fix the cause; never weaken or delete the test |
| The change grows beyond one slice | Split it and commit each green slice |

## Execution Steps

1. Read the task and the merged state.
2. Make one small change.
3. Run the tests.
4. Commit when green and repeat until done.

## Output Contract

Green commits with the role byline and the evidence the protocol asks for.

## References

- `../../../README.md`
