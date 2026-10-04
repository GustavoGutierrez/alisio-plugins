---
name: thesis-writing
description: "Trigger: academic prose, drafting a section, claim anchors, hedging, thesis language, topic sentences, evidence packet."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when drafting or revising a section from an evidence packet.

## Hard Rules

- Write in `brief.language`, in the academic register of that language. Keep field names and enums in English.
- Cite only citation keys that are present in the packet, as `[@key]`. A claim without support is stated as a gap or left out; never cite something you did not receive.
- One claim per paragraph topic sentence. Put a claim anchor (`<!-- claim:c3 -->`) at the start of every non-trivial claim paragraph and describe the claim in the envelope.
- Never invent numbers, quotes, names, dates or results. Quote data exactly as the user's files give it, with units. If a number is missing, say what is missing.
- Hedge in proportion to the evidence status: assertive verbs for verified peer-reviewed or primary sources, hedged verbs for contextual or limited ones. Always report limitations the packet lists.
- No first-person plural unless the policy or writing guide allows it. Follow person, voice, abbreviation and number rules from writing-guide rules in the profile.
- Use the Markdown dialect only: labels `{#sec-x}`, figures, tables with `Table:` captions, footnotes `[^1]`, math in `$...$`. Raw HTML, raw Typst and `\newpage` are rejected.
- Respect the section's purpose, target words and dependencies; do not write other sections' content.

## Decision Gates

| Situation | Action |
| --- | --- |
| The packet lacks support for an important claim | Write it as an open gap and add it to `gaps`; do not soften it into a fact |
| Sources disagree | Present both positions and the likely reason |
| A result needs a figure | Draft it with `thesis-figures`; refer to it with `@fig-id` |
| The target word count is hard to meet | Cut repetition first; never pad with unsupported claims |
| The user asks for a stronger tone than the evidence supports | Explain the limit and keep the supported wording |

## Execution Steps

1. Read the section plan, dossier, approved claims and evidence packet.
2. Outline the section in topic sentences, one per claim.
3. Draft paragraph by paragraph, adding anchors and citations as you go.
4. Check every key against the packet and every number against the data before returning.
5. Return the `SectionDraft` with claims, figure drafts and gaps.

## Output Contract

Return strict JSON for `SectionDraft`: `markdown` (no title heading: code adds it; subsections start one level below it), `keywords` (abstracts only), `claims` (anchor, text of at most 400 characters, kind, evidence ids, and for a conclusion `results`: the anchors of the result claims it rests on, or earlier CLM ids; `objectives`: the OBJ ids a result or conclusion answers), `figures` and `gaps`. Place each declared figure or table with `[[figure fig-id]]` alone on a line and refer to it with `@fig-id`. Code rejects unknown keys, missing or extra anchors, a conclusion that rests on no result, unknown labels and any figure that fails the FIG checks.

## References

- `../../../README.md`
- `../thesis-citations/SKILL.md`
- `../thesis-figures/SKILL.md`
- `../thesis-math/SKILL.md`
