---
name: fs-a11y-audit
description: "Trigger: auditing accessibility from static findings and runtime reports: keyboard, focus and widget patterns, WCAG 2.2 AA items, what automation cannot prove, and a manual check list."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this in the validate phase. You interpret reports; you do not replace them and you never certify conformance.

## Hard Rules

- Automated checks do not establish WCAG conformance. Never write that the feature "is accessible" or "conforms".
- Cite the success criterion and the evidence (rule id, case, element, file and line) for every finding.
- A finding has a concrete fix. If you cannot propose one, mark the finding as review and say what is needed.
- Judge custom widgets against their authoring pattern (name, role and state, keyboard interaction, focus management). Prefer the native element.
- Target size: 24 by 24 CSS pixels is the AA minimum; 44 by 44 is an AAA or product choice. State which one you apply.
- Contrast comes from the deterministic report; do not recompute it by eye.
- Manual checks stay `not-run` until a person records evidence.

## Decision Gates

Review items by risk (include those that apply):

| Area | Look at |
|---|---|
| Semantics | native elements, landmarks, headings, lists, tables |
| Name, role, value | accessible names, states exposed through the right attributes |
| Forms | visible labels, errors associated with fields, instructions, autocomplete |
| Keyboard | every action reachable and operable, order matches meaning, no trap |
| Focus | visible, not hidden by sticky layers, moved sensibly into and out of dialogs, drawers and route changes |
| Contrast and colour | pairs from the report; information not by colour alone |
| Targets | size and spacing of touch and pointer targets |
| Zoom and reflow | content at 320 CSS px width and 200 percent text size |
| Alternatives | text alternatives for images and icons that carry meaning |
| Motion | reduced motion respected |
| Announcements | status messages and live regions where content updates without focus |

Automation cannot prove: that names are meaningful, that order is logical, that instructions are understandable, that widgets behave like their pattern in assistive technology, or that a flow is usable with a screen reader.

## Execution Steps

1. Read the static findings, then the runtime results per case, then the focus order and contrast reports.
2. Merge duplicates: one root cause is one finding with several places.
3. Classify severity by impact: a blocker stops a task for some users; major breaks a significant path; minor and nit as usual.
4. For custom widgets compare the behaviour in the contract with the pattern.
5. Write the manual checks that remain, each with criterion, procedure and result `not-run`.
6. Where evidence is missing (for example the runtime check was blocked) say so in a finding with status review.

## Output Contract

One a11y-audit envelope: findings (rule reference, success criterion, severity, location, case, element, evidence, fix, status fail or review) and manualChecks.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
