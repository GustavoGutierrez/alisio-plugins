---
"@alisio/plugin-evalua": minor
---

Add the `/evalua:build` command and the `evalua_build` tool. They read the approved exam folder
(`exam.yaml` and `items.json`), fit the page budget and write the student exam, the answer sheet,
the solution book and the rubric as self-contained HTML and, with a Chromium-compatible browser, as
PDFs, together with `00_plan_proyecto.md` and `05_control_versiones.md`. Without a browser the HTML
files are still written and the build reports `EVL-LAY-000` (page limits not verified). The
`buildExam` pipeline now supports the no-browser path and an injectable printer for tests.
