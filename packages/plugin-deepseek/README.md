# @alisio/plugin-deepseek

The dedicated DeepSeek model provider for [Alisio](https://github.com/GustavoGutierrez/alisio).
Select it in `/connect`, discover models from the DeepSeek catalog, and talk to the Chat
Completions or Responses API.

## What it is

A `model-provider` plugin that registers the `deepseek` provider with the Alisio host. Credentials
are managed by Alisio and are never persisted by this plugin: keys live in the global credentials
store or an environment variable.

## Installation

```bash
alisio install npm:@alisio/plugin-deepseek   # global, per-user
alisio plugins list                          # confirm it is installed
```

For an embedded host, load the package (or its `dist/index.js`) through your plugin host instead.

## Using it: `/connect`

1. Run `alisio`, then `/connect` and choose **DeepSeek**.
2. Fields: **API key** (secret, required), **API key environment variable** (default
   `DEEPSEEK_API_KEY`), **API mode** (`chat` or `responses`), **base URL** (default
   `https://api.deepseek.com`; change only for a DeepSeek-compatible proxy).
3. Pick a model from the discovered catalog — for example `deepseek/deepseek-chat`.

The key is read from the stored credential first, then from `process.env[apiKeyEnv]` — usually:

```sh
export DEEPSEEK_API_KEY=...   # never put the key in config files, profiles or READMEs
```

## Features

- Model discovery from the DeepSeek catalog (`GET /models`) with honest context windows.
- Chat Completions and Responses modes (default `chat`); bearer auth, `max_tokens` output budget.
- Provider-side usage reporting while streaming (`streamUsage: true`).
- Credentials never leave the Alisio credentials store or the named environment variable.

While registered, the provider also appears in `/model` and `alisio doctor`.

## Requirements

Node.js **>= 22.16** and an Alisio host with `@alisio/sdk` `>=0.1.0-alpha.10`.

## License

MIT. Maintained by Gustavo Gutiérrez Mercado. Source:
<https://github.com/GustavoGutierrez/alisio-plugins/tree/main/packages/plugin-deepseek> ·
npm: <https://www.npmjs.com/package/@alisio/plugin-deepseek>.