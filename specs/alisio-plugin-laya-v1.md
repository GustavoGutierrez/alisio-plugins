# Spec: `@alisio/plugin-laya` v1 (Laya Decision Provider)

Status: implemented in the working tree (Phases 0-5, see §15 for what was built, what is unverified and the divergences
from this text). Nothing is committed or published; the owner orders both.
Revision 2: aligned with the core session's response to gaps G1-G9 (see §13). Core decisions are
proposals pending owner confirmation; sections that depend on them say so.
Revision 3: folds in the core session's Phase 0 measurements against real Laya 0.3.24 (§2.5): real wire
shapes (ordinal mapping corrected), pinned downloads, cold-start and latency numbers, sizes and a
confidence-quality caveat. Those numbers are reported by the core session; items this repo has not
verified itself are flagged "unverified here".
Audience: a coding agent implementing the package in this monorepo.
Companion spec (core repo): `specs/alisio-decision-intelligence-v1.md` (core 0.3.0).
Out of scope: `@alisio/plugin-jev` (remote API provider), fine-tuning, multi-provider failover,
Smart Dashboard, anything in the core.

Language: this file and every artifact it produces are English, except the documented EN/ES doc
pairs (see Phase 5).

---

## 1. Goal and non-goals

Ship an independently installable plugin that registers a `DecisionProvider` (`id: "laya"`)
backed by a locally managed Laya server, so any Alisio feature can call
`api.decisions.tryDecide(...)` and get `select` / `boolean` / `ordinal` answers with no
LLM generation, no data leaving the machine at decision time, and no knowledge of Laya in the core.

Non-goals (v1):

- No agent-facing tools (decisions are not model tools). No agent skill.
- No CLI subcommand (`alisio laya ...` is impossible for plugins; see §3.4).
- No fallback logic, confidence thresholding, circuit breaking, metrics or `decision_*` events:
  the core owns all of them.
- No grant of permissions. A decision never authorizes anything.
- No Windows-specific hardening beyond "works and does not leak the process" (see §10 risks).
- No upgrade of the runtime without an explicit re-run of `/laya:setup`.

## 2. Verified current state (2026-10-03)

Everything below was checked directly; items marked SPIKE must be re-verified by Phase 1's spike
against a real install before code depends on them.

### 2.1 This repo

| Fact | Evidence |
| --- | --- |
| 13 packages under `packages/*` (12 `plugin-*` + `wayfinder`). | `ls packages` |
| All 13 declare peer `"@alisio/sdk": ">=0.1.0-alpha.10 <0.2.0"`; devDependency is `0.1.0-alpha.11` (`wayfinder`: `alpha.10`). That range excludes core/SDK 0.2.x and 0.3.x. | each `package.json` |
| No `specs/` directory exists. This file creates it. | repo tree |
| Local `packages/*` are discovered automatically by the docs pipeline; `registry/plugins.json` is only for third-party packages and is currently `"plugins": []`. | `registry/README.md`, `registry/plugins.schema.json` |
| Plugin pages `site/plugins/<slug>.md` and `site/es/plugins/<slug>.md` are generated from the package README plus the committed cache `site/.vitepress/data/plugins.json` by `pnpm docs:scan`; `docs:check` fails on a stale cache/page or orphan cover. | `scripts/docs-check.mjs`, `site/es/plugins/telemetry.md` |
| `pnpm check` = lint, leak:check, typecheck, test, build, pack:check, docs:check, docs:build. | root `package.json` |
| Versions are driven by Changesets; `src/version.ts` is rewritten by `scripts/sync-versions.mjs`. | `.changeset/`, `scripts/` |
| `pack-check` accepts packages with no skill/agent resources. | header of `scripts/pack-check.mjs` |
| No plugin manages an OS process today. This is the first. | grep of `spawn`/`child_process` in `packages/*/src` |

### 2.2 How existing plugins resolve config and state (no host-provided option or data dir)

- Config: environment variables plus an optional JSON file under a config home resolved by each
  plugin itself: `ALISIO_CONFIG_HOME` > `$XDG_CONFIG_HOME/alisio` > `$HOME/.config/alisio`
  (`packages/plugin-telemetry/src/config.ts`, `packages/plugin-google-chat/src/config.ts`).
  Secrets are env-only; config files reject secret-shaped keys.
- State: `ALISIO_STATE_HOME` > `$XDG_STATE_HOME/alisio` > `$HOME/.local/state/alisio`, then a
  per-plugin subfolder; telemetry opens its SQLite through `api.storage.sqlite(path)`.
