---
name: evl-layout
description: "Trigger: layout, density, page budget, fitting, maxPages, overflow, legibility floor, columns, EVL-LAY."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

# Layout and fitting

Load before fitting the page budget or explaining a layout failure.

- `maxPages: auto` picks the fewest pages reachable at or above the legibility floor, preferring the
  most comfortable density that achieves it; `maxPages: k` picks the most comfortable preset within k.
- The density ladder is `comfortable`, `regular`, `compact`, `tight`, `minimum`; floors are body 9 pt,
  line height 1.15, margins 10 mm, math at least 85 %, and the answer-space floors.
- If no preset satisfies the budget the build fails with `EVL-LAY-001` and a report listing the
  smallest page count reached and concrete options; it never overflows or shrinks silently.
- Themes (`classic`, `blue`, `dark`) change tokens and typography, never the floors.
