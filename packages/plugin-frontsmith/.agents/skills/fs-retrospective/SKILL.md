---
name: fs-retrospective
description: "Trigger: closing a delivered feature: answer seven retrospective questions from evidence and propose few, real rule candidates in the workspace rule format."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this in the archive phase. The goal is to move repeated knowledge from conversation into the harness, not to add rules without end.

## Hard Rules

- Use only the evidence you are given: gate reports, review findings, counters, waivers.
- A rule candidate is a proposal. A person promotes it with a command; you never write rule packs.
- Propose a rule only when the same class of defect would otherwise come back, a deterministic engine can detect it and a fixture can prove it. Fewer, real rules beat many speculative ones.
- Workspace rule ids never start with `FS-`; they use the project's own prefix.
- Each candidate carries its evidence: report ids, finding ids or file references.

## Decision Gates

| Situation | Do this |
|---|---|
| A defect escaped the gates | Record it under escaped and name the check that finally caught it |
| A check was expensive and never useful | Record it under costly checks |
| An instruction was ambiguous | Record it under ambiguities with the sentence that was unclear |
| Context was missing | Record what and where it should live |
| Something repeats and a rule can catch it | Candidate rule; otherwise leave it as a note |

## Execution Steps

Answer in this order:
1. What escaped the gates?
2. What detected each error?
3. Which instructions were ambiguous?
4. What context was missing?
5. Which test was costly but not useful?
6. What step could be automated?
7. Which rule should become a permanent guardrail?

Then write each candidate rule with an id, a rationale, the evidence and the full rule object (id, title, rationale, severity, kind, engine, parameters and files).

## Output Contract

One archive envelope: the retrospective lists (escaped, detectedBy, ambiguities, missingContext, costlyChecks, automationCandidates) and ruleCandidates. Invalid candidates are dropped with a reported reason.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
