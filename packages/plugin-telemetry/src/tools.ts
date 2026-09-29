/**
 * Read-only, bounded, privacy-preserving agent tools.
 *
 * Every tool queries the LOCAL database only and returns an aggregate or a
 * bounded slice, never a raw event dump. All five tools declare `read`: they
 * have no local side effects. Writing, pruning and remote export are separate
 * `write`/`external` operations exposed as commands, not tools.
 */
import { type ToolDefinition, type ToolResult, textResult } from "@alisio/sdk";
import type { TelemetryConfig } from "./config.js";
import { boundsEnvelope, sanitizeField, stableError, toolJson } from "./format.js";
import type { Store, TimeRange } from "./store.js";

export const TOOL_NAMES = [
  "telemetry_summary",
  "telemetry_models",
  "telemetry_tools",
  "telemetry_sessions",
  "telemetry_search",
] as const;

export interface ToolRuntime {
  store: Store | null;
  config: TelemetryConfig | null;
  /** Actionable message explaining why the store is unavailable, when it is. */
  configError: string | null;
  now: () => number;
}

const WINDOW_PROPERTY = {
  type: "integer",
  minimum: 1,
  maximum: 525_600,
  description: "Look-back window in minutes (1 minute to 365 days). Defaults to 1440.",
} as const;

const LIMIT_PROPERTY = {
  type: "integer",
  minimum: 1,
  maximum: 100,
  description: "Maximum number of rows to return (1 to 100). Defaults to 20.",
} as const;

const MAX_WINDOW_MINUTES = 525_600;
const MAX_LIMIT = 100;
const DEFAULT_WINDOW_MINUTES = 1_440;
const DEFAULT_LIMIT = 20;

class ArgumentError extends Error {}

