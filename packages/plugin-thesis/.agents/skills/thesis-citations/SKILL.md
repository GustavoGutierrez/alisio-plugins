---
name: thesis-citations
description: "Trigger: citation keys, [@key], references.bib, claim support audit, narrative citations, citation integrity, CIT checks."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when writing or auditing citations, or when a CIT check fails.

## Hard Rules

- Citation keys have the form author, year and optional letter, lowercase (`perez2021b`). Use only keys the library provides; code generates `references.bib` and never lets it be hand-edited.
- Syntax: `[@key]`, `[@key, p. 17]`, `[@a2020; @b2021]` and narrative `@key`. Locators go inside the brackets.
- Every cited record must be citable for that section: verified primary, verified peer-reviewed or verified authoritative grey, or contextual with explicit approval.
- The writer is not the citation auditor. The auditor checks that the record supports the claim, not just that it exists.
- Never cite a source for more than it says. A review article does not prove a primary result it summarizes.
- Never invent, reformat or complete a reference by hand. Missing metadata is a verification issue, not a drafting task.
- Library records never cited are reported late in the process; do not pad the text to cite them.

## Decision Gates

| Situation | Action |
| --- | --- |
| The key is not in the library | Remove or replace the citation; never add the key yourself |
| The record supports only part of the claim | Narrow the claim or add a second source |
| Two records could support the claim | Prefer the stronger status and the more specific one |
| A quote is needed | Quote exactly with the page locator and keep quotes short |
| The citation style needs a format you do not know | It is the style's job; do not hand-format |

## Execution Steps

1. List every key used and check it against the packet or library.
2. For each claim, read the supporting location and judge support: supported, partial, unsupported or unverified.
3. Fix by narrowing the claim, replacing the source or reporting a gap.
4. Report results by section and key.

## Output Contract

Return per-claim audit entries (claim anchor, key, verdict, supporting location, note) and the list of keys to remove or replace.

## References

- `../../../README.md`
- `../thesis-evidence/SKILL.md`
- `../thesis-writing/SKILL.md`
