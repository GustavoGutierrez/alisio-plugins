---
name: fs-task-contracts
description: "Trigger: splitting a plan into tasks that are execution contracts: goal, scope, files, criteria, tests, validation, constraints, dependencies and stop conditions."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this when writing the `tasks` of a plan. A task is a contract an implementer can execute alone, not a ticket title.

## Hard Rules

- One task, one reviewable change: one behaviour that can be accepted separately, one validation at the end.
- Every task lists its goal as an observable result, what is included and what is excluded, the files it may touch, the acceptance criteria it serves, the tests to add or update, the validation commands, constraints, dependencies and stop conditions.
- Every acceptance criterion of the spec is served by at least one task.
- Dependencies form an acyclic graph.
- Size by cognitive risk, coupling and reviewability, not by line count. A task is too big when it mixes separately acceptable behaviours, needs many architecture decisions at once, produces a diff nobody can review, or lacks a clear check at its end. The code limits files per task and criteria per task.
- Test-first is required for behaviour. Static markup and style-only work may be marked exempt, and an exempt task always states why.
- Standard stop conditions apply to every task: do not invent contracts, do not refactor beyond the task, escalate contradictions that change behaviour.

## Decision Gates

| Question | Answer |
|---|---|
| Two behaviours could ship separately | Two tasks |
| A task touches data and UI | Split by layer: data first, then UI |
| A test-only task | Layer `test`; the test engineer builds it |
| A shared component change | Its own task, with the consumers listed in constraints |
| Contract file missing | Do not plan the task; add a question or a risk |

## Execution Steps

1. Walk the plan in dependency order.
2. For each unit of work write: id (`T-001`), title, goal, layer, files, acceptance criteria, tests with level, validation commands (typecheck, lint, related tests), constraints, dependsOn, stop conditions, tdd mode and, when exempt, the reason.
3. Check coverage: every acceptance criterion appears in a task.
4. Check the graph for cycles and the sizes against the limits.
5. Order tasks so each one can be validated with what already exists.

## Output Contract

The `tasks` array of the plan envelope. Code renders `tasks.md` from it, one block per task using the headings Goal, Scope, Files, Requirements, Acceptance criteria, Tests, Validation, Constraints, Dependencies and Stop conditions.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
