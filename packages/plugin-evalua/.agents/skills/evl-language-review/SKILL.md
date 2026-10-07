---
name: evl-language-review
description: "Trigger: language review, clarity, ambiguity, notation, bias, accessibility, wording, reviewer."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

# Language review

Load before reviewing the wording of authored items.

- Look for instructions that can be read two ways, undefined notation, vocabulary above the grade,
  cultural or gender bias, and missing units.
- Record each finding with a `kind` (`ambiguity`, `notation`, `bias`, `accessibility`, `clarity`) and a
  severity. A finding blocks only when marked `error`; otherwise it is advisory and recorded in
  `review.json`.
- The reviewer never rewrites the item; it reports what to change and why.
