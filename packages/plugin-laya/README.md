# @alisio/plugin-laya

A local [Laya](https://github.com/NandhaKishorM/laya) decision provider for
[Alisio](https://github.com/GustavoGutierrez/alisio). Features that ask Alisio for a
`select`, `boolean` or `ordinal` decision get an answer from a small model running on your
machine, without an LLM generation call and without sending the data anywhere.

This is an independent plugin. It is not affiliated with the Laya project. **Laya is optional:
Alisio works without it**, and every feature keeps its own fallback when no provider answers.

## Requirements

- Alisio core `>=0.3.0` (the plugin only registers its commands on older cores).
- Python 3.10 or newer (64-bit) with the `venv` module (on Debian or Ubuntu: `apt install python3-venv`).
- Disk: about 1.7 GB for the CPU install with the default `multilingual` checkpoint, about 6 GB with
  CUDA wheels.
- Memory: peak resident memory of the server measured at about 2.3 GB with `multilingual` and about 2.8 GB
  with `english` (CPU, one checkpoint loaded); plan for 3 GB free.
- Network only during `/laya:setup`. Afterwards the server runs offline.

## Install

```bash
alisio install npm:@alisio/plugin-laya
```

Then, inside Alisio:

1. `/laya:setup` — shows exactly what will be downloaded and where from, and asks for explicit
   consent before anything is fetched or written. It starts a background job and returns at once.
2. `/laya:status` — follow progress, then check the provider. `/laya:cancel` aborts a running setup.
3. Activate the provider in your Alisio configuration: `decisions.provider = "laya"`.

Installing the package alone downloads nothing and starts nothing.

## Commands

| Command | What it does |
| --- | --- |
| `/laya:setup [--device auto\|cpu\|cuda\|mps] [--model multilingual\|english\|typed-decisions\|auto] [--yes] [--repair] [--uninstall]` | Installs (or repairs, or removes) the managed runtime. Without an interactive UI it refuses unless `--yes` is passed. |
| `/laya:status` | Host support, setup job, installed pins, effective config with its source, server state, restarts, last error, observed latency. |
| `/laya:cancel` | Cancels a running setup job; the previous runtime stays untouched. |

## Configuration

| Key | Values | Default |
| --- | --- | --- |
| `device` | `auto`, `cpu`, `cuda`, `mps` | `auto` |
| `model` | `multilingual`, `english`, `typed-decisions`, `auto` | `multilingual` |
| `preload` | `true`, `false` | `true` |

Precedence, highest first: `ALISIO_LAYA_DEVICE` / `ALISIO_LAYA_MODEL` / `ALISIO_LAYA_PRELOAD`
environment variables, the plugin options in your Alisio configuration
(`pluginOverrides.laya.options`, user level only), `config.json` in the plugin config directory
(written by `/laya:setup --device ... --model ...`), then the defaults. `ALISIO_LAYA_PYTHON` selects
the interpreter used by setup; `ALISIO_LAYA_HOME` moves the runtime directory.

`preload: true` starts the server and warms the model when Alisio activates the provider, so the first
decisions are not lost to a cold start. Set it to `false` to save memory; the server then starts on the
first decision, which falls back while it warms up.

## How it behaves

- The server is bound to `127.0.0.1` on a free port, protected by a random per-start token, and runs
  with a minimal environment. It stops when the provider is deactivated and when Alisio closes.
- Cold start takes seconds. Until the model is warm, decisions fall back to the feature's default
  immediately instead of waiting.
- Quality is modest and uneven. On 375 labelled dashboard decisions (half Spanish), `multilingual` was right
  62 % of the time: about 90 % for the dashboard purpose, but close to chance for yes/no toggles and for
  choosing a column. Treat answers as hints that the feature can override, not as facts.
- Laya's confidence is **not calibrated**: treat it as a weak signal and do not make sensitive
  decisions depend on it. Alisio's confidence threshold is a heuristic filter.
- On a slow CPU, requests with many decisions can exceed Alisio's 1500 ms decision timeout; use
  smaller packs or raise `decisions.timeoutMs`. Measured on a busy CPU with 4 threads: about 0.3 s for one
  decision and about 2 s (p95 3 s) for a request of seven with `multilingual`; `english` is about three times slower.

## Privacy and security

- Decisions never leave your machine. After setup there is no network use beyond loopback.
- Setup is the only network phase. It contacts PyPI, PyPI's file host, the PyTorch wheel index (CPU
  installs) and Hugging Face, and pins the Laya version, the model revision and the SHA-256 of every
  model file.
- A subprocess is not a sandbox: the server runs with your user's privileges. The controls reduce
  exposure; they do not contain a compromised dependency.
- Nothing is written to your workspace. Files live only in the plugin's own config, state and cache
  directories. Secrets are never stored by this plugin.

## Troubleshooting

- `/laya:status` says the runtime is outdated: run `/laya:setup --repair`.
- Setup fails at "creating environment": install the Python `venv` module (see Requirements).
- The server keeps failing: `/laya:status` shows the last error; `/laya:setup --repair` rebuilds it.
- Remove everything with `/laya:setup --uninstall`.

## License

MIT
