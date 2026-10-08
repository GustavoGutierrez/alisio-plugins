# @alisio/plugin-google-chat

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

- 1f89d4e: Rename the shipped `google-chat-context` skill to `gchat-context` so every resource carries the plugin's `gchat-` prefix. The npm name, plugin id, and tools are unchanged.

## 0.1.1

### Patch Changes

- f697b89: Widen the `@alisio/sdk` peer range to `<0.5.0` so the packages install on Alisio core 0.2.x through 0.4.x. Typechecked against `@alisio/sdk@0.3.0`; no behavior change.
