# @alisio/plugin-wayfinder

## 0.5.0

### Minor Changes

- fc350a1: Update the `@alisio/sdk` dependency to `^0.8.0` (peer) and `0.8.0` (dev) across every plugin. The release
  only adds the optional Proof API, two events and optional fields, so no plugin code changes are needed.

## 0.4.0

### Minor Changes

- b7fda5b: Update the `@alisio/sdk` dependency to `^0.7.0` (peer) and `0.7.0` (dev) across every plugin, and refresh
  the pinned toolchain and runtime dependencies to their latest compatible releases. Typecheck and the full
  check stay green with the new SDK.

## 0.3.0

### Minor Changes

- Requires @alisio/sdk ^0.6.0 (Alisio 0.6.0)

## 0.2.3

### Patch Changes

- c06361a: Update the `@alisio/sdk` dependency to `^0.5.1` (peer) and `0.5.1` (dev) across every plugin. The API
  surface used is unchanged: typecheck and the full check stay green with the new SDK.

## 0.2.2

### Patch Changes

- 9e7e20f: Update the `@alisio/sdk` dependency to `^0.5.0` (peer) and `0.5.0` (dev) across every plugin. The API
  surface used is unchanged: typecheck and the full test suite stay green with the new SDK.

## 0.2.1

### Patch Changes

- 928b6aa: Update the `@alisio/sdk` dependency to `^0.4.5` (peer) and `0.4.5` (dev) across every plugin. The API
  surface used is unchanged: typecheck and the full test suite stay green with the new SDK.

## 0.2.0

### Minor Changes

- 1f89d4e: Prefix every shipped agent and skill with `wf-` (for example `wf-planner` and `wf-verify`) so they no longer collide with other plugins or the host catalog, and move the package directory to `packages/plugin-wayfinder`. The npm name, plugin id, and commands are unchanged.

## 0.1.2

### Patch Changes

- f697b89: Widen the `@alisio/sdk` peer range to `<0.5.0` so the packages install on Alisio core 0.2.x through 0.4.x. Typechecked against `@alisio/sdk@0.3.0`; no behavior change.

## 0.1.1

### Patch Changes

- Declare the methodology-harness catalog category
