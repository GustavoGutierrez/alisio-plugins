# @alisio/plugin-deepseek

## 0.1.2

### Patch Changes

- c9e484d: Retry transient request failures (408, 409, 429, 5xx and connection errors) up to two times with
  exponential backoff before the first token arrives. Once the stream has started, failures are
  never replayed.
  
  Truncation (`finish_reason: "length"` / `response.incomplete`) no longer throws: the provider
  completes with `truncated: true`, even with empty text, and passes tool calls through exactly as
  received so the host can discard the cut ones.

## 0.1.1

### Patch Changes

- Released as stable `0.1.1` from the `alisio-plugins` repository; the package previously shipped as `0.1.0-alpha.*` from the Alisio monorepo.
- Moved the DeepSeek, OpenCode Console (Zen) and OpenCode Go model providers out of the Alisio
  core repository into this monorepo, where each is versioned and published independently. They
  are no longer built-in Alisio plugins: install them with `alisio install npm:@alisio/plugin-...`.
