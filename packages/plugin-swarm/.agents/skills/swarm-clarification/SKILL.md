---
name: swarm-clarification
description: "Trigger: swarm clarification, ask the operator, ambiguous requirement. Ask one question per envelope and resume when answered."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when a requirement is ambiguous and guessing would risk wasted work.

## Hard Rules

- Ask only when the answer changes what you build.
- One question per `needs_clarification` envelope.
- Make the question answerable in a sentence and say what you would assume otherwise.
- After the answer arrives, continue from where you stopped.

## Decision Gates

| Situation | Action |
| --- | --- |
| The ambiguity is cosmetic | Pick the simplest option and note it |
| Two designs differ materially | Ask |
| You have several questions | Ask the most blocking one first |

## Execution Steps

1. State the ambiguity.
2. Return the envelope.
3. Wait for the answer.
4. Resume the work.

## Output Contract

A single `needs_clarification` envelope.

## References

- `../../../README.md`
