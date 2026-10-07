---
"@alisio/plugin-evalua": patch
---

Exam sheet layout and numbering. The header data table uses a tighter side margin (`3mm 1mm`) and the
header drops its bottom rule. Each section title sits in its own rounded frame and is numbered
("1. Selección única"). A new `numbering` spec field and interview question let the teacher choose how
questions are numbered: `letters` (a, b, c… per section, the default), `section` (1.1, 1.2, 1.3…) or
`continuous` (1..N). In a two-column layout a vertical rule separates the columns, but only when the
items carry answer options; a plain list of exercises to solve is printed without it. PDFs are now
page-numbered through the Chrome print footer (the new `pageOf` locale label, e.g. "Página 1 de 3").
