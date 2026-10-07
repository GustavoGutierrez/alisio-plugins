# @alisio/plugin-brave-search

## 0.1.3

### Patch Changes

- 928b6aa: Update the `@alisio/sdk` dependency to `^0.4.5` (peer) and `0.4.5` (dev) across every plugin. The API
  surface used is unchanged: typecheck and the full test suite stay green with the new SDK.

## 0.1.2

### Patch Changes

- f697b89: Widen the `@alisio/sdk` peer range to `<0.5.0` so the packages install on Alisio core 0.2.x through 0.4.x. Typechecked against `@alisio/sdk@0.3.0`; no behavior change.

## 0.1.1

### Patch Changes

- e71c3d0: Added `@alisio/plugin-brave-search`: Brave Search for coding agents. `brave_llm_context` grounds
  answers with pre-extracted page content from Brave's LLM Context API under a token budget, and
  `brave_web_search` is a compact titles-and-URLs fallback. The API key is read from
  `BRAVE_SEARCH_API_KEY`, then `BRAVE_API_KEY`, then a `0600` key file managed by
  `/brave-search:set-key`; `/brave-search:status` shows the active source without printing the key.
