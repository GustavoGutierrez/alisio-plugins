---
"@alisio/plugin-evalua": patch
---

The answer sheet now fits one page instead of two: its by-reference index and the specification
summary run in two columns, the table rows are tighter, and the heading and header are smaller on that
document alone. Measured with real Chrome, a 10-question sheet and even a 20-question one print on a
single page. The specification summary is written in the teacher's language — the topic's own name
instead of its internal id, and the cognitive level and item type from the locale (`recordar`,
`Selección única`) instead of `recall` and `single_choice` — and the total line uses the locale
wording too.
