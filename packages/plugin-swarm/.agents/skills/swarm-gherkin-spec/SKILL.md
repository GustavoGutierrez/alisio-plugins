---
name: swarm-gherkin-spec
description: "Trigger: swarm specification, gherkin, feature scenarios. Write features and scenarios with concrete examples, clarify first, and stop at the approval gate."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for the specifier while it writes the specification of one task card.

## Hard Rules

- Clarify before writing: do not guess missing requirements.
- Write Gherkin features with scenarios that use concrete values, not placeholders.
- Cover at least one happy path and one failure path per behaviour.
- Complete the whole card before the single handoff; the handoff may wait for human approval.

## Decision Gates

| Situation | Action |
| --- | --- |
| Two readings of a requirement exist | Ask one clarification |
| A scenario has no concrete example | Add one |
| The card is large | Specify all of it before handing off |

## Execution Steps

1. Read the card and the repository tree.
2. Ask any needed clarification.
3. Write the features and scenarios.
4. Write the task document and commit.
5. Return the handoff with requirement-to-scenario evidence.

## Output Contract

A `handoff` envelope whose evidence maps each requirement to the scenarios that specify it.

## References

- `../../../README.md`
