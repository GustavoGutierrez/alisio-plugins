---
name: evl-math-review
description: "Trigger: math review, independent review, verify key, recompute, substitute, distractor check, reviewer."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

# Math review

Load before reviewing an item and its key.

- The reviewer is independent: it sees only the item and its key, never the author's reasoning.
- Recompute the answer (substitution or the family solver) and compare it with the stored key; a
  mismatch is `EVL-ITM-004`.
- Confirm the options are pairwise distinct after canonicalization (`EVL-ITM-003`) and that the
  correct-option count matches the type (`EVL-ITM-001`, `EVL-ITM-002`).
- Confirm the numbers and the solution length stay inside the level calibration (`EVL-ITM-006`).
- Return `pass`/`fail` with a concrete message; never repair the item.
