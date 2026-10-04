---
name: thesis-csl-authoring
description: "Trigger: CSL style, citation style, independent style, institutional guide to CSL, fixtures, golden renderings."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when the user needs a citation style the shipped ones do not provide, derived from an institutional or writing guide.

## Hard Rules

- Produce CSL 1.0.2 independent styles. Do not use `independent-parent` links outside shipped styles, DTDs or entities.
- Start from the closest shipped style (APA, IEEE or ICONTEC) and change only what the guide prescribes. Do not restyle what the guide is silent about.
- Set `<info>`: `id` equal to `thesis-<slug>` and to the file name, `title`, `<rights>` CC-BY-SA 3.0 and `updated`. Set `default-locale` from the brief language.
- Record every guide rule that drove a change in a `<!-- rule: ... -->` comment with its source location.
- Cover the eight fixture types: journal article, book, chapter, thesis, law, standard, web page and dataset, in the thesis language.
- Never invent a rule the guide does not state. List ambiguities as questions for the user; unanswered questions block approval.
- A style is never applied to the thesis before the user approves its rendered fixtures. Fixtures are saved as golden renderings and re-checked on every build.

## Decision Gates

| Situation | Action |
| --- | --- |
| The guide gives only examples | Infer the pattern, mark the rule as inferred and ask the user to confirm |
| The guide contradicts itself | Quote both places and ask which wins |
| A reference type has no example | Say so; do not guess |
| A program supplies its own `.csl` file | Validate it and use it as is; do not rewrite it |
| The guide is a URL | Fetch with host tools if available; otherwise ask for the text |

## Execution Steps

1. Read the guide and list each rule with its location.
2. Pick the base style and mark each change with its rule comment.
3. Render the eight fixtures plus in-text citations in the thesis language and compare them against the guide's examples.
4. Return the style, the optional presentation profile, the open questions and the rule trace.

## Output Contract

Return strict JSON with `csl` (the XML), optional `profile`, `questions` and `ruleTrace` (rule, guide location, effect on the style).

## References

- `../../../README.md`
- `../thesis-institution-norms/SKILL.md`
