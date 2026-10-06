---
name: fs-test-design
description: "Trigger: mapping acceptance criteria to tests: choose the cheapest sufficient level, keep traceability, prefer user-facing locators and avoid snapshot, sleep and selector anti-patterns."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this in the test-design phase (map) and when writing tests (build mode). A test is a constraint on behaviour, never a description of the code.

## Hard Rules

- Every acceptance criterion maps to at least one automated test or to a manual verification with a procedure and a justification.
- Choose the cheapest level that gives enough confidence; do not push every criterion to end-to-end.
- Test behaviour a person can observe. Do not test private methods or accidental DOM structure.
- Locator priority: role with accessible name, then label, then visible text, then test id. Never rely on class names, nth-child or XPath.
- No fixed sleeps. Wait for an observable condition.
- A snapshot is not a substitute for behaviour. Never update snapshots or visual baselines yourself.
- Never delete, skip or weaken a test to make a result green.
- Tests that only confirm the existing code are a defect: write the expectation from the criterion first.

## Decision Gates

| Behaviour or risk | Level |
|---|---|
| Pure function or transformation | unit |
| Hook, store or service with rules | unit or integration |
| Interaction inside a component | component |
| Simulated API, states and contracts | integration |
| Critical business flow across pages | end-to-end (criteria marked critical only) |
| Layout or style that is part of the contract | visual |
| Keyboard, labels, semantics | component plus accessibility plus manual as the risk requires |
| Bundle size, load metrics | performance, measured |

Selection questions: can a pure function check it? does it need the DOM, a real browser, a real backend? would a defect be critical to the business? is appearance part of the contract? does accessibility need a manual check?

Coverage that matters: criteria covered, critical paths, error states, contracts and known risks, not only line percentage.

## Execution Steps

Design mode:
1. For each acceptance criterion write the risk in one line.
2. Pick the level and the evidence that will exist.
3. Add visual entries for states with fidelity rules and an accessibility entry for interactive components.
4. Use a manual entry only with a procedure and a justification.

Build mode:
1. Read the task and the criteria it serves.
2. Write the test from the criterion, using user-facing queries.
3. Run it and confirm it fails for the expected reason when the behaviour is not implemented yet.
4. Keep tests independent: no shared mutable state, deterministic data.

## Output Contract

Design mode: one test-map envelope with an entry per criterion. Build mode: one task-result envelope.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
