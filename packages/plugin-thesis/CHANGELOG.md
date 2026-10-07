# @alisio/plugin-thesis

## 0.1.2

### Patch Changes

- 928b6aa: Update the `@alisio/sdk` dependency to `^0.4.5` (peer) and `0.4.5` (dev) across every plugin. The API
  surface used is unchanged: typecheck and the full test suite stay green with the new SDK.

## 0.1.1

### Patch Changes

- The conversational agent now replies in prose in the user's language instead of a JSON envelope,
  can persist interview answers given in chat through the new `thesis_answer` tool (never approvals),
  and `/thesis:init` refuses a bare language code as the thesis folder and points to `--lang`.

## 0.1.0

### Minor Changes

- ba559b3: Initial release of Thesis Studio: an interview-driven thesis workflow with verified evidence,
  deterministic quality gates, workspace policy packs and styles, and fast Typst PDF builds (PDF/A
  on finalize) with a Chrome fallback and an HTML preview.
