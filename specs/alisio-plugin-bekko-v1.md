# Alisio plugin Bekko v1 — integration and verification notes

English translation of the integration guide delivered with the original `plugin-bekko` handoff
(`INTEGRACION.md`), with the status of each item after the package joined the monorepo.

## What was delivered

A TypeScript plugin `@alisio/plugin-bekko` with the `bekko` decision provider, a mapping from
`DecisionRequest` v1 to Bekko questions (choice, noul, score), a lazily loaded runtime,
activation/deactivation and commands. Default model: Bekko 68M. It does not modify `plugin-laya`
and does not install Python.

## Required steps in the real repository

| # | Step | Status (0.1.0) |
| --- | --- | --- |
| 1 | Install dependencies, typecheck and test; fix SDK mismatches. | Done. `jev-web` 0.10.0 does not exist on npm; pinned to 0.9.2 (latest, provides `createBekkoDecider` with the `68m` variant). Typed against `@alisio/sdk` 0.11.4; vitest unit tests replace the source-grep smoke test. |
| 2 | Load ONNX from Node 22+ on Linux and Windows x64; confirm ORT WASM initializes with `jev-web` and Transformers.js 4.3. Never simulate answers. | Linux x64 verified (Node 24, ONNX Runtime Web WASM): 68m and 17m load and answer. Windows not verified. |
| 3 | Verify the automatic download (~196 MB + metadata) on activation, observable state and offline availability after restart; persist the tokenizer and pin model digests. | Done: every file (manifest, tokenizer, model) is pinned by revision, size and SHA-256 and served from a content-addressed disk cache; a second load reads only the cache. |
| 4 | Test 16-decision batches, cancellation, startup, deactivation during download, CPU only, p50/p95 latency and CPU/RAM. | Unit tests cover cancellation, timeouts and deactivation during load. Latency/RAM benchmarks are still open. |
| 5 | Test at least 200 ES/EN examples against Laya. Bekko v0 is mainly English. | Open. A Spanish smoke prompt worked but with low confidence. |
| 6 | Ensure the host falls back when health is not `ready`, on truncation or on error. Never return invented results. | Done: `not_ready` / `unavailable` / `timeout` / `invalid_response` provider errors; truncated input is refused. |
| 7 | Review the licenses of the original weights, dependencies and redistribution. Publish after the smoke test. | Open for the owner: the model card says the weight license "remains to be finalized". Dependencies are MIT/Apache-2.0. Weights are downloaded, not redistributed. |

## Intended user behavior

- Install `@alisio/plugin-bekko` in Alisio.
- Run `/bekko:activate` and confirm; no manual weight download, no Python.
- During the first initialization the provider reports `starting` and Alisio uses its normal fallback.
- `/bekko:status` shows the phase; once ready, decisions are local.
- `/bekko:setup` preloads the model without changing the active provider.

## Remaining limits

Inference runs on the host's main thread; an abandoned request still finishes its ONNX run. A
worker-thread runtime and quality benchmarks against Laya are the main follow-ups.
