/**
 * OpenTelemetry-aligned OTLP/HTTP export.
 *
 * EXPERIMENTAL BY NATURE. Every `gen_ai.*` semantic convention is currently
 * Development/experimental (the GenAI conventions even moved out of the main
 * semconv repository). Using the standard names here is deliberate, and so is
 * refusing to claim stability: these attribute names may change. Where no
 * standard exists (cache-hit ratio, tool effect, token totals, retry state) this
 * module uses clearly namespaced `alisio.telemetry.*` attributes instead of
 * inventing new `gen_ai.*` names.
 *
 * DURABILITY. Payloads are persisted as batches in SQLite before any network
 * call. A batch key is the content hash of the payload, so re-export is
 * idempotent: the same data never creates a second batch and never sends twice.
 * A successful send marks the batch `sent`; a retryable failure leaves it
 * `pending` for a later flush; a non-retryable failure marks it `dead` so it is
 * visible in status rather than silently lost.
 *
 * RETRY POLICY. HTTP 200 (including a partial-success body) is success and is
 * never retried. Only 429, 502, 503 and 504 are retried, with bounded attempts
 * and floor-ed exponential backoff that honors `Retry-After`. Redirects are
 * refused. Response bodies are read through a hard cap.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { OtlpSettings, OtlpSignal } from "./config.js";
import type { Store, TelemetrySnapshot, TimeRange } from "./store.js";
import { VERSION } from "./version.js";

export type Fetcher = typeof fetch;
type Clock = () => number;
export type Sleeper = (milliseconds: number) => Promise<void>;

export const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
export const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;

export interface ResourceInfo {
  serviceName: string;
  environment: string;
  instanceId: string;
}

export interface OtlpAttribute {
  key: string;
  value: Record<string, unknown>;
}

export interface ExportResult {
  signal: OtlpSignal;
  batchKey: string;
  status: "sent" | "retry" | "dead" | "skipped";
  attempts: number;
  httpStatus: number | null;
  error: string | null;
}

export interface ExporterOptions {
  store: Store;
  settings: OtlpSettings;
  fetcher: Fetcher;
  now: Clock;
  sleep: Sleeper;
  /** Read from the token environment at flush time and never stored. */
  token: string | null;
  buildSnapshot: (range: TimeRange) => TelemetrySnapshot;
  /** Window looked at when deriving payloads. Defaults to 24 hours. */
  windowMs?: number;
  maxResponseBytes?: number;
  maxBatchPerFlush?: number;
}

/** Build the OTLP endpoint for a signal under the configured base endpoint. */
export function otlpUrl(endpoint: string, signal: OtlpSignal): string {
  return `${endpoint.replace(/\/+$/, "")}/v1/${signal}`;
}

function hashHex(input: string, length: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

function traceIdFor(runId: string): string {
  return hashHex(`trace:${runId}`, 32);
}

function spanIdFor(key: string): string {
  return hashHex(`span:${key}`, 16);
}

function isoToNanos(iso: string, fallbackMs: number): string {
  const parsed = Date.parse(iso);
  const millis = Number.isFinite(parsed) ? parsed : fallbackMs;
  return (BigInt(Math.trunc(millis)) * 1_000_000n).toString();
}

function attribute(key: string, value: unknown): OtlpAttribute | null {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return { key, value: { intValue: value } };
    return { key, value: { doubleValue: value } };
  }
  return null;
}

function attributes(entries: Array<[string, unknown]>): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const [key, value] of entries) {
    const built = attribute(key, value);
    if (built !== null) out.push(built);
  }
  return out;
}

/** Best-effort provider/host derived from a `provider/model` reference. */
const PROVIDER_HOSTS: Record<string, string> = {
  openai: "api.openai.com",
  anthropic: "api.anthropic.com",
  deepseek: "api.deepseek.com",
  openrouter: "openrouter.ai",
  google: "generativelanguage.googleapis.com",
  gemini: "generativelanguage.googleapis.com",
  mistral: "api.mistral.ai",
  groq: "api.groq.com",
  xai: "api.x.ai",
  ollama: "localhost",
};

export function providerFromModel(model: string | null): { provider: string; host: string } | null {
  if (model === null) return null;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  const provider = model.slice(0, slash).toLowerCase();
  const host = PROVIDER_HOSTS[provider];
  return host === undefined ? null : { provider, host };
}

/** Deterministic sampling by run id so a run is never half-exported. */
export function shouldSample(runId: string, ratio: number): boolean {
  if (!(ratio > 0)) return false;
  if (ratio >= 1) return true;
  const bucket = Number.parseInt(hashHex(`sample:${runId}`, 8), 16);
  return bucket / 0xffffffff < ratio;
}

