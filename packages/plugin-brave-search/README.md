# @alisio/plugin-brave-search

Brave Search for coding agents in [Alisio](https://github.com/GustavoGutierrez/alisio). The main
tool calls Brave's **LLM Context** endpoint, which returns pre-extracted page content (text, code
blocks, tables, documentation) sized to a token budget, so a model can ground an answer from one
call instead of reading human-oriented result pages.

This is an independent plugin. It is not an official Brave product and is not affiliated with or
endorsed by Brave Software.

**When to pick this plugin.** `@alisio/plugin-web-search` is provider-neutral: it routes one generic
`web_search` across several providers, and its Brave route returns titles and snippets only. Pick
this plugin when you have a Brave Search API key and want Brave-specific, LLM-context-first
grounding with token budgets, relevance thresholds, and Goggles. Both plugins can be installed
together.

## Install

```bash
alisio install npm:@alisio/plugin-brave-search
```

## Configure the API key

Create a key in the [Brave Search API dashboard](https://api-dashboard.search.brave.com). The LLM
Context and Web Search endpoints need an active subscription that includes them. Then use **one**
of these, in order of precedence:

1. `BRAVE_SEARCH_API_KEY` environment variable.
2. `BRAVE_API_KEY` environment variable, the same name Brave's official MCP server
   (`@brave/brave-search-mcp-server`) uses, so an existing setup works with no changes.
3. A key stored for your user with `/brave-search:set-key <key>`.

```bash
# bash / zsh (add to ~/.bashrc or ~/.zshrc)
export BRAVE_SEARCH_API_KEY='your-key'
```

```fish
# fish
set -Ux BRAVE_SEARCH_API_KEY 'your-key'
```

```powershell
# PowerShell (current user, persistent; open a new terminal afterwards)
[Environment]::SetEnvironmentVariable('BRAVE_SEARCH_API_KEY', 'your-key', 'User')
```

Environment variables are read by the running process, so restart Alisio after changing them. A key
saved with `set-key` applies immediately. It is written atomically with mode `0600` (parent `0700`)
to `configHome/brave-search/api-key`, where `configHome` is `ALISIO_CONFIG_HOME`, else
`$XDG_CONFIG_HOME/alisio`, else `~/.config/alisio`. The command argument may be kept in your
session history, so prefer an environment variable on shared machines.

The key is never accepted through tool input, never logged or echoed, and is redacted from every
message. A missing or malformed key never crashes the plugin: tools return setup instructions and
make no network call.

## Commands

```
/brave-search:status          # which key sources are set and which one is active (value hidden)
/brave-search:set-key <key>   # store a key for this user (0600 file)
/brave-search:clear-key       # delete the stored key file
```

## Tools

Both tools have the `external` effect: the query is sent to `https://api.search.brave.com`.

- `brave_llm_context` — `POST /res/v1/llm/context`. Input: `query` (required, max 400 characters
  and 50 words), `maxTokens` (1024–32768, default 4096), `count` (1–50), `maxUrls` (1–50),
  `threshold` (`strict`, `balanced`, `lenient`, `disabled`), `freshness`, `country`, `searchLang`,
  and `goggles` (an https Goggle URL or inline rules). Output: numbered sources with title, URL,
  date when known, and the extracted content fenced between explicit external-content markers.
- `brave_web_search` — `GET /res/v1/web/search`. Input: `query`, `count` (1–20, default 8),
  `offset` (0–9), `freshness`, `country`, `searchLang`. Output: a compact list of titles, URLs,
  ages, and descriptions. Use it to find pages; use `brave_llm_context` to read them.

Out-of-range numbers are clamped to the documented range; other invalid input is rejected before any
network call. `freshness` accepts `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`.

### Writing good queries

Tool descriptions and the bundled `brave-llm-context` skill teach the agent to rewrite requests
instead of forwarding the user's sentence:

```
"ERR_REQUIRE_ESM" vite 8 build
next.js 16 route handlers site:nextjs.org
stripe webhook "No signatures found matching the expected signature" -php
```

## Safety and limits

- One fixed origin, no redirects, no cookies, no retries. A 30-second timeout combines with the host
  cancellation signal, and response bodies are capped at 4 MiB.
- Failures use a closed vocabulary with actionable hints: missing API key, authentication failed
  (401), not permitted (403, usually a plan that excludes the endpoint), request rejected (400/422),
  rate limited (429, with a retry hint from `Retry-After` or Brave's `X-RateLimit-Reset`), timed out,
  temporarily unavailable, invalid response, response exceeded limit. Raw response bodies are never
  shown.
- Remote content is untrusted: control characters are stripped, URLs must be `http(s)` without
  credentials, fields and output are bounded (about 5 characters per requested token), forged
  boundary markers are neutralized, and every result starts with a provenance notice.
- Brave's terms of service and privacy policy apply to your use of the API.

## Requirements

Node.js **>= 22.16** and an Alisio host with `@alisio/sdk` `>=0.1.0-alpha.10`. Zero runtime
dependencies.

## License

MIT.
