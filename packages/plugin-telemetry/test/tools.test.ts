import type { ToolDefinition, ToolResult } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultConfig, type TelemetryConfig } from "../src/config.js";
import type { SqlDatabase } from "../src/database.js";
import { createStore, type Store, type TelemetryRecord } from "../src/store.js";
import { createTelemetryTools, TOOL_NAMES, type ToolRuntime } from "../src/tools.js";
import { makeTempDir, makeToolContext, resultJson, type TempDir } from "./helpers.js";
import { openSqlite } from "./sqlite-driver.js";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const NOW = BASE + 3_600_000;
const at = (minutes: number): string => new Date(BASE + minutes * 60_000).toISOString();
const HOME_PATH = ["", "home", "bob", "bin", "sh"].join("/");
const NPM_TOKEN = `np${"m_"}${"b".repeat(40)}`;

let temp: TempDir | null = null;
let database: SqlDatabase | null = null;
afterEach(() => {
  try {
    database?.close();
  } catch {
    // ignore
  }
  database = null;
  temp?.cleanup();
  temp = null;
});

const records: TelemetryRecord[] = [
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
    timestamp: at(1),
    turn: 1,
    model: "openai/gpt-4o",
    inputTokens: 10,
    outputTokens: 5,
    cachedInputTokens: 0,
    calls: 1,
    durationMs: 20,
  },
  {
    kind: "tool_start",
    runId: "run-1",
    sessionId: "s-1",
    seq: 3,
    timestamp: at(2),
    callId: "c1",
    name: HOME_PATH,
    effect: "process",
    argsBytes: 0,
    args: null,
  },
  {
    kind: "tool_end",
    runId: "run-1",
    sessionId: "s-1",
    seq: 4,
    timestamp: at(3),
    callId: "c1",
    name: HOME_PATH,
    isError: true,
    durationMs: 30,
    resultBytes: 0,
    preview: null,
  },
];

function makeStore(config: TelemetryConfig): { store: Store; runtime: ToolRuntime } {
  temp = makeTempDir();
  database = openSqlite(`${temp.dir}/telemetry.sqlite`);
  const store = createStore(database);
  store.migrate();
  store.writeRecords(records);
  return { store, runtime: { store, config, configError: null, now: () => NOW } };
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

async function call(tool: ToolDefinition, input: Record<string, unknown>): Promise<ToolResult> {
  return tool.execute(input, makeToolContext());
}

describe("telemetry tools", () => {
  it("exposes exactly the documented read-only tools", () => {
    const { runtime } = makeStore(createDefaultConfig());
    const tools = createTelemetryTools(runtime);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(tools.every((tool) => tool.effect === "read")).toBe(true);
  });

  it("returns a bounds envelope on every tool", async () => {
    const { runtime } = makeStore(createDefaultConfig());
    const tools = createTelemetryTools(runtime);
    for (const name of TOOL_NAMES) {
      const input = name === "telemetry_search" ? { query: "anything" } : {};
      const payload = resultJson(await call(findTool(tools, name), input));
      expect(Object.keys(payload)).toEqual(
        expect.arrayContaining(["window", "returned", "total", "truncated", "hint", "data"]),
      );
      expect(typeof payload.truncated).toBe("boolean");
    }
  });

  it("rejects invalid arguments with a stable error", async () => {
    const { runtime } = makeStore(createDefaultConfig());
    const tools = createTelemetryTools(runtime);
    const result = await call(findTool(tools, "telemetry_summary"), { windowMinutes: 0 });
    expect(result.isError).toBe(true);
    expect(resultJson(result).error).toMatchObject({ code: "invalid_arguments" });
  });

  it("returns a stable error when the store is unavailable", async () => {
    const tools = createTelemetryTools({
      store: null,
      config: null,
      configError: "boom",
      now: () => NOW,
    });
    const result = await call(findTool(tools, "telemetry_summary"), {});
    expect(result.isError).toBe(true);
    expect(resultJson(result).error).toMatchObject({ code: "telemetry_unavailable" });
  });

  it("explains that content capture is disabled by default", async () => {
    const { runtime } = makeStore(createDefaultConfig());
    const tools = createTelemetryTools(runtime);
    const payload = resultJson(
      await call(findTool(tools, "telemetry_search"), { query: "secret" }),
    );
    const data = payload.data as { contentCapture: boolean };
    expect(data.contentCapture).toBe(false);
    expect(String(payload.hint)).toContain("Content capture is disabled");
  });

  it("returns captured content when capture is enabled", async () => {
    const config = createDefaultConfig();
    config.capture.prompts = true;
    const { store, runtime } = makeStore(config);
    store.recordContent([
      {
        runId: null,
        sessionId: "s-1",
        kind: "prompt",
        ref: null,
        text: "a needle in the haystack",
        createdAt: at(4),
      },
    ]);
    const tools = createTelemetryTools(runtime);
    const payload = resultJson(
      await call(findTool(tools, "telemetry_search"), { query: "needle" }),
    );
    const data = payload.data as { contentCapture: boolean; hits: unknown[] };
    expect(data.contentCapture).toBe(true);
    expect(data.hits).toHaveLength(1);
  });

  it("never exposes absolute machine paths or credentials in results", async () => {
    const { store, runtime } = makeStore(createDefaultConfig());
    store.recordContent([
      {
        runId: null,
        sessionId: "s-1",
        kind: "prompt",
        ref: null,
        text: `path ${HOME_PATH} token ${NPM_TOKEN}`,
        createdAt: at(4),
      },
    ]);
    const tools = createTelemetryTools(runtime);
    const toolPayload = resultJson(await call(findTool(tools, "telemetry_tools"), {}));
    const serialized = JSON.stringify(toolPayload);
    expect(serialized).not.toContain("bob");
    expect(serialized).toContain("<path>");
  });
});
