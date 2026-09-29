import { describe, expect, it } from "vitest";
import { createDefaultConfig, type OtlpSettings } from "../src/config.js";
import type { SqlDatabase } from "../src/database.js";
import {
  buildLogsPayload,
  buildMetricsPayload,
  buildTracesPayload,
  createExporter,
  otlpUrl,
  parseRetryAfter,
  providerFromModel,
  readCappedText,
  shouldSample,
} from "../src/otlp.js";
import { createStore, type Store, type TelemetrySnapshot } from "../src/store.js";
import { first, makeFetcher, makeTempDir } from "./helpers.js";
import { openSqlite } from "./sqlite-driver.js";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const NOW = BASE + 3_600_000;
const at = (ms: number): string => new Date(BASE + ms).toISOString();

function baseSettings(overrides: Partial<OtlpSettings> = {}): OtlpSettings {
  return {
    ...createDefaultConfig().otlp,
    enabled: true,
    endpoint: "https://collector.example.com",
    signals: { traces: true, logs: false, metrics: false },
    maxAttempts: 3,
    ...overrides,
  };
}

const snapshot: TelemetrySnapshot = {
  runs: [
    {
      runId: "run-1",
      sessionId: "s-1",
      model: "openai/gpt-4o",
      startedAt: at(0),
      endedAt: at(1000),
      status: "completed",
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 30,
      totalTokens: 140,
      truncated: false,
      turns: 1,
      toolCalls: 1,
      toolErrors: 0,
    },
  ],
  turns: [
    {
      runId: "run-1",
      sessionId: "s-1",
      turn: 1,
      model: "openai/gpt-4o",
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 30,
      durationMs: 500,
      createdAt: at(100),
    },
  ],
  tools: [
    {
      runId: "run-1",
      callId: "call-1",
      sessionId: "s-1",
      name: "bash",
      effect: "process",
      startedAt: at(200),
      finishedAt: at(201),
      durationMs: 12,
      isError: false,
    },
  ],
};

const generatorOptions = {
  resource: { serviceName: "alisio", environment: "test", instanceId: "inst-1" },
  settings: baseSettings(),
  now: () => NOW,
};

function attributesOf(span: {
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const entry of span.attributes) {
    out[entry.key] =
      entry.value.stringValue ??
      entry.value.intValue ??
      entry.value.boolValue ??
      entry.value.doubleValue;
  }
  return out;
}

describe("OTLP endpoints and payloads", () => {
  it("builds signal URLs under the base endpoint", () => {
    expect(otlpUrl("https://collector.example.com/", "traces")).toBe(
      "https://collector.example.com/v1/traces",
    );
    expect(otlpUrl("https://collector.example.com/otlp", "logs")).toBe(
      "https://collector.example.com/otlp/v1/logs",
    );
    expect(otlpUrl("https://collector.example.com", "metrics")).toBe(
      "https://collector.example.com/v1/metrics",
    );
  });

  it("emits standard span names, gen_ai attributes and namespaced customs", () => {
    const payload = buildTracesPayload(snapshot, generatorOptions) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string }> };
        scopeSpans: Array<{
          spans: Array<{
            name: string;
            parentSpanId?: string;
            attributes: Array<{ key: string; value: Record<string, unknown> }>;
          }>;
        }>;
      }>;
    };
    const resourceKeys = payload.resourceSpans[0]?.resource.attributes.map((entry) => entry.key);
    expect(resourceKeys).toContain("service.name");
    expect(resourceKeys).toContain("telemetry.sdk.name");
    expect(resourceKeys).toContain("alisio.telemetry.instance_id");

    const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans;
    expect(spans.map((span) => span.name)).toEqual([
      "invoke_agent openai/gpt-4o",
      "chat openai/gpt-4o",
      "execute_tool bash",
    ]);
    const invoke = attributesOf(first(spans));
    expect(invoke["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(invoke["gen_ai.conversation.id"]).toBe("s-1");
    expect(invoke["gen_ai.usage.input_tokens"]).toBe(100);
    expect(invoke["alisio.telemetry.cache_hit_ratio"]).toBeCloseTo(0.3);

    const chat = attributesOf(first(spans.slice(1)));
    expect(chat["server.address"]).toBe("api.openai.com");
    expect(chat["server.port"]).toBe(443);

    const tool = attributesOf(first(spans.slice(2)));
    expect(tool["gen_ai.tool.name"]).toBe("bash");
    expect(tool["gen_ai.tool.call.id"]).toBe("call-1");
    expect(tool["alisio.telemetry.tool.effect"]).toBe("process");
    expect(spans[1]?.parentSpanId).toBeDefined();
  });

  it("emits logs for runs and failed tools, and custom metrics", () => {
    const failing: TelemetrySnapshot = {
      ...snapshot,
      tools: [{ ...first(snapshot.tools), isError: true }],
    };
    const logs = buildLogsPayload(failing, generatorOptions) as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: unknown[] }> }>;
    };
    expect(logs.resourceLogs[0]?.scopeLogs[0]?.logRecords).toHaveLength(2);

    const metrics = buildMetricsPayload(snapshot, generatorOptions) as {
      resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<{ name: string }> }> }>;
    };
    const names = metrics.resourceMetrics[0]?.scopeMetrics[0]?.metrics.map((metric) => metric.name);
    expect(names).toContain("alisio.telemetry.tokens");
    expect(names).toContain("alisio.telemetry.tool.calls");
  });

  it("derives providers and samples deterministically", () => {
    expect(providerFromModel("openai/gpt-4o")).toEqual({
      provider: "openai",
      host: "api.openai.com",
    });
    expect(providerFromModel("unknown/model")).toBeNull();
    expect(shouldSample("run-1", 1)).toBe(true);
    expect(shouldSample("run-1", 0)).toBe(false);
    expect(shouldSample("run-1", 0.5)).toBe(shouldSample("run-1", 0.5));
  });
});

