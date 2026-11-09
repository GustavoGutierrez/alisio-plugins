---
"@alisio/plugin-scribe": patch
---

Check LaTeX documents against the bundled engine before compiling. A new
`compiler/bundle-manifest.json` lists the classes, packages and babel locales the bundle ships;
`pdf.compile` fails fast with `latex_package_missing` (listing only the missing names) and
generated drafts carry the same report. The writer now loads babel with `provide=*`, relies on
the engine's Unicode fonts instead of `inputenc`/`fontenc`/`lmodern`, and prefers packages the
bundle guarantees. `vendor-tex-bundle.py` takes the TEXMF roots to snapshot, adds generated font
maps from TEXMFVAR, and writes the manifest.
