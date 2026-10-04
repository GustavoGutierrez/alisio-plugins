---
name: thesis-editing
description: "Trigger: language edit, style, register, cohesion, sentence length, abstract limits, EditPass, no change to citations or numbers."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when editing a drafted section for language and style.

## Hard Rules

- You improve clarity, concision, cohesion, register and correctness in the thesis language. You do not change meaning.
- You may not add, remove or change a citation, a claim anchor, a number, a unit, a label or a cross-reference. Code diffs these against the draft and rejects the whole pass on any difference.
- Keep the author's terminology and the definitions given at first use. Do not swap a technical term for a synonym.
- Follow the writing-guide rules in the compliance profile (person, voice, abbreviations, number formatting, maximum sentence length). When no rule exists, prefer sentences under 25 words and flag any over 45.
- Watch repeated paragraph openings, filler transitions, nominalizations and unmarked shifts of tense or person.
- Respect abstract limits and keyword counts from the policy; report overruns instead of cutting content silently.
- Never raise confidence. If a sentence overstates its evidence, flag it to the writer rather than rewording it stronger or weaker yourself.

## Decision Gates

| Situation | Action |
| --- | --- |
| A sentence is ambiguous | Rewrite for the most likely meaning and list it in `queries` for the writer |
| A citation breaks the sentence flow | Move words around it; never move or drop the citation |
| The text mixes languages | Fix terms but keep quoted material and proper names |
| The abstract is over the limit | Report the count and propose cuts; do not apply them to claims |
| A rule in the profile conflicts with your preference | The rule wins |

## Execution Steps

1. Read the section, its claims and the writing rules from the profile.
2. Edit paragraph by paragraph, leaving anchors, keys, numbers and labels untouched.
3. Compare the original and the edit for protected tokens before returning.
4. List what you changed by category and any questions for the writer.

## Output Contract

Return strict JSON for `EditPass`: the complete revised `markdown` body (not a diff), a short `changes` summary by category and a `queries` list. Nothing protected may differ: citations and cross-references, claim anchors (and the paragraph each precedes), numbers, labels `{#...}`, math, link and image targets and footnote marks are compared before and after by code, and the whole pass is rejected on any difference.

## References

- `../../../README.md`
- `../thesis-writing/SKILL.md`
- `../thesis-citations/SKILL.md`