describe("retry, caps and redirect policy", () => {
  it("parses Retry-After in seconds and HTTP-date form", () => {
    expect(parseRetryAfter("2", NOW)).toBe(2000);
    expect(parseRetryAfter(new Date(NOW + 5000).toUTCString(), NOW)).toBe(5000);
    expect(parseRetryAfter(null, NOW)).toBe(0);
  });

  it("caps the response body", async () => {
    const capped = await readCappedText(new Response("x".repeat(1000), { status: 200 }), 100);
    expect(capped.text.length).toBe(100);
    expect(capped.truncated).toBe(true);
  });

  it("refuses redirects", async () => {
    const directions: Array<RequestInit["redirect"]> = [];
    const { fetcher } = makeFetcher((_url, init) => {
      directions.push(init.redirect);
      return new Response("{}", { status: 200 });
    });
    const { store, close } = makeStore();
    try {
      const exporter = makeExporter(store, fetcher, baseSettings());
      await exporter.flush();
      expect(directions.length).toBeGreaterThan(0);
      expect(directions.every((direction) => direction === "error")).toBe(true);
    } finally {
      close();
    }
  });
});

interface StoreHandle {
  store: Store;
  close: () => void;
}

function makeStore(): StoreHandle {
  const temp = makeTempDir();
  const database: SqlDatabase = openSqlite(`${temp.dir}/telemetry.sqlite`);
  const store = createStore(database);
  store.migrate();
  store.writeRecords([
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
      timestamp: at(100),
      turn: 1,
      model: "openai/gpt-4o",
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 0,
      calls: 1,
      durationMs: 100,
    },
  ]);
  return {
    store,
    close: () => {
      database.close();
      temp.cleanup();
    },
  };
}

function makeExporter(
  store: Store,
  fetcher: typeof fetch,
  settings: OtlpSettings,
  sleep = async () => {},
) {
  return createExporter({
    store,
    settings,
    fetcher,
    now: () => NOW,
    sleep,
    token: null,
    buildSnapshot: (range) => store.snapshot(range, 100),
    maxBatchPerFlush: 10,
  });
}

