---
"@alisio/plugin-evalua": minor
---

Add the `geometry` family. It generates figure-based items (area and perimeter of squares,
rectangles and equilateral triangles, and counting polygon sides) with a deterministic SVG figure in
the stem, and the `basic-math` geometry topic uses it, so a geometry exam generates items with
figures out of the box.

Fix a defect confirmed in real execution: `verifyItem` required a non-empty reference on a
not-yet-frozen item, but the reference is assigned when the item is placed (`place`), so every static
bank item was rejected and bank-backed topics generated nothing. The reference is now validated only
at the exam level (`EVL-EXM-002`), and bank items are accepted again.

Large exams are supported: the interview accepts up to 100 questions, a bank of up to 400 items and
up to 8 variants, and the fitter handles any page count (a number from 1 to 20, or the fewest legible
pages).
