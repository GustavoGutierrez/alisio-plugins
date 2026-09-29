import { describe, expect, it } from "vitest";
import {
  createEventBuffer,
  createEventHandler,
  isTrustedEnvelope,
  normalizeEvent,
} from "../src/events.js";
import { redactJson, redactText } from "../src/redact.js";
import { runEvent } from "./helpers.js";

const METADATA_ONLY = {
  capture: { prompts: false, completions: false, toolArguments: false, toolResults: false },
  redaction: { mode: "strict" as const },
};
const CAPTURE_ALL = {
  capture: { prompts: true, completions: true, toolArguments: true, toolResults: true },
  redaction: { mode: "strict" as const },
};

/** Build credential-shaped strings without embedding them literally in source. */
const BEARER_HEADER = `Author${"ization: Bear"}er ${"z".repeat(24)}`;
const HOME_PATH = ["", "home", "alice", "secrets.txt"].join("/");
const NPM_TOKEN = `np${"m_"}${"a".repeat(40)}`;

describe("envelope validation", () => {
  it("accepts a well-formed envelope and rejects malformed ones", () => {
    expect(isTrustedEnvelope(runEvent("run_started", {}))).toBe(true);
    expect(isTrustedEnvelope(null)).toBe(false);
    expect(isTrustedEnvelope({ schemaVersion: 2 })).toBe(false);
    expect(isTrustedEnvelope({ schemaVersion: 1, runId: "r", sessionId: "s", seq: "1" })).toBe(
      false,
    );
    expect(
      isTrustedEnvelope({
        schemaVersion: 1,
        runId: "r",
        sessionId: "s",
        seq: 1,
        timestamp: "t",
        type: "x",
      }),
    ).toBe(true);
  });
});

describe("event mapping", () => {
  it("maps run start, turn and tool events into the telemetry model", () => {
    const start = normalizeEvent(
      runEvent("run_started", { model: "openai/gpt-4o" }),
      METADATA_ONLY,
    );
    expect(start).toMatchObject({ kind: "run_start", runId: "run-1", model: "openai/gpt-4o" });

    const turn = normalizeEvent(
      runEvent("turn_completed", {
        turn: 2,
        calls: 3,
        model: "openai/gpt-4o",
        usage: { input: 100, output: 40, cachedInput: 30 },
      }),
      METADATA_ONLY,
    );
    expect(turn).toMatchObject({
      kind: "turn",
      turn: 2,
      calls: 3,
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 30,
    });

    const toolStart = normalizeEvent(
      runEvent("tool_started", {
        name: "bash",
        id: "call-1",
        arguments: { cmd: "ls" },
        effect: "process",
      }),
      METADATA_ONLY,
    );
    expect(toolStart).toMatchObject({
      kind: "tool_start",
      name: "bash",
      callId: "call-1",
      effect: "process",
    });

    const toolEnd = normalizeEvent(
      runEvent("tool_completed", {
        id: "call-1",
        name: "bash",
        isError: true,
        durationMs: 12,
        preview: "boom",
      }),
      METADATA_ONLY,
    );
    expect(toolEnd).toMatchObject({
      kind: "tool_end",
      callId: "call-1",
      isError: true,
      durationMs: 12,
    });
  });

  it("ignores unknown event types and malformed data", () => {
    expect(normalizeEvent(runEvent("text_delta", { delta: "x" }), METADATA_ONLY)).toBeNull();
    expect(normalizeEvent(runEvent("tool_started", "not-an-object"), METADATA_ONLY)).toBeNull();
    expect(normalizeEvent(runEvent("turn_completed", { model: "m" }), METADATA_ONLY)).toBeNull();
  });

  it("never captures content by default (metadata only)", () => {
    const start = normalizeEvent(
      runEvent("tool_started", { name: "bash", id: "c1", arguments: { token: NPM_TOKEN } }),
      METADATA_ONLY,
    );
    expect(start?.kind).toBe("tool_start");
    if (start?.kind === "tool_start") {
      expect(start.args).toBeNull();
      expect(start.argsBytes).toBeGreaterThan(0);
    }
    const end = normalizeEvent(
      runEvent("tool_completed", { id: "c1", preview: "secret output" }),
      METADATA_ONLY,
    );
    if (end?.kind === "tool_end") {
      expect(end.preview).toBeNull();
      expect(end.resultBytes).toBeGreaterThan(0);
    }
  });

  it("redacts credentials and machine paths when capture is enabled", () => {
    const record = normalizeEvent(
      runEvent("tool_started", {
        name: "bash",
        id: "c1",
        arguments: { note: BEARER_HEADER, file: HOME_PATH, key: NPM_TOKEN },
      }),
      CAPTURE_ALL,
    );
    expect(record?.kind).toBe("tool_start");
    if (record?.kind === "tool_start") {
      expect(record.args).not.toBeNull();
      expect(record.args).not.toContain("zzzz");
      expect(record.args).not.toContain("alice");
      expect(record.args).not.toContain(NPM_TOKEN);
      expect(record.args).toContain("<path>");
    }
  });
});

describe("redaction helpers", () => {
  it("strips bearer headers, tokens, private keys and paths", () => {
    const pem = `${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)} body`;
    const text = redactText(
      `Authorization: Bearer ${"q".repeat(30)}\n${pem}\npath ${HOME_PATH} token=${NPM_TOKEN}`,
      { mode: "strict" },
    );
    expect(text).not.toContain("qqqq");
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain("alice");
    expect(text).not.toContain(NPM_TOKEN);
  });

  it("drops secret-named object keys entirely", () => {
    const json = redactJson(
      { authorization: "Bearer abcdefghijklmnop", safe: "value" },
      { mode: "strict" },
    );
    expect(json).not.toContain("abcdefghijklmnop");
    expect(json).toContain("[redacted]");
    expect(json).toContain("value");
  });
});

describe("synchronous event handler", () => {
  it("never throws and never returns a promise, even on hostile input", () => {
    const buffer = createEventBuffer(10);
    const handler = createEventHandler({
      buffer,
      capture: METADATA_ONLY.capture,
      redaction: METADATA_ONLY.redaction,
    });
    expect(handler(null)).toBeUndefined();
    expect(handler(42)).toBeUndefined();
    expect(handler({ schemaVersion: 1, runId: 1 })).toBeUndefined();
    const evil = {
      schemaVersion: 1,
      runId: "r",
      sessionId: "s",
      seq: 1,
      timestamp: "t",
      type: "tool_started",
      data: new Proxy(
        {},
        {
          get() {
            throw new Error("boom");
          },
        },
      ),
    };
    expect(handler(evil)).toBeUndefined();
    expect(buffer.size()).toBe(0);
  });

  it("drops safely under a burst instead of blocking", () => {
    const buffer = createEventBuffer(5);
    const handler = createEventHandler({
      buffer,
      capture: METADATA_ONLY.capture,
      redaction: METADATA_ONLY.redaction,
    });
    for (let index = 0; index < 20; index += 1) {
      handler(runEvent("run_started", { model: `m${index}` }, { seq: index }));
    }
    expect(buffer.size()).toBe(5);
    expect(buffer.dropped()).toBe(15);
    expect(buffer.drain(10)).toHaveLength(5);
    expect(buffer.size()).toBe(0);
  });
});
