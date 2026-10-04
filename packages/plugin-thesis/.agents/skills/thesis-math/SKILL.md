---
name: thesis-math
description: "Trigger: equations, LaTeX math, displayed equations, symbols, units, labels {#eq-}, MTH checks."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

## Activation Contract

Load when a section contains formulas, derivations or symbols.

## Hard Rules

- Write math in LaTeX syntax: inline `$...$`, displayed `$$...$$`. Every displayed equation that is referenced gets `{#eq-name}` after the closing delimiter.
- Only math commands are allowed. `\input`, `\include`, `\write`, `\def` and other non-math commands are rejected (MTH-001). Keep delimiters balanced and avoid backticks inside `\text{}`.
- Define every symbol at first use, with units where they exist. Keep notation consistent across chapters; use one symbol for one quantity.
- Do not typeset numbers from tables inside equations unless they are inputs of the derivation; keep significant figures consistent with the data.
- Refer to equations with `@eq-name` and write the sentence around them; never leave an equation without a verb.
- Long derivations go in annexes; the body keeps the result and the key steps.

## Decision Gates

| Situation | Action |
| --- | --- |
| The formula is referenced later | Add a label and refer with `@eq-name` |
| A symbol is reused | Rename one of them and say so |
| A formula comes from a source | Cite it with a locator; do not alter it silently |
| A formula needs unusual notation | Define it in a sentence before use |
| The command is not math | Rewrite it with plain math or describe it in words |

## Execution Steps

1. List the quantities, symbols and units.
2. Write the equation, label it if referenced, and define symbols after it.
3. Reference it from the text and explain what it means.
4. Check delimiters, labels and units before returning.

## Output Contract

Return Markdown with labeled equations and a short list of symbols with units in the draft's `notes`.

## References

- `../../../README.md`
- `../thesis-writing/SKILL.md`
- `../thesis-figures/SKILL.md`
