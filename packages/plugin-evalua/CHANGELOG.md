# @alisio/plugin-evalua

## 0.2.0

### Minor Changes

- de87688: Add the `/evalua:build` command and the `evalua_build` tool. They read the approved exam folder
  (`exam.yaml` and `items.json`), fit the page budget and write the student exam, the answer sheet,
  the solution book and the rubric as self-contained HTML and, with a Chromium-compatible browser, as
  PDFs, together with `00_plan_proyecto.md` and `05_control_versiones.md`. Without a browser the HTML
  files are still written and the build reports `EVL-LAY-000` (page limits not verified). The
  `buildExam` pipeline now supports the no-browser path and an injectable printer for tests.

## 0.1.1

### Patch Changes

- 3106585: Fix the document output and localize the interview. The answer sheet and the solution book now
  typeset their math with KaTeX instead of showing raw `\div` and `\dfrac`; the answer sheet shows the
  localized type label (for example "Selección única"); and the exam information table shows the
  teacher name. The interview is in Spanish and starts with the language question (then institution,
  teacher name and logo) and the page-limit question keeps a free-number option. `basic-math` gains the
  "Conjunto de los números racionales (Q)" topic with the fraction, decimal, compare and percent
  families.

## 0.1.0

### Minor Changes

- 266a3d3: First release of Evalua. Teacher profile (`teacher.yaml` with validated logo copy), workspace and
  exam numbering, the guided exam interview with headless continuation, and the `evalua_profile`,
  `evalua_answer` and `evalua_status` tools with the `/evalua:init`, `/evalua:new` and `/evalua:status`
  commands. Plus the math core (exact rational and polynomial arithmetic, seeded RNG, linear and
  quadratic solvers), the extensible YAML knowledge base with workspace layering and the `EVL-KB-*`
  checks, the `basic-math` pack, and the first item families (`integer-ops`, `order-of-operations`,
  `gcd-lcm`, `fraction-simplify`, `fraction-ops`, `decimal-ops`, `percent`).
