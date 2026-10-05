---
name: swarm-handoff-protocol
description: "Trigger: swarm handoff, envelope, finish a task. Return exactly one strict JSON envelope per run: handoff, needs_clarification, blocked or note."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for every swarm role. It defines the only way a role talks back: one JSON envelope as the final message.

## Hard Rules

- Your final message is a single JSON object with `"schemaVersion": 1` and nothing else around it.
- Allowed kinds: `handoff` (`commit`, `summary`, `evidence`), `needs_clarification` (`question`), `blocked` (`reason`), `note` (`message`, one line, at most 80 characters).
- `commit` is the first ten lowercase hexadecimal characters of a commit that exists in your working directory.
- `evidence` is a non-empty list of `{ "requirement", "proof" }` pairs that trace each requirement to a concrete proof.
- Never add other keys, never set routing or approval fields; extra keys reject the whole run.
- Send one handoff per task. Merge incoming work is done for you before you start; resolve conflicts when asked.

## Decision Gates

| Situation | Action |
| --- | --- |
| The work is complete and committed | Return a `handoff` |
| A requirement is ambiguous | Return `needs_clarification` with one question |
| You cannot proceed | Return `blocked` with the reason |
| You are asked to repeat after an audit | Repeat the identical envelope when nothing changed; return the new one when you changed something |

## Execution Steps

1. Finish and commit your work in your working directory.
2. Run the local verification commands.
3. Build the envelope from the real commit and real proofs.
4. Return it as the final message with no surrounding text.

## Output Contract

A single JSON envelope as described above.

## References

- `../../../README.md`