function resourceAttributes(resource: ResourceInfo): OtlpAttribute[] {
  return attributes([
    ["service.name", resource.serviceName],
    ["service.version", VERSION],
    ["telemetry.sdk.name", "alisio-plugin-telemetry"],
    ["telemetry.sdk.language", "nodejs"],
    ["telemetry.sdk.version", VERSION],
    ["alisio.telemetry.schema_version", 1],
    ...(resource.environment
      ? ([["deployment.environment", resource.environment]] as Array<[string, unknown]>)
      : []),
    ...(resource.instanceId
      ? ([["alisio.telemetry.instance_id", resource.instanceId]] as Array<[string, unknown]>)
      : []),
  ]);
}

type GeneratorOptions = {
  resource: ResourceInfo;
  settings: OtlpSettings;
  now: Clock;
};

function runAttributes(
  run: TelemetrySnapshot["runs"][number],
  settings: OtlpSettings,
): OtlpAttribute[] {
  const provider = providerFromModel(run.model);
  const cacheHitRatio = run.inputTokens > 0 ? run.cachedInputTokens / run.inputTokens : null;
  const total = run.totalTokens ?? run.inputTokens + run.outputTokens;
  return attributes([
    ["gen_ai.operation.name", "invoke_agent"],
    ["gen_ai.conversation.id", run.sessionId],
    ...(provider
      ? ([["gen_ai.provider.name", provider.provider]] as Array<[string, unknown]>)
      : []),
    ...(run.model
      ? ([
          ["gen_ai.request.model", run.model],
          ["gen_ai.response.model", run.model],
        ] as Array<[string, unknown]>)
      : []),
    ["gen_ai.usage.input_tokens", run.inputTokens],
    ["gen_ai.usage.output_tokens", run.outputTokens],
    ["gen_ai.usage.cached_input_tokens", run.cachedInputTokens],
    ["alisio.telemetry.tokens.total", total],
    ["alisio.telemetry.tool.calls", run.toolCalls],
    ["alisio.telemetry.tool.errors", run.toolErrors],
    ["alisio.telemetry.truncated", run.truncated],
    ...(cacheHitRatio === null
      ? []
      : ([["alisio.telemetry.cache_hit_ratio", cacheHitRatio]] as Array<[string, unknown]>)),
    ...(run.status === "error"
      ? ([["error.type", "agent_run_error"]] as Array<[string, unknown]>)
      : []),
    ["alisio.telemetry.redaction", settings.enabled ? "enabled" : "local-only"],
  ]);
}

function statusFor(ok: boolean): Record<string, unknown> {
  return ok ? { code: 1 } : { code: 2, message: "error" };
}

