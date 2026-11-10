# @alisio/plugin-scribe

## 0.3.5

### Patch Changes

- 5127d51: Scribe no longer gets stuck on "Scribe is unavailable" after a single transient host error (for example when returning to Alisio): the studio re-checks before showing that screen, which now has a "Try again" button and recovers on its own when the window is shown again, restoring the open document.
  
  Adds a Spanish README (`README.es.md`) mirroring the English one.

## 0.3.4

### Patch Changes

- b1918d7: Check LaTeX documents against the bundled engine before compiling. A new
  `compiler/bundle-manifest.json` lists the classes, packages and babel locales the bundle ships;
  `pdf.compile` fails fast with `latex_package_missing` (listing only the missing names) and
  generated drafts carry the same report. The writer now loads babel with `provide=*`, relies on
  the engine's Unicode fonts instead of `inputenc`/`fontenc`/`lmodern`, and prefers packages the
  bundle guarantees. `vendor-tex-bundle.py` takes the TEXMF roots to snapshot, adds generated font
  maps from TEXMFVAR, and writes the manifest.
- Redesign the Scribe studio: a new home (prompt card with sources, language and discipline pills, idea templates, document cards with derived status, filters and a drafting activity bar) and a three-column document view (structure and files, a conversation-style assistant with job stages and proposed-change summaries, and a PDF preview with paging and zoom). Fix the PDF preview being replaced by an error after rendering (release the document through its pdf.js loading task).
- b1918d7: Ship a reproducible TeX Live 2023 bundle (Spanish, Portuguese, French and German babel, siunitx, algorithms, biblatex, pgfplots, recommended fonts with generated font maps), built from a documented install-tl profile. The bundle is trimmed to 106 MB (no Type1 copies of OpenType fonts, AFM metrics, MetaPost data or image-heavy novelty packages) so the package stays within npm's size limit.
- b1918d7: Show the Scribe icon in the studio header, give dialogs descriptive titles and spacing (history items, settings buttons), and keep "Download LaTeX ZIP" in the settings button row.

## 0.3.3

### Patch Changes

- Trust Alisio's approval: stop re-checking the session's standing grants, which rejected actions the user had just approved once, and warn about read-only only for a truly read-only session.

## 0.3.2

### Patch Changes

- f70d57a: Name the missing permission (write or process) and how to grant it when Alisio rejects a studio action.
- Require Alisio 0.11.6, whose studio actions ask for approval like the chat; use the host's denied `effect`, wait for approval prompts (up to 10 minutes), and show the cover in the README.
- Show "Waiting for your approval in Alisio…" while a write or process action waits on the approval prompt.

## 0.3.1

### Patch Changes

- Add the Scribe studio on the shipped Alisio 0.11.5 plugin apps API, with a static Tectonic engine that builds PDFs on any x86_64 Linux.
