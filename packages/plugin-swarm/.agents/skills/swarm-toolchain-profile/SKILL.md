---
name: swarm-toolchain-profile
description: "Trigger: swarm toolchain, gate report, coverage mutation commands. Read the active toolchain profile and gate reports to run the right commands."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for roles that run tests, coverage, complexity or mutation commands.

## Hard Rules

- Use the commands the toolchain profile declares; do not invent others.
- Treat gate reports as authoritative; fix findings instead of arguing with them.
- Run commands without a shell wrapper and read their real output.

## Decision Gates

| Situation | Action |
| --- | --- |
| A gate report lists findings | Fix each finding, then re-run |
| A command is missing | Return `blocked` naming it |
| Output is ambiguous | Re-run with the profile's reporter |

## Execution Steps

1. Read the toolchain profile.
2. Run the command for your task.
3. Read the report.
4. Fix and re-run until it passes.

## Output Contract

Evidence in the handoff that quotes the passing command and its key numbers.

## References

- `../../../README.md`
