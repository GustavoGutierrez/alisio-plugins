---
"@alisio/plugin-evalua": minor
---

Cover primary school (Primero to Quinto) with thirteen new topics, each backed by its own exact,
verified item family, and draw the figures they need.

- New `primary-math` topics: place value and comparing numbers, time and clocks, money in pesos,
  number patterns, the equal sign and the missing number, fractions as part of a whole,
  pictograms and bar charts, perimeter and area of rectangles and L-shapes, volume with cubes and
  prisms, angles, fraction/decimal/percent, and simple probability. New `basic-math` topic: the
  coordinate plane (first quadrant at basico for Quinto, all four quadrants from intermedio).
- Merged into existing topics: parity, multiples and divisor counts join "Divisibilidad, MCD y
  MCM" (now Cuarto to Séptimo), and "Estadística descriptiva" now also lists Cuarto and Quinto.
- Every new topic fills at least 20 distinct questions per supported type and level; open answers
  are offered where a short written answer fits, multiple choice is never offered.
- New figures, all drawn from the same parameters as the answer, with a Spanish accessible title
  and hatching or letters instead of colour so they print in black and white: analog clock,
  fraction circle, pictogram, labelled L-shape/rectangle, unit-cube stack, numbered coordinate
  grid, spinner and bag of balls; bar charts, angles, prisms and fraction bars gain labelled
  variants. Existing figures render byte for byte as before.
- The figure code is now one small component per figure behind a registry, so new figures are one
  file and one line.
- A topic with several item families now rotates through them slot by slot instead of letting the
  first family fill nearly every question (affects algebraic expressions, fractions, rational
  numbers, polynomials, linear equations, whole-number operations and divisibility).
- The chat interview matches a grade typed as free text ("primero", "1º", "grado 3"), so the
  primary grades can be chosen there as in the app.
