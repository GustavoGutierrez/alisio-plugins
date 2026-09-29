# @alisio/plugin-telemetry

Privacy-first local agent observability for
[Alisio](https://github.com/GustavoGutierrez/alisio). It records what the agent
does into a local SQLite database, exposes bounded read-only query tools, and can
optionally export OpenTelemetry-aligned data over OTLP. Local-only is the default;
remote export is opt-in.

This is an independent plugin. It is not affiliated with the OpenTelemetry
project and claims no conformance to a stable semantic-convention release.

## Install

```bash
alisio install npm:@alisio/plugin-telemetry
```

## What it does

- Observes Alisio `RunEvent`s through a synchronous, non-blocking handler and
  writes compact records to a local SQLite database.
- Serves five read-only tools that return bounded, aggregated, privacy-preserving
  summaries.
- Optionally exports traces, logs and metrics to an OTLP/HTTP endpoint with
  durable, idempotent batching.
- Ships a `telemetry` agent skill explaining when and how to consult it.

## Privacy defaults

- **Metadata-only by default.** Prompt, completion, tool-argument and tool-result
  content capture is OFF unless explicitly enabled.
- **Local-only by default.** No network call is made until remote export is
  enabled with an endpoint.
- When content capture is enabled, every captured value passes through
  allowlist-based redaction: bearer/authorization headers, tokens, private keys,
  secrets in key/value form, absolute machine paths and (in `strict` mode) long
  high-entropy runs are stripped, and every field is bounded. Redaction is never
  denylist-only.
- **The OTLP credential is never persisted, logged, returned or serialized.** It
  is read at export time only, from the environment variable named by
  `otlp.tokenEnv` (default `ALISIO_TELEMETRY_OTLP_TOKEN`). The config file may
  only reference the variable's name.
- Telemetry can reveal how someone works, which repositories they use, and what
  they type. Keep `strict` redaction on, prefer metadata-only, and set a
  retention window you are comfortable with.

## Configuration

Configuration precedence, highest first:

1. Explicit non-secret command/tool argument (for example
   `/telemetry:telemetry-setup --retention-days 7`).
2. Environment variables.
3. The config file at `<configHome>/telemetry/config.json`.
4. Built-in safe defaults.

`configHome` resolves as `ALISIO_CONFIG_HOME`, else `XDG_CONFIG_HOME/alisio`,
else `~/.config/alisio`. `stateHome` resolves as `ALISIO_STATE_HOME`, else
`XDG_STATE_HOME/alisio`, else `~/.local/state/alisio`.

The database path is `ALISIO_TELEMETRY_DB`, else
`<stateHome>/telemetry/telemetry.sqlite`. Telemetry stores its data through the
host-provided SQLite storage port (`api.storage.sqlite`), so the plugin never
depends on a runtime SQLite driver. Because the host port sets no pragmas, the
plugin hardens the port right after opening: it enables WAL, a `busy_timeout`,
foreign keys and `NORMAL` synchronous mode, ensures parent directories are
`0700` and the database file is `0600`, and periodically runs `PRAGMA optimize`.

An invalid configuration **fails closed**: telemetry is disabled and an actionable
message is reported. It never crashes the host.

### Settings

| Field | Meaning |
| --- | --- |
| `retentionDays` | How long records are kept before `telemetry-prune` removes them |
| `capture.prompts` / `.completions` / `.toolArguments` / `.toolResults` | Opt-in content capture (redacted, bounded) |
| `redaction.mode` | `strict` (default) or `standard` |
| `otlp.enabled` | Master switch for remote export |
| `otlp.endpoint` | OTLP/HTTP base URL, e.g. `https://collector.example.com:4318` |
| `otlp.headers` | Non-secret headers only; secret-shaped headers are refused |
| `otlp.tokenEnv` | Name of the environment variable that holds the token |
| `otlp.serviceName` / `.environment` / `.instanceId` | Resource attributes |
| `otlp.samplingRatio` | Deterministic per-run sampling, `0`–`1` |
| `otlp.signals.traces` / `.logs` / `.metrics` | Which signals to export |
| `otlp.gzip` | Gzip the request body |
| `otlp.maxAttempts` / `.timeoutMs` / `.batchSize` | Export bounds |
| `batch.batchSize` / `.flushIntervalMs` / `.maxQueue` | Local write bounds |

### Environment variables

`ALISIO_TELEMETRY_DB`, `ALISIO_CONFIG_HOME`, `ALISIO_STATE_HOME`,
`XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `ALISIO_TELEMETRY_RETENTION_DAYS`,
`ALISIO_TELEMETRY_OTLP_ENABLED`, `ALISIO_TELEMETRY_OTLP_ENDPOINT`,
`ALISIO_TELEMETRY_OTLP_TOKEN_ENV`, `ALISIO_TELEMETRY_OTLP_INSTANCE_ID`,
`ALISIO_TELEMETRY_SERVICE_NAME`, `ALISIO_TELEMETRY_ENVIRONMENT`,
`ALISIO_TELEMETRY_SAMPLING_RATIO`, `ALISIO_TELEMETRY_CAPTURE_PROMPTS`,
`ALISIO_TELEMETRY_CAPTURE_COMPLETIONS`, `ALISIO_TELEMETRY_CAPTURE_TOOL_ARGUMENTS`,
`ALISIO_TELEMETRY_CAPTURE_TOOL_RESULTS`, `ALISIO_TELEMETRY_REDACTION_MODE`,
`ALISIO_TELEMETRY_OTLP_SIGNALS`, `ALISIO_TELEMETRY_OTLP_GZIP`,
`ALISIO_TELEMETRY_BATCH_SIZE`, `ALISIO_TELEMETRY_FLUSH_INTERVAL_MS`,
`ALISIO_TELEMETRY_MAX_QUEUE`.

The token itself is read only from `ALISIO_TELEMETRY_OTLP_TOKEN` (or the variable
named by `otlp.tokenEnv`).

## Tools

All tools are read-only (`read`), closed-schema, and return a bounds envelope
(`window`, `returned`, `total`, `truncated`, `hint`). They never dump raw events
and never expose secrets or absolute machine paths.

| Tool | Returns |
| --- | --- |
| `telemetry_summary` | Sessions, runs, turns, tokens, tool errors, latency and a time series |
| `telemetry_models` | Model mix with token usage, calls and average turn duration |
| `telemetry_tools` | Tool call counts, error rate, latency and effects |
| `telemetry_sessions` | Recent sessions/runs with bounded metadata |
| `telemetry_search` | Bounded content search; only returns content when capture is enabled |

## Commands

Alisio namespaces external plugin commands as `<plugin id>:<name>`, so the real
invocation form is:

```
/telemetry:telemetry-setup [options]
/telemetry:telemetry-status
/telemetry:telemetry-flush
/telemetry:telemetry-prune [--days <n>]
```

`telemetry-setup` persists configuration non-interactively and reports exactly
which fields changed, without ever echoing a credential. Use `--json` on any of
these for machine-readable output.

## OpenTelemetry alignment

The plugin emits OTLP/HTTP JSON to `/v1/traces`, `/v1/logs` and `/v1/metrics`
under the configured base endpoint. It uses standard names where they exist, for
example `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`,
`gen_ai.response.model`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.usage.cached_input_tokens`,
`gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.conversation.id`, and the
stable core attributes `error.type`, `server.address` and `server.port`. Span
names follow `{gen_ai.operation.name} {target}`, using `invoke_agent`, `chat` and
`execute_tool`.

**Honesty constraint.** Every `gen_ai.*` semantic convention is currently
Development/experimental, not stable, and the GenAI conventions moved out of the
main semantic-conventions repository. There is no stable release for metrics.
These attribute names may change and this plugin claims no stability. Where no
standard exists — cost, retry rate, cache-hit ratio, approval outcomes, context
growth — the plugin uses clearly namespaced `alisio.telemetry.*` attributes or
metrics instead of inventing `gen_ai.*` names. Cost and approval outcomes are not
captured at all.

Export behavior: HTTP 200 (including a partial-success body) is success and is
never retried; only `429`, `502`, `503` and `504` are retried, with bounded
attempts and floor-ed exponential backoff honoring `Retry-After`. Redirects are
refused and response bodies are read through a hard cap. Payloads are persisted as
batches keyed by their content hash before any network call, so a failed export
stays queued and a retry is idempotent — data is neither lost nor duplicated
silently. Non-retryable responses are marked `dead` and surfaced in
`telemetry-status` rather than discarded.

## Deleting telemetry

`/telemetry:telemetry-prune [--days <n>]` deletes runs, turns, tool calls and
content older than the cutoff, purges the full-text search index, then runs
`optimize` and `VACUUM`. To remove everything, run it with a cutoff in the
future (for example `--days 0`), or delete the SQLite file directly.

**FTS caveat:** the full-text search shadow tables (`content_fts\*`) can retain
fragments even after rows are deleted; prune clears the index and vacuums, but a
copy of the database made earlier may still contain forensic traces. Treat any
captured content as sensitive.

## Requirements

Node.js **>= 22.16** and an Alisio host with `@alisio/sdk`
`>=0.1.0-alpha.10` that provides the SQLite storage port
(`api.storage.sqlite`). Zero runtime dependencies: Node built-ins and native
`fetch` only.

## License

MIT.
