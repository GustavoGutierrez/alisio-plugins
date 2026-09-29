---
title: "Literature Research"
description: "Safe scholarly metadata and abstract research"
pageClass: "plugin-detail"
---

<PluginDetail slug="literature-research" />

Zero-key scholarly metadata tools for Alisio: `literature_search`, `paper_discover`, and `literature_read`.

All tools have the `external` effect. Queries and identifiers are sent only to fixed official HTTPS APIs: OpenAlex, Crossref, and arXiv. The plugin does not persist queries, identifiers, metadata, abstracts, headers, or caches.

It reads **metadata and a source-provided bounded abstract only**. It does not fetch arbitrary URLs, landing pages, HTML, PDFs, or full text, and it rejects redirects.

## Install

```bash
alisio install npm:@alisio/plugin-literature-research
```

`literature_search` searches OpenAlex. `paper_discover` supports `openalex`, `crossref`, and `arxiv`. `literature_read` accepts exactly one DOI, arXiv identifier, or OpenAlex work ID and discloses the fixed source used.

Inputs are bounded: query 1–512 characters, result limit 1–10, and years 1600 through next year. Results are normalized, escaped, capped, and retain source provenance. No generated relevance score is added.

Requires Node.js **>= 22.16** and an Alisio host with `@alisio/sdk` `>=0.1.0-alpha.10`.

## License

MIT.
