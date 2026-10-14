# @alisio/plugin-material-icons

## 0.7.0

### Minor Changes

- b7fda5b: Update the `@alisio/sdk` dependency to `^0.7.0` (peer) and `0.7.0` (dev) across every plugin, and refresh
  the pinned toolchain and runtime dependencies to their latest compatible releases. Typecheck and the full
  check stay green with the new SDK.

## 0.6.0

### Minor Changes

- Requires @alisio/sdk ^0.6.0 (Alisio 0.6.0)

## 0.5.2

### Patch Changes

- c06361a: Update the `@alisio/sdk` dependency to `^0.5.1` (peer) and `0.5.1` (dev) across every plugin. The API
  surface used is unchanged: typecheck and the full check stay green with the new SDK.

## 0.5.1

- Moved the package from the `alisio` monorepo into `alisio-plugins`.
- Self-contained `icon-theme` provider: vendors 1251 Material Icon Theme SVGs and a VSCode-style
  manifest, registering absolute `manifestPath`/`iconsDir` with no external icon dependency.
