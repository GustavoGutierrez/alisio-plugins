import { statSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { fileMode, type SqlDatabase } from "../src/database.js";
import { createStore, type Store, type TelemetryRecord, toMatchQuery } from "../src/store.js";
import { first, makeTempDir, type TempDir } from "./helpers.js";
import { openSqlite } from "./sqlite-driver.js";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();
const range = { from: at(-1), to: at(120) };

let temp: TempDir | null = null;
let database: SqlDatabase | null = null;
afterEach(() => {
  try {
    database?.close();
  } catch {
    // ignore double close
  }
  database = null;
  temp?.cleanup();
  temp = null;
});

function makeStore(): { store: Store; path: string } {
  temp = makeTempDir();
  const path = `${temp.dir}/telemetry/telemetry.sqlite`;
  database = openSqlite(path);
  const store = createStore(database);
  store.migrate();
  return { store, path };
}

const sample: TelemetryRecord[] = [
  {
    kind: "run_start",
    runId: "run-1",
    sessionId: "s-1",
    seq: 1,
    timestamp: at(0),
    model: "openai/gpt-4o",
  },
  {
    kind: "turn",
    runId: "run-1",
    sessionId: "s-1",
    seq: 2,
    timestamp: at(5),
    turn: 1,
    model: "openai/gpt-4o",
    inputTokens: 100,
    outputTokens: 40,
    cachedInputTokens: 30,
    calls: 2,
    durationMs: 5000,
  },
  {
    kind: "tool_start",
    runId: "run-1",
    sessionId: "s-1",
    seq: 3,
    timestamp: at(6),
    callId: "call-1",
    name: "bash",
    effect: "process",
    argsBytes: 10,
    args: null,
  },
  {
    kind: "tool_end",
    runId: "run-1",
    sessionId: "s-1",
    seq: 4,
    timestamp: at(7),
    callId: "call-1",
    name: "bash",
    isError: false,
    durationMs: 12,
    resultBytes: 5,
    preview: null,
  },
  {
    kind: "turn",
    runId: "run-1",
    sessionId: "s-1",
    seq: 5,
    timestamp: at(65),
    turn: 2,
    model: "openai/gpt-4o",
    inputTokens: 50,
    outputTokens: 20,
    cachedInputTokens: 0,
    calls: 1,
    durationMs: null,
  },
  {
    kind: "tool_start",
    runId: "run-1",
    sessionId: "s-1",
    seq: 6,
    timestamp: at(66),
    callId: "call-2",
    name: "read",
    effect: "read",
    argsBytes: 3,
    args: null,
  },
  {
    kind: "tool_end",
    runId: "run-1",
    sessionId: "s-1",
    seq: 7,
    timestamp: at(70),
    callId: "call-2",
    name: "read",
    isError: true,
    durationMs: 100,
    resultBytes: 4,
    preview: null,
  },
  {
    kind: "run_end",
    runId: "run-1",
    sessionId: "s-1",
    seq: 8,
    timestamp: at(90),
    status: "completed",
    totalTokens: 210,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    truncated: false,
    text: null,
  },
];

describe("schema, pragmas and permissions", () => {
  it("creates the schema, enables WAL and busy_timeout, and hardens permissions", () => {
    const { store, path } = makeStore();
    expect(store).toBeTruthy();
    const journal = database?.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    const timeout = database?.prepare("PRAGMA busy_timeout").get() as { timeout?: number };
    expect(String(journal.journal_mode).toLowerCase()).toBe("wal");
    expect(Number(timeout.timeout)).toBeGreaterThan(0);
    expect(fileMode(path)).toBe(0o600);
    expect(statSync(`${temp?.dir}/telemetry`).mode & 0o777).toBe(0o700);
  });
});

describe("record storage and aggregation", () => {
  it("stores records and aggregates summary, models, tools and sessions", () => {
    const { store } = makeStore();
    const written = store.writeRecords(sample);
    expect(written.written).toBe(sample.length);
    expect(written.content).toBe(0);

    const summary = store.summary(range);
    expect(summary).toMatchObject({
      sessions: 1,
      runs: 1,
      turns: 2,
      toolCalls: 2,
      toolErrors: 1,
      inputTokens: 150,
      outputTokens: 60,
      cachedInputTokens: 30,
      totalTokens: 210,
    });
    expect(summary.avgToolDurationMs).toBeCloseTo(56);
    expect(summary.maxToolDurationMs).toBe(100);

    const models = store.models(range, 10);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ model: "openai/gpt-4o", turns: 2, calls: 3 });

    const tools = store.tools(range, 10);
    expect(tools).toHaveLength(2);
    const read = tools.find((tool) => tool.name === "read");
    expect(read).toMatchObject({ calls: 1, errors: 1, errorRate: 1, effects: ["read"] });

    const sessions = store.sessions(range, 10);
    expect(sessions[0]).toMatchObject({
      sessionId: "s-1",
      runs: 1,
      turns: 2,
      models: ["openai/gpt-4o"],
    });
  });

  it("buckets a time series", () => {
    const { store } = makeStore();
    store.writeRecords(sample);
    const buckets = store.series(range, 1800);
    expect(buckets.length).toBe(2);
    expect(buckets[0]?.turns).toBe(1);
    expect(buckets[1]?.turns).toBe(1);
    expect(buckets[0]?.inputTokens).toBe(100);
  });

  it("counts distinct rows for the bounds envelope", () => {
    const { store } = makeStore();
    store.writeRecords(sample);
    expect(store.totals(range)).toEqual({ models: 1, tools: 2, sessions: 1 });
  });
});

describe("full-text search and retention", () => {
  it("indexes captured content and purges the index on prune", () => {
    const { store } = makeStore();
    store.recordContent([
      {
        runId: null,
        sessionId: "s-1",
        kind: "prompt",
        ref: null,
        text: "hello searchable world",
        createdAt: at(1),
      },
    ]);
    expect(store.search("searchable", range, 10).total).toBe(1);

    const future = at(10_000);
    const deleted = store.pruneBefore(future);
    expect(deleted.content).toBe(1);
    expect(store.search("searchable", range, 10).total).toBe(0);
    expect(store.counts().content).toBe(0);
    store.optimize();
  });

  it("quotes free text into a safe MATCH expression", () => {
    expect(toMatchQuery("hello world")).toBe('"hello" "world"');
    expect(toMatchQuery('bad"quote')).toBe('"badquote"');
    expect(toMatchQuery("   ")).toBe("");
    expect(toMatchQuery("a".repeat(100))).toBe("");
  });
});

describe("OTLP batch state", () => {
  it("deduplicates batches by key and tracks retry state", () => {
    const { store } = makeStore();
    const now = at(0);
    expect(store.enqueueBatch("traces:abc", "traces", "{}", now)).toBe(true);
    expect(store.enqueueBatch("traces:abc", "traces", "{}", now)).toBe(false);
    const pending = store.pendingBatches(10);
    expect(pending).toHaveLength(1);

    store.markBatchRetry(first(pending).id, "HTTP 503", now);
    expect(store.pendingBatches(10)[0]?.attempts).toBe(1);
    expect(store.counts().pendingBatches).toBe(1);

    store.markBatchSent(first(pending).id, now);
    expect(store.pendingBatches(10)).toHaveLength(0);
    expect(store.counts().pendingBatches).toBe(0);

    store.enqueueBatch("logs:def", "logs", "{}", now);
    const logs = first(store.pendingBatches(10));
    store.markBatchDead(logs.id, "HTTP 400", now);
    expect(store.counts().deadBatches).toBe(1);
  });
});
