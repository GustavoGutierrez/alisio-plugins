---
title: "Bekko"
description: "Local Bekko System One decision provider: fast select, boolean and ordinal decisions from a small on-device model"
pageClass: "plugin-detail"
---

<PluginDetail slug="bekko" />

[Español](https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/plugin-bekko/README.es.md). Both READMEs must be updated together.

![Bekko System One: a small on-device chip splits one quick pulse into a choice, a yes/no switch and an ordinal level](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-bekko/cover.svg)

A local "System One" decision provider for [Alisio](https://github.com/GustavoGutierrez/alisio).
Features that ask Alisio for a `select`, `boolean` or `ordinal` decision get a fast answer from
**Bekko**, a small typed-decision model that runs on your CPU: no LLM call, no Python, no GPU, and
no data leaves your machine once the model is downloaded.

This is an independent plugin, not affiliated with the Bekko project. **Bekko is optional:
Alisio works without it**, and every feature keeps its own fallback when no provider answers.

## Requirements

- Alisio with the decisions API (`>=0.9.0 <0.12.0`); on older hosts only the commands load.
- Disk: about **200 MB** for the default `68m` model (about 33 MB for `17m`), plus the npm
  dependencies (ONNX Runtime and Transformers.js, roughly 450 MB installed).
- Memory: the Alisio process grew to about 1.6 GB while the `68m` model was loaded (measured on Linux x64); plan for that much free memory.
- Network only for the first download, from Hugging Face.

## Install and activate

```bash
alisio install npm:@alisio/plugin-bekko
```

Then, inside Alisio:

1. `/bekko:activate` asks Alisio to make Bekko the active decision provider. Alisio asks you to
   confirm and saves `decisions.provider` itself; it never replaces a different provider you
   configured. On a host without that capability, set `decisions.provider = "bekko"` by hand.
2. Once active, the model downloads and loads in the background. Until it is ready, Alisio keeps
   using its normal fallback. `/bekko:status` shows progress.
3. Optional: `/bekko:setup` downloads and loads the model now, without changing the active
   provider.

Installing the package alone downloads nothing and starts nothing.

## Commands

| Command | What it does |
| --- | --- |
| `/bekko:status` | Model state (`inactive`, `loading`, `ready`, `failed`) with its detail, and the active decision provider. |
| `/bekko:setup` | Downloads (first run) and loads the model now; reports the download size. |
| `/bekko:activate` | Asks Alisio to make Bekko the active decision provider (Alisio asks you to confirm). |

## How it works

- Each request (`DecisionRequest` v1: up to 16 decisions, 32 KiB) is mapped to Bekko's typed
  questions: `select` to a choice among 2 to 20 options, `boolean` to a yes/no question and
  `ordinal` to a score over 2 to 10 levels.
- The model runs with ONNX Runtime Web on its WebAssembly backend (CPU) through
  [`jev-web`](https://github.com/warsang/jev-web). Loading the `68m` model took about 7 seconds
  the first time and 2.5 seconds from the local copy on a desktop CPU; a three-decision request
  answered in about a tenth of a second.
- The provider never waits for the model: while it loads, a request fails fast as "not ready"
  and Alisio uses its fallback. Answers whose probabilities are invalid, or whose input the model
  had to truncate, are rejected instead of being guessed.
- `confidence` is the model's own probability for its answer. It is not calibrated, so keep
  Alisio's `decisions.minConfidence` threshold.

## Model download and integrity

- Files come only from fixed revisions of `hotchpotch/bekko-system-one-v0-68m` (or `-v0-17m`) on
  Hugging Face: `manifest.json`, `tokenizer.json` and `model.onnx`.
- Every file is checked against a size and SHA-256 digest built into this plugin version before
  it is used, and is written to the cache only after it passes. Redirects are followed only within
  Hugging Face's domains (`huggingface.co`, `hf.co`).
- The cache lives in Alisio's per-plugin cache directory (or `ALISIO_BEKKO_CACHE_DIR`, or
  `~/.alisio/cache/bekko`). A damaged cached file is detected and downloaded again. Delete the
  directory to free the space.

## Limitations

- **Model license.** The Bekko model card says the license of the released weights "remains to
  be finalized" and does not assign one. This plugin does not ship the weights; it downloads them
  from Hugging Face when you activate it. Review the model card before using Bekko in a product.
- Bekko v0 is trained mainly on English. Decisions on other languages work but are less reliable.
- Inference runs on the main thread of the Alisio process. A request that exceeds its deadline is
  reported as a timeout, but the ONNX computation already started still finishes in the background.
- The 400M variant is not offered (1.4 GB download).

## Advanced use

```ts
import { createBekkoPlugin } from "@alisio/plugin-bekko";

export default createBekkoPlugin({ variant: "17m" }); // smaller, lower quality
```

`createBekkoPlugin` also accepts `cacheDir` and an `engineFactory` (for tests or a custom runtime).

## Development

```sh
pnpm --filter @alisio/plugin-bekko test
pnpm --filter @alisio/plugin-bekko build
```

Unit tests use a fake engine and a fake network; they never download the model.

## Sources

- Bekko System One: <https://github.com/hotchpotch/bekko-system-one> (runtime code MIT) and
  <https://huggingface.co/hotchpotch/bekko-system-one-v0-68m>.
- `jev-web` (MIT), ONNX Runtime Web (MIT), Transformers.js (Apache-2.0).

## License

MIT for this plugin. The Bekko model weights are not part of this package and carry their own
terms (see Limitations).
