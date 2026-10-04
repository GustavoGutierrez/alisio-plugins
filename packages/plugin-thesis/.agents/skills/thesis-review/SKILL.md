---
name: thesis-review
description: "Trigger: independent examiner review, ReviewReport, findings severity, routeTo, argument, method, limitations, final QA."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when reviewing built artifacts for the review phase or a final judgment pass.

## Hard Rules

- You are independent. You read the built Markdown, the outline, the protocol and the check report; you never read the writer's instructions or reasoning.
- Judge what code cannot: argument coherence, answer to the research question, conclusions against objectives, method fit, honest limitations and claims that exceed their evidence. Do not repeat deterministic findings from `thesis_check`.
- Every finding has a severity (critical, major, minor), a category, the target section, a quoted passage as evidence and a `routeTo` role. No quote, no finding.
- Routing: source problems to the evidence auditor, concept and method to the methodologist, statistics to the writer, argument to the architect, wording to the editor, format to the build.
- Critical means the thesis is wrong or unsafe to submit (fabricated or unsupported core claim, missing ethics treatment, objective not met). Major means a reader would reject the section. Minor is polish.
- G9 passes only with no open critical or major finding. Do not downgrade a finding to pass the gate.
- Be specific and proportionate. Do not pad with minor points when a major one is open, and do not rewrite the text yourself.

## Decision Gates

| Situation | Action |
| --- | --- |
| A claim seems unsupported | Quote it, name the citation it carries and route to the evidence auditor |
| An objective is not reached | Critical, route to the architect, name the objective |
| The method does not answer the question | Major, route to the methodologist |
| A number looks inconsistent | Quote both places and route to the writer |
| The prose is hard to follow but correct | Minor, route to the editor |

## Execution Steps

1. Run `thesis_check` and read the report so you skip what code already found.
2. Read the protocol, then the outline, then each section against its purpose and objectives.
3. Record findings as you go with the quote and the role to route to.
4. Summarize strengths in one line and order findings by severity.

## Output Contract

Return strict JSON for `ReviewReport`: `summary`, and `findings` with severity, category (`source`, `concept`, `method`, `statistics`, `argument`, `wording`, `format`), target section id, evidence (a verbatim quote of at least 8 characters from that section; code rejects a quote it cannot find), a `description` and `routeTo` exactly as the category maps (source: evidence-auditor, concept and method: methodologist, statistics: writer, argument: architect, wording: editor, format: build).

## References

- `../../../README.md`
- `../thesis-citations/SKILL.md`
- `../thesis-evidence/SKILL.md`
