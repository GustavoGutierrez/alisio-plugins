import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginAPI, RunEvent, ToolContext, ToolDefinition } from "@alisio/sdk";
import { openSqlite } from "./sqlite-driver.js";

export interface TempDir {
  dir: string;
  cleanup: () => void;
}

/** A throwaway directory removed by the caller (usually in `afterEach`). */
export function makeTempDir(): TempDir {
  const dir = mkdtempSync(join(tmpdir(), "alisio-telemetry-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface FakeApi {
  api: PluginAPI;
  tools: ToolDefinition[];
  commands: Array<{ name: string; handler: (args: string) => Promise<string>; options?: unknown }>;
  skills: string[];
  getEventHandler: () => ((event: unknown) => void) | null;
  getSessionEnd: () => unknown;
}

/** A minimal `PluginAPI` that records registrations without touching the host. */
export function makeFakeApi(): FakeApi {
  const tools: ToolDefinition[] = [];
  const commands: Array<{
    name: string;
    handler: (args: string) => Promise<string>;
    options?: unknown;
  }> = [];
  const skills: string[] = [];
  let eventHandler: ((event: unknown) => void) | null = null;
  let sessionEnd: unknown = null;

  const api = {
    tools: {
      register: (tool: ToolDefinition) => {
        tools.push(tool);
        return () => {};
      },
    },
    commands: {
      register: (name: string, handler: (args: string) => Promise<string>, options?: unknown) => {
        commands.push({ name, handler, options });
        return () => {};
      },
    },
    events: {
      on: (handler: (event: unknown) => void) => {
        eventHandler = handler;
        return () => {};
      },
    },
    context: { register: () => () => {} },
    resources: {
      skills: (path: string) => {
        skills.push(path);
      },
      prompts: () => {},
      agents: () => {},
      list: () => [],
    },
    state: { get: () => undefined, set: () => {} },
    compaction: { register: () => () => {} },
    session: {
      onStart: () => () => {},
      onEnd: (handler: unknown) => {
        sessionEnd = handler;
        return () => {};
      },
    },
    model: { complete: async () => "" },
    models: { list: async () => [], resolve: async () => ({}) },
    providers: { register: () => () => {} },
    storage: { sqlite: (path: string) => openSqlite(path) },
    extensions: { register: () => () => {} },
    sessions: {} as never,
    ui: {} as never,
  } as unknown as PluginAPI;

  return {
    api,
    tools,
    commands,
    skills,
    getEventHandler: () => eventHandler,
    getSessionEnd: () => sessionEnd,
  };
}

/** A tool execution context with an abort signal that will not fire. */
export function makeToolContext(): ToolContext {
  return { signal: new AbortController().signal, workspace: ".", emit: () => {} };
}

/** Build a `RunEvent`-shaped object for handler tests. */
export function runEvent(type: string, data: unknown, overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    schemaVersion: 1,
    runId: "run-1",
    sessionId: "session-1",
    seq: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    type,
    data,
    ...overrides,
  } as RunEvent;
}

/** Build a `fetch`-compatible seam that records every call. */
export function makeFetcher(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(url, call.init);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

/** Extract the JSON payload from a tool result's first text part. */
export function resultJson(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  for (const part of result.content) {
    if (part.type === "text" && typeof part.text === "string") {
      return JSON.parse(part.text) as Record<string, unknown>;
    }
  }
  throw new Error("tool result had no text part");
}

/** Return the first element or throw, avoiding non-null assertions in tests. */
export function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("expected at least one element");
  return value;
}
