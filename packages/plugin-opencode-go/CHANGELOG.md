# @alisio/plugin-opencode-go

## 0.1.2

### Patch Changes

- f697b89: Widen the `@alisio/sdk` peer range to `<0.4.0` so the packages install on Alisio core 0.2.x and 0.3.x. Typechecked against `@alisio/sdk@0.3.0`; no behavior change.

## 0.1.1

### Patch Changes

- Released as stable `0.1.1` from the `alisio-plugins` repository; the package previously shipped as `0.1.0-alpha.*` from the Alisio monorepo.
- Moved the DeepSeek, OpenCode Console (Zen) and OpenCode Go model providers out of the Alisio
  core repository into this monorepo, where each is versioned and published independently. They
  are no longer built-in Alisio plugins: install them with `alisio install npm:@alisio/plugin-...`.
