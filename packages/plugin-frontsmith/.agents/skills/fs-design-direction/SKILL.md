---
name: fs-design-direction
description: "Trigger: making or judging visual design choices: ask 1-3 open design questions, translate answers to checkable rules, and read generic-design signals as review hints only."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load this when the UI contract needs design decisions, or when design critique of a result is requested. Aesthetic taste is never law: you turn intent into checkable instructions and flag signals for a person to judge.

## Hard Rules

- Three levels of rule: required (accessibility, truthful content, behaviour, approved contracts), product conventions (the chosen scale, palette, components) and heuristics (balance, rhythm, density, warmth). Only the first two can fail a check.
- Preserve what the product already approved. Do not change an approved palette or typeface because of fashion.
- Ask only what changes the experience or identity and is not already decided: one to three questions per round, each with free-text answers allowed, two or three options and a reasoned recommendation that explains its effect.
- If the person delegated the choice and does not answer, record a reversible assumption and continue.
- Never invent testimonials, metrics, client logos or product facts.
- Never call a design machine-made or "AI looking". The signals below are review hints with an effect and a proposal, never gate input.
- Do not replace one cliche with its opposite; decide from the brief.

## Decision Gates

Question bank, grouped by what each decides (ask only the unresolved ones):

| Decision | Options | Effect |
|---|---|---|
| Purpose of the screen | operate, decide, read, explore | hierarchy and density |
| Replicate, refine or redesign | what to keep, what may change | scope of change |
| Who uses it, how often | frequent expert, occasional, mixed | density and disclosure |
| Primary action | one, several equal, none | emphasis |
| Content organisation | table or list, cards, editorial | comparison versus exploration |
| Colour role | neutrals with accent, brand-led, several semantic families | palette |
| Themes | light, dark, both | token parity |
| Motion | brief feedback, navigation transitions, expressive | motion budget |
| Mobile changes first | collapse navigation, reorder, wrap actions, local scroll | responsive rules |

Operational rules UI-01 to UI-18: one main task per view; hierarchy before decoration; group by proximity; shared alignment anchors; repetition for equivalence and contrast for difference; one body typeface and a second only for a distinct role; test typography with real content; the strongest emphasis for the next step; a semantic palette with every allowed pair validated; structure and space before borders and shadows; consistent radii, strokes, icons and elevation; density matched to the user; specific action labels and errors with a recovery; authentic or clearly illustrative imagery; motion that explains and respects reduced motion; responsive composition that keeps priorities and reading order; loading, empty, error and success designed as carefully as the normal state; stop when the contract is met.

Generic-design signals (review hints AV01 to AV20): interchangeable composition, a marketing hero inside a tool, every datum in a card, nested decorative containers, ornament louder than the task, everything equally prominent, a palette chosen by reflex, faint text for elegance, typography without criteria, extreme tracking, every control as a chip, mixed or oversized icons, filler imagery, generic copy, invented figures, uniform spacing for different relations, emptiness as sophistication, motion without meaning, random imperfection as personality, swapping one cliche for another.

## Execution Steps

1. Read the product, the visual system and the brief; list what is already decided.
2. Ask the open questions that remain (maximum three), with options and a recommendation.
3. Turn each answer into consequences: layout, density, typography roles, emphasis, copy, what to preserve and how to verify it.
4. Record unresolved items instead of hiding them.
5. For critique: name the signal, the region, the effect on the task and a concrete proposal; keep it short.
6. Stop when the contract is satisfied and no relevant defect remains.

## Output Contract

For direction: decisions as short statements with consequences and verification steps, plus the list of unresolved items. For critique: entries with signal id, region, effect and proposal. Advisory only.

## References

- [Frontsmith README](../../../README.md): commands, phases, gates and the evidence the workflow produces.
