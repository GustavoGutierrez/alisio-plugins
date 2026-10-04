import type { ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { COMMAND_NAMES } from "../src/commands.js";
import { createTelemetryPlugin, resourcePaths, TOOL_NAMES, VERSION } from "../src/index.js";
import { makeFakeApi, makeTempDir, type TempDir } from "./helpers.js";

let temp: TempDir | null = null;
afterEach(() => {
  temp?.cleanup();
  temp = null;
});

function setupPlugin(autoFlushMs: number | null = null) {
  temp = makeTempDir();
  const fake = makeFakeApi();
  const plugin = createTelemetryPlugin({
    env: {},
    paths: { configFile: `${temp.dir}/config.json`, database: `${temp.dir}/telemetry.sqlite` },
    skipConfigFile: true,
    autoFlushMs,
  });
  plugin.setup(fake.api);
  return { plugin, fake };
}

describe("plugin registration", () => {
  it("declares a stable id, category and version", () => {
    const { plugin } = setupPlugin();
    expect(plugin.id).toBe("telemetry");
    expect(plugin.apiVersion).toBe(1);
    expect(plugin.categories).toEqual(["analytics"]);
    expect(plugin.version).toBe(VERSION);
  });

  it("registers every tool with a read effect and a closed schema", () => {
    const { fake } = setupPlugin();
    expect(fake.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of fake.tools) {
      expect(tool.effect).toBe("read");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(typeof tool.description).toBe("string");
    }
  });

  it("requires a query for telemetry_search only", () => {
    const { fake } = setupPlugin();
    const search = fake.tools.find((tool) => tool.name === "telemetry_search") as ToolDefinition;
    expect(search.inputSchema.required).toEqual(["query"]);
    for (const tool of fake.tools.filter((entry) => entry.name !== "telemetry_search")) {
      expect(tool.inputSchema.required).toBeUndefined();
    }
  });

  it("registers the operator commands and the skill resource", () => {
    const { fake } = setupPlugin();
    expect(fake.commands.map((command) => command.name).sort()).toEqual([...COMMAND_NAMES].sort());
    expect(fake.skills).toEqual([resourcePaths.skills]);
    expect(resourcePaths.skills).toBe("../.agents/skills");
  });

  it("registers one synchronous event handler and a session-end hook", () => {
    const { fake } = setupPlugin();
    const handler = fake.getEventHandler();
    expect(typeof handler).toBe("function");
    // The handler must be synchronous: no promise is returned even for a valid event.
    expect(handler?.({ schemaVersion: 1 })).toBeUndefined();
    expect(typeof fake.getSessionEnd()).toBe("function");
  });
});
