/**
 * The local SQLite store: the primary sink and the source of truth.
 *
 * REMOTE EXPORT NEVER OWNS THE DATA. Every record lands here first; OTLP batches
 * are derived from these rows and tracked in `otlp_batches` so a failed export
 * can be retried idempotently. Remote failures never delete or mutate rows.
 *
 * FULL-TEXT SEARCH IS CONTENT-ONLY AND OPT-IN. The `content_fts` shadow tables
 * can retain fragments after rows are deleted. Deletion therefore also clears
 * the FTS index, runs `optimize`, and vacuums; the README states plainly that
 * forensic traces in a copied file cannot be guaranteed gone.
 */

import type { SqlDatabase, SqlRow, SqlValue } from "./database.js";
import type { TelemetryRecord } from "./events.js";

export interface TimeRange {
  /** Inclusive ISO timestamp lower bound. */
  from: string;
  /** Inclusive ISO timestamp upper bound. */
  to: string;
}

export interface StoreSummary {
  sessions: number;
  runs: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  avgToolDurationMs: number | null;
  maxToolDurationMs: number | null;
  firstAt: string | null;
  lastAt: string | null;
}

export interface ModelAggregate {
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  calls: number;
  avgTurnDurationMs: number | null;
}

export interface ToolAggregate {
  name: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number | null;
  maxDurationMs: number | null;
  effects: string[];
}

export interface SessionAggregate {
  sessionId: string;
  runs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  lastAt: string | null;
  models: string[];
}

