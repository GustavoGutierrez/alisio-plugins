# @alisio/plugin-opencode-go

## 0.1.1

### Patch Changes

- Released as stable `0.1.1` from the `alisio-plugins` repository; the package previously shipped as `0.1.0-alpha.*` from the Alisio monorepo.
- Moved the DeepSeek, OpenCode Console (Zen) and OpenCode Go model providers out of the Alisio
  core repository into this monorepo, where each is versioned and published independently. They
  are no longer built-in Alisio plugins: install them with `alisio install npm:@alisio/plugin-...`.