function readInteger(
  input: Record<string, unknown>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new ArgumentError(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function readQuery(input: Record<string, unknown>): string {
  const value = input.query;
  if (typeof value !== "string") throw new ArgumentError("query is required and must be a string");
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 200)
    throw new ArgumentError("query must be between 1 and 200 characters");
  return trimmed;
}

function windowFor(runtime: ToolRuntime, windowMinutes: number): TimeRange {
  const to = new Date(runtime.now()).toISOString();
  const from = new Date(runtime.now() - windowMinutes * 60_000).toISOString();
  return { from, to };
}

function unavailable(runtime: ToolRuntime): ToolResult {
  return textResult(
    toolJson(
      stableError(
        "telemetry_unavailable",
        "The telemetry store is unavailable; no local database is open.",
        runtime.configError ??
          "Check the telemetry configuration and database path, then retry. Use the telemetry-status command for details.",
      ),
    ),
    true,
  );
}

function failure(error: unknown): ToolResult {
  if (error instanceof ArgumentError)
    return textResult(toolJson(stableError("invalid_arguments", error.message)), true);
  return textResult(
    toolJson(
      stableError(
        "telemetry_query_failed",
        "The telemetry query failed.",
        "The local store may be locked or corrupt. Retry, or run telemetry-status for details.",
      ),
    ),
    true,
  );
}

/** Run a tool body with uniform argument validation, availability and error handling. */
function handler(
  runtime: ToolRuntime,
  body: (store: Store, input: Record<string, unknown>) => ToolResult,
): (input: Record<string, unknown>) => Promise<ToolResult> {
  return async (input: Record<string, unknown>): Promise<ToolResult> => {
    if (runtime.store === null || runtime.config === null) return unavailable(runtime);
    try {
      return body(runtime.store, input);
    } catch (error) {
      return failure(error);
    }
  };
}

function contentCaptureEnabled(config: TelemetryConfig): boolean {
  const { capture } = config;
  return capture.prompts || capture.completions || capture.toolArguments || capture.toolResults;
}

export function createTelemetryTools(runtime: ToolRuntime): ToolDefinition[] {
  const summary: ToolDefinition = {
    name: "telemetry_summary",
    description:
      "Summarize recent local agent activity: sessions, runs, turns, token totals, tool errors, and tool latency, plus a time series. Metadata only; never returns content.",
    effect: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        windowMinutes: WINDOW_PROPERTY,
        limit: LIMIT_PROPERTY,
      },
    },
    execute: handler(runtime, (store, input) => {
      const windowMinutes = readInteger(
        input,
        "windowMinutes",
        DEFAULT_WINDOW_MINUTES,
        1,
        MAX_WINDOW_MINUTES,
      );
      const limit = readInteger(input, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
      const range = windowFor(runtime, windowMinutes);
      const summaryValue = store.summary(range);
      const bucketSeconds = Math.max(60, Math.floor((windowMinutes * 60) / limit));
      const buckets = store.series(range, bucketSeconds).map((bucket) => ({
        bucketStart: bucket.bucketStart,
        turns: bucket.turns,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
      }));
      const window = { from: range.from, to: range.to, windowMinutes };
      return textResult(
        toolJson(
          boundsEnvelope({
            window,
            limit,
            returned: buckets.length,
            total: buckets.length,
            hint:
              summaryValue.runs === 0
                ? "No runs recorded in this window; run an agent session or widen windowMinutes."
                : `Aggregated over the whole window in ${buckets.length} bucket(s).`,
            data: {
              sessions: summaryValue.sessions,
              runs: summaryValue.runs,
              turns: summaryValue.turns,
              toolCalls: summaryValue.toolCalls,
              toolErrors: summaryValue.toolErrors,
              inputTokens: summaryValue.inputTokens,
              outputTokens: summaryValue.outputTokens,
              cachedInputTokens: summaryValue.cachedInputTokens,
              totalTokens: summaryValue.totalTokens,
              avgToolDurationMs: summaryValue.avgToolDurationMs,
              maxToolDurationMs: summaryValue.maxToolDurationMs,
              firstAt: summaryValue.firstAt,
              lastAt: summaryValue.lastAt,
              buckets,
            },
          }),
        ),
      );
    }),
  };

  const models: ToolDefinition = {
    name: "telemetry_models",
    description:
      "Model mix for a bounded window: turns, input/output/cached tokens, tool calls and average turn duration per model.",
    effect: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { windowMinutes: WINDOW_PROPERTY, limit: LIMIT_PROPERTY },
    },
    execute: handler(runtime, (store, input) => {
      const windowMinutes = readInteger(
        input,
        "windowMinutes",
        DEFAULT_WINDOW_MINUTES,
        1,
        MAX_WINDOW_MINUTES,
      );
      const limit = readInteger(input, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
      const range = windowFor(runtime, windowMinutes);
      const rows = store.models(range, limit);
      const totals = store.totals(range);
      const window = { from: range.from, to: range.to, windowMinutes };
      return textResult(
        toolJson(
          boundsEnvelope({
            window,
            limit,
            returned: rows.length,
            total: totals.models,
            data: rows.map((row) => ({
              model: sanitizeField(row.model, 200),
              turns: row.turns,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              cachedInputTokens: row.cachedInputTokens,
              calls: row.calls,
              avgTurnDurationMs: row.avgTurnDurationMs,
            })),
          }),
        ),
      );
    }),
  };

  const tools: ToolDefinition = {
    name: "telemetry_tools",
    description:
      "Tool usage for a bounded window: call counts, error rate, average/max duration and observed effects per tool name.",
    effect: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { windowMinutes: WINDOW_PROPERTY, limit: LIMIT_PROPERTY },
    },
    execute: handler(runtime, (store, input) => {
      const windowMinutes = readInteger(
        input,
        "windowMinutes",
        DEFAULT_WINDOW_MINUTES,
        1,
        MAX_WINDOW_MINUTES,
      );
      const limit = readInteger(input, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
      const range = windowFor(runtime, windowMinutes);
      const rows = store.tools(range, limit);
      const totals = store.totals(range);
      const window = { from: range.from, to: range.to, windowMinutes };
      return textResult(
        toolJson(
          boundsEnvelope({
            window,
            limit,
            returned: rows.length,
            total: totals.tools,
            data: rows.map((row) => ({
              name: sanitizeField(row.name, 200),
              calls: row.calls,
              errors: row.errors,
              errorRate: Math.round(row.errorRate * 1000) / 1000,
              avgDurationMs: row.avgDurationMs,
              maxDurationMs: row.maxDurationMs,
              effects: row.effects.map((effect) => sanitizeField(effect, 40)),
            })),
          }),
        ),
      );
    }),
  };

  const sessions: ToolDefinition = {
    name: "telemetry_sessions",
    description:
      "Recent sessions/runs for a bounded window with bounded metadata: run and turn counts, tokens, last activity and models.",
    effect: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { windowMinutes: WINDOW_PROPERTY, limit: LIMIT_PROPERTY },
    },
    execute: handler(runtime, (store, input) => {
      const windowMinutes = readInteger(
        input,
        "windowMinutes",
        DEFAULT_WINDOW_MINUTES,
        1,
        MAX_WINDOW_MINUTES,
      );
      const limit = readInteger(input, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
      const range = windowFor(runtime, windowMinutes);
      const rows = store.sessions(range, limit);
      const totals = store.totals(range);
      const window = { from: range.from, to: range.to, windowMinutes };
      return textResult(
        toolJson(
          boundsEnvelope({
            window,
            limit,
            returned: rows.length,
            total: totals.sessions,
            data: rows.map((row) => ({
              sessionId: sanitizeField(row.sessionId, 120),
              runs: row.runs,
              turns: row.turns,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
              lastAt: row.lastAt,
              models: row.models.map((model) => sanitizeField(model, 200)),
            })),
          }),
        ),
      );
    }),
  };

  const search: ToolDefinition = {
    name: "telemetry_search",
    description:
      "Search captured telemetry content. Returns content only when content capture is explicitly enabled; otherwise explains that capture is off. Metadata-only by default.",
    effect: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description:
            "Full-text query over captured prompts, completions, tool arguments and results.",
        },
        windowMinutes: WINDOW_PROPERTY,
        limit: LIMIT_PROPERTY,
      },
      required: ["query"],
    },
    execute: handler(runtime, (store, input) => {
      const captureOn = runtime.config !== null && contentCaptureEnabled(runtime.config);
      const windowMinutes = readInteger(
        input,
        "windowMinutes",
        DEFAULT_WINDOW_MINUTES,
        1,
        MAX_WINDOW_MINUTES,
      );
      const limit = readInteger(input, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
      const range = windowFor(runtime, windowMinutes);
      const window = { from: range.from, to: range.to, windowMinutes };
      if (!captureOn) {
        return textResult(
          toolJson(
            boundsEnvelope({
              window,
              limit,
              returned: 0,
              total: 0,
              hint: "Content capture is disabled, so no content is searchable. Enable capture in the telemetry config to index prompts, completions, tool arguments or results; metadata tools still work.",
              data: { contentCapture: false, hits: [] },
            }),
          ),
        );
      }
      const query = readQuery(input);
      const result = store.search(query, range, limit);
      return textResult(
        toolJson(
          boundsEnvelope({
            window,
            limit,
            returned: result.hits.length,
            total: result.total,
            data: {
              contentCapture: true,
              hits: result.hits.map((hit) => ({
                kind: sanitizeField(hit.kind, 40),
                ref: hit.ref === null ? null : sanitizeField(hit.ref, 120),
                createdAt: hit.createdAt,
                snippet: sanitizeField(hit.snippet, 280),
              })),
            },
          }),
        ),
      );
    }),
  };

  return [summary, models, tools, sessions, search];
}
