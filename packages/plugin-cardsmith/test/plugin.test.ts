import type { PluginAPI, ToolDefinition } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import plugin from "../src/index.js";

function stubApi(): { api: PluginAPI; tools: Map<string, ToolDefinition>; skills: string[] } {
  const tools = new Map<string, ToolDefinition>();
  const skills: string[] = [];
  const api = {
    tools: {
      register: (tool: ToolDefinition) => {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    resources: {
      skills: (path: string) => {
        skills.push(path);
      },
    },
  } as unknown as PluginAPI;
  return { api, tools, skills };
}

describe("plugin entry", () => {
  it("declares id, version and api version", () => {
    expect(plugin.id).toBe("alisio.cardsmith");
    expect(plugin.version).toBe("0.1.0");
    expect(plugin.apiVersion).toBe(1);
  });

  it("setup registers exactly five tools and the skill directory", () => {
    const { api, tools, skills } = stubApi();
    plugin.setup(api);
    expect([...tools.keys()].sort()).toEqual([
      "card_catalog",
      "card_design",
      "card_export",
      "card_render",
      "card_update",
    ]);
    expect(skills).toEqual(["../.agents/skills"]);
  });

  it("dispose removes the registered tools", () => {
    const { api, tools } = stubApi();
    plugin.setup(api);
    expect(tools.size).toBe(5);
    plugin.dispose?.();
    expect(tools.size).toBe(0);
  });
});
