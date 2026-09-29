# @alisio/plugin-opencode

The OpenCode Console (Zen) model provider for [Alisio](https://github.com/GustavoGutierrez/alisio).
Discover the unauthenticated OpenCode model catalog and route each model to the protocol OpenCode
documents for it.

## What it is

A `model-provider` plugin that registers the `opencode` provider with the Alisio host. Model
references use the canonical `opencode/<model-id>` form.

## Installation

```bash
alisio install npm:@alisio/plugin-opencode   # global, per-user
alisio plugins list                          # confirm it is installed
```

For an embedded host, load the package (or its `dist/index.js`) through your plugin host instead.

## Using it: `/connect`

1. Run `alisio`, then `/connect` and choose **OpenCode Console (Zen)**.
2. Enter the **API key** (secret, required). It is stored only in the global credentials store
   (`credentials.json`, mode 0600) — never in the profile or configuration.
3. Pick a model from the discovered catalog (`https://opencode.ai/zen/v1/models`).

There is no hard-coded default API-key environment variable for this provider: the key is entered
in `/connect` and kept out of configuration files.

## Features

- Unauthenticated catalog discovery of `opencode/<model-id>` entries.
- Fail-closed routing from the documented protocol map: GPT, Grok and Muse through **Responses**;
  DeepSeek, GLM, Kimi, MiMo, MiniMax and documented compatible models through **Chat Completions**;
  Claude and documented Qwen models through **Anthropic Messages**.
- Gemini-native and System One entries are hidden rather than guessed.
- Requests send `user-agent: alisio/<version>` and an opaque, stable `x-opencode-session`
  conversation ID that never includes a workspace path, prompt or credential.

While registered, the provider also appears in `/model` and `alisio doctor`.

## Requirements

Node.js **>= 22.16** and an Alisio host with `@alisio/sdk` `>=0.1.0-alpha.10`.

## License

MIT. Maintained by Gustavo Gutiérrez Mercado. Source:
<https://github.com/GustavoGutierrez/alisio-plugins/tree/main/packages/plugin-opencode> ·
npm: <https://www.npmjs.com/package/@alisio/plugin-opencode>.