export interface SeriesBucket {
  bucketStart: string;
  runs: number;
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ContentHit {
  id: number;
  kind: string;
  ref: string | null;
  snippet: string;
  createdAt: string;
}

export interface BatchRow {
  id: number;
  batchKey: string;
  signal: string;
  payload: string;
  attempts: number;
  createdAt: string;
}

export interface RunSnapshot {
  runId: string;
  sessionId: string;
  model: string | null;
  startedAt: string;
  endedAt: string | null;
  status: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number | null;
  truncated: boolean;
  turns: number;
  toolCalls: number;
  toolErrors: number;
}

export interface TurnSnapshot {
  runId: string;
  sessionId: string;
  turn: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  durationMs: number | null;
  createdAt: string;
}

export interface ToolSnapshot {
  runId: string;
  callId: string;
  sessionId: string;
  name: string;
  effect: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  isError: boolean;
}

export interface TelemetrySnapshot {
  runs: RunSnapshot[];
  turns: TurnSnapshot[];
  tools: ToolSnapshot[];
}

export interface StoreCounts {
  runs: number;
  turns: number;
  toolCalls: number;
  content: number;
  pendingBatches: number;
  deadBatches: number;
}

export interface WindowTotals {
  models: number;
  tools: number;
  sessions: number;
}

export interface TranscriptContent {
  runId: string | null;
  sessionId: string;
  kind: string;
  ref: string | null;
  text: string;
  createdAt: string;
}

export interface Store {
  migrate(): void;
  writeRecords(records: TelemetryRecord[]): { written: number; content: number };
  summary(range: TimeRange): StoreSummary;
  models(range: TimeRange, limit: number): ModelAggregate[];
  tools(range: TimeRange, limit: number): ToolAggregate[];
  sessions(range: TimeRange, limit: number): SessionAggregate[];
  series(range: TimeRange, bucketSeconds: number): SeriesBucket[];
  search(query: string, range: TimeRange, limit: number): { hits: ContentHit[]; total: number };
  snapshot(range: TimeRange, limit: number): TelemetrySnapshot;
  totals(range: TimeRange): WindowTotals;
  recordContent(records: TranscriptContent[]): number;
  counts(): StoreCounts;
  pruneBefore(iso: string): { runs: number; turns: number; toolCalls: number; content: number };
  optimize(): void;
  enqueueBatch(key: string, signal: string, payload: string, createdAt: string): boolean;
  pendingBatches(limit: number): BatchRow[];
  markBatchSent(id: number, at: string): void;
  markBatchRetry(id: number, error: string, at: string): void;
  markBatchDead(id: number, error: string, at: string): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER,
  turns INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_errors INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
CREATE TABLE IF NOT EXISTS turns (
  run_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, turn)
);
CREATE INDEX IF NOT EXISTS turns_created ON turns(created_at);
CREATE INDEX IF NOT EXISTS turns_model ON turns(model);
CREATE TABLE IF NOT EXISTS tool_calls (
  run_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  effect TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  is_error INTEGER NOT NULL DEFAULT 0,
  args_bytes INTEGER,
  result_bytes INTEGER,
  PRIMARY KEY (run_id, call_id)
);
CREATE INDEX IF NOT EXISTS tool_calls_name ON tool_calls(name);
CREATE INDEX IF NOT EXISTS tool_calls_started ON tool_calls(started_at);
CREATE TABLE IF NOT EXISTS content (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  ref TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS content_created ON content(created_at);
CREATE TABLE IF NOT EXISTS otlp_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_key TEXT NOT NULL UNIQUE,
  signal TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS otlp_batches_status ON otlp_batches(status);
CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
  text,
  kind UNINDEXED,
  ref UNINDEXED,
  tokenize = 'unicode61'
);
`;

function number(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return 0;
}

function maybeNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOf(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function createStore(database: SqlDatabase): Store {
  const { prepare } = database;

  const recordRunAggregates = (runId: string): void => {
    prepare(
      `UPDATE runs SET
         turns = (SELECT COUNT(*) FROM turns WHERE run_id = ?),
         tool_calls = (SELECT COUNT(*) FROM tool_calls WHERE run_id = ?),
         tool_errors = (SELECT COUNT(*) FROM tool_calls WHERE run_id = ? AND is_error = 1),
         input_tokens = (SELECT COALESCE(SUM(input_tokens), 0) FROM turns WHERE run_id = ?),
         output_tokens = (SELECT COALESCE(SUM(output_tokens), 0) FROM turns WHERE run_id = ?),
         cached_input_tokens = (SELECT COALESCE(SUM(cached_input_tokens), 0) FROM turns WHERE run_id = ?)
       WHERE run_id = ?`,
    ).run(runId, runId, runId, runId, runId, runId, runId);
  };

  const insertContent = (
    runId: string | null,
    sessionId: string,
    kind: string,
    ref: string | null,
    text: string,
    createdAt: string,
  ): void => {
    const result = prepare(
      "INSERT INTO content (run_id, session_id, kind, ref, text, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(runId, sessionId, kind, ref, text, createdAt);
    const rowId = result.lastInsertRowid;
    prepare("INSERT INTO content_fts (rowid, text, kind, ref) VALUES (?, ?, ?, ?)").run(
      typeof rowId === "bigint" ? rowId : number(rowId),
      text,
      kind,
      ref,
    );
  };

  return {
    migrate(): void {
      database.exec(SCHEMA);
      prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
    },

    writeRecords(records: TelemetryRecord[]): { written: number; content: number } {
      let contentWrites = 0;
      database.transaction(() => {
        for (const record of records) {
          switch (record.kind) {
            case "run_start": {
              prepare(
                `INSERT INTO runs (run_id, session_id, started_at, model, status)
                 VALUES (?, ?, ?, ?, 'running')
                 ON CONFLICT(run_id) DO UPDATE SET
                   session_id = excluded.session_id,
                   model = COALESCE(excluded.model, runs.model)`,
              ).run(record.runId, record.sessionId, record.timestamp, record.model ?? null);
              break;
            }
            case "run_end": {
              prepare(
                `INSERT INTO runs (run_id, session_id, started_at, ended_at, status, total_tokens, truncated)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(run_id) DO UPDATE SET
                   ended_at = excluded.ended_at,
                   status = excluded.status,
                   total_tokens = COALESCE(excluded.total_tokens, runs.total_tokens),
                   truncated = excluded.truncated`,
              ).run(
                record.runId,
                record.sessionId,
                record.timestamp,
                record.timestamp,
                record.status,
                record.totalTokens ?? null,
                record.truncated ? 1 : 0,
              );
              if (record.text !== null) {
                insertContent(
                  record.runId,
                  record.sessionId,
                  "completion",
                  record.runId,
                  record.text,
                  record.timestamp,
                );
                contentWrites += 1;
              }
              recordRunAggregates(record.runId);
              break;
            }
            case "turn": {
              prepare(
                `INSERT INTO turns (run_id, turn, session_id, model, input_tokens, output_tokens, cached_input_tokens, calls, duration_ms, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(run_id, turn) DO UPDATE SET
                   session_id = excluded.session_id,
                   model = COALESCE(excluded.model, turns.model),
                   input_tokens = excluded.input_tokens,
                   output_tokens = excluded.output_tokens,
                   cached_input_tokens = excluded.cached_input_tokens,
                   calls = excluded.calls,
                   duration_ms = COALESCE(excluded.duration_ms, turns.duration_ms)`,
              ).run(
                record.runId,
                record.turn,
                record.sessionId,
                record.model ?? null,
                record.inputTokens,
                record.outputTokens,
                record.cachedInputTokens,
                record.calls,
                record.durationMs ?? null,
                record.timestamp,
              );
              prepare(
                `INSERT INTO runs (run_id, session_id, started_at, model, status)
                 VALUES (?, ?, ?, ?, 'running')
                 ON CONFLICT(run_id) DO UPDATE SET model = COALESCE(excluded.model, runs.model)`,
              ).run(record.runId, record.sessionId, record.timestamp, record.model ?? null);
              recordRunAggregates(record.runId);
              break;
            }
            case "tool_start": {
              prepare(
                `INSERT INTO tool_calls (run_id, call_id, session_id, name, effect, started_at, args_bytes)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(run_id, call_id) DO UPDATE SET
                   name = excluded.name,
                   effect = COALESCE(excluded.effect, tool_calls.effect),
                   started_at = COALESCE(tool_calls.started_at, excluded.started_at),
                   args_bytes = COALESCE(excluded.args_bytes, tool_calls.args_bytes)`,
              ).run(
                record.runId,
                record.callId,
                record.sessionId,
                record.name,
                record.effect ?? null,
                record.timestamp,
                record.argsBytes,
              );
              if (record.args !== null) {
                insertContent(
                  record.runId,
                  record.sessionId,
                  "tool_arguments",
                  record.callId,
                  record.args,
                  record.timestamp,
                );
                contentWrites += 1;
              }
              recordRunAggregates(record.runId);
              break;
            }
            case "tool_end": {
              prepare(
                `INSERT INTO tool_calls (run_id, call_id, session_id, name, finished_at, duration_ms, is_error, result_bytes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(run_id, call_id) DO UPDATE SET
                   name = COALESCE(excluded.name, tool_calls.name),
                   finished_at = excluded.finished_at,
                   duration_ms = COALESCE(excluded.duration_ms, tool_calls.duration_ms),
                   is_error = excluded.is_error,
                   result_bytes = COALESCE(excluded.result_bytes, tool_calls.result_bytes)`,
              ).run(
                record.runId,
                record.callId,
                record.sessionId,
                record.name ?? null,
                record.timestamp,
                record.durationMs ?? null,
                record.isError ? 1 : 0,
                record.resultBytes,
              );
              if (record.preview !== null) {
                insertContent(
                  record.runId,
                  record.sessionId,
                  "tool_result",
                  record.callId,
                  record.preview,
                  record.timestamp,
                );
                contentWrites += 1;
              }
              recordRunAggregates(record.runId);
              break;
            }
          }
        }
      });
      return { written: records.length, content: contentWrites };
    },

    summary(range: TimeRange): StoreSummary {
      const runs = prepare(
        `SELECT COUNT(*) AS runs,
                COALESCE(SUM(turns), 0) AS turns,
                COALESCE(SUM(tool_calls), 0) AS toolCalls,
                COALESCE(SUM(tool_errors), 0) AS toolErrors,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
                COALESCE(SUM(total_tokens), 0) AS totalTokens,
                MIN(started_at) AS firstAt,
                MAX(COALESCE(ended_at, started_at)) AS lastAt
         FROM runs WHERE started_at >= ? AND started_at <= ?`,
      ).get(range.from, range.to) as SqlRow | undefined;
      const sessions = prepare(
        "SELECT COUNT(DISTINCT session_id) AS sessions FROM runs WHERE started_at >= ? AND started_at <= ?",
      ).get(range.from, range.to) as SqlRow | undefined;
      const durations = prepare(
        `SELECT AVG(duration_ms) AS avg, MAX(duration_ms) AS max
         FROM tool_calls
         WHERE COALESCE(started_at, finished_at) >= ? AND COALESCE(started_at, finished_at) <= ?`,
      ).get(range.from, range.to) as SqlRow | undefined;
      return {
        sessions: number(sessions?.sessions),
        runs: number(runs?.runs),
        turns: number(runs?.turns),
        toolCalls: number(runs?.toolCalls),
        toolErrors: number(runs?.toolErrors),
        inputTokens: number(runs?.inputTokens),
        outputTokens: number(runs?.outputTokens),
        cachedInputTokens: number(runs?.cachedInputTokens),
        totalTokens: number(runs?.totalTokens),
        avgToolDurationMs: maybeNumber(durations?.avg),
        maxToolDurationMs: maybeNumber(durations?.max),
        firstAt: stringOrNull(runs?.firstAt),
        lastAt: stringOrNull(runs?.lastAt),
      };
    },

    models(range: TimeRange, limit: number): ModelAggregate[] {
      const rows = prepare(
        `SELECT COALESCE(model, '(unknown)') AS model,
                COUNT(*) AS turns,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
                COALESCE(SUM(calls), 0) AS calls,
                AVG(duration_ms) AS avgTurnDurationMs
         FROM turns WHERE created_at >= ? AND created_at <= ?
         GROUP BY COALESCE(model, '(unknown)')
         ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC, model ASC
         LIMIT ?`,
      ).all(range.from, range.to, Math.max(1, Math.trunc(limit))) as SqlRow[];
      return rows.map((row) => ({
        model: stringOf(row.model, "(unknown)"),
        turns: number(row.turns),
        inputTokens: number(row.inputTokens),
        outputTokens: number(row.outputTokens),
        cachedInputTokens: number(row.cachedInputTokens),
        calls: number(row.calls),
        avgTurnDurationMs: maybeNumber(row.avgTurnDurationMs),
      }));
    },

    tools(range: TimeRange, limit: number): ToolAggregate[] {
      const rows = prepare(
        `SELECT name,
                COUNT(*) AS calls,
                COALESCE(SUM(is_error), 0) AS errors,
                AVG(duration_ms) AS avgDurationMs,
                MAX(duration_ms) AS maxDurationMs,
                GROUP_CONCAT(DISTINCT effect) AS effects
         FROM tool_calls
         WHERE COALESCE(started_at, finished_at) >= ? AND COALESCE(started_at, finished_at) <= ?
         GROUP BY name
         ORDER BY calls DESC, name ASC
         LIMIT ?`,
      ).all(range.from, range.to, Math.max(1, Math.trunc(limit))) as SqlRow[];
      return rows.map((row) => {
        const calls = number(row.calls);
        const errors = number(row.errors);
        const effects = stringOf(row.effects)
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
        return {
          name: stringOf(row.name, "(unknown)"),
          calls,
          errors,
          errorRate: calls === 0 ? 0 : errors / calls,
          avgDurationMs: maybeNumber(row.avgDurationMs),
          maxDurationMs: maybeNumber(row.maxDurationMs),
          effects,
        };
      });
    },

    sessions(range: TimeRange, limit: number): SessionAggregate[] {
      const rows = prepare(
        `SELECT session_id,
                COUNT(*) AS runs,
                COALESCE(SUM(turns), 0) AS turns,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                MAX(COALESCE(ended_at, started_at)) AS lastAt,
                GROUP_CONCAT(DISTINCT model) AS models
         FROM runs WHERE started_at >= ? AND started_at <= ?
         GROUP BY session_id
         ORDER BY lastAt DESC
         LIMIT ?`,
      ).all(range.from, range.to, Math.max(1, Math.trunc(limit))) as SqlRow[];
      return rows.map((row) => ({
        sessionId: stringOf(row.session_id, "(unknown)"),
        runs: number(row.runs),
        turns: number(row.turns),
        inputTokens: number(row.inputTokens),
        outputTokens: number(row.outputTokens),
        lastAt: stringOrNull(row.lastAt),
        models: stringOf(row.models)
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== ""),
      }));
    },

    series(range: TimeRange, bucketSeconds: number): SeriesBucket[] {
      const bucket = Math.max(1, Math.trunc(bucketSeconds));
      const rows = prepare(
        `SELECT (CAST(strftime('%s', created_at) AS INTEGER) / ?) * ? AS bucket,
                COUNT(*) AS turns,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens
         FROM turns WHERE created_at >= ? AND created_at <= ?
           AND strftime('%s', created_at) IS NOT NULL
         GROUP BY bucket ORDER BY bucket ASC`,
      ).all(bucket, bucket, range.from, range.to) as SqlRow[];
      return rows.map((row) => ({
        bucketStart: new Date(number(row.bucket) * 1000).toISOString(),
        runs: 0,
        turns: number(row.turns),
        toolCalls: 0,
        inputTokens: number(row.inputTokens),
        outputTokens: number(row.outputTokens),
      }));
    },

    search(query: string, range: TimeRange, limit: number): { hits: ContentHit[]; total: number } {
      const match = toMatchQuery(query);
      if (match === "") return { hits: [], total: 0 };
      try {
        const totalRow = prepare(
          "SELECT COUNT(*) AS total FROM content_fts WHERE content_fts MATCH ?",
        ).get(match) as SqlRow | undefined;
        const rows = prepare(
          `SELECT c.id AS id, c.kind AS kind, c.ref AS ref,
                  c.created_at AS createdAt,
                  snippet(content_fts, 0, '[', ']', '…', 12) AS snippet
           FROM content_fts JOIN content c ON c.id = content_fts.rowid
           WHERE content_fts MATCH ? AND c.created_at >= ? AND c.created_at <= ?
           ORDER BY c.created_at DESC, c.id DESC
           LIMIT ?`,
        ).all(match, range.from, range.to, Math.max(1, Math.trunc(limit))) as SqlRow[];
        return {
          total: number(totalRow?.total),
          hits: rows.map((row) => ({
            id: number(row.id),
            kind: stringOf(row.kind),
            ref: stringOrNull(row.ref),
            snippet: stringOf(row.snippet),
            createdAt: stringOf(row.createdAt),
          })),
        };
      } catch {
        // A malformed MATCH expression must never crash the tool.
        return { hits: [], total: 0 };
      }
    },

    snapshot(range: TimeRange, limit: number): TelemetrySnapshot {
      const bound = Math.max(1, Math.trunc(limit));
      const runRows = prepare(
        `SELECT run_id, session_id, model, started_at, ended_at, status,
                input_tokens, output_tokens, cached_input_tokens, total_tokens,
                truncated, turns, tool_calls, tool_errors
         FROM runs WHERE started_at >= ? AND started_at <= ?
         ORDER BY started_at ASC LIMIT ?`,
      ).all(range.from, range.to, bound) as SqlRow[];
      const turnRows = prepare(
        `SELECT run_id, session_id, turn, model, input_tokens, output_tokens,
                cached_input_tokens, duration_ms, created_at
         FROM turns WHERE created_at >= ? AND created_at <= ?
         ORDER BY created_at ASC LIMIT ?`,
      ).all(range.from, range.to, bound) as SqlRow[];
      const toolRows = prepare(
        `SELECT run_id, call_id, session_id, name, effect, started_at, finished_at, duration_ms, is_error
         FROM tool_calls WHERE COALESCE(started_at, finished_at) >= ? AND COALESCE(started_at, finished_at) <= ?
         ORDER BY COALESCE(started_at, finished_at) ASC LIMIT ?`,
      ).all(range.from, range.to, bound) as SqlRow[];
      return {
        runs: runRows.map((row) => ({
          runId: stringOf(row.run_id),
          sessionId: stringOf(row.session_id),
          model: stringOrNull(row.model),
          startedAt: stringOf(row.started_at),
          endedAt: stringOrNull(row.ended_at),
          status: stringOf(row.status, "running"),
          inputTokens: number(row.input_tokens),
          outputTokens: number(row.output_tokens),
          cachedInputTokens: number(row.cached_input_tokens),
          totalTokens: maybeNumber(row.total_tokens),
          truncated: number(row.truncated) === 1,
          turns: number(row.turns),
          toolCalls: number(row.tool_calls),
          toolErrors: number(row.tool_errors),
        })),
        turns: turnRows.map((row) => ({
          runId: stringOf(row.run_id),
          sessionId: stringOf(row.session_id),
          turn: number(row.turn),
          model: stringOrNull(row.model),
          inputTokens: number(row.input_tokens),
          outputTokens: number(row.output_tokens),
          cachedInputTokens: number(row.cached_input_tokens),
          durationMs: maybeNumber(row.duration_ms),
          createdAt: stringOf(row.created_at),
        })),
        tools: toolRows.map((row) => ({
          runId: stringOf(row.run_id),
          callId: stringOf(row.call_id),
          sessionId: stringOf(row.session_id),
          name: stringOf(row.name, "(unknown)"),
          effect: stringOrNull(row.effect),
          startedAt: stringOrNull(row.started_at),
          finishedAt: stringOrNull(row.finished_at),
          durationMs: maybeNumber(row.duration_ms),
          isError: number(row.is_error) === 1,
        })),
      };
    },

    totals(range: TimeRange): WindowTotals {
      const row = prepare(
        `SELECT
           (SELECT COUNT(DISTINCT COALESCE(model, '(unknown)')) FROM turns WHERE created_at >= ? AND created_at <= ?) AS models,
           (SELECT COUNT(DISTINCT name) FROM tool_calls WHERE COALESCE(started_at, finished_at) >= ? AND COALESCE(started_at, finished_at) <= ?) AS tools,
           (SELECT COUNT(DISTINCT session_id) FROM runs WHERE started_at >= ? AND started_at <= ?) AS sessions`,
      ).get(range.from, range.to, range.from, range.to, range.from, range.to) as SqlRow | undefined;
      return {
        models: number(row?.models),
        tools: number(row?.tools),
        sessions: number(row?.sessions),
      };
    },

    recordContent(records: TranscriptContent[]): number {
      let written = 0;
      database.transaction(() => {
        for (const record of records) {
          insertContent(
            record.runId,
            record.sessionId,
            record.kind,
            record.ref,
            record.text,
            record.createdAt,
          );
          written += 1;
        }
      });
      return written;
    },

    counts(): StoreCounts {
      const scalar = (sql: string): number => {
        const row = prepare(sql).get() as SqlRow | undefined;
        return number(row?.value);
      };
      return {
        runs: scalar("SELECT COUNT(*) AS value FROM runs"),
        turns: scalar("SELECT COUNT(*) AS value FROM turns"),
        toolCalls: scalar("SELECT COUNT(*) AS value FROM tool_calls"),
        content: scalar("SELECT COUNT(*) AS value FROM content"),
        pendingBatches: scalar(
          "SELECT COUNT(*) AS value FROM otlp_batches WHERE status = 'pending'",
        ),
        deadBatches: scalar("SELECT COUNT(*) AS value FROM otlp_batches WHERE status = 'dead'"),
      };
    },

    pruneBefore(iso: string): { runs: number; turns: number; toolCalls: number; content: number } {
      return database.transaction(() => {
        const contentIds = prepare("SELECT id FROM content WHERE created_at < ?").all(
          iso,
        ) as SqlRow[];
        let content = 0;
        if (contentIds.length > 0) {
          const ids = contentIds.map((row) => number(row.id));
          const placeholders = ids.map(() => "?").join(", ");
          const params = ids as SqlValue[];
          prepare(`DELETE FROM content_fts WHERE rowid IN (${placeholders})`).run(...params);
          const deleted = prepare(`DELETE FROM content WHERE id IN (${placeholders})`).run(
            ...params,
          );
          content = number(deleted.changes);
        }
        const toolCalls = number(
          prepare("DELETE FROM tool_calls WHERE COALESCE(started_at, finished_at) < ?").run(iso)
            .changes,
        );
        const turns = number(prepare("DELETE FROM turns WHERE created_at < ?").run(iso).changes);
        const runs = number(prepare("DELETE FROM runs WHERE started_at < ?").run(iso).changes);
        return { runs, turns, toolCalls, content };
      });
    },

    optimize(): void {
      database.exec("PRAGMA optimize");
      try {
        database.exec("INSERT INTO content_fts(content_fts) VALUES('optimize')");
      } catch {
        // FTS optimize is best-effort.
      }
      try {
        database.exec("VACUUM");
      } catch {
        // VACUUM can fail inside an open transaction; never fatal.
      }
    },

    enqueueBatch(key: string, signal: string, payload: string, createdAt: string): boolean {
      const result = prepare(
        "INSERT OR IGNORE INTO otlp_batches (batch_key, signal, payload, created_at, status) VALUES (?, ?, ?, ?, 'pending')",
      ).run(key, signal, payload, createdAt);
      return number(result.changes) > 0;
    },

    pendingBatches(limit: number): BatchRow[] {
      const rows = prepare(
        "SELECT id, batch_key, signal, payload, attempts, created_at FROM otlp_batches WHERE status = 'pending' ORDER BY id ASC LIMIT ?",
      ).all(Math.max(1, Math.trunc(limit))) as SqlRow[];
      return rows.map((row) => ({
        id: number(row.id),
        batchKey: stringOf(row.batch_key),
        signal: stringOf(row.signal),
        payload: stringOf(row.payload),
        attempts: number(row.attempts),
        createdAt: stringOf(row.created_at),
      }));
    },

    markBatchSent(id: number, at: string): void {
      prepare(
        "UPDATE otlp_batches SET status = 'sent', attempts = attempts + 1, last_attempt_at = ?, last_error = NULL WHERE id = ?",
      ).run(at, id);
    },

    markBatchRetry(id: number, error: string, at: string): void {
      prepare(
        "UPDATE otlp_batches SET attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE id = ?",
      ).run(at, error.slice(0, 500), id);
    },

    markBatchDead(id: number, error: string, at: string): void {
      prepare(
        "UPDATE otlp_batches SET status = 'dead', attempts = attempts + 1, last_attempt_at = ?, last_error = ? WHERE id = ?",
      ).run(at, error.slice(0, 500), id);
    },
  };
}

/**
 * Turn free text into a safe FTS5 MATCH expression: each whitespace token is
 * quoted as a phrase, so FTS operators in the query cannot cause a syntax error.
 */
export function toMatchQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/["*^:()]/g, "").trim())
    .filter((token) => token.length > 0 && token.length <= 64)
    .slice(0, 12);
  if (tokens.length === 0) return "";
  return tokens.map((token) => `"${token}"`).join(" ");
}