describe("exporter behavior", () => {
  it("treats HTTP 200 partial success as success and never retries", async () => {
    const { store, close } = makeStore();
    try {
      const { fetcher, calls } = makeFetcher(
        () =>
          new Response(JSON.stringify({ partialSuccess: { rejectedSpans: 1 } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const exporter = makeExporter(store, fetcher, baseSettings());
      const results = await exporter.flush();
      expect(results).toHaveLength(1);
      expect(results[0]?.status).toBe("sent");
      expect(calls).toHaveLength(1);
      expect(store.counts().pendingBatches).toBe(0);
    } finally {
      close();
    }
  });

  it("retries 503, honors Retry-After, and succeeds on the next attempt", async () => {
    const { store, close } = makeStore();
    try {
      let call = 0;
      const { fetcher, calls } = makeFetcher(() => {
        call += 1;
        return call === 1
          ? new Response("busy", { status: 503, headers: { "retry-after": "2" } })
          : new Response("{}", { status: 200 });
      });
      const sleeps: number[] = [];
      const exporter = makeExporter(store, fetcher, baseSettings(), async (ms) => {
        sleeps.push(ms);
      });
      const results = await exporter.flush();
      expect(results[0]?.status).toBe("sent");
      expect(results[0]?.attempts).toBe(2);
      expect(calls).toHaveLength(2);
      expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
    } finally {
      close();
    }
  });

  it("stops after bounded attempts and keeps retryable data pending", async () => {
    const { store, close } = makeStore();
    try {
      const { fetcher, calls } = makeFetcher(() => new Response("busy", { status: 429 }));
      const exporter = makeExporter(store, fetcher, baseSettings({ maxAttempts: 2 }));
      const results = await exporter.flush();
      expect(results[0]?.status).toBe("retry");
      expect(results[0]?.attempts).toBe(2);
      expect(calls).toHaveLength(2);
      expect(store.counts().pendingBatches).toBe(1);
    } finally {
      close();
    }
  });

  it("marks non-retryable responses dead without retrying", async () => {
    for (const status of [400, 401, 404, 500]) {
      const { store, close } = makeStore();
      try {
        const { fetcher, calls } = makeFetcher(() => new Response("nope", { status }));
        const exporter = makeExporter(store, fetcher, baseSettings());
        const results = await exporter.flush();
        expect(results[0]?.status).toBe("dead");
        expect(calls).toHaveLength(1);
        expect(store.counts().deadBatches).toBe(1);
      } finally {
        close();
      }
    }
  });

  it("re-exports idempotently after a failure without duplicating the batch", async () => {
    const { store, close } = makeStore();
    try {
      let call = 0;
      const { fetcher, calls } = makeFetcher(() => {
        call += 1;
        return call === 1
          ? new Response("busy", { status: 503 })
          : new Response("{}", { status: 200 });
      });
      const exporter = makeExporter(store, fetcher, baseSettings({ maxAttempts: 1 }));
      const first = await exporter.flush();
      expect(first[0]?.status).toBe("retry");
      expect(store.counts().pendingBatches).toBe(1);

      const second = await exporter.flush();
      expect(second[0]?.status).toBe("sent");
      expect(calls).toHaveLength(2);
      expect(calls[0]?.init.body).toBe(calls[1]?.init.body);

      const third = await exporter.flush();
      expect(third).toHaveLength(0);
      expect(calls).toHaveLength(2);
    } finally {
      close();
    }
  });

  it("makes no network call and queues nothing when export is disabled", async () => {
    const { store, close } = makeStore();
    try {
      const { fetcher, calls } = makeFetcher(() => new Response("{}", { status: 200 }));
      const exporter = makeExporter(store, fetcher, baseSettings({ enabled: false }));
      const results = await exporter.flush();
      expect(results).toHaveLength(0);
      expect(calls).toHaveLength(0);
      expect(store.counts().pendingBatches).toBe(0);
    } finally {
      close();
    }
  });

  it("injects the token only as a per-request header", async () => {
    const { store, close } = makeStore();
    try {
      const { fetcher, calls } = makeFetcher(() => new Response("{}", { status: 200 }));
      const exporter = createExporter({
        store,
        settings: baseSettings(),
        fetcher,
        now: () => NOW,
        sleep: async () => {},
        token: "unit-test-token",
        buildSnapshot: (range) => store.snapshot(range, 100),
      });
      const results = await exporter.flush();
      expect(calls[0]?.init.headers).toMatchObject({ authorization: "Bearer unit-test-token" });
      expect(JSON.stringify(results)).not.toContain("unit-test-token");
    } finally {
      close();
    }
  });
});
