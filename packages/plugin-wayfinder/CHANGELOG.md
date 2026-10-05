# @alisio/plugin-wayfinder

## 0.2.0

### Minor Changes

- 1f89d4e: Prefix every shipped agent and skill with `wf-` (for example `wf-planner` and `wf-verify`) so they no longer collide with other plugins or the host catalog, and move the package directory to `packages/plugin-wayfinder`. The npm name, plugin id, and commands are unchanged.

## 0.1.2

### Patch Changes

- f697b89: Widen the `@alisio/sdk` peer range to `<0.5.0` so the packages install on Alisio core 0.2.x through 0.4.x. Typechecked against `@alisio/sdk@0.3.0`; no behavior change.

## 0.1.1

### Patch Changes

- Declare the methodology-harness catalog category
