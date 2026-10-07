---
name: evl-item-writing
description: "Trigger: item, distractor, item card, stem, options, solution, misconception, authored item, EVL-ITM."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

# Item writing

Load before authoring or reviewing an item.

- Content is a mini markup: plain text with `$inline$` and `$$display$$` math, plus table blocks.
- A `single_choice` has exactly one correct option; a `multiple_choice` has at least two correct and
  one incorrect; `open` and `practice` carry a reference answer and rubric criteria.
- Every option names the misconception it encodes (sign error, omitted step, wrong common
  denominator, ...). Options are pairwise distinct after canonicalization; "ninguna/todas las
  anteriores" is never used.
- Checks: `EVL-ITM-001..010` (counts, equivalent options, recomputed key, duplicates, calibration,
  forbidden text, missing steps, unfilled slot, authored key). A formula KaTeX rejects is
  `EVL-ITM-011` and never reaches a PDF.
