---
name: wayfinder-discover
description: "Trigger: wayfinder discovery, inspect change context. Gather repository facts and critical questions without designing."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load for the discovery phase of one explicit change intent.

## Hard Rules

- Cite current repository evidence, not guesses.
- Keep product, security, data, and compatibility uncertainty visible.
- Do not propose implementation or mutate files.
- Return only the coordinator-requested JSON shape.

## Decision Gates

| Finding | Treatment |
| --- | --- |
| Confirmed in files | Record as finding or constraint |
| Changes business behavior | Record as critical question |
| Merely technical risk | Preserve for design context |

## Execution Steps

1. Locate repository structure, conventions, and relevant tests.
2. Inspect only paths connected to the intent.
3. Separate constraints from open questions.
4. Produce a concise evidence-based summary.

## Output Contract

Return summary, non-empty findings, constraints, and critical questions.

## References

- `../../../README.md`
