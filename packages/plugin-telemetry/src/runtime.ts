/**
 * The telemetry runtime: wires the synchronous event handler, the bounded
 * buffer, the local store, the opt-in OTLP exporter and the flush scheduler.
 *
 * FAIL-SAFE CONSTRUCTION. If configuration is invalid or the database cannot be
 * opened, the runtime reports an actionable error and disables telemetry rather
 * than failing plugin setup. The event handler then does nothing.
 *
 * FLUSH. `flush()` drains the buffer, derives best-effort turn durations, writes
 * records to SQLite in one transaction, periodically optimizes the database, and
 * then asks the exporter to derive and send OTLP batches. Every failure is
 * captured in the returned report; `flush()` itself never rejects.
 */
import type { Message, SessionInfo } from "@alisio/sdk";
import {
  type ConfigResult,
  type Environment,
  loadTelemetryConfig,
  resolveTelemetryPaths,
  type TelemetryConfig,
  type TelemetryOverrides,
  type TelemetryPaths,
} from "./config.js";
import { configureDatabase, type SqlDatabase } from "./database.js";
import {
  createEventBuffer,
  createEventHandler,
  type EventBuffer,
  type EventEnvelope,
  type TelemetryRecord,
} from "./events.js";
import {
  createExporter,
  type Exporter,
  type ExportResult,
  type Fetcher,
  type Sleeper,
} from "./otlp.js";
import { type RedactionOptions, redactText } from "./redact.js";
import { createStore, type Store } from "./store.js";

export type Clock = () => number;

export interface FlushReport {
  records: number;
  content: number;
  dropped: number;
  queueSize: number;
  exports: ExportResult[];
  optimized: boolean;
  error: string | null;
}

export interface PruneReport {
  cutoff: string;
  retentionDays: number;
  deleted: { runs: number; turns: number; toolCalls: number; content: number };
  note: string;
}

export interface TelemetryRuntimeOptions {
  env?: Environment;
  paths?: TelemetryPaths;
  overrides?: TelemetryOverrides;
  /** Injected config file content (tests); skips disk reads for the file. */
  configFile?: unknown;
  skipConfigFile?: boolean;
  fetcher?: Fetcher;
  now?: Clock;
  sleep?: Sleeper;
  /**
   * Database opener seam. Production wires the host storage port
   * (`api.storage.sqlite`); tests inject an in-process `SqlDatabase`.
   */
  openDatabase?: (path: string) => SqlDatabase;
  /** Scheduler period; `null` disables the background flush (tests, embedders). */
  autoFlushMs?: number | null;
  /** Export look-back window. Defaults to 24 hours. */
  exportWindowMs?: number;
}

export interface TelemetryRuntime {
  configResult: ConfigResult;
  paths: TelemetryPaths;
  env: Environment;
  config: TelemetryConfig | null;
  configError: string | null;
  store: Store | null;
  buffer: EventBuffer;
  handler: (event: EventEnvelope) => void;
  exporter: Exporter | null;
  now: Clock;
  start(): void;
  stop(): void;
  flush(): Promise<FlushReport>;
  captureTranscript(info: Pick<SessionInfo, "sessionId" | "messages">): Promise<number>;
  prune(days?: number): PruneReport;
  dispose(): Promise<void>;
}

const OPTIMIZE_EVERY = 20;
const MAX_TRANSCRIPT_MESSAGES = 200;
const MAX_TRACKED_RUNS = 5_000;
const MAX_DRAIN_PER_FLUSH = 5_000;

function isoAt(now: Clock, offsetMs = 0): string {
  return new Date(now() + offsetMs).toISOString();
}

