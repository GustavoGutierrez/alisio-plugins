---
name: cards-author
description: "Trigger: greeting card, certificate, badge, banner, collage, chart or dynamic card image; render or save a card in the workspace. Guides the Cardsmith flow: catalog, design, adjust, render, export."
license: MIT
metadata:
  author: alisio-contributors
  version: 1.0
---

# Cardsmith authoring flow

Load before designing, rendering or exporting any card. The model writes text; the plugin draws
every pixel. Follow this one sequence and let the template defaults do the rest.

## Sequence

1. **Catalog only when needed.** Call `card_catalog` only when the template, family, palette or a
   compatible size is unclear. It returns ids, required fields and feature flags. Pass `family` or
   `templateId` to narrow it. Never dump the whole catalog into chat; quote only the few ids you
   chose.

2. **Design with `card_design`.** Send `family`, `templateId` and `content` with the user's text.
   The template carries `defaultPalette`, `defaultFontPair` and its compatible sizes, so do not
   ask for palette, size or font unless the user asked for changes. Ask only truly indispensable
   data, at most one question per turn (a certificate needs the recipient name; a greeting card
   usually needs nothing). Omitted fields stay out; do not invent content.

3. **Summarize and adjust.** Read the returned `draftId` and `revision` and show a compact
   summary: draftId, revision, dimensions, palette and font-pair names, warnings. Apply every
   change with `card_update` and the `expectedRevision` you last saw; `content` merges per key and
   the other fields replace. Palette, size and font changes are deterministic — never re-render
   by hand or ask the model to redraw anything. On `REVISION_MISMATCH`, reuse the revision from
   the last result.

4. **Render.** Use `card_render` with `mode: "preview"` while iterating and `mode: "final"` when
   the user is happy. The resulting PNG or JPEG appears in chat as an image. Preview is smaller
   and never replaces the final file.

5. **Export.** Use `card_export` to save the final image into the workspace. `copy` (default)
   keeps the working file; use `move` only when the user explicitly asks to move it, and pass
   `overwrite: true` only when replacing a file is intended. Explicitly explain the difference
   when the destination is remote: download saves to the user's browser machine, export writes
   to the Alisio server workspace.

## Rules

- Never paste base64, byte counts, layout geometry, font files or path points into chat; those
  are plugin internals. Report ids, dimensions, formats, names and warnings.
- A QR payload is data the user provided. Draw it when the template supports QR, but never claim
  it proves authenticity or identity.
- Rendering is deterministic: the same spec, seed and environment produce the same image. Reuse a
  seed when the user re-renders a revised card so the decoration stays stable.
- Errors carry an actionable code (`INVALID_SPEC`, `UNKNOWN_TEMPLATE`, `TEXT_OVERFLOW`,
  `QR_TOO_DENSE`, `IMAGE_TOO_LARGE`, `REVISION_MISMATCH`, `EXPORT_CONFLICT`, and so on). Read the
  message, fix the reported field or ask the user for the missing data, then retry.
- Keep one card per conversation turn: design, adjust and render that card before starting the
  next one.
