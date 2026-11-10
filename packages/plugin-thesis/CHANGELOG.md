# @alisio/plugin-thesis

## 0.6.0

### Minor Changes

- c7d51f9: Adds **Thesis Studio** ("Estudio de tesis"), a full-page guided app for Alisio 0.11.6 or newer: a progress bar over the seven phases and one "Next step" button, the interview as a wizard, the research and chapter plans with their gates, a chapters board, the evidence library, the review findings, checks, PDF builds with an in-app preview and download, Gate C and the final document, and settings (model, rules and styles, ethics requirements, file editors, Typst setup). It follows Alisio's language (English or Spanish) and light or dark theme. Long work runs in the background with progress and Cancel.
  
  Every command, tool, agent and the chat keep working as before; on older hosts the app is simply not registered and `/thesis:status` names the Alisio version it needs. New for the chat: only one surface changes a thesis at a time, so a state-changing command run while the app is working answers `Blocked: Thesis Studio is running ...`; and a model chosen in the app (`settings.model`) is used by every assistant, chat included, with a note when it is not available. The README's SDK range now matches the package (`>=0.9.0 <0.12.0`).

## 0.5.3

### Patch Changes

- Declare the plugin icon in `package.json` (`alisio.icon`) so Alisio shows it for installed plugins, and build against `@alisio/sdk` 0.11.4 (peer range unchanged).

## 0.5.2

### Patch Changes

- 3c11bd8: Ship a square `icon.svg` (512×512) in the package, used by the catalog and host UIs.

## 0.5.1

### Patch Changes

- 7df00a0: Widen the `@alisio/sdk` peer range to `>=0.9.0 <0.12.0` so the plugin installs alongside plugins built for `@alisio/sdk` 0.11 (caret ranges on 0.x pin a single minor and made npm reject mixed installs).

## 0.5.0

### Minor Changes

- Update the `@alisio/sdk` dependency to `^0.9.0` (peer) and `0.9.0` (dev) across every plugin.

## 0.4.0

### Minor Changes

- fc350a1: Update the `@alisio/sdk` dependency to `^0.8.0` (peer) and `0.8.0` (dev) across every plugin. The release
  only adds the optional Proof API, two events and optional fields, so no plugin code changes are needed.

## 0.3.0

### Minor Changes

- b7fda5b: Update the `@alisio/sdk` dependency to `^0.7.0` (peer) and `0.7.0` (dev) across every plugin, and refresh
  the pinned toolchain and runtime dependencies to their latest compatible releases. Typecheck and the full
  check stay green with the new SDK.

## 0.2.0

### Minor Changes

- Requires @alisio/sdk ^0.6.0 (Alisio 0.6.0)

## 0.1.4

### Patch Changes

- c06361a: Update the `@alisio/sdk` dependency to `^0.5.1` (peer) and `0.5.1` (dev) across every plugin. The API
  surface used is unchanged: typecheck and the full check stay green with the new SDK.

## 0.1.3

### Patch Changes

- 9e7e20f: Update the `@alisio/sdk` dependency to `^0.5.0` (peer) and `0.5.0` (dev) across every plugin. The API
  surface used is unchanged: typecheck and the full test suite stay green with the new SDK.

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