export function createTelemetryRuntime(options: TelemetryRuntimeOptions = {}): TelemetryRuntime {
  const env = options.env ?? process.env;
  const paths = options.paths ?? resolveTelemetryPaths(env);
  const now: Clock = options.now ?? (() => Date.now());
  const fetcher: Fetcher = options.fetcher ?? fetch;
  const sleep: Sleeper =
    options.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  const configResult = loadTelemetryConfig({
    env,
    paths,
    ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    ...(options.configFile === undefined ? {} : { file: options.configFile }),
    ...(options.skipConfigFile === true ? { skipFile: true } : {}),
  });

  const config = configResult.ok ? configResult.config : null;
  let configError = configResult.ok ? null : configResult.error;
  const capture = config?.capture ?? {
    prompts: false,
    completions: false,
    toolArguments: false,
    toolResults: false,
  };
  const redaction = config?.redaction ?? { mode: "strict" as const };

  const buffer = createEventBuffer(config?.batch.maxQueue ?? 10_000);
  const handler = createEventHandler({
    buffer,
    capture,
    redaction,
    onError: () => {
      // A normalization failure is counted as a drop; it must never escape.
    },
  });

  let store: Store | null = null;
  let database: SqlDatabase | null = null;
  if (config !== null) {
    try {
      if (options.openDatabase === undefined)
        throw new Error("the host did not provide a SQLite storage port");
      // The host opens and owns the file; harden its port (WAL, busy_timeout,
      // foreign_keys, synchronous) and permissions before touching any schema.
      database = configureDatabase(options.openDatabase(paths.database), paths.database);
      store = createStore(database);
      store.migrate();
    } catch (error) {
      store = null;
      configError = `telemetry database unavailable at configured path: ${
        error instanceof Error ? error.message : String(error)
      }`;
      try {
        database?.close();
      } catch {
        // Ignore.
      }
      database = null;
    }
  }

  const tokenEnvName = config?.otlp.tokenEnv ?? "ALISIO_TELEMETRY_OTLP_TOKEN";
  const exporter =
    config !== null && store !== null && config.otlp.enabled && config.otlp.endpoint !== null
      ? createExporter({
          store,
          settings: config.otlp,
          fetcher,
          now,
          sleep,
          // Read at flush time; never stored, logged or returned.
          token: env[tokenEnvName] ?? null,
          buildSnapshot: (range) => (store as Store).snapshot(range, 5_000),
          ...(options.exportWindowMs === undefined ? {} : { windowMs: options.exportWindowMs }),
        })
      : null;

  // Best-effort per-turn latency: the gap between consecutive events of a run.
  const lastSeenByRun = new Map<string, number>();

  const withTurnDurations = (records: TelemetryRecord[]): TelemetryRecord[] => {
    for (const record of records) {
      const parsed = Date.parse(record.timestamp);
      if (Number.isFinite(parsed)) {
        if (record.kind === "turn" && record.durationMs === null) {
          const previous = lastSeenByRun.get(record.runId);
          if (previous !== undefined && parsed >= previous) {
            record.durationMs = Math.min(parsed - previous, 60 * 60 * 1000);
          }
        }
        lastSeenByRun.set(record.runId, parsed);
      }
    }
    if (lastSeenByRun.size > MAX_TRACKED_RUNS) lastSeenByRun.clear();
    return records;
  };

  let flushes = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const runFlush = async (): Promise<FlushReport> => {
    const report: FlushReport = {
      records: 0,
      content: 0,
      dropped: buffer.dropped(),
      queueSize: buffer.size(),
      exports: [],
      optimized: false,
      error: null,
    };
    if (store === null || config === null) {
      report.error = configError ?? "telemetry is disabled";
      return report;
    }
    try {
      const records: TelemetryRecord[] = [];
      for (;;) {
        const batch = buffer.drain(config.batch.batchSize);
        if (batch.length === 0) break;
        records.push(...batch);
        if (records.length >= MAX_DRAIN_PER_FLUSH) break;
      }
      if (records.length > 0) {
        const written = store.writeRecords(withTurnDurations(records));
        report.records = written.written;
        report.content = written.content;
      }
      flushes += 1;
      if (flushes % OPTIMIZE_EVERY === 0) {
        store.optimize();
        report.optimized = true;
      }
      if (exporter !== null) {
        report.exports = await exporter.flush();
      }
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
    } finally {
      report.queueSize = buffer.size();
      report.dropped = buffer.dropped();
    }
    return report;
  };

  // Serialize flushes so a background tick and a manual command can never
  // write and export the same records concurrently.
  let inFlightFlush: Promise<FlushReport> | null = null;
  const flush = (): Promise<FlushReport> => {
    if (inFlightFlush !== null) return inFlightFlush;
    inFlightFlush = runFlush().finally(() => {
      inFlightFlush = null;
    });
    return inFlightFlush;
  };

  const runtime: TelemetryRuntime = {
    configResult,
    paths,
    env,
    config,
    configError,
    store,
    buffer,
    handler: (event: EventEnvelope): void => {
      if (store === null) return;
      handler(event);
    },
    exporter,
    now,

    start(): void {
      if (timer !== null || stopped) return;
      if (store === null) return;
      const period =
        options.autoFlushMs === undefined
          ? (config?.batch.flushIntervalMs ?? null)
          : options.autoFlushMs;
      if (period === null || period <= 0) return;
      timer = setInterval(
        () => {
          void flush();
        },
        Math.max(250, period),
      );
      if (typeof timer.unref === "function") timer.unref();
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },

    flush,

    async captureTranscript(info: Pick<SessionInfo, "sessionId" | "messages">): Promise<number> {
      if (store === null || config === null) return 0;
      if (!config.capture.prompts && !config.capture.completions) return 0;
      const redactionOptions: RedactionOptions = { mode: config.redaction.mode };
      const createdAt = isoAt(now);
      const messages = info.messages.slice(-MAX_TRANSCRIPT_MESSAGES) as readonly Message[];
      const records = [];
      for (const message of messages) {
        if (message.role === "user" && config.capture.prompts) {
          const text = redactText(message.text, redactionOptions);
          if (text !== "")
            records.push({
              runId: null,
              sessionId: info.sessionId,
              kind: "prompt",
              ref: null,
              text,
              createdAt,
            });
        } else if (message.role === "assistant" && config.capture.completions) {
          const text = redactText(message.text, redactionOptions);
          if (text !== "")
            records.push({
              runId: null,
              sessionId: info.sessionId,
              kind: "completion",
              ref: null,
              text,
              createdAt,
            });
        }
      }
      if (records.length === 0) return 0;
      try {
        return store.recordContent(records);
      } catch {
        return 0;
      }
    },

    prune(days?: number): PruneReport {
      const retentionDays = days ?? config?.retentionDays ?? 30;
      const cutoff = isoAt(now, -retentionDays * 24 * 60 * 60 * 1000);
      if (store === null) {
        return {
          cutoff,
          retentionDays,
          deleted: { runs: 0, turns: 0, toolCalls: 0, content: 0 },
          note: configError ?? "telemetry is disabled; nothing to prune",
        };
      }
      const deleted = store.pruneBefore(cutoff);
      store.optimize();
      return {
        cutoff,
        retentionDays,
        deleted,
        note:
          "Deleted rows and purged search index entries, then optimized and vacuumed. " +
          "Note: SQLite FTS shadow tables can retain fragments after deletion; a copied database may keep forensic traces.",
      };
    },

    async dispose(): Promise<void> {
      if (stopped) return;
      stopped = true;
      runtime.stop();
      try {
        await flush();
      } catch {
        // Best effort.
      }
      try {
        database?.close();
      } catch {
        // Ignore close errors.
      }
      database = null;
      store = null;
    },
  };

  return runtime;
}
