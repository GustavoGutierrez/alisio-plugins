---
name: wf-coordinate
description: "Trigger: wayfinder status, resume wayfinder, wayfinder lifecycle. Operate deterministic commands without bypassing gates."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when starting, inspecting, or resuming a Wayfinder change.

## Hard Rules

- Treat command code and validated state as lifecycle authority.
- Never approve proposal or plan scope on the user's behalf.
- Never hand-edit lifecycle state or generated phase artifacts.
- Do not delegate; phase commands create bounded sessions directly.

## Decision Gates

| State | Action |
| --- | --- |
| No change | Run `new` with explicit intent |
| Critical questions | Record clarification, then retry |
| Approval pending | Ask concisely or stop headless |
| Implementation | Build one unit |
| Verification/archive | Use the indicated command |

## Execution Steps

1. Read status before resuming unfamiliar work.
2. Run only the reported next command.
3. Surface blocked state and artifact path without inventing a transition.
4. Retry the same phase after malformed or partial child output.

## Output Contract

Return change name, current phase, blocking gate, and exact next command.

## References

- `../../../README.md`
