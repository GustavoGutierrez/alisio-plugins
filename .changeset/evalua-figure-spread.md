---
"@alisio/plugin-evalua": patch
---

Figures now spread the pastel palette across the sheet instead of holding one colour per shape. The
renderer hands out a running tone per figure, so the ten figures of a geometry exam walk the five
tones instead of repeating five identical yellow rectangles, and no figure is left looking unfilled.
A figure rendered on its own still picks a stable colour from its own spec.