- `api.state.get/set` is a small host key/value store (used for light state only).
- Today there is no `api.paths` and no plugin options in the host config. Core 0.3.0 adds both as
  optional, detectable members (G1, G2): `api.paths` (dirs created `0700`) and `api.options` (frozen, <= 8 KB, user-level only). `plugin-laya` uses them when present and keeps the
  duplicated-primitive resolution above as the fallback (AGENTS.md: "duplicate a small stable
  primitive"), so it also works against hosts that lack them.

### 2.3 `@alisio/sdk` typings available locally (0.1.0-alpha.11)

- `Plugin { id, version, apiVersion: 1, name?, description?, categories?, setup(api), dispose?() }`.
- `api.commands.register(name, handler(args, ctx?) => Promise<string>, { description, argumentHint })`.
  `CommandContext` only has `sessionId?`. No abort signal, no progress sink, no output stream.
- `api.ui.askQuestions(request)` returns `undefined` per question when no interactive UI exists
  (never hangs headless); `api.ui.interactive()`, `api.ui.status(key, text, detail?)` exist.
- `api.state`, `api.storage.sqlite`, `api.events.on`, `api.session.onStart/onEnd` exist.
- `api.decisions`, `api.paths` and plugin `options` do **not** exist yet. They arrive with SDK/core
  0.3.0 (contract in §4.1, fixed by the core session). Until 0.3.0 is published, the package cannot
  typecheck; see Phase 0. Implementation starts only after SDK 0.3.0 is published (G8).

### 2.4 Laya upstream (PyPI `laya`, GitHub `NandhaKishorM/laya`, Hugging Face `convaiinnovations/*`)

| Fact | Value |
| --- | --- |
| License | Apache-2.0 (PyPI classifier; Hugging Face card `license: apache-2.0`). |
| Latest PyPI release | `0.3.24`, uploaded 2026-10-02. 32 releases; 0.3.x ships roughly daily. Wheel 299 KB, sdist 855 KB. |
| Python | `>=3.10`. |
| Core deps | `torch>=2.0.0`, `transformers>=4.48.0`, `safetensors>=0.4.0`, `huggingface_hub>=0.20.0`, `numpy>=1.20.0`. |
| Extras | `serve` (fastapi, uvicorn, python-multipart), `onnx` (onnx, onnxruntime, onnxscript), `fast` (tilelang), `mcp`, framework wrappers. |
| Server | `laya-serve` (entry point confirmed by core Phase 0); env `LAYA_HOST`, `LAYA_PORT` (default 8000), `LAYA_DEVICE` (`cuda|cpu|mps|xpu`), `LAYA_PRELOAD`, `LAYA_MODELS`, `LAYA_THREADS`, `LAYA_AUTO_TASK`, `LAYA_DEFAULT_MODEL`, `LAYA_MAX_LOADED` (2), `LAYA_API_KEY` (Bearer), `LAYA_MAX_TOKEN_BUDGET`, `LAYA_CUDA_AMP`, `LAYA_CPU_AMP`, `LAYA_REVISION` (`reviewed` pins a reviewed SHA), `LAYA_SHA256_DIGESTS` (download verification). The default bind is `0.0.0.0:8000` (confirmed in `serve.py` by core Phase 0). |
| Endpoints | `POST /v1/systemone`, `POST /v1/systemone/batch` (<= 64 states), `GET /health` (liveness stays open; with `LAYA_API_KEY` the detail needs the Bearer), `GET /models`. Measured limits (core Phase 0, §2.5): 100 choice options (101 -> 413), 32 score levels, 64 questions, 16 concurrent requests (then 503), `state` 50,000 characters, body 2 MiB. |
| Request | `{ state: str|dict|list, questions: { id: { type: "choice"|"score"|"noul", instructions, criteria } }, model?, task?, lang?, lang_guess?, min_confidence?, max_len?, head_max_len? }`. `choice.criteria` = `{label: description}`; `score.criteria` = list of level descriptions (every level needs a description; null level => 422); `noul.criteria` keyed `true`/`false`. |
| Response | `{ answers: { id: { choice | score | noul, confidence, answer_confidence, probabilities? } }, usage: { input_tokens, output_tokens }, routing: {...} }`. `choice` = label; `noul` = P(true); `score` = **expected value** as a float (README example `1.84 / 2.0`), never a level or index. The real `score` answer also carries `legend` and `probabilities` keyed by index strings (§2.5). |
| Confidence | `confidence` = 1 - normalised entropy (NOT calibrated, shifts with option count) for `choice`/`score`; `answer_confidence` = `max(p)` for `choice`/`score`, and equals `confidence` for `noul`. Upstream says to gate on `answer_confidence`, but it is not a reliable separator on the multilingual checkpoint (§2.5, R7). `min_confidence` (request) only annotates (`abstention`, `low_confidence`) and never removes answers; this plugin never sends it. |
| Known quality caveats | `noul` without explicit `criteria` can answer "no" regardless of the state, strongest on the English checkpoint (upstream #156); >~20 options degrade; both checkpoints are over-confident as shipped. |
| Checkpoints | `english` (ModernBERT-large, 421M params, `model.safetensors` 842,609,210 B), `multilingual` (mmBERT-base, 322M params, 643,835,514 B + 34 MB tokenizer), `typed-decisions` (842,609,220 B). The "320-420 MB" figure in the planning summary is parameter count, not download size. Weights are `safetensors` (no pickle). |
| HF revisions observed 2026-10-03 | `laya` `55cf4c4e...`, `laya-multilingual` `e4e9ddf2...`, `laya-typed-decisions` `1a793eb5...` (full SHAs are recorded by the spike into `src/runtime/manifest.ts`). The `convaiinnovations/laya` repo also stores `rl_agent_api.py` / `rl_common.py`; core Phase 0 found no `trust_remote_code` in the package (weights load through `safetensors.load_file`, the encoder config is local); re-check on every pin bump. |
| ONNX | `laya[onnx]` is an *export* path: `laya-ts/scripts/export_onnx.py` loads the PyTorch checkpoint with torch and writes `encoder.onnx` + `head.onnx`. No ONNX weights are published on Hugging Face (file listing checked). INT8 quantization is documented to have collapsed to 32 % agreement per-channel (default is now per-tensor). |
| `laya-ts` | Exists in the repo (`laya-ts/`, v0.1.0, Apache-2.0, optional `onnxruntime-node`), but **is not on the npm registry** (`registry.npmjs.org/laya-ts` returns 404 on 2026-10-03). `laya-client` (HTTP client) is also not on npm. A third-party `@receptron/laya` 0.1.2 (MIT, `onnxruntime-node` + `@huggingface/tokenizers`) exists; unvetted. |

### 2.5 Core Phase 0 measurements (Laya 0.3.24, CPU and CUDA, `multilingual` checkpoint)

Reported by the core session after running the real server; this repo has not re-run them
(unverified here until the Phase 1 spike repeats them with the plugin's own harness).

| Area | Measured |
| --- | --- |
| Pinning | Downloads are NOT pinned by default (default branch of the Hub). `LAYA_REVISION=reviewed` pins a reviewed SHA (it resolved to `55cf4c4e...` in `convaiinnovations/laya`, `multilingual` subfolder; example only, the plugin resolves and records the SHA itself). `LAYA_SHA256_DIGESTS` adds verification. |
| Package safety | No `trust_remote_code`; `safetensors.load_file`; local encoder config. |
| Request | `POST /v1/systemone` with `{state, questions: {id: {type, instructions, criteria}}, model?, min_confidence?, ...}`. `choice.criteria` = dict; `score.criteria` = list of levels; `noul.criteria` = optional `{false, true}`. `GET /health` is open (detail needs the token). Auth `Authorization: Bearer`. Response header `X-Inference-Time-Ms`. |
| Limits | 100 options (101 -> 413), 32 levels, 64 questions, 16 concurrent requests (then 503), `state` 50,000 characters, body 2 MiB. |
| `score` answer | No level and no index: `score` is the expected value (sum of `i * p_i`), plus `legend` and `probabilities` keyed by index strings. |
| `noul` answer | P(true); `confidence == answer_confidence`. |
| Cold start | CPU with `LAYA_PRELOAD=1`: 4.9 s to the first answer. Without preload the port opens quickly but the first request takes ~3.9 s. CUDA with preload: 11.4 s. |
| Latency | CPU ~80 ms per question (4 questions: p95 399 ms; 16 questions: p95 1273 ms). CUDA p95 17.7 ms. |
| Sizes | `multilingual` checkpoint 647 MB; CPU venv 992 MB; CUDA venv 5.4 GB. |
| Quality (indicative, small hand-labelled sample) | `laya-multilingual` ships without tuned temperatures. 14 of 20 clear cases correct; `answer_confidence` did not separate clear from ambiguous cases (AUC 0.34). The `english` checkpoint was not tested. |

Still unverified by anyone: peak RAM, model-visibility of question ids, the exact format of
`LAYA_SHA256_DIGESTS`, macOS/Windows behavior, and the `english`/`typed-decisions` checkpoints.

## 3. Architecture decisions

### 3.1 Runtime: managed Python server (decision) vs `laya-ts`/ONNX

**Decision: managed Python `laya-serve` in an isolated venv, pinned to an exact Laya version.**

| Option | Avoids Python? | Verdict |
| --- | --- | --- |
| Managed Python server (`laya[serve]`) | No | Chosen. Official, the only path with published weights, Jev-compatible protocol, loads from the pinned HF revisions, supports cuda/mps/cpu. Cost: a Python >= 3.10 prerequisite and a multi-GB first install (torch). |
| `laya-ts` + ONNX | No (today) | Rejected for v1. Not published on npm; weights must be exported with Python + torch + `laya[onnx]` first, and no ONNX artifacts are hosted. It removes Python only at *runtime*, not at install, and adds export-verification and quantization-drift risk. |
| `@receptron/laya` (third party) | Unknown | Not adopted: unvetted third-party code in a security-sensitive position and a different maintainer from Laya. |

Revisit when upstream publishes `laya-ts` to npm **and** hosts prebuilt ONNX weights with
checksums. To keep that swap cheap, the Laya wire protocol, the process supervisor and the
installer are separate modules behind small interfaces (§5.2); an ONNX transport would replace
`supervisor` + `installer` only.

### 3.2 Activation model

The plugin always registers the provider when `api.decisions` exists. Registering does not
activate it; the user sets `decisions.provider = "laya"` in the Alisio config (core-owned). The
core calls the optional `provider.activate()` when Laya becomes the active provider and
`provider.deactivate()` when it stops being active (G4); both are bounded by `pluginHooks.timeoutMs`, receive no `AbortSignal`, and are never fatal. They also run when the
user changes `decisions.provider` live. Disabling the plugin or `/reload` does not call `dispose()` (both need a
restart, core ADR-12), so a live switch away from Laya is the only stop short of closing the app. The plugin must be inert (no process, no network, no disk writes outside its config/state
homes) until `activate()` runs; `activate()` starts and warms the server, `deactivate()` stops it.
A direct `health()` call (from `/decisions`) on an inactive-but-installed provider reports
`unavailable` with detail `provider not active` and never starts a process.

### 3.3 Fail-open

Every failure path ends in a typed rejection from `decide()` (a `DecisionProviderError`, §4.3) or a
`health()` status. `setup()`, `activate()`, `deactivate()` and `dispose()` never throw. A missing
`api.decisions` (old core) registers only the commands, and `/laya:status` explains the version
requirement. The plugin is never the source of truth for any
lifecycle state of the host.

### 3.4 Commands, not CLI subcommands

`alisio laya setup|status` from the plan is not implementable (CLI subcommands are static in the
core). Register `setup`, `status` and `cancel` through `api.commands.register`; the host exposes
them as `/laya:setup`, `/laya:status` and `/laya:cancel` (verify the namespacing against core 0.3.0
in Phase 4 and document what is observed). Commands get no abort signal and no progress sink in
0.3.0 (G3 deferred), so none of them may run longer than a few seconds: `/laya:setup` starts a
background job and returns immediately (§6).

### 3.5 Configuration and paths (host support optional; gaps G1/G2)

Effective configuration, highest precedence first:

1. `ALISIO_LAYA_*` environment variables (explicit, per process).
2. `api.options` (a frozen snapshot of the user-level `pluginOverrides.laya.options`, max 8 KB), when
   the host exposes it (G2). The plugin never writes it. Project-level options are ignored by the
   core with a diagnostic, so the plugin must never expect or document per-project overrides.
3. `<pluginConfig>/config.json` (fallback; the only file the plugin writes, and only from
   `/laya:setup` flags).
4. Built-in defaults.

`/laya:status` reports the source of each effective value. Host options go through the same strict
validation as the file. The snapshot is read once in `setup()`; changing options needs a host restart.

Config file shape, same resolution rules as §2.2 for the fallback:

```jsonc
{ "version": 1, "device": "auto", "model": "multilingual", "preload": true }
```

| Key | Values | Default | Effect |
| --- | --- | --- | --- |
| `device` | `auto`, `cpu`, `cuda`, `mps` | `auto` | `auto` omits `LAYA_DEVICE` (Laya picks). Also selects the torch wheel variant at setup (§6). `xpu` intentionally not exposed. |
| `model` | `multilingual`, `english`, `typed-decisions`, `auto` | `multilingual` | Owner decision: the default is the single `multilingual` checkpoint (647 MB download measured by core Phase 0, plus tokenizer; one resident model; covers non-English text; note its confidence is not tuned, R7). A single name loads and downloads only that checkpoint and pins `model` per request. `auto` is opt-in: `LAYA_MODELS=english,multilingual` (router picks by language), ~1.5 GB download and two resident models (not measured by core Phase 0). |
| `preload` | boolean | `true` | Owner decision. Rationale: the provider is only activated after the user opts in with `decisions.provider = "laya"`, and with `false` the first decisions of each session would always fall back. `true`: `activate()` starts the server and warms the model in the background. `false`: `activate()` only marks the provider active; the server starts on the first `decide()`, which rejects `not_ready` (and so falls back) until warm-up ends. Users who want to save RAM can set `false`. Measured cold start (core Phase 0, §2.5): CPU with preload 4.9 s to the first answer, without preload ~3.9 s on the first request (so the first decisions fall back either way, but only briefly with preload); CUDA with preload 11.4 s. Peak RAM is still unmeasured; the Phase 1 spike records it. |

Env overrides (precedence in the list above): `ALISIO_LAYA_DEVICE`, `ALISIO_LAYA_MODEL`,
`ALISIO_LAYA_PRELOAD`, `ALISIO_LAYA_PYTHON` (interpreter path used by setup only),
`ALISIO_LAYA_HOME` (runtime root override). Validation is strict: unknown keys, secret-shaped
keys and bad values are rejected with an actionable message; an invalid config makes the provider
`unavailable` with that message instead of throwing. Writes are atomic (temp file in the same
directory, `fsync`, rename, mode `0600`, dir `0700`).

Paths: three plugin-scoped directories, `<pluginConfig>`, `<pluginState>` and `<pluginCache>`.
When `api.paths` exists (G1) they are its `config`, `state` and `cache` values: the core creates them
with mode `0700` on first read and `config` lives under `<configHome>/plugins/<id>`. Those values are
already plugin-scoped, so the plugin never appends another `laya/` segment. Otherwise (older host) the
plugin resolves the same layout itself from §2.2: `<pluginConfig> = <configHome>/plugins/laya`,
`<pluginState> = <stateHome>/plugins/laya`, `<pluginCache> = <pluginState>`, creating them `0700`, so
both resolutions agree on the shape. `ALISIO_LAYA_HOME` still overrides the runtime root. The model
cache (`hf/`) lives under `<pluginCache>` when it is distinct from `<pluginState>`; the runtime
manifest and venv stay under state. Layout:

```text
<pluginConfig>/config.json
<pluginState>/runtime/
  jobs/current.json   # background setup job record (§6), no secrets
  runtime.json        # install manifest, no secrets (see §6)
  venv/               # isolated Python environment
  hf/                 # HF_HOME (model cache; under <pluginCache> when distinct)
  server.pid          # {pid, startedAt, venv} for orphan reaping, mode 0600
```

Nothing is ever written to the user's workspace; the child `cwd` is the runtime directory.

## 4. Contracts

### 4.1 SDK 0.3.0 contract (fixed by the core session; code against this)

```ts
api.decisions?: {
  registerProvider(provider: DecisionProvider): () => void;
  available(): boolean;
  activeProvider(): { id: string; name: string } | null;
  tryDecide(request: DecisionRequest, options?: DecisionOptions): Promise<DecisionResponse | null>;
}
api.paths?: { state: string; config: string; cache: string };        // per plugin, optional (G1)
api.options?: Readonly<Record<string, JsonValue>>;                   // fed by pluginOverrides["<id>"].options (G2); optional, empty object when unset
interface DecisionProvider {
  id: string; name: string;
  capabilities: { select: boolean; boolean: boolean; ordinal: boolean };
  activate?(): Promise<void>;     // became the active provider (G4); bounded by a core timeout, never fatal
  deactivate?(): Promise<void>;   // stopped being the active provider (G4)
  health?(signal?: AbortSignal): Promise<{ status: "ready" | "starting" | "unavailable"; detail?: string }>;
  decide(request: DecisionRequest, context: { signal: AbortSignal; timeoutMs: number }): Promise<DecisionProviderResult>;
}
class DecisionProviderError extends Error {                           // exported from the SDK root (G7)
  code: "not_ready" | "unavailable" | "timeout" | "invalid_response" | "internal";
}
// DecisionRequest { version: 1; id; pack?; language?: string /* BCP 47, G6 */; state: JsonValue; decisions: Record<string, DecisionDefinition> }
// DecisionDefinition = select{instruction, options: Record<string,string>} | boolean{instruction, trueMeaning?, falseMeaning?} | ordinal{instruction, levels: string[]}
// DecisionAnswer     = select{value, confidence, probabilities?} | boolean{value, confidence, probability} | ordinal{level, index, confidence, distribution?}
// DecisionProviderResult { decisions: Record<string, DecisionAnswer>; usage?: { inputUnits?, outputUnits? } }  // no `meta` in v1 (rejected)
```

Core guarantees before calling (G9): <= 16 decisions; decision keys match
`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`; <= 20 options per select; option keys/descriptions and ordinal
levels non-empty and unique; serialized `state` <= 16 KB; total serialized request <= 32 KB;
default timeout 1500 ms (raised from 800 ms after core Phase 0); answer validation, confidence threshold, circuit breaker and `decision_*`
events. The plugin re-checks these as defense in depth (same caps: 16 decisions, 20 options,
16 KB state, 32 KB total). A request that violates them is a core bug, so the plugin rejects it
with `DecisionProviderError("internal")` without contacting the server.

Core semantics the plugin relies on (G7):

- A fast `not_ready` or `unavailable` rejection counts as a fallback for the feature but does **not**
  open the circuit. Only `timeout` and untyped or `internal` errors count toward the breaker.
- The core never calls `health()` on the `decide` path; only `/decisions` does. Therefore `decide()`
  must itself reject immediately with `not_ready` while the server is starting.
- The core does not assume `confidence` is calibrated: it is the provider's best estimate in [0,1] that the
  answer is correct, and the core's `minConfidence` (default 0.6) is only a heuristic filter. The adapter
  maps it from Laya's `answer_confidence` (§4.2).

### 4.2 Wire mapping (pure functions, `src/protocol/codec.ts`)

Question ids sent to Laya are positional (`q0`, `q1`, ...) with a reverse map held per call, so
decision keys never reach the server or a prototype-sensitive object, and responses are looked up
by the ids the plugin generated. SPIKE (still unverified): confirm ids are not
model-visible; if they are, switch to the original ids, which the core now guarantees match
`^[a-zA-Z][a-zA-Z0-9_]{0,63}$` (G9), and use `q<i>` otherwise.

`state`: strings, objects and arrays pass through; JSON scalars/null are wrapped as `{"value": x}`.
`DecisionRequest.language` (BCP 47, optional, G6), when present and well-formed, is sent as
`lang_guess` (a hint for checkpoint routing under `model: auto`; ignored when a single checkpoint is
configured); a malformed value is dropped, never forwarded. The plugin never sends
`min_confidence`, `task`, `lang`, hooks, or `LAYA_AUTO_TASK` routing.

| Alisio | Laya request question | Laya answer field | Alisio answer |
| --- | --- | --- | --- |
| `select` | `{type:"choice", instructions: instruction, criteria: options}` (option keys are the labels; criteria is a dict) | `choice` (label), `probabilities` (label -> p), `answer_confidence` (= `max(p)`) | `value = choice` (must be a requested key), `confidence = answer_confidence`, else `probabilities[value]`; `probabilities` copied when it is a finite per-label map. |
| `boolean` | `{type:"noul", instructions, criteria: {true: trueMeaning ?? "yes, the statement holds", false: falseMeaning ?? "no, the statement does not hold"}}` (criteria always sent even though upstream makes it optional; upstream #156) | `noul` = P(true) in [0,1]; `confidence == answer_confidence` | `probability = noul`, `value = probability >= 0.5`, `confidence = max(p, 1-p)` (equals Laya's `answer_confidence`/`confidence` for `noul`). |
| `ordinal` | `{type:"score", instructions, criteria: levels}` (criteria is the list of level descriptions; levels non-empty and unique, at most 32, else reject the decision before sending) | `score` (expected value `sum(i * p_i)`, NOT a level or index), `legend`, `probabilities` keyed by index strings (`"0"`, `"1"`, ...), `answer_confidence` (= `max(p)`) | The server returns no level or index, so the adapter derives them: parse `probabilities` into an array of length `levels.length` by index key (every key `"0"`..`"n-1"` present, all finite, within [0,1]); `index = argmax(distribution)` (ties resolve to the lowest index); `level = levels[index]`; `distribution` = that array in index order; `confidence = answer_confidence`, else `distribution[index]`. Never derive the level from `score` (an expected value can fall between levels). If `probabilities` is missing or malformed, fail closed with `LayaProtocolError` (no `round(score)` fallback). |

Rules: use `answer_confidence`, never the entropy `confidence`, and say why in a code comment
(not calibrated, shifts with option count). This matches the core's contract semantics: `confidence`
is the provider's best estimate in [0,1] that the answer is correct (the core makes no calibration claim). The real shapes are now known (§2.5: `choice` probabilities keyed by label, `score` probabilities keyed
by index strings); the Phase 1 spike records them as scrubbed fixtures and the decoder accepts exactly
those shapes, failing closed on anything else.

Response validation (hand-written, zero dependencies): body <= 1 MiB (stream-counted), JSON
object, `answers` object, every requested id present, no extra id trusted, all numbers finite and
within [0,1] for probabilities/confidences, `score` probability keys exactly the index strings
`"0"`..`"n-1"`, the `X-Inference-Time-Ms` header ignored (never trusted or forwarded), `choice` among the requested keys, `usage` optional
non-negative integers mapped to `inputUnits`/`outputUnits`. Any violation throws
`LayaProtocolError` (message never echoes request state or server text beyond a short code).

### 4.3 Errors and health

Internal typed errors (all extend `Error`, carry a stable `code`, never contain state, tokens or
paths): `LayaUnavailableError` (`not_installed | starting | failed | backoff | overloaded | inactive | host_unsupported`),
`LayaTimeoutError`, `LayaProtocolError`, `LayaConfigError`. At the provider boundary every internal
error is converted to the SDK's `DecisionProviderError` (the core's breaker keys off its `code`):

| Internal condition | `DecisionProviderError.code` | Breaker effect (core) |
| --- | --- | --- |
| `starting`, `not_installed`-while-warming, supervisor not `ready` | `not_ready` | none (fallback only) |
| `not_installed`, `failed`, `backoff`, `overloaded`, `inactive`, invalid config | `unavailable` | none (fallback only) |
| Request deadline or caller abort reached | `timeout` | counts |
| `LayaProtocolError` (bad JSON, schema violation, unknown id, label outside options) | `invalid_response` | core-defined |
| Anything unexpected, or an over-limit request (core bug) | `internal` | counts |

The plugin never lets a raw `Error` or a string escape `decide()`.

`health()` is called only by `/decisions`, never on the `decide` path. It is cheap (never longer
than ~2 s, probe result cached <= 5 s) and has no side effects: it never starts a process.

| Condition | Result |
| --- | --- |
| Config invalid | `unavailable`, detail = validation message |
| Runtime not installed / manifest mismatch | `unavailable`, detail `not installed: run /laya:setup` |
| Setup job running | `unavailable`, detail `setup in progress` |
| Provider not active (no `activate()` yet) | `unavailable`, detail `provider not active` |
| Process starting or warming up | `starting` |
| Crashed, in backoff or failed | `unavailable`, detail with failure code and next retry |
| Probe `GET /health` OK and warm | `ready` |

`decide()` rejects immediately with `not_ready` while the supervisor is starting or warming (never
waits for startup, never calls `health()`), and with `unavailable` when it is failed, in backoff,
not installed or inactive. A `decide()` that arrives while the supervisor is idle but the provider
is active (for example `preload: false`) triggers a single-flight background start and rejects
`not_ready`. It uses `AbortSignal.any([context.signal, AbortSignal.timeout(context.timeoutMs)])`
for the request, no retries (the core owns policy), a client-side in-flight limit of 4 (extra
calls reject `unavailable`/`overloaded`), and treats a connection error as a signal to re-probe.

### 4.4 Latency versus the decision timeout

Measured CPU latency is ~80 ms per question (core Phase 0): 4 questions p95 399 ms, 16 questions p95
1273 ms. The core's default timeout is now 1500 ms (owner decision after Phase 0) and its cap is 16
decisions per request, so a full 16-decision request on CPU fits, with a thin margin of roughly 230 ms
(unverified on other hardware). Slower CPUs, fewer threads or a cold first request (~3.9 s without
preload) can still end as `timeout`, which counts toward the circuit breaker (G7). CUDA (p95 17.7 ms)
has ample headroom. Consequences:

- The plugin cannot answer part of a request, so it does not truncate; it honors `context.timeoutMs`
  and rejects `timeout` when exceeded.
- README guidance: on slow CPUs keep packs small or raise `decisions.timeoutMs`; `/laya:status` reports
  the observed per-question latency (rolling median, in memory only) so users can tune it.
- G10 (provider `maxDecisionsPerRequest` hint or per-provider timeout) was **rejected by the core for
  0.3.0**. Nothing in this plugin depends on it.

## 5. Package design

### 5.1 Manifest

- Name `@alisio/plugin-laya`, plugin id `laya`, version `0.1.0` (first release; see §11),
  `description` accurate and English, `keywords` include `alisio-plugin`, `laya`, `decisions`,
  `local`, `categories: ["decisions"]` (a `PluginCategory` of SDK 0.3.0; the catalog's own category list does not know it yet, see §15).
- MIT `LICENSE`, README, `cover.svg` (follow sibling covers; `docs:check` rejects orphans/missing),
  `repository` with `directory: "packages/plugin-laya"`, `homepage`, `bugs` per AGENTS.md.
- ESM, `engines.node >= 22.16`, `exports` -> `dist`, declarations emitted.
- `peerDependencies["@alisio/sdk"]: ">=0.3.0 <0.7.0"`, `devDependencies["@alisio/sdk"]: "0.3.0"`
  (exact, matching sibling style). See §11 for why the range is wide. Zero runtime dependencies (Node built-ins only: `node:child_process`,
  `node:net`, `node:fs/promises`, `node:crypto`, global `fetch`).
- No `.agents` folder (no skills/agents; `pack-check` allows that).
- Never import another plugin or `@alisio/core`.

### 5.2 Module layout (keep boundaries; they are the Jev reuse seam)

```text
src/
  index.ts            # definePlugin, setup/dispose wiring only
  version.ts          # rewritten by scripts/sync-versions.mjs
  errors.ts           # typed errors (§4.3)
  config.ts           # load/validate/save config, env precedence (§3.5)
  paths.ts            # api.paths when present, else XDG/ALISIO_* fallback; realpath containment guard
  provider.ts         # DecisionProvider: health/decide, depends only on the three seams below
  protocol/
    codec.ts          # PURE encode(DecisionRequest) -> {wire, map}; decode(wire, map) -> result
    validate.ts       # hand-written response validation
  transport/
    http.ts           # loopback-only fetch client: bearer, size cap, no redirects, timeout
  runtime/
    manifest.ts       # pinned laya version, HF repo+revision+file sizes+sha256, python/torch policy
    python.ts         # interpreter discovery and checks
    installer.ts      # venv + pip + model download + smoke test, atomic swap; cancellable (AbortSignal)
    jobs.ts           # single background setup job: state machine, persisted record, cancel
    supervisor.ts     # process lifecycle state machine
    env.ts            # child environment allowlist
    pidfile.ts        # orphan reaping
  commands.ts         # /laya:setup, /laya:status, /laya:cancel
test/
  fixtures/           # real recorded Laya responses (from the spike)
  fixtures/fake-laya-serve.mjs   # scriptable fake server executable
  ...
```

Reuse seam for a future `plugin-jev`: `provider.ts` depends only on a `Codec` (pure, wire <-> Alisio),
a `Transport` (`health(signal)`, `infer(wire, ctx)`) and a `RuntimeStatus` source. Jev would keep the
same shapes and replace `runtime/*` with credentials + endpoint. Per AGENTS.md rules, `plugin-jev`
copies these small primitives; do **not** extract a shared package and do not import across plugins.
Do not implement anything Jev-specific here.

## 6. Managed installation (`/laya:setup`)

Syntax: `/laya:setup [--device auto|cpu|cuda|mps] [--model auto|multilingual|english|typed-decisions] [--yes] [--repair] [--uninstall]`,
`/laya:status`, `/laya:cancel`.
Arguments parsed with an allowlist; unknown flags are an error. Flags other than `--yes`, `--repair`,
`--uninstall` update `config.json` after a successful install (atomically).

### 6.0 Background job model (G3 deferred: commands have no abort signal or progress sink)

A command handler must return within seconds. Setup takes minutes, so it is a **background job**
owned by `jobs.ts`:

- `/laya:setup` runs steps 1-2 (preflight and consent) inside the command call, then starts the job
  (steps 3-7) and **returns immediately** with a short message ("setup started; check
  `/laya:status`, cancel with `/laya:cancel`"). Preflight is offline, fast and bounded; the consent
  prompt is the only part that waits on the user.
- One job at a time. A second `/laya:setup` while a job is `running` returns the current job status
  and starts nothing. `--repair` and `--uninstall` are jobs too and follow the same rules.
- Job states: `idle -> running(step) -> succeeded | failed(code) | cancelled`. The record
  (`jobs/current.json`: state, step name, started/updated timestamps, failure code, short sanitized
  message; no secrets, no state data) is written atomically on every transition so `/laya:status`
  survives a host restart. A record left in `running` by a dead host is reported as `interrupted`
  and may be retried with `/laya:setup --repair`.
- Progress: the job updates `api.ui.status("laya", "<step n/7> <short text>")` when available;
  `/laya:status` is the authoritative view (current step, elapsed time, bytes downloaded when known).
- Cancellation: `/laya:cancel` aborts the job's `AbortController`, which kills the active child
  (pip, download script, smoke server), removes `venv.new` and partial downloads, leaves the previous
  working runtime untouched, and ends in `cancelled`. It is a no-op with a clear message when no job
  runs. `dispose()` (application close) cancels a running job the same way (setup never outlives the host).
- While a job runs: the provider reports `unavailable` (`setup in progress`) and `decide()` rejects
  `unavailable`; the supervisor is not started, and a repair or uninstall job first stops a running server.
- Consent is bound to the job: the consent text is persisted in the job record only as the pin/size
  summary, never replayed as consent for a later run.

Flow (job steps report through the job record; `/laya:status` prints the summary):

1. **Offline preflight, no network, no writes.**
   Resolve config/paths. Find Python: `ALISIO_LAYA_PYTHON`, then `python3.13`, `python3.12`,
   `python3.11`, `python3.10`, `python3`, `python` (Windows: `py -3`). For each, run it with a fixed
   `-c` that prints version and pointer size via argv-free code; require >= 3.10, 64-bit, and a working
   `venv` + `ensurepip` (Debian splits `python3-venv`: surface that exact remedy). Failure messages name
   what to install; nothing is installed on the user's behalf outside the venv.
2. **Consent (blocking).**
   Print the exact plan from `manifest.ts`: pinned `laya[serve]==<pin>`, torch variant, the model files
   with exact byte sizes, total approximate disk (core Phase 0 measured: `multilingual` checkpoint 647 MB; CPU venv 992 MB, so
   about 1.7 GB for CPU; CUDA venv 5.4 GB, so about 6 GB for CUDA; the spike re-confirms against the
   plugin's own install; torch on Linux defaults to multi-GB CUDA wheels, so the CPU index is used for
   `cpu`/`auto`-without-NVIDIA), the hosts that will
   be contacted (PyPI and its file host, the PyTorch wheel index when used, Hugging Face), and the
   runtime directory. Ask with `api.ui.askQuestions` (two options: install / cancel). If no interactive UI
   (`undefined` answers), refuse unless `--yes` was passed explicitly. Declined or unanswered => zero
   network, zero writes, exit with "cancelled". Consent is not persisted; a changed pin requires a new run.
3. **Isolated venv** at `venv.new` inside the runtime dir (`python -m venv`). All pip invocations use
   the venv's interpreter with `-m pip install --no-input --disable-pip-version-check --require-virtualenv`,
   `PIP_*` and `PYTHONPATH` stripped from the environment, `PYTHONNOUSERSITE=1`.
4. **Install**: for the CPU variant first `torch` from the PyTorch CPU wheel index only
   (`--index-url`, never `--extra-index-url`, to avoid dependency confusion), then
   `laya[serve]==<pin>` from PyPI. macOS and CUDA use the default PyPI torch. Exact torch version
   policy is decided by the spike and recorded in `manifest.ts`.
5. **Model download** with the venv interpreter running a fixed plugin-owned script (constant source,
   inputs passed through argv/env, never interpolated): `huggingface_hub.snapshot_download` with
   `repo_id`, pinned `revision` (full commit SHA, resolved from `LAYA_REVISION=reviewed` and recorded in `manifest.ts`; setup aborts if the resolved SHA differs from the manifest), `allow_patterns` limited to the chosen checkpoint
   files, `cache_dir = <runtime>/hf`. Afterwards verify every file's size and SHA-256 against
   `manifest.ts`; mismatch aborts and deletes the partial cache.
6. **Smoke test**: start the real server through the supervisor on an ephemeral port with offline
   flags, send one tiny `choice`, `noul` and `score` request, assert the §4.2 decode succeeds, stop it.
7. **Commit** (as built: the venv is created directly in a versioned directory `venv-<laya>-<id>`, because a
   venv is not relocatable; see §15): write `runtime.json` (atomically; it names the venv directory),
   then remove older `venv-*` directories. Originally specified as renaming `venv.new` -> `venv`:
   write `runtime.json` (`schemaVersion`, laya pin, python version, torch variant, device, model set,
   per-file revision/size/sha256, `installedAt`; no tokens, no absolute-path-dependent data other than
   what is needed to locate the venv relative to the runtime root).
   On any failure remove `venv.new`; the previous working runtime, if any, is untouched.

`--repair`: re-run steps 3-7 with the same pins (consent is requested again). `--uninstall`: ask
confirmation through `askQuestions` (or `--yes`), stop the server, then remove only
`<pluginState>/runtime` (and the model cache directory when it lives elsewhere under
`<pluginCache>`) after a `realpath` containment check (the target must be exactly that directory and
not a symlink to elsewhere).

Offline afterwards: at runtime the supervisor sets `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`,
and the plugin never invokes pip or any downloader outside `/laya:setup`.

`/laya:status` (read-only, no network, no secrets, home-collapsed paths) prints: host support
(`api.decisions`, `api.paths`, plugin options present or not), registered/active (`activeProvider()`),
the setup job (state, step, elapsed, failure code) when one exists, installed pin and checkpoints,
effective config and where each value came from, supervisor state, restart count, last error code
and short sanitized message, and the next step (`/laya:setup`, `/laya:cancel`, or set
`decisions.provider = "laya"`).

## 7. Process lifecycle

State machine in `supervisor.ts`: `stopped -> starting -> warming -> ready -> stopping -> stopped`,
plus `failed(backoff)`. Single-flight `ensureStarted()`; every transition is deterministic and unit-testable
with an injectable clock and spawner.

- **Start trigger**: `provider.activate()` (G4), called by the core when Laya becomes the active
  provider. With `preload` it starts the server and warms the model, then returns without waiting for
  readiness (it must finish well inside the core's activation timeout; a slow start continues in the
  background). Without `preload`, the first `decide()` on an active provider starts it lazily and
  rejects `not_ready`. `health()` never starts a process. `activate()` is a no-op, never an error,
  when the runtime is not installed or a setup job is running. If the host lacks
  `activate`/`deactivate` support, fall back to `activeProvider()?.id === "laya"` checked after
  `setup()` and the lazy path.
  Startup is always asynchronous and never blocks `setup()`, `activate()` or the host's boot.
- **Stop trigger**: `provider.deactivate()` stops the server (same graceful sequence as `dispose()`)
  and clears backoff state; the core bounds it by a timeout, so it must return promptly and finish
  the kill sequence in the background.
- **Port**: bind a probe server to `127.0.0.1:0`, read the port, close it, pass it as `LAYA_PORT`.
  If the child exits early with an address-in-use failure, retry with a new port up to 3 times.
- **Token**: 32 random bytes (hex) generated per start, passed only as `LAYA_API_KEY` in the child env,
  held in memory, never logged, never written to disk or `runtime.json`.
- **Spawn**: absolute path to the `laya-serve` entry inside `venv` (entry point `laya-serve` confirmed by core Phase 0; validate it resolves under the
  venv root), `shell: false`,
  argument array, `cwd` = runtime dir, `stdio: ["ignore","pipe","pipe"]`, `windowsHide: true`, not detached.
- **Child environment (allowlist)**: `PATH` (minimal system), `HOME`/`USERPROFILE`/`SYSTEMROOT`/`TMPDIR` as
  needed, plus `LAYA_HOST=127.0.0.1`, `LAYA_PORT`, `LAYA_API_KEY`, `LAYA_DEVICE` (unless auto),
  `LAYA_MODELS`, `LAYA_DEFAULT_MODEL`, `LAYA_PRELOAD=1`, `LAYA_REVISION=reviewed`, `LAYA_SHA256_DIGESTS` (from the manifest; exact format to confirm in the spike), `LAYA_AUTO_TASK=0`, `LAYA_MAX_LOADED=2`,
  `LAYA_THREADS=max(1, min(4, floor(cpus/2)))`, `HF_HOME=<runtime>/hf`, `HF_HUB_OFFLINE=1`,
  `TRANSFORMERS_OFFLINE=1`, `HF_HUB_DISABLE_TELEMETRY=1`, `DO_NOT_TRACK=1`, `PYTHONNOUSERSITE=1`,
  `PYTHONUNBUFFERED=1`. Every other variable of the host is dropped (no inherited API keys or tokens).
- **Readiness**: poll `GET /health` with the Bearer every 250 ms (connection refused counts as
  starting) until 200 or a 120 s start deadline, then run one internal warm-up `POST /v1/systemone`
  (60 s deadline) so the model is resident; only then `ready`. Deadline exceeded => kill, `failed`. Measured cold start is 4.9 s (CPU, preload) to 11.4 s (CUDA, preload), so the 120 s deadline is generous; revisit after the spike.
- **Output**: stdout/stderr go to a bounded in-memory ring buffer (last 8 KB each, token redacted) used for
  the status line; no log file in v1.
- **Crash/restart**: on unexpected exit, record the code; no eager respawn loop. A lazy restart happens on the next
  demand subject to exponential backoff (1 s, 2 s, 4 s ... capped at 60 s); after 5 consecutive failures within
  10 minutes the state is `failed` until `/laya:setup --repair` or a new Alisio session. With `preload`, one
  eager restart is allowed while within the backoff budget.
- **Shutdown**: `dispose()` and `deactivate()` are idempotent: abort in-flight calls and any running
  setup job, `SIGTERM`, wait up to 1200 ms, then `SIGKILL` (Windows uses the platform kill of the process
  tree). The core calls `dispose()` on application close only (`/exit`, Ctrl+C, TUI SIGTERM/SIGHUP, `serve`
  SIGINT/SIGTERM, `alisio run` SIGINT/SIGTERM/SIGHUP); all disposals run in parallel, each capped by
  `pluginHooks.disposeTimeoutMs` (default 2000 ms), and the active provider's `deactivate()` runs before them
  with the same cap. Disabling the plugin and `/reload` do NOT call `dispose()` (both need a restart,
  core ADR-12). The whole sequence must fit inside 2000 ms: the 1200 ms SIGTERM grace plus the SIGKILL leave
  a margin; `deactivate()` returns promptly and finishes the kill in the background, and `dispose()` returns
  as soon as the kill is issued. The plugin does not rely on `dispose()` alone: a synchronous
  `process.on("exit")` hook issues a last `SIGKILL`, and the pidfile reaper below covers hard kills.
  Ctrl-C reaches the child because it shares the process group (not detached).
- **Orphans**: `server.pid` records `{pid, startedAt, venv}`. On start, if the file exists and the pid is alive and its
  command line points into our venv (Linux `/proc/<pid>/cmdline`, macOS `ps -p <pid> -o command=`), terminate it
  before starting (this reclaims an orphan left by a missed `dispose()` or a hard kill). A pid that does not match is never touched. The pidfile is removed on clean stop.
  Known limit: a hard kill (SIGKILL) of the host leaves the server alive until the next start (risk R4).
- **Memory**: the resident server holds one checkpoint by default (`multilingual`) or two under `model: auto`; RAM is unmeasured (Phase 1 spike). `/laya:status` reports
  the model set.

## 8. Security model

A subprocess is never a sandbox. Treat `laya-serve` as trusted-but-isolated code that has the user's
privileges; the controls below reduce exposure, they do not contain a compromised dependency.

1. **Network exposure**: Laya binds `0.0.0.0` by default (confirmed), so always `LAYA_HOST=127.0.0.1`; the client connects only to `127.0.0.1:<port>`; if the
   health response shows the server bound elsewhere, treat it as a failure. Random per-start Bearer token on every
   request including `/health`. Same-user local processes can still read the child's environment; document it.
2. **Egress**: the only network use after setup is loopback. Offline flags are set; pip never runs at runtime.
   Setup is the sole network phase and requires explicit consent listing the hosts.
3. **Supply chain**: exact `laya` pin (releases are near-daily). Laya's downloads are unpinned by default, so
   the plugin sets `LAYA_REVISION=reviewed` and `LAYA_SHA256_DIGESTS` for the server and additionally pins the HF
   commit SHA and verifies SHA-256 for every weight file in its own setup; weights are `safetensors`. Transitive Python deps (`torch`, `transformers`, ...) are not hash-pinned in v1
   (risk R5); the manifest makes tightening to a constraints file with hashes a one-file change.
4. **Execution of repo code**: core Phase 0 found no `trust_remote_code` (weights load with `safetensors.load_file`, local
   encoder config). Re-check on every pin bump; if a future pin executes repo code, the plugin must not ship it.
5. **Untrusted input/output**: the server response is untrusted: size-capped, strict-validated, no redirects followed,
   keys from a plugin-owned map. Decision text and `state` are never logged and never echoed in errors or status.
   Python/venv/model paths come from a validated manifest; every path is `realpath`-contained inside the runtime root
   before use, deletion or spawn. No shell, no string-built commands; the download script is constant source.
6. **Decisions grant nothing**: the plugin exposes no tool and returns no permission-shaped data; it only returns answers.
7. **Secrets**: none persisted by the plugin. Config rejects secret-shaped keys. Leak rules apply to every tracked file
   and tarball: no local machine paths or credential-shaped strings in source, fixtures, docs or snapshots (fixtures must be
   scrubbed; the leak check will block otherwise).
8. **Resource limits**: client in-flight cap, response cap, start deadline, backoff, single server per runtime (pidfile).
9. **Writes**: only under the plugin's config directory, runtime directory and (when distinct) cache
   directory, atomic, `0600`/`0700`; never in the workspace. Host-provided `api.paths` values (created `0700` by the core) are
   still `realpath`-validated (absolute, exist or creatable, not inside the workspace) before use.
10. **Host options are untrusted input**: `api.options` (frozen snapshot, max 8 KB) is validated like the file
    (strict keys, enums, no secrets) and never interpolated into commands or paths.
11. **Setup job**: single job, cancellable, with every child killed on cancel/dispose; the job record
    holds no secrets and no decision data.

## 9. Test strategy (vitest, offline, no real Python in CI)

`pnpm check` must pass without Python, torch, network or a model. Network is a test failure.

Seams for injection: `spawn`, `exec` (installer), `fetch`/transport, `clock`, `fs` root (temp dirs), `env`, `now`.

| Area | Tests |
| --- | --- |
| Config/paths | precedence env > host options > file > default with per-value source, XDG fallbacks, `api.paths` used when present and fallback when absent (both resolve to the same `<configHome>/plugins/laya` shape, no double `laya/` segment), `api.options` frozen snapshot read once, > 8 KB or project-level options never expected, strict validation of file and host options, secret-key rejection, atomic write, realpath containment, traversal and symlink escapes. |
| Codec (pure, table-driven from recorded fixtures) | select/boolean/ordinal encode and decode; boolean with and without meanings; ordinal derived from index-string `probabilities` (argmax, tie -> lowest index, `level = levels[index]`, ordered `distribution`), never from `score`; missing or malformed score probabilities fail closed; choice label-keyed probabilities; `noul` P(true) with `confidence == answer_confidence`; `answer_confidence` preferred over entropy `confidence`; `min_confidence` never present in the encoded request; >32 levels rejected; scalar state wrapping; `language` forwarded as `lang_guess` only when well-formed BCP 47; 16 decisions / 20 options / 16 KB state / 32 KB total limits; duplicate or empty ordinal levels; hostile keys (`__proto__`, `constructor`) and keys outside `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`. |
| Response validation | missing id, extra id, label outside options, NaN/Infinity, out-of-range probability, wrong types, oversized body, non-JSON, empty body, wrong `Content-Type`. |
| Transport vs fake HTTP server (`node:http`) | bearer sent, loopback only, redirects refused, timeout aborts, caller abort, 401/403/413/422/500/503 (+`Retry-After`), connection reset, slow body, huge body. |
| Supervisor vs `fake-laya-serve.mjs` (real child process via `process.execPath`) | fast start; slow start; never ready (deadline); port collision retry; process killed (SIGKILL) mid-flight; exits at boot; hangs on SIGTERM (escalates to SIGKILL; whole stop sequence completes under 2000 ms with a fake clock); orphan from a missed `dispose()` reclaimed on next start via the pidfile; backoff schedule with fake clock; fail-after-5; single-flight under concurrent `ensureStarted`; dispose idempotent; no orphan after dispose; stale pidfile reaping only when cmdline matches; foreign pid untouched; token never appears in ring buffer or errors; child env contains only the allowlist and offline flags. |
| Installer (fake runner + temp dir) | python discovery matrix (missing, 3.9, 32-bit, no venv module); consent declined/unanswered/`--yes`; zero side effects before consent; step failure at each stage leaves previous runtime intact; checksum mismatch; atomic swap; `--repair`; `--uninstall` containment; manifest write; no network call without consent (a throwing fetch/spawn proves it). |
| Setup job (`jobs.ts`, fake runner, fake clock) | `/laya:setup` returns immediately after consent and does not await the install; second call while running starts nothing and reports status; state transitions and atomic record writes; `/laya:status` shows step/elapsed/failure; `/laya:cancel` kills the active child, removes `venv.new` and partial downloads, keeps the previous runtime, ends `cancelled`; cancel with no job is a no-op; `dispose()` mid-job cancels it; stale `running` record reported `interrupted`; provider `unavailable` and supervisor idle while a job runs; headless without `--yes` never starts a job. |
| Provider | `health()` for every condition in §4.3, never exceeds its time budget, has no side effects (starts no process); `decide()` never calls `health()`; `decide()` rejects fast with `not_ready` while starting/warming and with `unavailable` while failed/backoff/not installed/inactive; every rejection is a `DecisionProviderError` with the §4.3 code and no raw `Error` escapes; over-limit request -> `internal` without contacting the server; timeout -> `timeout`; JSON invalid -> `invalid_response`; model missing (server 5xx mapped to `unavailable`); process-died-between-health-and-decide. |
| Activation | `activate()` with `preload` starts a background start and returns without awaiting readiness; without `preload` it starts nothing and the first `decide()` single-flights a start and rejects `not_ready`; `activate()` is a no-op when not installed or a job runs; `deactivate()` stops the server promptly, idempotently; never throws; `activate`/`deactivate` absent on the host -> `activeProvider()` fallback path. |
| Plugin wiring (fake `PluginAPI`) | registers commands always; registers provider only when `api.decisions` exists; unregister on dispose; no throw without `api.decisions`, `api.paths` or options; `setup()` returns before any process starts; no process before `activate()`; no registration of tools/events. |
| Failure injection matrix (named, mirrors plan §41) | process killed, health timeout, invalid JSON, decision timeout, model missing, low-confidence passthrough (plugin returns the value; core thresholds), runtime absent. Each asserts: rejection type/health status, no unhandled rejection, no leaked process, no leaked timer, no state in messages. |

Optional, outside `pnpm check`: `LAYA_E2E=1` runs a real install and real decisions on the maintainer's machine
(manual release checklist; never in CI).

Strict TDD applies: write the failing test first per work unit.

## 10. Phases, deliverables and acceptance criteria

Each phase is a reviewable work unit; tests and docs travel with the code. Commits are conventional and
carry no AI attribution (user rule). Nothing is committed or published until the owner orders it.

### Phase 0 - Prerequisites (separate changes, before any plugin code lands)

- **P0.1 SDK peer range, other packages** (separate PR, `chore`): widen `peerDependencies["@alisio/sdk"]` of the
  other 13 packages from `>=0.1.0-alpha.10 <0.2.0` to a range covering the current core (at minimum 0.2.x; recommended
  `>=0.1.0-alpha.10 <0.4.0` once each is smoke-tested against 0.2.x and 0.3.0). Add a patch changeset per package.
  Do not change devDependencies unless a package needs newer typings. Acceptance: `pnpm check` green; no behavior change.
  This is independent of the Decision contract and can land at any time.
- **P0.2 SDK 0.3.0 published** by the core with the §4.1 types, before plugin implementation starts (G8).
  Acceptance: installing `@alisio/sdk@0.3.0` in the new package resolves; `DecisionProvider`,
  `DecisionProviderError`, every `Decision*` type and `JsonValue` are exported from the SDK root; `api.paths`
  and `api.options` (fixed by the core as `api.options?: Readonly<Record<string, JsonValue>>`) are confirmed
  from the published typings; update this spec if they differ.
- **P0.4 Checkpoint comparison** (`english` vs `multilingual`): run both checkpoints on a larger hand-labelled set
  covering select, boolean and ordinal decisions, in English and at least one other language, using the real
  adapter codec. Quality is measured formally in the core's 0.4.0 benchmark variant C; this task is the
  plugin-side check. Acceptance: a scrubbed report (per-type accuracy, `answer_confidence` vs correctness
  separation, latency, size) is attached to the Phase 1 PR, with the labelled set size stated. The owner's
  decision `model = multilingual` stays in force unless this comparison shows a material quality gap that
  justifies another default; the result also informs the threshold guidance in the README.
- **P0.3 Owner decisions**: default `model = multilingual` and `preload = true` are DECIDED (§3.5). Still pending: owner
  confirmation of the core resolutions in §13 (currently proposals).

### Phase 1 - Spike and pure core (no process, no network)

Deliverables: scrubbed real fixtures; `manifest.ts` with real pins/sizes/SHA-256; `errors.ts`, `config.ts`, `paths.ts`,
`protocol/codec.ts`, `protocol/validate.ts`, `transport/http.ts`, `provider.ts` over injected seams; tests for all of them.

Already answered by core Phase 0 (§2.5, to be re-confirmed, not re-discovered): console-script name, default bind,
response shapes and limits, `trust_remote_code`, sizes, cold start, latency. Spike checklist (done once on a throwaway
venv, results recorded in the PR description and fixtures, never with local paths): record scrubbed real fixtures for
choice/score/noul from the pinned version; whether question ids are model-visible; the exact `LAYA_SHA256_DIGESTS`
format and how `LAYA_REVISION=reviewed` interacts with the plugin's own `snapshot_download` pin; torch wheel policy;
peak RAM per checkpoint; behavior with `HF_HUB_OFFLINE=1` after setup; the `english`/`typed-decisions` checkpoints.
Acceptance: codec round-trips every fixture (including the index-string `score` probabilities); all §4.2/§4.3 rows covered; coverage of codec/validate/config/paths >= 90 % lines.

### Phase 2 - Supervisor

Deliverables: `supervisor.ts`, `env.ts`, `pidfile.ts`, `fake-laya-serve.mjs`, full lifecycle tests.
Acceptance: every supervisor row in §9 passes; repeated runs (x50) show no flakes, no leaked processes or timers.

### Phase 3 - Installer and commands

Deliverables: `python.ts`, `installer.ts`, `jobs.ts`, `commands.ts` (`/laya:setup`, `/laya:status`, `/laya:cancel`);
consent flow; background job with persisted record and cancellation; `--repair`/`--uninstall`.
Acceptance: installer and setup-job rows in §9 pass; `/laya:setup` returns immediately after consent; a cancel leaves
no partial state; a throwing network/spawn stub is never invoked before consent;
manual run on a clean machine installs, smoke-tests and runs `decide` with the network disabled afterwards (recorded in the PR).

### Phase 4 - Plugin wiring

Deliverables: `index.ts` (`definePlugin`, `setup`, `dispose`), provider `activate`/`deactivate` wiring, `api.paths` and plugin
options adoption with fallbacks, registration against the real 0.3.0 `PluginAPI`, command namespacing verified, README (EN).
Acceptance: the plan's acceptance example works end to end against a real core with Laya active
(`api.decisions.tryDecide` with a `select`), and works (falls back, no crash) with the plugin disabled, uninstalled, or killed;
a cold start produces `not_ready` fallbacks that do not open the circuit; switching `decisions.provider` away stops the server;
the plugin also loads and degrades cleanly against a core without `api.paths`/options; `pnpm check` green.

### Phase 5 - Documentation, catalog, release

- Package `README.md` (English only): what it is, requirements (Python >= 3.10, disk/RAM, consent), install, `/laya:setup`,
  `/laya:status`, config, privacy/security notes, troubleshooting, "Laya is optional; Alisio works without it".
- Site: the plugin pages `site/plugins/laya.md` and `site/es/plugins/laya.md` are generated: run `pnpm docs:scan --offline`
  and commit the regenerated cache and pages. If a human-written explanation of managed local processes is added to
  `site/developing-plugins.md`, add the same change to `site/es/developing-plugins.md` in the same commit (neutral, professional Spanish;
  each file links to its mirror and states they must be updated together).
- `registry/plugins.json`: **no entry is needed** (local `packages/*` are auto-discovered; the registry is for third parties).
  Add one only if a catalog override (e.g. `featured`) is explicitly wanted.
- Changeset: `minor` for `@alisio/plugin-laya` initial release (0.1.0), then `pnpm run version`; never hand-publish.
- Acceptance: `pnpm check` (includes `docs:check`, `docs:build`, `pack:check`, leak scan of the tarball) green; if a diagram is added,
  `pnpm diagrams:check`.

## 11. Versioning and compatibility

- `@alisio/plugin-laya` starts at `0.1.0`. Peer range **`>=0.3.0 <0.7.0`**.
  - Why wide, not per-release widening: on `0.x`, `^0.3.0` means `<0.4.0`, so the narrow range would
    force a plugin release for every core minor even though the core commits to keeping the Decision
    contract compatible across 0.4, 0.5 and 0.6. A stale peer range makes package managers warn or
    refuse the install on a core the plugin does work with, which is the same defect Phase 0 fixes for
    the other 13 packages. This plugin consumes only the Decision contract, `api.paths`, options,
    `api.commands`, `api.ui` and `api.state`.
  - Why not unbounded: the compatibility promise covers 0.4-0.6 only. At the first core minor that
    breaks any of those surfaces, narrow the range in a patch release (`<0.N.0`) and widen again after
    a smoke run. The core's compatibility commitment must be restated in its spec so this range has a
    documented basis.
  - Guard rails: the Phase 4 smoke test runs against every published core minor in range before each
    plugin release; `devDependencies` stays the exact `0.3.0` (types are the floor); the plugin
    feature-detects `api.decisions`, `api.paths`, options and `activate`/`deactivate` at runtime, so
    additive members never break it. If the owner prefers the conservative option, the fallback is
    `>=0.3.0 <0.4.0` plus one widening patch per core minor.
  - Note for the repo-wide Phase 0.1 change: apply the same reasoning (range tied to published,
    verified core versions) rather than hardcoding `<0.4.0` by habit.
- `config.json` and `runtime.json` carry `version`/`schemaVersion`; an unknown higher version makes the provider `unavailable`
  with a clear message; lower versions are migrated forward only through `/laya:setup`.
- A Laya pin bump is a normal minor release that makes `/laya:status` report "runtime outdated: run /laya:setup --repair"; it is
  never applied silently.
- Honour `DecisionRequest.version`: reject (as `LayaProtocolError`) any version other than `1`.

## 12. Risks

| ID | Risk | Mitigation |
| --- | --- | --- |
| R1 | Large first install (CPU ~1.7 GB, CUDA ~6 GB including the 647 MB `multilingual` checkpoint) surprises users. | Consent screen with exact numbers; CPU wheel index; single-checkpoint default (`multilingual`); clear status. |
| R2 | Cold start (measured 3.9-11.4 s) far exceeds the 1500 ms decision timeout, so early calls fall back. | Start at `activate()`, immediate `not_ready` rejection (never waits), warm-up before `ready`, honest README. Relies on the core's accepted G7 rule that `not_ready`/`unavailable` do not open the circuit; verify in Phase 4. |
| R3 | Laya releases daily; protocol/field drift. | Exact pin, recorded fixtures, strict validation that fails closed, drift surfaces as `LayaProtocolError` and fallback. |
| R4 | Orphan server after a hard host kill, or `dispose()` not run (it runs only on application close; disable and `/reload` need a restart and skip it). | Core runs `dispose()` on close with a 2000 ms cap (G5); stop sequence fits that cap; plugin keeps pidfile reaper (reclaims the orphan at next start), exit hook and non-detached child as defense. A SIGKILL of the host remains a known limit. |
| R5 | Transitive Python deps and PyPI/HF compromise. | Pins + SHA-256 for weights; document; constraints-with-hashes follow-up. |
| R6 | Same-user processes can read the bearer token from the child env. | Document; loopback + token blocks other users and remote hosts; nothing stronger is possible without OS sandboxing. |
| R7 | Confidence quality: `laya-multilingual` ships without tuned temperatures; core Phase 0 saw 14/20 clear cases correct and `answer_confidence` AUC 0.34 (it did not separate clear from ambiguous cases; small hand-labelled sample, `english` untested). `noul` label bias on English remains. | Always send explicit criteria; use `answer_confidence` (still the upstream-recommended field); the plugin cannot fix calibration. Core confidence thresholds may be unreliable with this provider, so features should treat Laya confidence as a weak signal and the core should not make safety decisions depend on it. README states this plainly and does not claim "calibrated" answers. Re-evaluate on a larger labelled set and on `english`/`typed-decisions` before recommending a threshold. |
| R13 | CPU latency (~80 ms/question): a 16-decision request (p95 1273 ms) fits the 1500 ms default with a thin margin; slower CPUs or a cold first request can still produce breaker-counting `timeout`s. | §4.4: no truncation, README guidance (smaller packs or a larger `decisions.timeoutMs` on slow CPUs), status reports observed latency. G10 rejected; no dependency. |
| R8 | Platform variance (Windows, macOS MPS, no `python3-venv`). | Preflight diagnostics; Windows supported best-effort in v1, documented. |
| R9 | Peer-range gap blocks installation on current cores. | Phase 0 prerequisites; the plugin itself needs `>=0.3.0`. |
| R10 | Commands have no abort signal or progress channel (G3 deferred), but setup takes minutes. | Setup is a background job that returns immediately; state, progress and cancellation via `/laya:status` and `/laya:cancel`; persisted job record; `dispose()` cancels on application close; idempotent `--repair`. Residual: a user who closes the host mid-job gets an `interrupted` record and must re-run. |
| R12 | Core proposals (G1, G2, G4) are not yet confirmed by the owner or published. | Every use is feature-detected with a working fallback; Phase 0.2 re-checks the published typings and this spec is updated before code. |
| R11 | Third-party `@receptron/laya` or future `laya-ts` look attractive and diverge. | Documented decision criteria in §3.1; revisit trigger stated. |

## 13. Gaps in core/SDK and their resolution

Status of each gap after the core session's response. All resolutions are proposals for core 0.3.0,
**pending owner confirmation** unless stated otherwise; this spec is written against them.

| ID | Need | Resolution | Effect on this spec |
| --- | --- | --- | --- |
| G1 | Per-plugin directories (`api.paths`: state, config, cache). | **Accepted, implemented.** `api.paths?: { state; config; cache }`, optional, detectable; created `0700` on first read; `config` under `<configHome>/plugins/<id>`. | Used when present; own XDG/`ALISIO_*` resolution kept as fallback (§2.2, §3.5). |
| G2 | Config options for external plugins. | **Accepted (minimal), implemented.** `api.options`: frozen snapshot of user-level `pluginOverrides[id].options`, max 8 KB; project options ignored with a diagnostic. | Precedence env > host options > file > default (§3.5); file and `ALISIO_LAYA_*` remain the fallback. |
| G3 | Abort signal and progress for commands. | **Deferred** (not in 0.3.0). | `/laya:setup` is a background job returning immediately; state and cancellation via `/laya:status` and `/laya:cancel` (§6.0, R10). |
| G4 | Provider activation notification. | **Accepted.** `DecisionProvider.activate?()` / `deactivate?()`, bounded by `pluginHooks.timeoutMs`, no `AbortSignal`, never fatal; also called on a live `decisions.provider` change. | Server starts and warms in `activate()`, stops in `deactivate()` (§3.2, §7). |
| G5 | Guaranteed, bounded `dispose()`. | **Corrected after core Phase 3.** `dispose()` runs on application close only (`/exit`, Ctrl+C, TUI SIGTERM/SIGHUP, `serve` SIGINT/SIGTERM, `alisio run` SIGINT/SIGTERM/SIGHUP), in parallel, each capped by `pluginHooks.disposeTimeoutMs` (2000 ms), after the active provider's `deactivate()`. Disable and `/reload` need a restart and do not call it (ADR-12). | Stop sequence sized to 2000 ms; pidfile reaper and exit hook kept as defense (§7, R4). |
| G6 | `DecisionRequest.language?`. | **Accepted.** BCP 47 string, optional. | Forwarded as `lang_guess` (§4.2). |
| G7 | Breaker and error semantics. | **Accepted.** SDK exports `DecisionProviderError` with `code: "not_ready" \| "unavailable" \| "timeout" \| "invalid_response" \| "internal"`. Fast `not_ready`/`unavailable` count as fallback but do not open the circuit; only `timeout` and untyped/`internal` errors count. The core never calls `health()` on the `decide` path (only `/decisions`). **`DecisionProviderResult.meta` is rejected for v1** (no consumer). | `decide()` rejects immediately with `not_ready` while starting; error mapping table in §4.3; no `meta` anywhere. |
| G8 | Export all `Decision*` types and `JsonValue` from the SDK root; publish SDK 0.3.0 first. | **Accepted.** SDK 0.3.0 is published before plugin implementation starts. | Phase 0.2 gate. |
| G9 | Request hygiene. | **Accepted.** Keys `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`; unique non-empty levels and options; total request <= 32 KB in addition to `state` <= 16 KB. | Core guarantees these; the plugin re-validates (§4.1). |
| G10 | CPU latency vs the decision timeout. | **Rejected for 0.3.0.** The core instead raised the default `decisions.timeoutMs` to 1500 ms (covers 16 decisions on CPU). | None required; thin margin on slow CPUs documented (§4.4, R13). |
| - | `confidence` semantics. | Contract: the provider's best estimate in [0,1] that the answer is correct; the core assumes no calibration and `minConfidence` (0.6) is a heuristic filter. | The `answer_confidence` mapping stands (§4.2). |

## 14. Divergences from the planning summary (verified differences)

1. Checkpoint downloads are ~0.64-0.84 GB each (safetensors), not 320-420 MB (that is parameter count).
2. `laya-ts` and `laya-client` are not published on npm today; `laya-ts` cannot avoid Python for installation anyway.
3. `registry/plugins.json` registration is not needed for local packages (auto-discovered); only a third-party registry uses it.
4. `confidence` in Laya is entropy-based and not calibrated; the adapter must use `answer_confidence`.
5. `device` additionally supports `mps` (Apple Silicon); `xpu` is deliberately not exposed.
6. Laya publishes a patch release almost daily: the plugin pins exactly and upgrades only through an explicit setup run.
7. Consent UI exists (`api.ui.askQuestions`); headless runs require an explicit `--yes`.
8. `score` answers carry no level or index (expected value plus index-string `probabilities`): the adapter derives them (§4.2).
9. Laya downloads are unpinned by default, so the plugin must set `LAYA_REVISION=reviewed` and `LAYA_SHA256_DIGESTS`.
10. Laya `answer_confidence` did not separate clear from ambiguous cases on the multilingual sample (AUC 0.34); the "calibrated" framing is not safe to promise (R7).

## 15. Implementation notes (as built)

Built in `packages/plugin-laya` (309 offline tests, `pnpm check` green, leak scan clean). Everything below
that touches a real Laya install is **unverified here**: no pip install and no model download was run, so the
installer is proven only against fake runners and `test/fixtures/fake-laya-serve.mjs`.

### 15.1 Verified while implementing (from the published artifacts, not from a running server)

- SDK 0.3.0 typings: `api.decisions`, `api.paths`, `api.options`, `DecisionProviderError` (runtime class),
  category `"decisions"`, `activate?(): void | Promise<void>` all match §4.1. The provider id must match
  `^[a-z0-9][a-z0-9.-]{0,63}$` (`laya` does). Core command keys are `<pluginId>:<name>`, so `setup`, `status` and
  `cancel` become `/laya:setup`, `/laya:status` and `/laya:cancel` (read from the core's plugin host).
- Laya 0.3.24 wheel (downloaded to a scratch directory, not installed): `laya-serve = laya.serve:main`;
  `LAYA_SHA256_DIGESTS` is either a flat `{path: sha256}` or a nested `{model: {path: sha256}}`, paths relative to
  the checkpoint directory; the bundle repo `convaiinnovations/laya` holds `multilingual/` and `typed-decisions/`
  subfolders, and English at the root; `LAYA_DEFAULT_MODEL` and `LAYA_MODELS` select checkpoints.
- Pins in `src/runtime/manifest.ts`: bundle repo revision `55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851`; sizes and
  SHA-256 of every checkpoint file (LFS digests from the Hub listing, small files hashed from the pinned revision).
- All 13 existing packages typecheck against `@alisio/sdk@0.3.0`; their peer range was widened to `<0.4.0` (Phase 0.1).

### 15.2 Divergences from the text above

1. No changeset for `@alisio/plugin-laya`: a first release already sits at `0.1.0` (repo release skill: no changeset for
   a first release). Only the peer-widening changeset for the other 13 packages exists.
2. The venv is created in `venv-<laya>-<id>` and `runtime.json` names it (relative); no `venv.new` rename.
3. The model download uses `HF_HOME=<hf>` (Hugging Face then writes `<hf>/hub`), not `cache_dir`.
4. `LAYA_SHA256_DIGESTS` is sent in the nested per-checkpoint form.
5. `LAYA_PRELOAD=1` is always set on the child; the plugin's `preload` option decides only whether `activate()`
   starts the server.
6. Failure streak: crashes within 10 minutes count toward the 5-failure limit and the streak resets only after the
   server stayed up 60 s (a server that reaches `ready` and crashes at once never resets it).
7. `--uninstall` removes only what setup created inside the runtime root (`runtime.json`, `jobs`, `hf`, `server.pid`,
   `venv-*`), never the whole directory a user pointed `ALISIO_LAYA_HOME` at.
8. `deactivate()` waits at most 500 ms for the stop to be issued; the kill sequence finishes in the background.
9. The catalog category list (`site/.vitepress/data/categories.json`) has no `decisions`, so the generated catalog
   entry shows no category. Adding it touches the list, the registry schema, `format.ts` labels, the scan test and
   the EN/ES developer docs; left for an owner decision.

### 15.3 Still open

- P0.4 (english vs multilingual comparison) and the remaining Phase 1 spike items (peak RAM, offline load after
  setup, `english` / `typed-decisions` behaviour, whether question ids are model-visible) need a real install.
- The manual clean-machine run of Phase 3, the end-to-end run against a real core in Phase 4, and the Phase 4 smoke
  against each core minor in range.
- Coverage: tooling is not installed, so the >= 90 % line-coverage criterion was not measured.

## 16. Real-install verification and P0.4 results (2026-10-03)

Run on a real Laya 0.3.24 install (CPU, Python 3.10.12, Ubuntu) through the plugin's own `/laya:setup`, with an
isolated config and state home, `LAYA_REVISION=reviewed` and the pinned model checksums. Raw evidence is kept
outside the repository.

### 16.1 Findings from the real install

- **Bug found and fixed:** `pip install laya[serve]` crashed with `AssertionError` in the pip 22.0.2 that Ubuntu
  22.04 bundles in new venvs (resolver topological weights). Setup now upgrades pip (`pip>=24`, from PyPI) as the
  first step of "installing packages"; covered by a test. After the fix a full setup (CPU torch 2.14.1, laya 0.3.24,
  multilingual checkpoint) succeeded and the smoke test passed; a second run with `--model auto` added `english`
  with its checksums verified.
- The server listened only on `127.0.0.1` (checked with `ss -ltnp`), with `LAYA_API_KEY` set, `HF_HUB_OFFLINE=1`
  and `TRANSFORMERS_OFFLINE=1`, and was gone after the host process exited.
- Runtime sizes: venv 1.1 GB, `multilingual` 0.68 GB, `english` 0.85 GB. Cold start to ready with preload: 5.3 s
  (`multilingual`), 4.3 s (`english`).
- Core `/laya:*` commands are reachable only from the TUI (`/command laya:status`); `alisio run` sends the text to the
  model and the web UI lists no plugin commands. In a headless run started cold, the first decision fell back with
  `not_ready` (as designed); with the server warm it produced `decision_completed` (101 ms, 2 decisions).

### 16.2 P0.4 checkpoint comparison

Set: 64 dashboard scenarios (32 English, 32 Spanish; 48 templated with explicit goal clauses, 16 hand-written), 375
labelled decisions (187 English, 188 Spanish), built exactly like the core's `smart-dashboard-v1` pack (opaque
column aliases `c1..cN`, labels and cardinality from the example CSV headers) and sent through the plugin's real codec
and transport. Labels are designed by the author from the goal text, so they are optimistic for templated goals.
Ordinal decisions are not part of that pack and were not measured. Run inside a network namespace with no network:
both checkpoints loaded and answered offline. Machine: 20 threads, shared and busy (load average about 5-6), server
`LAYA_THREADS=4`, so latencies are pessimistic.

| Checkpoint | Language | Accuracy | AUC of `answer_confidence` | Request p50 / p95 (7.4 decisions) | Single decision p50 / p95 | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| multilingual | English | 61.0 % (n=187) | 0.61 | 2.1 s / 3.1 s | 0.30 s / 0.38 s | 2.3 GB |
| multilingual | Spanish | 62.2 % (n=188) | 0.60 | (same run) | (same run) | |
| multilingual | All | 61.6 % +/- 4.9 | 0.60 | | | |
| english | English | 58.8 % (n=187) | 0.64 | 6.7 s / 9.7 s | 0.87 s / 1.09 s | 2.8 GB |
| english | Spanish | 54.3 % (n=188) | 0.67 | (same run) | (same run) | |
| english | All | 56.5 % +/- 5.0 | 0.65 | | | |

By question (all languages, multilingual / english): purpose 90 % / 61 %, composition toggle 76 % / 55 %, ranking
toggle 67 % / 67 %, trend toggle 57 % / 74 %, correlation toggle 52 % / 44 %, primary measure 53 % / 53 %, ranking
dimension 33 % / 43 %. Boolean bias: `multilingual` answered true 78 % of the time (labels 52 % true), `english` 31 %.

Confidence: `answer_confidence` separates right from wrong only weakly (AUC 0.60-0.65, mean 0.80 vs 0.74 for
`multilingual`). With the core default `minConfidence` 0.6, `multilingual` keeps 82 % of the answers (65.6 % correct),
`english` keeps only 17 % (73 % correct), so `english` would almost always fall back.

Conclusions: no material quality gap in favour of `english`; `multilingual` is better or equal on Spanish, on
purpose selection and on latency, and lighter. Keep `multilingual` as the default. Both are close to chance for yes/no
toggles and for column choices, so a feature should treat Laya as a hint for coarse choices (like the dashboard
purpose) and keep its rules for columns. A single decision fits the 1500 ms timeout; seven decisions in one request do
not on a busy CPU.

### 16.3 Divergence 9 resolved

The catalog category `decisions` was added to `categories.json`, the registry schema, `format.ts` labels, badge
colours and the EN/ES developer docs; the Laya card is classified `decisions`.

## 17. 0.1.1 note (2026-10-03)

Two changes, no new SDK or core requirement (peer range unchanged, `>=0.3.0 <0.7.0`).

1. **Live setup jobs are never marked `interrupted` by another process.** The job record now carries the owner `pid`
   and, on Linux, a process start token that guards against pid reuse (additive fields; records without a pid keep the
   old behavior). `load()` marks a `running` record `interrupted` only when the owner is provably dead (`ESRCH`; `EPERM`
   counts as alive). A live foreign owner leaves the record untouched; `/laya:status` reports it as running in another
   Alisio process (read-only) and `/laya:cancel` says it can only be cancelled from the process that started it.
   No cross-process cancel was implemented.
2. **Automatic activation after setup.** Core 0.4.2 adds the optional `api.decisions.activate(providerId)`. The plugin
   feature-detects it with a local structural type, calls it once when an install or repair job succeeds, and stores
   `activation: { status, at }` (plus the active provider id for `other_provider_active`) in the job record. The host
   asks for confirmation and persists the global config; the plugin never writes the user's `config.json`.
   `/laya:activate` repeats the call on demand; `/laya:status` gives a next step per outcome, and cores without the
   member keep the manual `decisions.provider = "laya"` instruction.

## 18. 0.1.2 note (2026-10-04)

No new SDK or core requirement (peer range unchanged, `>=0.3.0 <0.7.0`).

1. **Recommended pre-selection.** Core 0.4.3 adds an optional second argument to the host member:
   `api.decisions.activate(providerId, { recommend?: boolean })`. With `recommend: true` the host pre-selects "Yes
   (recommended)" in its confirmation question. Every user-initiated activation (the one after a successful setup and
   `/laya:activate`) passes `{ recommend: true }`; older cores ignore the extra argument. The local structural type
   carries the optional argument; statuses, job record and texts are unchanged.
2. **Documentation corrected from real measurements (2026-10-04).** The managed runtime takes about 6 GB on a
   CUDA-capable machine (PyTorch's default wheels; about 1 GB on CPU only), the `multilingual` checkpoint download is
   678 MB, and a first setup with warm caches took about 3 minutes. Repeated setups replace the previous runtime. The
   README now describes the host-written `decisions.provider`, the `alisio install --update` remedy for peer
   `@alisio/sdk` conflicts (ERESOLVE) and for the stale first install after a publication (npm metadata cache), and
   that column and boolean decisions are near chance, which is why Smart Dashboard asks Laya only for the purpose.
