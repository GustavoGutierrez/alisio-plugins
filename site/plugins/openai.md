---
title: "OpenAI"
description: "Official OpenAI Responses API provider"
pageClass: "plugin-detail"
---

<PluginDetail slug="openai" />

Official OpenAI Responses API provider for Alisio (`openai`). Install with `alisio install npm:@alisio/plugin-openai`, then connect using an OpenAI API key or `OPENAI_API_KEY` (a stored key takes precedence).

This release uses streaming, function tools, stateless continuation, model discovery, usage reporting, cancellation, and `store: false`. The host must choose an active model; availability is account-specific.

## Requirements and authentication

Node.js >= 22.16 and an OpenAI API-billed key are required. OpenCode OAuth, ChatGPT Plus/Pro, Codex, Max, and other subscription credentials are intentionally unsupported in this release. This plugin neither reads nor imports them.

## License

MIT.
