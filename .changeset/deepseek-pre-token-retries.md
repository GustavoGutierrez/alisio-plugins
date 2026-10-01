---
"@alisio/plugin-deepseek": patch
---

Retry transient request failures (408, 409, 429, 5xx and connection errors) up to two times with
exponential backoff before the first token arrives. Once the stream has started, failures are
never replayed.

Truncation (`finish_reason: "length"` / `response.incomplete`) no longer throws when nothing usable
was produced: the provider completes with `truncated: true`, and tool calls whose arguments are
incomplete or not valid JSON are dropped instead of returned half-built.
