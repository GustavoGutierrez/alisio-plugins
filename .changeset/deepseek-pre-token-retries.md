---
"@alisio/plugin-deepseek": patch
---

Retry transient request failures (408, 409, 429, 5xx and connection errors) up to two times with
exponential backoff before the first token arrives. Once the stream has started, failures are
never replayed.

Truncation (`finish_reason: "length"` / `response.incomplete`) no longer throws: the provider
completes with `truncated: true`, even with empty text, and passes tool calls through exactly as
received so the host can discard the cut ones.
