---
name: thesis-methodology
description: "Trigger: research protocol, problem, question, objectives, justification, methodology, reporting guideline, ethics questionnaire."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when designing or revising the research protocol that Human Gates A and B approve.

## Hard Rules

- Return a `ProtocolDraft` envelope: problem, research question or questions, general objective, 2 to 6 specific objectives, justification, scope and limitations, hypotheses (quantitative only), methodology, ethics answers.
- Each specific objective starts with an approved action verb for the thesis language, names an object, and states a verifiable deliverable. Flag verbs that cannot be verified (for example understand, know) and replace them.
- Justification covers relevance, novelty, feasibility and beneficiaries, each in a sentence or two, without citing anything you have no evidence for.
- Pick the reporting guideline from the approach and `studyDesign` as the policy routes it (systematic review: PRISMA; observational: STROBE; trial: CONSORT; interviews: COREQ or SRQR). Say when none applies.
- The ethics questionnaire has eleven yes or no questions: human participants, minors, identifiable personal data, sensitive data, intervention, risk above minimal, biological samples, animals, communities, clinical research, additional institutional rules. Answer from the user's description; ask when unsure.
- Map every yes to the requirements the resolved policy lists. When the policy lists none, say so and recommend asking the ethics committee. Never say consent, assent or review is unnecessary; only an ethics committee can waive them.
- The user approves Gate A (topic, problem, question, objectives) and Gate B (methodology, ethics, scope) separately. Never present an approval as given.

## Decision Gates

| Situation | Action |
| --- | --- |
| The objective is vague | Rewrite it with a measurable verb, object and deliverable; show both versions |
| The approach is quantitative | Add testable hypotheses and the analysis plan |
| The topic involves people or their data | Walk the questionnaire explicitly and map the policy requirements |
| Minors may be involved | Answer yes to minors, list the policy requirements and recommend committee review |
| The user wants three titles | Offer three, ranked by clarity and scope fit, each under 20 words |

## Execution Steps

1. Read the brief, the compliance profile summary and the round-3 answers.
2. Draft the problem and question, then the objectives, then justification, scope, methodology and ethics.
3. Check every specific objective against the verb list and the deliverable rule.
4. Return the envelope with open questions for the user instead of guessing missing facts.

## Output Contract

Return strict JSON for `ProtocolDraft`: text fields in the thesis language, enums in English, all 11 ethics answers as booleans (code maps each yes to the policy requirements), the reporting guideline name or null, and an `openQuestions` list. Do not include ids; code allocates `OBJ-G` and `OBJ-01`.

## References

- `../../../README.md`
- `../thesis-policy/SKILL.md`
- `../thesis-outline/SKILL.md`
