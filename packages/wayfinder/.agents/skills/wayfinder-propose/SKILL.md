---
name: wayfinder-propose
description: "Trigger: wayfinder proposal, define change scope. Produce an approval-ready outcome and explicit boundaries."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load after discovery has no unresolved critical question.

## Hard Rules

- Define WHAT outcome is proposed, not internal implementation.
- Make in-scope and out-of-scope boundaries explicit.
- Preserve consequential assumptions as critical questions.
- Never approve the proposal or edit files.

## Decision Gates

| Condition | Action |
| --- | --- |
| Intent and evidence agree | State the bounded outcome |
| Scope is ambiguous | Add a critical question |
| Nice-to-have is unnecessary | Put it out of scope |

## Execution Steps

1. Reconcile intent with discovery constraints.
2. State one outcome a reviewer can approve.
3. Define boundaries and assumptions.
4. Return the exact JSON contract.

## Output Contract

Return outcome, in-scope items, out-of-scope items, assumptions, and critical questions.

## References

- `../../../README.md`