export function buildTracesPayload(
  snapshot: TelemetrySnapshot,
  options: GeneratorOptions,
): unknown {
  const spans: unknown[] = [];
  const sampledRuns = snapshot.runs.filter((run) =>
    shouldSample(run.runId, options.settings.samplingRatio),
  );
  const runSpanIds = new Map<string, string>();
  for (const run of sampledRuns) runSpanIds.set(run.runId, spanIdFor(`${run.runId}:invoke_agent`));

  for (const run of sampledRuns) {
    const spanId = runSpanIds.get(run.runId) as string;
    const start = isoToNanos(run.startedAt, options.now());
    const end = isoToNanos(run.endedAt ?? run.startedAt, options.now());
    spans.push({
      traceId: traceIdFor(run.runId),
      spanId,
      name: `invoke_agent ${run.model ?? options.resource.serviceName}`,
      kind: 1,
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      status: statusFor(run.status !== "error"),
      attributes: runAttributes(run, options.settings),
    });
  }

  for (const turn of snapshot.turns) {
    const parent = runSpanIds.get(turn.runId);
    if (parent === undefined) continue;
    const provider = providerFromModel(turn.model);
    const start = isoToNanos(turn.createdAt, options.now());
    const durationMs = turn.durationMs ?? 0;
    const end = (
      BigInt(start) +
      BigInt(Math.max(0, Math.trunc(durationMs))) * 1_000_000n
    ).toString();
    spans.push({
      traceId: traceIdFor(turn.runId),
      spanId: spanIdFor(`${turn.runId}:turn:${turn.turn}`),
      parentSpanId: parent,
      name: `chat ${turn.model ?? "unknown"}`,
      kind: 1,
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      status: statusFor(true),
      attributes: attributes([
        ["gen_ai.operation.name", "chat"],
        ["gen_ai.conversation.id", turn.sessionId],
        ...(provider
          ? ([["gen_ai.provider.name", provider.provider]] as Array<[string, unknown]>)
          : []),
        ...(provider
          ? ([
              ["server.address", provider.host],
              ["server.port", 443],
            ] as Array<[string, unknown]>)
          : []),
        ...(turn.model
          ? ([
              ["gen_ai.request.model", turn.model],
              ["gen_ai.response.model", turn.model],
            ] as Array<[string, unknown]>)
          : []),
        ["gen_ai.usage.input_tokens", turn.inputTokens],
        ["gen_ai.usage.output_tokens", turn.outputTokens],
        ["gen_ai.usage.cached_input_tokens", turn.cachedInputTokens],
        ["alisio.telemetry.turn", turn.turn],
        ...(turn.durationMs === null
          ? []
          : ([["alisio.telemetry.turn.duration_ms", turn.durationMs]] as Array<[string, unknown]>)),
      ]),
    });
  }

  for (const tool of snapshot.tools) {
    const parent = runSpanIds.get(tool.runId);
    if (parent === undefined) continue;
    const startedAt = tool.startedAt ?? tool.finishedAt ?? new Date(options.now()).toISOString();
    const start = isoToNanos(startedAt, options.now());
    const end = isoToNanos(tool.finishedAt ?? startedAt, options.now());
    spans.push({
      traceId: traceIdFor(tool.runId),
      spanId: spanIdFor(`${tool.runId}:tool:${tool.callId}`),
      parentSpanId: parent,
      name: `execute_tool ${tool.name}`,
      kind: 1,
      startTimeUnixNano: start,
      endTimeUnixNano: end,
      status: statusFor(!tool.isError),
      attributes: attributes([
        ["gen_ai.operation.name", "execute_tool"],
        ["gen_ai.tool.name", tool.name],
        ["gen_ai.tool.call.id", tool.callId],
        ["gen_ai.conversation.id", tool.sessionId],
        ...(tool.effect
          ? ([["alisio.telemetry.tool.effect", tool.effect]] as Array<[string, unknown]>)
          : []),
        ...(tool.durationMs === null
          ? []
          : ([["alisio.telemetry.tool.duration_ms", tool.durationMs]] as Array<[string, unknown]>)),
        ...(tool.isError ? ([["error.type", "tool_error"]] as Array<[string, unknown]>) : []),
      ]),
    });
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(options.resource) },
        scopeSpans: [
          {
            scope: { name: "alisio-plugin-telemetry", version: VERSION },
            spans,
          },
        ],
      },
    ],
  };
}

export function buildLogsPayload(snapshot: TelemetrySnapshot, options: GeneratorOptions): unknown {
  const sampled = snapshot.runs.filter((run) =>
    shouldSample(run.runId, options.settings.samplingRatio),
  );
  const runIds = new Set(sampled.map((run) => run.runId));
  const records: unknown[] = [];
  for (const run of sampled) {
    const at = run.endedAt ?? run.startedAt;
    records.push({
      timeUnixNano: isoToNanos(at, options.now()),
      observedTimeUnixNano: isoToNanos(at, options.now()),
      severityNumber: run.status === "error" ? 17 : 9,
      severityText: run.status === "error" ? "ERROR" : "INFO",
      body: { stringValue: `run ${run.runId} ${run.status}` },
      attributes: attributes([
        ["gen_ai.operation.name", "invoke_agent"],
        ["gen_ai.conversation.id", run.sessionId],
        ...(run.model ? ([["gen_ai.request.model", run.model]] as Array<[string, unknown]>) : []),
        ["alisio.telemetry.tokens.total", run.totalTokens ?? run.inputTokens + run.outputTokens],
        ...(run.status === "error"
          ? ([["error.type", "agent_run_error"]] as Array<[string, unknown]>)
          : []),
      ]),
    });
  }
  for (const tool of snapshot.tools) {
    if (!tool.isError || !runIds.has(tool.runId)) continue;
    const at = tool.finishedAt ?? tool.startedAt ?? new Date(options.now()).toISOString();
    records.push({
      timeUnixNano: isoToNanos(at, options.now()),
      observedTimeUnixNano: isoToNanos(at, options.now()),
      severityNumber: 13,
      severityText: "WARN",
      body: { stringValue: `tool ${tool.name} failed` },
      attributes: attributes([
        ["gen_ai.operation.name", "execute_tool"],
        ["gen_ai.tool.name", tool.name],
        ["gen_ai.tool.call.id", tool.callId],
        ["gen_ai.conversation.id", tool.sessionId],
        ["error.type", "tool_error"],
      ]),
    });
  }
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes(options.resource) },
        scopeLogs: [
          {
            scope: { name: "alisio-plugin-telemetry", version: VERSION },
            logRecords: records,
          },
        ],
      },
    ],
  };
}

