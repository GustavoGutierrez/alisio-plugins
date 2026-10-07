---
"@alisio/plugin-evalua": patch
---

Fix the document output and localize the interview. The answer sheet and the solution book now
typeset their math with KaTeX instead of showing raw `\div` and `\dfrac`; the answer sheet shows the
localized type label (for example "Selección única"); and the exam information table shows the
teacher name. The interview is in Spanish and starts with the language question (then institution,
teacher name and logo) and the page-limit question keeps a free-number option. `basic-math` gains the
"Conjunto de los números racionales (Q)" topic with the fraction, decimal, compare and percent
families.
