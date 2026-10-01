# @alisio/plugin-brave-search

## 0.1.1

### Patch Changes

- e71c3d0: Added `@alisio/plugin-brave-search`: Brave Search for coding agents. `brave_llm_context` grounds
  answers with pre-extracted page content from Brave's LLM Context API under a token budget, and
  `brave_web_search` is a compact titles-and-URLs fallback. The API key is read from
  `BRAVE_SEARCH_API_KEY`, then `BRAVE_API_KEY`, then a `0600` key file managed by
  `/brave-search:set-key`; `/brave-search:status` shows the active source without printing the key.