export function buildMetricsPayload(
  snapshot: TelemetrySnapshot,
  options: GeneratorOptions,
): unknown {
  const sampled = snapshot.runs.filter((run) =>
    shouldSample(run.runId, options.settings.samplingRatio),
  );
  const end = options.now();
  const start = end;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  for (const run of sampled) {
    inputTokens += run.inputTokens;
    outputTokens += run.outputTokens;
    cachedTokens += run.cachedInputTokens;
    toolCalls += run.toolCalls;
    toolErrors += run.toolErrors;
  }
  const point = (attributesList: OtlpAttribute[], value: number): unknown => ({
    startTimeUnixNano: String(BigInt(Math.trunc(start)) * 1_000_000n),
    timeUnixNano: String(BigInt(Math.trunc(end)) * 1_000_000n),
    asInt: String(value),
    attributes: attributesList,
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes(options.resource) },
        scopeMetrics: [
          {
            scope: { name: "alisio-plugin-telemetry", version: VERSION },
            metrics: [
              {
                name: "alisio.telemetry.tokens",
                description:
                  "Tokens observed in the export window (custom; no stable semconv exists).",
                unit: "{token}",
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    point(attributes([["alisio.telemetry.token.type", "input"]]), inputTokens),
                    point(attributes([["alisio.telemetry.token.type", "output"]]), outputTokens),
                    point(
                      attributes([["alisio.telemetry.token.type", "cached_input"]]),
                      cachedTokens,
                    ),
                  ],
                },
              },
              {
                name: "alisio.telemetry.tool.calls",
                description: "Tool calls observed in the export window (custom).",
                unit: "{call}",
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    point(
                      attributes([["alisio.telemetry.tool.outcome", "ok"]]),
                      Math.max(0, toolCalls - toolErrors),
                    ),
                    point(attributes([["alisio.telemetry.tool.outcome", "error"]]), toolErrors),
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Parse a `Retry-After` header (seconds or HTTP-date) into a bounded delay. */
export function parseRetryAfter(
  value: string | null,
  nowMs: number,
  maxMs = MAX_BACKOFF_MS,
): number {
  if (value === null) return 0;
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, maxMs);
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(0, parsed - nowMs), maxMs);
}

/** Read a response body through a hard byte cap and cancel the remainder. */
export async function readCappedText(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (body === null) {
    try {
      const text = await response.text();
      return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
    } catch {
      return { text: "", truncated: false };
    }
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, maxBytes - total)));
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // A body read failure is not fatal; return what we have.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors.
    }
  }
  const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return { text: buffer.toString("utf8"), truncated };
}

function payloadFor(
  signal: OtlpSignal,
  snapshot: TelemetrySnapshot,
  options: GeneratorOptions,
): unknown {
  if (signal === "traces") return buildTracesPayload(snapshot, options);
  if (signal === "logs") return buildLogsPayload(snapshot, options);
  return buildMetricsPayload(snapshot, options);
}

function isEmptyPayload(signal: OtlpSignal, payload: unknown): boolean {
  const object = payload as Record<string, Array<Record<string, unknown>>>;
  if (signal === "traces") {
    const spans = object.resourceSpans?.[0]?.scopeSpans as
      | Array<Record<string, unknown>>
      | undefined;
    return !spans || spans.every((scope) => Array.isArray(scope.spans) && scope.spans.length === 0);
  }
  if (signal === "logs") {
    const logs = object.resourceLogs?.[0]?.scopeLogs as Array<Record<string, unknown>> | undefined;
    return (
      !logs ||
      logs.every((scope) => Array.isArray(scope.logRecords) && scope.logRecords.length === 0)
    );
  }
  return false;
}

export interface Exporter {
  /** Derive pending batches from the store, then attempt to send them. */
  flush(): Promise<ExportResult[]>;
}

