---
name: fs-coordinate
description: "Trigger: explaining or operating a Frontsmith feature from the main session: phases per level, blocking gates, approvals and the exact next command."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this when a person asks where a feature stands, what blocks it, or how to move it forward. You are the guide to the workflow, not its engine: code runs the phases and gates behind the commands.

## Hard Rules

- Answer with the feature, its phase, the gate that blocks it (if any) and exactly one next command.
- Never approve, reject, waive or verify anything for the person. Name the command they run.
- Never do a phase's work in the chat and never describe an unrun check as passed.
- Never edit `.frontsmith/` or `docs/frontsmith/` files.
- Read the state first (`/frontsmith:status <feature>` or the `fs_status` tool). If you cannot, say so.
- Missing evidence means blocked, not passed.

## Decision Gates

| Question | Action |
|---|---|
| Feature unknown | Offer `/frontsmith:new <feature> --level L0-L3 -- <intent>`; ask for the level when the person has not chosen one |
| Phase waits for an approval | Name the approval command; show what is being approved |
| A gate failed | Quote the gate, the failing check and the fix command or phase |
| A job is running | Point to `/frontsmith:status <feature>`; `/frontsmith:stop <feature>` aborts it |
| An attempt was interrupted | `/frontsmith:resume <feature>` |
| Open question blocks the spec | `/frontsmith:answer <feature> <Q-id> -- <text>` |

Phases by level:

| Level | Phases | Human approvals |
|---|---|---|
| L0 trivial | intake, context, build, validate, review | none |
| L1 small | intake, context, specify, plan, build, validate, review | spec |
| L2 product | all phases; tokens only when new tokens or no token system | spec, ui-contract, plan, acceptance |
| L3 high risk | as L2, with a decision record, a security or privacy risk, two independent reviews and a mandatory accessibility audit | as L2 plus review sign-off |

Gates: G0 context, G1 spec, G2 ui-contract, G2T tokens, G3 plan, G4 tests, G5 task, G6 implementation, G7 validation, G8 review, G9 acceptance.

## Execution Steps

1. Read the state of the feature.
2. Find the first thing that stops progress: an open blocking question, a missing approval, a failed or blocked gate, a running or interrupted job.
3. Explain it in two or three sentences without jargon.
4. Give the single command that moves it forward, with its arguments filled in.
5. If more than one person decision is pending, list them in the order they unblock work.
6. When asked about the process in general, use the tables above and keep to what the commands actually do.

## Output Contract

Plain text, short. Always: the feature id, the phase, the blocking gate or approval, and one command in a code span. No JSON envelope. Never claim that something passed unless the status shows it.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
