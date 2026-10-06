---
name: fs-evidence-protocol
description: "Trigger: producing any Frontsmith envelope: label each claim observed, measured, inferred or pending, prove completion with commands, and stop on the listed conditions."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this for every child that returns an envelope. It defines how you talk about what you know and what you verified.

## Hard Rules

- Done means demonstrated. A summary such as "implemented" or "all tests pass" is not evidence.
- Label every value: observed (you saw it), measured (a tool produced it), inferred (you reasoned to it) or pending (unknown). Never promote an inference to a measurement.
- List what you did not verify and why. An honest gap is better than a confident guess.
- Report commands exactly as run with their exit code; the coordinator re-runs them and trusts only its own results.
- Your final message is one JSON object that matches the envelope in your prompt: no prose, no extra keys, strings within the length caps.
- Paths are workspace-relative with `/` separators, never absolute, never containing `..`.
- Never invent ids, contracts, endpoints, copy, assets or business rules.

## Decision Gates

Stop and report instead of continuing when:

- the spec contradicts a contract, or the design contradicts an approved rule;
- a needed endpoint, permission, secret or asset does not exist;
- you would have to add a material dependency the plan does not list;
- an irreversible or destructive step is outside the task;
- existing tests show a behaviour you cannot reconcile with the task;
- the work would change another feature significantly.

These are not stop conditions: choosing a trivial local name, fixing a typo in your own change, applying a convention the repository already uses, reusing a documented pattern.

## Execution Steps

1. Read the inputs you were given; do not rebuild context that is already in them.
2. Do the smallest piece of work that satisfies the contract of your role.
3. Check it in the cheapest way that is convincing, and keep the evidence.
4. Compare the result with the inputs: scope, ids, paths, caps.
5. Write the envelope. Put open problems in the question or deviation fields, not in prose.
6. Re-read the envelope against the schema before answering.

## Output Contract

The JSON envelope of your role only. When blocked, use the status or question fields the envelope offers and say precisely what is missing; do not return a partial envelope that looks complete.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
