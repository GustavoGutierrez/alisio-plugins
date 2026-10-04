# Third-party notices

This package vendors two Typst packages, three browser libraries for the Chrome/HTML output and three CSL styles, and depends on seven npm packages. Each keeps its own
license; the full license texts ship next to the vendored files.

## Vendored Typst packages (`typst-packages/preview/`)

These are copied unmodified from the Typst package registry and loaded offline through
`--package-path`; nothing is downloaded at build time.

| Package | Version | License | Files |
| --- | --- | --- | --- |
| mitex | 0.2.7 | Apache-2.0 | `typst-packages/preview/mitex/0.2.7/` (license: `LICENSE`) |
| merman | 0.3.0 | MIT OR Apache-2.0 | `typst-packages/preview/merman/0.3.0/` (licenses: `LICENSE`, `THIRD_PARTY_NOTICES.md`, `THIRD_PARTY_LICENSES/`) |

merman bundles the following components in its WebAssembly plugin. Their license texts are in
`typst-packages/preview/merman/0.3.0/THIRD_PARTY_LICENSES/`:

| Component | Version | License |
| --- | --- | --- |
| cose-base 1.x | 1.0.3 | MIT |
| cose-base 2.x | 2.2.0 | MIT |
| Cytoscape.js | 3.34.0 | MIT |
| cytoscape.js-cose-bilkent | 4.1.0 | MIT |
| cytoscape.js-fcose | 2.2.0 | MIT |
| d3-shape | 3.2.0 | ISC |
| Dagre | 2.0.2 | MIT |
| DOMPurify | 3.4.13 | Apache-2.0 OR MPL-2.0 |
| fmin | 0.0.4 | BSD-3-Clause |
| Graphlib | 2.2.4 | MIT |
| layout-base 1.x | 1.0.2 | MIT |
| layout-base 2.x | 2.0.1 | MIT |
| Mermaid | 11.16.1 | MIT |
| rough-rs (roughr) | 0.12.0 | MIT |
| Rough.js | 4.6.6 | MIT |
| sanitize-url | 7.1.1 | MIT |
| @upsetjs/venn.js | 2.0.0 | MIT |
| ZenUML Core | 3.50.1 | MIT |
| Eclipse Layout Kernel | 0.9.1 | EPL-2.0 |
| elkjs | 0.9.3 | EPL-2.0 |
| wasm-minimal-protocol | 0.2.0 | Unlicense |

The Eclipse Layout Kernel and elkjs are distributed under the Eclipse Public License 2.0; their
source is available from https://github.com/eclipse-elk/elk and https://github.com/kieler/elkjs.

## Vendored browser libraries (`templates/html/vendor/`)

Used only by the Chrome PDF fallback and the HTML preview (`/thesis:build --html`). They are copied
unmodified from the npm tarballs listed below (versions pinned) and loaded from the local build
directory; the page never fetches anything from the network. KaTeX is also evaluated in Node (in an
isolated `vm` context) to typeset formulas before the page is written. Each folder keeps its upstream
license text.

| Library | Version | License | Source tarball (SHA-256) | Vendored file (SHA-256, bytes) |
| --- | --- | --- | --- | --- |
| Paged.js | 0.4.3 | MIT | `pagedjs-0.4.3.tgz` (`a79baaa94d15cf952e6327950fa886ba7533bdce92194b677d9d1b4cce6c17c5`) | `pagedjs/paged.polyfill.min.js` (`f44e35a6d5106d819c3415fd38591de04d3834343c14e50a562b84257e204692`, 503181) |
| KaTeX | 0.19.0 | MIT | `katex-0.19.0.tgz` (`d8e49f2fea6eeed7cdae2cf4fd48e2f1d348758aa9e5740715e4533c2c96d1ee`) | `katex/katex.min.js` (`103a53763cc033bba8d175bf3f0ba597c3505c9b6747dd3f2c7bc2a6bfcc8ae7`, 272868); `katex/katex.min.css` (`d4ab5b8ee16989b070cdb0ea24bd6ad48fc8df1b787f280f29d3ae4f959f2c00`, 24793); `katex/fonts/*.woff2` (20 files, 263888 bytes; the CSS lists the woff and ttf fallbacks, which are not shipped) |
| Mermaid | 11.16.1 | MIT | `mermaid-11.16.1.tgz` (`ebd9885111092c78cefc79a76f6c1dc34ed5b834b02ae8f338227ce79c003de4`) | `mermaid/mermaid.min.js` (`18327bef70d96fb505fe7287d9f6a7362ebf07ff6576ddfaffb1a06f3e1a2954`, 3566058) |

`mermaid.min.js` is the upstream single-file bundle; it includes the components that Mermaid declares
as dependencies (among them d3, dagre-d3-es, Cytoscape and its layouts, DOMPurify, KaTeX, khroma, marked,
roughjs, stylis, ts-dedent, uuid, dayjs, es-toolkit, @braintree/sanitize-url and @upsetjs/venn.js)
under MIT, ISC, BSD-3-Clause, Apache-2.0 or MPL-2.0 terms; the bundle's own comments and the
tables for the same Mermaid release in the merman section above name them. citeproc-js is not used:
the HTML output formats citations with a small built-in formatter.

## Vendored citation styles (`styles/`)

| File | Source | License |
| --- | --- | --- |
| `apa.csl` | https://github.com/citation-style-language/styles (2026-10-04); **modified derivative**: the `date` and `date-issued-month-day` macros print month and day with their own prefix so that sources without a month no longer render `(2012,)` under Typst/Hayagriva. The change is noted in the style's `<info>` and header comment | CC BY-SA 3.0 |
| `ieee.csl` | https://github.com/citation-style-language/styles (copied unmodified, 2026-10-04) | CC BY-SA 3.0 |
| `icontec-ntc1486-2022.csl` | Written for this package from public NTC 1486:2022 library guides (provisional) | CC BY-SA 3.0 |

Each style keeps its `<rights>` notice. The license text is in `styles/LICENSE-CSL`; the
golden fixtures under `styles/fixtures/` are renderings of these styles and share their license.

## Typst CLI (not bundled)

The Typst command-line compiler (Apache-2.0, https://github.com/typst/typst) is not part of this
package. `/thesis:setup` downloads the pinned release from GitHub after verifying its SHA-256, or
you point `ALISIO_THESIS_TYPST` at your own copy.

## npm dependencies

| Package | License |
| --- | --- |
| markdown-it | MIT |
| markdown-it-footnote | MIT |
| yaml | ISC |
| vega | BSD-3-Clause |
| vega-lite | BSD-3-Clause |
| vega-interpreter | BSD-3-Clause |
| d3-dsv | ISC |
