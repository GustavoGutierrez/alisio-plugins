---
name: thesis-outline
description: "Trigger: thesis outline, section plan, objectives coverage, dependsOn, required sections, argument map."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when drafting or revising the outline that the OUTLINE human gate approves, or the per-section dossier.

## Hard Rules

- Return an `OutlineDraft`: an ordered tree where each section has title, purpose of at most 300 characters, objectives (OBJ ids), 1 to 8 research topics, questions to answer, evidence needs, target words and `dependsOn`.
- Include every required section from the compliance profile in the order it prescribes: cover, abstract or abstracts, introduction, problem, objectives, justification, theoretical framework or state of the art, methodology, results, discussion, conclusions, references, annexes and the AI declaration when required.
- Every specific objective is covered by at least one section; every section serves at least one objective or is a required section. Code rejects an outline that leaves an objective uncovered.
- `dependsOn` must be acyclic. A results section depends on the methodology; conclusions depend on results and discussion.
- Never allocate section ids. Give each section a short unique kebab-case `key`; `dependsOn` lists keys, and `children` nests sub-sections. Code assigns `SEC-nn` ids from the order. Tag every required section with its `requiredKey`.
- Evidence needs use the fixed set: empirical, theoretical, normative, statistical, methodological. Pick the ones that really apply.

## Decision Gates

| Situation | Action |
| --- | --- |
| An objective has no section | Add or expand a section; do not drop the objective |
| A required section seems irrelevant | Keep it and make it short; the policy requires it |
| Two sections overlap | Merge them or sharpen each purpose in one sentence |
| The thesis is very long or very short for its work type | Adjust target words and say why |
| A section needs the results of another | Add the dependency instead of reordering |

## Execution Steps

1. Read the approved protocol and the required sections from the profile.
2. Draft the tree top-down, then assign objectives, topics, evidence needs and dependencies.
3. Verify coverage, order and acyclicity yourself before returning.
4. Write the claims and gaps for each section when producing a dossier.

## Output Contract

Return strict JSON for `OutlineDraft` (or `Dossier` after research: `synthesis` and `gaps` that together cover every research topic copied exactly, and `claims` that cite only EVD ids and `[@keys]` from the packet). Purposes and topics are written in the thesis language.

## References

- `../../../README.md`
- `../thesis-methodology/SKILL.md`
- `../thesis-evidence/SKILL.md`
