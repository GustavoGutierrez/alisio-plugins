---
title: "Web Search"
description: "Provider-neutral external web search and opt-in fetch tools"
pageClass: "plugin-detail"
---

<PluginDetail slug="web-search" />

Provider-neutral `web_search` and `web_fetch` tools for [Alisio](https://github.com/GustavoGutierrez/alisio).

## Privacy and permissions

Both tools have the `external` effect. A search query or fetch URL is sent to the selected remote
provider; result content is returned only to the current tool call and is not cached or logged by
this plugin. Keyless Exa MCP access is best-effort and rate-limited. The remote provider may process
queries, so it is neither confidential nor guaranteed.

`web_fetch` is disabled by default. Enable it only in a non-secret profile after considering the
outbound URL flow. The plugin accepts only public HTTP(S) URLs, rejects credentials, fragments and
private/reserved network ranges, validates DNS answers, and returns bounded text. It does not use a
browser, cookies, custom headers, proxies, or direct arbitrary-page scraping.

## Install

```bash
alisio install npm:@alisio/plugin-web-search
```

The default route is keyless hosted Exa MCP. It requires no API key, but availability is best-effort.
To configure another route, provide a non-secret `ALISIO_WEB_SEARCH_PROFILE` JSON object and place
keys in Alisio credentials where the host supports them, or use the named environment fallbacks:

```bash
export ALISIO_WEB_SEARCH_PROFILE='{"providerRoute":"searxng,exaMcp","searxngUrl":"https://search.example.net","enableFetch":false}'
export BRAVE_SEARCH_API_KEY='…' # or TAVILY_API_KEY, JINA_API_KEY, FIRECRAWL_API_KEY, EXA_API_KEY
```

An explicit comma-separated route is tried strictly in its declared order for search. A request with
`provider` uses only that provider. No failed request is relayed to an unrelated provider.

## Providers

| Provider | Search | Fetch | Configuration |
| --- | --- | --- | --- |
| Exa MCP | Yes, default | Yes, when `enableFetch` is true | Keyless best-effort hosted MCP |
| SearXNG | Yes | No | Explicit self-hosted `searxngUrl` |
| Brave | Yes | No | `BRAVE_SEARCH_API_KEY` or credential |
| Tavily | Yes | Yes, when `enableFetch` is true | `TAVILY_API_KEY` or credential |
| Jina | Yes | Yes, when `enableFetch` is true | `JINA_API_KEY` or credential |
| Firecrawl | Yes | Yes, when `enableFetch` is true | `FIRECRAWL_API_KEY` or credential |
| Exa API | Yes | No | `EXA_API_KEY` or credential |

SearXNG has no public default: choose and operate an instance you trust. The plugin makes no
unlimited-free claim and deliberately does not scrape unsupported search engines.

## Inputs and output

`web_search` requires `query` (1–512 characters) and accepts `maxResults` (1–20, default 5),
`language`, `country`, `safeSearch`, `freshness`, `includeDomains`, `excludeDomains`, and `provider`.
It returns only normalized source results: title, canonical public URL, optional snippet/date/score/site
name, and provider identity—never a generated answer or raw provider payload.

Node.js **>= 22.16** and an Alisio host with `@alisio/sdk` `>=0.1.0-alpha.10` are required.

## License

MIT.
