/**
 * Event ingestion: a defensive, synchronous bridge from the host's fire-and-
 * forget `RunEvent` stream into a bounded in-memory record queue.
 *
 * THE HANDLER MUST NEVER MISBEHAVE. Alisio calls observers synchronously inside
 * the agent run, wraps *synchronous* throws in try/catch, but does NOT catch a
 * rejected promise from an `async` handler. Therefore the registered handler
 * here is a plain synchronous function: it validates, maps into a compact
 * record, enqueues, and returns `undefined`. It never awaits, never returns a
 * promise, never throws, and never touches disk. A full queue drops the newest
 * event and counts it rather than blocking the run.
 *
 * CONTENT IS STRIPPED AT THE DOOR. Tool arguments and result previews are only
 * carried into the queue when the matching capture flag is enabled, and only
 * after allowlist redaction. The default record contains metadata only.
 */
import type { CaptureSettings, RedactionSettings } from "./config.js";
import { redactJson } from "./redact.js";

export interface EventEnvelope {
  schemaVersion?: unknown;
  runId?: unknown;
  sessionId?: unknown;
  seq?: unknown;
  timestamp?: unknown;
  type?: unknown;
  data?: unknown;
}

/** An envelope that passed the minimum shape check. */
export interface TrustedEnvelope {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  seq: number;
  timestamp: string;
  type: string;
  data: unknown;
}

export interface RunStartRecord {
  kind: "run_start";
  runId: string;
  sessionId: string;
  seq: number;
  timestamp: string;
  model: string | null;
}

export interface RunEndRecord {
  kind: "run_end";
  runId: string;
  sessionId: string;
  seq: number;
  timestamp: string;
  status: "completed" | "error";
  totalTokens: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  truncated: boolean;
  text: string | null;
}

export interface TurnRecord {
  kind: "turn";
  runId: string;
  sessionId: string;
  seq: number;
  timestamp: string;
  turn: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  calls: number;
  durationMs: number | null;
}

export interface ToolStartRecord {
  kind: "tool_start";
  runId: string;
  sessionId: string;
  seq: number;
  timestamp: string;
  callId: string;
  name: string;
  effect: string | null;
  argsBytes: number;
  args: string | null;
}

export interface ToolEndRecord {
  kind: "tool_end";
  runId: string;
  sessionId: string;
  seq: number;
  timestamp: string;
  callId: string;
  name: string | null;
  isError: boolean;
  durationMs: number | null;
  resultBytes: number;
  preview: string | null;
}

export type TelemetryRecord =
  | RunStartRecord
  | RunEndRecord
  | TurnRecord
  | ToolStartRecord
  | ToolEndRecord;

export interface RedactionContext {
  capture: CaptureSettings;
  redaction: RedactionSettings;
}

const MAX_ID = 200;
const MAX_MODEL = 200;
const MAX_TOOL_NAME = 200;
const MAX_EFFECT = 40;

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function whole(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  return null;
}

/** Coerce to a non-negative integer, defaulting to 0. */
function count(value: unknown): number {
  const numeric = whole(value);
  return numeric === null || numeric < 0 ? 0 : numeric;
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return false;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function usageOf(data: Record<string, unknown>): {
  input: number;
  output: number;
  cachedInput: number;
} {
  const usage = asObject(data.usage);
  return {
    input: count(usage?.input),
    output: count(usage?.output),
    cachedInput: count(usage?.cachedInput),
  };
}

/** True when the envelope carries the minimum shape required to trust it. */
export function isTrustedEnvelope(event: unknown): event is TrustedEnvelope {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as EventEnvelope;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.runId === "string" &&
    candidate.runId.length > 0 &&
    candidate.runId.length <= 512 &&
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length <= 512 &&
    typeof candidate.seq === "number" &&
    Number.isFinite(candidate.seq) &&
    typeof candidate.timestamp === "string" &&
    candidate.timestamp.length <= 64 &&
    typeof candidate.type === "string"
  );
}

const RUN_START = new Set(["run_started", "run_start", "run.started"]);
const RUN_END = new Set(["run_completed", "run_finished", "run_finish", "run.completed"]);
const TURN = new Set(["turn_completed", "turn.completed"]);
const TOOL_START = new Set(["tool_started", "tool.started"]);
const TOOL_END = new Set(["tool_completed", "tool.completed"]);

/**
 * Map one trusted envelope into a compact record. Returns null for unknown
 * event types, malformed payloads, or payloads missing required identifiers.
 * Never throws.
 */
