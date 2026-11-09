---
name: scr-latex
description: "Trigger: drafting or revising a Scribe LaTeX manuscript, or explaining a Scribe PDF build error. Create conservative LaTeX manuscripts and explain compilation diagnostics."
---

Use article, amsmath, amssymb and graphicx for the baseline. Escape prose metacharacters, keep
equations syntactically valid and preserve unknown user macros. Do not enable shell escape.
Use supplied assets through relative paths. Missing assets and bibliography entries are issues
to report, not permission to invent content. Return proposals; the host owns persistence.

Scribe compiles with Tectonic (XeTeX) and a fixed offline bundle:
- Language: \usepackage[<language>,provide=*]{babel}, e.g. \usepackage[spanish,provide=*]{babel}.
  Without provide=* babel fails with "Unknown option" for languages shipped only as .ini locales.
  English documents may omit babel.
- Fonts: rely on the default Unicode fonts. inputenc, fontenc ([T1]) and lmodern are unnecessary
  and may fail; fontspec is fine.
- Packages: prefer amsmath, amssymb, amsthm, mathtools, graphicx, xcolor, booktabs, tabularx,
  multirow, caption, subcaption, float, geometry, enumitem, hyperref, url, natbib, csquotes,
  fontspec, listings and tikz. siunitx, biblatex and algorithm packages may be missing; use natbib
  with references.bib for citations.
- A `latex_package_missing` failure lists the packages or babel languages the bundle lacks:
  remove or replace them, or add provide=* where the hint says so.
