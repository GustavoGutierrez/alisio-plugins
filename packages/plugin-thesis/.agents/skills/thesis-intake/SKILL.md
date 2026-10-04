---
name: thesis-intake
description: "Trigger: thesis init, interview, language, work type, country, institution. Run the intake rounds with recommended options."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when the user starts or resumes a thesis workspace, or asks what the interview needs. The interview runs in code; this skill tells you how to guide it.

## Hard Rules

- The thesis language is the first question of round 1, always. Never assume it from the topic.
- Every question offers 2 to 4 options and at most one is recommended. Present the recommended option first and say why it is recommended in one short sentence.
- Rounds 1 and 2 (language, work type, country, second abstract, institution, citation style, domain, approach) are mandatory before any other phase. Round 3 (title, topic, objective, justification) is mandatory before design completes. Round 4 (paper, palette, typeface, AI declaration) can wait until the first figure or build.
- Ask at most one open question at a time. Do not ask again what `thesis.yaml` already answers.
- Never choose the citation style or presentation standard for the user. `Let the policy decide` is a valid answer that leaves the decision to institution rules, with a flagged default when none exists. Colombia never selects ICONTEC automatically.
- Language values are BCP-47 tags (es-CO, en, pt-BR). Country values are ISO 3166-1 alpha-2 codes. Reject anything else and say what is allowed.
- Headless sessions answer through `/thesis:answer` with `id=value` pairs or one JSON object. Free text uses `<id>:text=...`. Never invent an answer to unblock the flow.

## Decision Gates

| Situation | Action |
| --- | --- |
| The user wrote in Spanish and has not chosen a language | Offer the conversation language as the recommended option, still ask |
| The user is unsure about the citation style | Recommend `Let the policy decide`; explain that the institution's rules win and that defaults are flagged |
| The user has no institution yet | Choose `Not decided yet`; remind them that institution rules override defaults once known |
| The user pastes a long description of their topic | Store it as the topic answer; do not rewrite it during intake |
| Answers are rejected | Show the allowed values from the rejection message and ask again, once |

## Execution Steps

1. Run `/thesis:init` (add `--lang <tag>` when you know the conversation language) and read the first round aloud with its recommended options.
2. For headless sessions, relay the pending questions exactly and wait for `/thesis:answer`.
3. After each round, state what was recorded and which round is next.
4. When rounds 1 to 3 are complete, report the resolved citation style and whether it is a default, then the G0 result, then the next command.

## Output Contract

Report the answers recorded, the files written (`thesis.yaml`, `compliance-profile.json`, `research/intake.json`), the G0 result and the single next command. Never summarize policy as legal advice.

## References

- `../../../README.md`
- `../thesis-policy/SKILL.md`