export function normalizeEvent(
  event: Readonly<TrustedEnvelope>,
  context: RedactionContext,
): TelemetryRecord | null {
  const { runId, sessionId, seq, timestamp, type } = event;
  const run = text(runId, MAX_ID);
  const session = text(sessionId, MAX_ID);
  if (run === null || session === null) return null;
  const data = asObject(event.data);

  if (RUN_START.has(type)) {
    return {
      kind: "run_start",
      runId: run,
      sessionId: session,
      seq,
      timestamp,
      model: text(data?.model, MAX_MODEL),
    };
  }

  if (RUN_END.has(type)) {
    const usage = data ? usageOf(data) : { input: 0, output: 0, cachedInput: 0 };
    const textValue = data ? text(data.text, 2000) : null;
    return {
      kind: "run_end",
      runId: run,
      sessionId: session,
      seq,
      timestamp,
      status: data && truthy(data.error) ? "error" : "completed",
      totalTokens: data ? whole(data.tokens) : null,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedInputTokens: usage.cachedInput,
      truncated: data ? truthy(data.truncated) : false,
      text:
        textValue !== null && context.capture.completions
          ? redactJson(textValue, { mode: context.redaction.mode })
          : null,
    };
  }

  if (TURN.has(type)) {
    if (!data) return null;
    const turn = whole(data.turn);
    if (turn === null) return null;
    const usage = usageOf(data);
    return {
      kind: "turn",
      runId: run,
      sessionId: session,
      seq,
      timestamp,
      turn,
      model: text(data.model, MAX_MODEL),
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedInputTokens: usage.cachedInput,
      calls: count(data.calls),
      durationMs: whole(data.durationMs),
    };
  }

  if (TOOL_START.has(type)) {
    if (!data) return null;
    const callId = text(data.id, MAX_ID);
    const name = text(data.name, MAX_TOOL_NAME);
    if (callId === null || name === null) return null;
    const argsJson = data.arguments === undefined ? "" : safeJson(data.arguments);
    return {
      kind: "tool_start",
      runId: run,
      sessionId: session,
      seq,
      timestamp,
      callId,
      name,
      effect: text(data.effect, MAX_EFFECT),
      argsBytes: byteLength(argsJson),
      args:
        context.capture.toolArguments && argsJson !== ""
          ? redactJson(data.arguments, { mode: context.redaction.mode })
          : null,
    };
  }

  if (TOOL_END.has(type)) {
    if (!data) return null;
    const callId = text(data.id, MAX_ID);
    if (callId === null) return null;
    const preview = data.preview === undefined ? "" : safeJson(data.preview);
    return {
      kind: "tool_end",
      runId: run,
      sessionId: session,
      seq,
      timestamp,
      callId,
      name: text(data.name, MAX_TOOL_NAME),
      isError: truthy(data.isError),
      durationMs: whole(data.durationMs),
      resultBytes: byteLength(preview),
      preview:
        context.capture.toolResults && preview !== ""
          ? redactJson(data.preview, { mode: context.redaction.mode })
          : null,
    };
  }

  return null;
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * A bounded queue. `push` refuses the newest record when full and reports it via
 * the dropped counter; nothing here can block or throw.
 */
export interface EventBuffer {
  push(record: TelemetryRecord): boolean;
  drain(max: number): TelemetryRecord[];
  size(): number;
  dropped(): number;
}

export function createEventBuffer(maxQueue: number): EventBuffer {
  const limit = Math.max(1, Math.trunc(maxQueue));
  const items: TelemetryRecord[] = [];
  let head = 0;
  let droppedCount = 0;
  return {
    push(record: TelemetryRecord): boolean {
      if (items.length - head >= limit) {
        droppedCount += 1;
        return false;
      }
      items.push(record);
      return true;
    },
    drain(max: number): TelemetryRecord[] {
      const take = Math.max(0, Math.trunc(max));
      const out: TelemetryRecord[] = [];
      while (head < items.length && out.length < take) {
        out.push(items[head] as TelemetryRecord);
        head += 1;
      }
      if (head === items.length) {
        items.length = 0;
        head = 0;
      } else if (head > 1024) {
        items.splice(0, head);
        head = 0;
      }
      return out;
    },
    size(): number {
      return items.length - head;
    },
    dropped(): number {
      return droppedCount;
    },
  };
}

export interface EventHandlerOptions {
  buffer: EventBuffer;
  capture: CaptureSettings;
  redaction: RedactionSettings;
  /** Invoked when normalization itself throws; must not throw. */
  onError?: () => void;
}

/**
 * Build the synchronous event handler registered with `api.events.on`. The
 * return type is `void`, the body contains no `await`, and every path is
 * wrapped so a hostile or malformed event can never reach the host.
 */
export function createEventHandler(options: EventHandlerOptions): (event: unknown) => void {
  const context: RedactionContext = { capture: options.capture, redaction: options.redaction };
  return (event: unknown): void => {
    try {
      if (!isTrustedEnvelope(event)) return;
      const record = normalizeEvent(event, context);
      if (record !== null) options.buffer.push(record);
    } catch {
      try {
        options.onError?.();
      } catch {
        // Swallow: an error reporter must not break the run either.
      }
    }
  };
}