/** Build the exporter. The OTLP token is passed per call and is never retained. */
export function createExporter(options: ExporterOptions): Exporter {
  const { store, settings, fetcher, now, sleep, token } = options;
  const windowMs = options.windowMs ?? 24 * 60 * 60 * 1000;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxBatchPerFlush = options.maxBatchPerFlush ?? 50;

  const range = (): TimeRange => {
    const to = new Date(now()).toISOString();
    const from = new Date(now() - windowMs).toISOString();
    return { from, to };
  };

  const enqueue = (): void => {
    if (settings.endpoint === null) return;
    const snapshot = options.buildSnapshot(range());
    const generatorOptions: GeneratorOptions = {
      resource: {
        serviceName: settings.serviceName,
        environment: settings.environment,
        instanceId: settings.instanceId,
      },
      settings,
      now,
    };
    const signals: OtlpSignal[] = (["traces", "logs", "metrics"] as OtlpSignal[]).filter(
      (signal) => settings.signals[signal],
    );
    const createdAt = new Date(now()).toISOString();
    for (const signal of signals) {
      const payload = payloadFor(signal, snapshot, generatorOptions);
      if (isEmptyPayload(signal, payload)) continue;
      const serialized = JSON.stringify(payload);
      const key = `${signal}:${hashHex(serialized, 32)}`;
      store.enqueueBatch(key, signal, serialized, createdAt);
    }
  };

  const send = async (
    signal: OtlpSignal,
    payload: string,
  ): Promise<{
    status: ExportResult["status"];
    httpStatus: number | null;
    error: string | null;
    attempts: number;
  }> => {
    if (settings.endpoint === null)
      return { status: "skipped", httpStatus: null, error: null, attempts: 0 };
    const url = otlpUrl(settings.endpoint, signal);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...settings.headers,
    };
    if (token !== null && token.trim() !== "") headers.authorization = `Bearer ${token}`;
    let body: string | Uint8Array = payload;
    if (settings.gzip) {
      headers["content-encoding"] = "gzip";
      body = gzipSync(Buffer.from(payload));
    }

    let lastError: string | null = null;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= settings.maxAttempts; attempt += 1) {
      attemptsMade = attempt;
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "POST",
          headers,
          body: body as NonNullable<RequestInit["body"]>,
          redirect: "error",
          signal: AbortSignal.timeout(settings.timeoutMs),
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < settings.maxAttempts) {
          await sleep(Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS));
          continue;
        }
        return { status: "retry", httpStatus: null, error: lastError, attempts: attemptsMade };
      }

      await readCappedText(response, maxResponseBytes);
      if (response.status === 200)
        return { status: "sent", httpStatus: 200, error: null, attempts: attemptsMade };
      if (RETRYABLE_STATUS.has(response.status)) {
        lastError = `HTTP ${response.status}`;
        const delay = parseRetryAfter(response.headers.get("retry-after"), now());
        const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
        if (attempt < settings.maxAttempts) {
          await sleep(Math.max(delay, backoff));
          continue;
        }
        return {
          status: "retry",
          httpStatus: response.status,
          error: lastError,
          attempts: attemptsMade,
        };
      }
      return {
        status: "dead",
        httpStatus: response.status,
        error: `HTTP ${response.status}`,
        attempts: attemptsMade,
      };
    }
    return { status: "retry", httpStatus: null, error: lastError, attempts: attemptsMade };
  };

  return {
    async flush(): Promise<ExportResult[]> {
      const results: ExportResult[] = [];
      if (!settings.enabled || settings.endpoint === null) return results;
      try {
        enqueue();
      } catch {
        return results;
      }
      let batches: ReturnType<Store["pendingBatches"]>;
      try {
        batches = store.pendingBatches(maxBatchPerFlush);
      } catch {
        return results;
      }
      for (const batch of batches) {
        const signal = batch.signal as OtlpSignal;
        let outcome: {
          status: ExportResult["status"];
          httpStatus: number | null;
          error: string | null;
          attempts: number;
        };
        try {
          outcome = await send(signal, batch.payload);
        } catch (error) {
          outcome = {
            status: "retry",
            httpStatus: null,
            error: error instanceof Error ? error.message : String(error),
            attempts: 1,
          };
        }
        const at = new Date(now()).toISOString();
        if (outcome.status === "sent") store.markBatchSent(batch.id, at);
        else if (outcome.status === "dead")
          store.markBatchDead(batch.id, outcome.error ?? "unknown", at);
        else if (outcome.status === "retry")
          store.markBatchRetry(batch.id, outcome.error ?? "unknown", at);
        results.push({
          signal,
          batchKey: batch.batchKey,
          status: outcome.status,
          attempts: outcome.attempts,
          httpStatus: outcome.httpStatus,
          error: outcome.error,
        });
      }
      return results;
    },
  };
}
