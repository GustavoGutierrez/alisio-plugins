# Third-party notices

`@alisio/plugin-evalua` vendors the following third-party resources so a build is hermetic (no
network access) and reproducible.

## KaTeX

- Files: `templates/html/vendor/katex/katex.min.js`, `katex.min.css`, `fonts/*.woff2`.
- Version: 0.19.0.
- License: MIT. The upstream license text is kept verbatim in
  `templates/html/vendor/katex/LICENSE` (Copyright (c) 2013-2020 Khan Academy and other
  contributors).
- Use: server-side typesetting in an isolated `vm` context; the CSS and its `woff2` fonts are
  inlined as data URIs so the generated HTML references no network resource.

The bundled KaTeX fonts are distributed under the same MIT license as KaTeX.
