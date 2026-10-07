# @alisio/plugin-evalua

## 0.7.0

### Minor Changes

- 2a30178: Primary school and the two missing MEN "pensamientos" are now covered. A new `primary-math` pack
  (grades Primero to Quinto) with `whole-number-operations` and `measurement` topics, plus a
  `statistics` topic for Sexto to Noveno, backed by five new item families: addition and subtraction of
  whole numbers, multiplication, division (exact and with a remainder), measurement conversions across
  the decimal metric system and time, and mean/median/mode over a small data set.

### Patch Changes

- 2a30178: Geometric figures are filled with soft tones again. Every figure picks one of five print-safe pastels
  (`#FFDA64`, `#A3D084`, `#F4B281`, `#E3E3E3`, `#8FA9DA`) from its own spec, so a figure keeps its colour
  across rebuilds and two different figures rarely match. The Venn circles keep their own tones with a
  translucent overlap and the fraction bar keeps its white bar so its shading still carries the
  fraction. Fixes two defects the fill exposed: a measured circle radius was read as pixels, so
  `radius: 4` drew a dot, and the cone was not a closed silhouette, so its fill distorted the shape.
- 2a30178: Two interview fixes. A slash-command answer whose ids do not belong to the pending round no longer
  resets the interview: it now reports which ids were sent, which round is pending and that nothing was
  reset. And the coordinator instructions now state that a round is answered only with what the teacher
  actually said, and that an option marked `(text)` must always carry its `id:text=` value.

## 0.6.6

### Patch Changes

- 3875fa8: The framed intro paragraph and the closing quote or verse use the same 16px corner radius as the
  header panel and a tighter side margin (`3mm 1mm`), so they line up with the rest of the sheet. The
  closing sits on a gray panel (the new `closingBg` theme token, `#D2D2D2` by default).

## 0.6.5

### Patch Changes

- 9109723: Exam sheet layout and numbering. The header data table uses a tighter side margin (`3mm 1mm`) and the
  header drops its bottom rule. Each section title sits in its own rounded frame and is numbered
  ("1. Selección única"). A new `numbering` spec field and interview question let the teacher choose how
  questions are numbered: `letters` (a, b, c… per section, the default), `section` (1.1, 1.2, 1.3…) or
  `continuous` (1..N). In a two-column layout a vertical rule separates the columns, but only when the
  items carry answer options; a plain list of exercises to solve is printed without it. PDFs are now
  page-numbered through the Chrome print footer (the new `pageOf` locale label, e.g. "Página 1 de 3").

## 0.6.4

### Patch Changes

- b509d27: Exam sheet polish. The header data table sits in a rounded frame (16px radius, `#D2D2D2`, exposed as
  the new `infoBorder` token) with a left and right margin, so its right border is no longer clipped at
  the page edge; the teacher, student and date rows own their line and span the full row width, and the
  date is a single-line mask `____ / ____ / ____`. Each question number is now a filled badge (the new
  `badgeBg` and `badgeText` tokens, black on white by default) instead of a bare `1.`. The intro and the
  closing quote or verse each sit in their own rounded frame. The duration uses a singular form, so a
  60-minute exam reads "1 hora" instead of "1 horas".

## 0.6.3

### Patch Changes

- 928b6aa: Update the `@alisio/sdk` dependency to `^0.4.5` (peer) and `0.4.5` (dev) across every plugin. The API
  surface used is unchanged: typecheck and the full test suite stay green with the new SDK.

## 0.6.2

### Patch Changes

- 301fec0: Resolve a free-text topic to a knowledge-base topic. The interview now offers three topic
  suggestions instead of two, and a description the teacher types in their own words is matched to a
  known `<pack>/<topic>` (by name and keywords) so the exam is generated instead of silently coming out
  empty. An unmatched description is still kept as free text but produces no items, so the coordinator
  is instructed to resolve the topic with `evalua_kb` and answer with the exact topic id.

## 0.6.1

### Patch Changes

- fb37d44: Localize the document output. Every family solution step is now in the exam language (they were in
  English), so the solution book reads in Spanish. The exam header is redesigned (an academic rule, the
  logo and the text aligned, and the band variant per theme) and the information table is now a
  two-column field grid with a prominent Nota box. The Fecha field is a fill-in mask that follows the
  language order: day / month / year in Spanish and month / day / year in English.

## 0.6.0

### Minor Changes

- 2c9d4b0: Add the `geometry` family. It generates figure-based items (area and perimeter of squares,
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

## 0.5.0

### Minor Changes

- 53ec515: Wire agent-authored item instructions end to end. The exam spec stores `itemPrompts` (per item
  family, with `{expr}` for the item's math); `evalua_exam` gains `action: "set-prompts"` to save them
  into `exam.yaml`; and `generateExam` applies them to any family while the answer and the distractors
  stay computed by code. The `evl-coordinator` and `evl-item-author` agents now propose the wording for
  the questionnaire they determined, so any exam topic can read as the questions the teacher wants.
- Geometry family: the `geometry` family now generates figure-based items (area and perimeter of
  squares, rectangles and equilateral triangles, and counting polygon sides), and the `basic-math`
  geometry topic uses it, so a geometry exam generates items with SVG figures out of the box.
- Fix: `verifyItem` no longer required a reference on a not-yet-frozen item, so static bank items were
  all rejected (their reference is assigned at freeze and validated at the exam level, `EVL-EXM-002`);
  bank-backed topics now generate again. Exams may be large: the interview accepts up to 100 questions,
  a bank of up to 400 items and up to 8 variants, and the fitter handles any page count (1 to 20 or the
  fewest legible pages).

## 0.4.0

### Minor Changes

- cc7e441: Every item now carries a real, concise Spanish instruction instead of a bare expression (for example
  "Simplifica la fracción {expr} hasta su forma irreducible." or "Resuelve la ecuación: {expr}"), for
  all families, so any exam topic reads as a question rather than just a number and an operation. A
  topic source can override the instruction with agent-authored templates through `params.prompts`,
  where `{expr}` is replaced by the item's math, so the coordinator can phrase the questions for the
  questionnaire it determined.
- d722121: The coordinator saves those instructions: `evalua_exam` gains `action: "set-prompts"`
  (agent-authored templates per item family, `{expr}` for the math), `generateExam` applies them to
  any family, and the answer and distractors stay computed by code.

## 0.3.0

### Minor Changes

- 490d97c: Add deterministic, print-friendly grayscale SVG figures generated by code: Venn/sets diagrams,
  Cartesian planes, triangles (equilateral, right, isosceles, scalene), squares, rectangles, regular
  polygons, circles, ellipses, rectangular prisms, cylinders, cones, number lines, fraction bars, bar
  charts and angles. Items embed a figure through a `figure` block in the mini markup, so a question
  can show a diagram with no external asset and no network; the static item schema and the item
  `stem` accept figure blocks. `basic-math` gains a geometry topic with figure-based items, and the
  `fraction-ops` stem and the `decimal-ops` solution now keep `\times`/`\div` inside the math so no
  formula renders as raw LaTeX.

## 0.2.1

### Patch Changes

- a288724: Add the in-page layout audit (spec 11.4). When a browser prints each density preset it also runs a
  deterministic in-page script that reports horizontal overflow, overlapping item boxes, text below
  the legibility floor, display formulas wider than their column and answer space below the floor.
  The chosen preset's report becomes `EVL-LAY-002` (error) for a real problem and `EVL-LAY-004`
  (warning) for a scaled formula. Also correct the README install command to `alisio install
  npm:@alisio/plugin-evalua` and document `alisio install --update` and the local `alisio --plugin`
  form.

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
