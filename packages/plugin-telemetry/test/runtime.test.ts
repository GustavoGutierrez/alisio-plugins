import type { Message } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { createTelemetryRuntime } from "../src/runtime.js";
import { createTelemetryTools } from "../src/tools.js";
import { makeFetcher, makeTempDir, makeToolContext, resultJson, runEvent } from "./helpers.js";
import { openSqlite } from "./sqlite-driver.js";

const NOW = Date.parse("2026-01-01T12:00:00.000Z");
const NPM_TOKEN = `np${"m_"}${"c".repeat(40)}`;

function runtimeOptions(dir: string, overrides: Record<string, unknown> = {}) {
  return {
    env: {},
    paths: { configFile: `${dir}/config.json`, database: `${dir}/telemetry.sqlite` },
    skipConfigFile: true,
    autoFlushMs: null,
    now: () => NOW,
    openDatabase: openSqlite,
    ...overrides,
  };
}

describe("telemetry runtime pipeline", () => {
  it("records observed events and produces aggregates without any network call", async () => {
    const temp = makeTempDir();
    try {
      const { fetcher, calls } = makeFetcher(() => new Response("{}", { status: 200 }));
      const runtime = createTelemetryRuntime(runtimeOptions(temp.dir, { fetcher }));
      runtime.handler(runEvent("run_started", { model: "openai/gpt-4o" }));
      runtime.handler(
        runEvent("turn_completed", {
          turn: 1,
          calls: 1,
          model: "openai/gpt-4o",
          usage: { input: 100, output: 40, cachedInput: 10 },
        }),
      );
      runtime.handler(runEvent("tool_started", { name: "bash", id: "c1", effect: "process" }));
      runtime.handler(
        runEvent("tool_completed", { id: "c1", name: "bash", isError: false, durationMs: 5 }),
      );

      const report = await runtime.flush();
      expect(report.records).toBe(4);
      expect(report.error).toBeNull();
      expect(calls).toHaveLength(0);

      const summary = runtime.store?.summary({
        from: new Date(NOW - 24 * 3_600_000).toISOString(),
        to: new Date(NOW).toISOString(),
      });
      expect(summary).toMatchObject({
        runs: 1,
        turns: 1,
        toolCalls: 1,
        inputTokens: 100,
        outputTokens: 40,
      });
      await runtime.dispose();
    } finally {
      temp.cleanup();
    }
  });

  it("keeps the handler synchronous and safe after registration", async () => {
    const temp = makeTempDir();
    try {
      const runtime = createTelemetryRuntime(runtimeOptions(temp.dir));
      expect(runtime.handler({ nope: true })).toBeUndefined();
      expect(runtime.handler(null)).toBeUndefined();
      await runtime.dispose();
    } finally {
      temp.cleanup();
    }
  });

  it("fails closed on invalid configuration without opening a store", async () => {
    const temp = makeTempDir();
    try {
      const runtime = createTelemetryRuntime(
        runtimeOptions(temp.dir, {
          skipConfigFile: true,
          configFile: undefined,
          env: { ALISIO_TELEMETRY_SAMPLING_RATIO: "2" },
        }),
      );
      expect(runtime.store).toBeNull();
      expect(runtime.configError).toContain("samplingRatio");
      const report = await runtime.flush();
      expect(report.error).not.toBeNull();
      const tools = createTelemetryTools({
        store: runtime.store,
        config: runtime.config,
        configError: runtime.configError,
        now: runtime.now,
      });
      const result = await tools[0]?.execute({}, makeToolContext());
      expect(resultJson(result).error).toMatchObject({ code: "telemetry_unavailable" });
      await runtime.dispose();
    } finally {
      temp.cleanup();
    }
  });

  it("captures transcript prompts only when enabled, with redaction", async () => {
    const temp = makeTempDir();
    try {
      const enabled = createTelemetryRuntime(
        runtimeOptions(temp.dir, {
          configFile: { capture: { prompts: true } },
          skipConfigFile: false,
        }),
      );
      const messages = [
        { role: "user", text: `token ${NPM_TOKEN}` },
        { role: "assistant", text: "ignored", calls: [] },
      ] as unknown as Message[];
      const stored = await enabled.captureTranscript({ sessionId: "s-1", messages });
      expect(stored).toBe(1);
      const found = enabled.store?.search(
        "token",
        { from: new Date(NOW - 3_600_000).toISOString(), to: new Date(NOW).toISOString() },
        5,
      );
      expect(found?.total).toBe(1);
      expect(JSON.stringify(found)).not.toContain(NPM_TOKEN);
      await enabled.dispose();

      const disabled = createTelemetryRuntime(runtimeOptions(temp.dir));
      const storedDisabled = await disabled.captureTranscript({ sessionId: "s-2", messages });
      expect(storedDisabled).toBe(0);
      await disabled.dispose();
    } finally {
      temp.cleanup();
    }
  });

  it("prunes old telemetry and reports what it deleted", async () => {
    const temp = makeTempDir();
    try {
      const runtime = createTelemetryRuntime(runtimeOptions(temp.dir));
      runtime.handler(runEvent("run_started", {}, { timestamp: "2020-01-01T00:00:00.000Z" }));
      await runtime.flush();
      const report = runtime.prune(1);
      expect(report.deleted.runs).toBe(1);
      expect(runtime.store?.counts().runs).toBe(0);
      await runtime.dispose();
    } finally {
      temp.cleanup();
    }
  });
});
