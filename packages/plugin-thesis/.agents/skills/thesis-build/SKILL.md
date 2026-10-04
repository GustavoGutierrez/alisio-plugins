---
name: thesis-build
description: "Trigger: build, check, PDF, Typst, deterministic gates, check report, engines, doctor, thesis_check, thesis_build."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when running checks, explaining a report, or building the PDF.

## Hard Rules

- Every check that code can decide is decided by code and is available as a tool, a command and the `alisio-thesis` CLI. Never claim a check passed without running it.
- `thesis_check` is read-only. `/thesis:check` also refreshes `compliance-profile.json` and writes `build/check-report.json`. The CLI exits 0 when no check fails, 1 when one fails and 2 on usage or environment errors.
- Explain findings by gate: G0 brief and policy, G1 design, G2 evidence, G3 and G4 outline and claims, G5 citations, G6 ethics and AI, G7 language and hygiene, G8 build, G9 review, G10 final.
- Build output is generated. Never edit generated markup under `build/`; fix the Markdown source, the brief or the policy instead.
- Rendering is format-agnostic: the Markdown dialect and the profile data are the contract, and Typst PDF is one engine behind it. Do not promise features of one engine as properties of the thesis.
- `/thesis:doctor` reports engines, versions, vendored packages and policy packs without changing anything. `/thesis:build` and `/thesis:setup` build the PDF; `/thesis:style list|check` validates workspace styles and profiles (CSL-001, PRF-001, CSL-010).
- No PDF/A or submission claim is made unless the final gates passed and the build succeeded.

## Decision Gates

| Situation | Action |
| --- | --- |
| Errors in G0 | Fix `thesis.yaml` or policy files first; later gates assume a valid brief |
| Only warnings | Explain each, say which are optional, and continue |
| The report is stale | Re-run the check; reports record their own time |
| No engine is available | Run `/thesis:doctor` and relay what to install; do not fake a build |
| The user asks to skip a gate | Explain what the gate protects; only a human approval can mark a human gate |

## Execution Steps

1. Run `thesis_check` for the gates in scope.
2. Group findings by gate and severity; translate messages into the user's language.
3. Name the fix and the responsible command or role for each error.
4. Re-run the check after fixes and report the new counts.

## Output Contract

Report counts by severity, the blocking findings with file and line, the fix for each and the next command.

## References

- `../../../README.md`
- `../thesis-policy/SKILL.md`
