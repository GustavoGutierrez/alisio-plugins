import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginAPI, ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { AppContext, AppRegistration } from "../src/apps.js";
import plugin from "../src/index.js";
import { VERSION } from "../src/version.js";
import { fakeApi } from "./helpers.js";

interface Harness {
  api: PluginAPI;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, (args: string) => Promise<string>>;
  views: string[];
  agents: string[];
  skills: string[];
  apps: AppRegistration[];
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function harness(withApps: boolean): Promise<Harness> {
  const state = await mkdtemp(join(tmpdir(), "scribe-plugin-"));
  roots.push(state);
  const base = fakeApi();
  const h: Omit<Harness, "api"> = {
    tools: new Map(),
    commands: new Map(),
    views: [],
    agents: [],
    skills: [],
    apps: [],
  };
  const api = {
    ...base,
    sessions: { ...base.sessions, workspace: () => "/workspace" },
    paths: { state, config: state, cache: state },
    options: {},
    resources: {
      agents: (path: string) => h.agents.push(path),
      skills: (path: string) => h.skills.push(path),
    },
    tools: {
      register: (tool: ToolDefinition) => {
        h.tools.set(tool.name, tool);
        return () => h.tools.delete(tool.name);
      },
    },
    commands: {
      register: (name: string, handler: (args: string) => Promise<string>) => {
        h.commands.set(name, handler);
        return () => h.commands.delete(name);
      },
    },
    views: {
      register: (view: { id: string }) => {
        h.views.push(view.id);
        return () => {};
      },
    },
    ...(withApps
      ? {
          apps: {
            register: (app: AppRegistration) => {
              h.apps.push(app);
              return () => {};
            },
          },
        }
      : {}),
  } as unknown as PluginAPI;
  await plugin.setup(api);
  return { ...h, api };
}

describe("plugin entry", () => {
  it("declares id, the package version and api version", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(plugin.id).toBe("alisio.scribe");
    expect(plugin.version).toBe(VERSION);
    expect(VERSION).toBe(manifest.version);
    expect(plugin.apiVersion).toBe(1);
  });

  it("registers the studio app, tool, view, help and resources when api.apps exists", async () => {
    const h = await harness(true);
    expect(h.agents).toEqual(["../.agents/agents"]);
    expect(h.skills).toEqual(["../.agents/skills"]);
    expect([...h.tools.keys()]).toEqual(["scribe_documents"]);
    expect(h.views).toEqual(["documents"]);
    expect(h.apps).toHaveLength(1);
    const app = h.apps[0];
    if (!app) throw new Error("app missing");
    expect(app.id).toBe("studio");
    expect(app.actions["jobs.cancel"]?.effect).toBe("write");
    expect(app.actions["pdf.compile"]?.effect).toBe("process");
    expect(app.actions["documents.list"]?.effect).toBe("read");
    expect(await h.commands.get("help")?.("")).toMatch(/project sidebar/);

    const context: AppContext = {
      sessionId: "s",
      workspace: "/workspace",
      signal: new AbortController().signal,
      idempotencyKey: randomUUID(),
    };
    const created = (await app.actions["documents.create"]?.handler(
      { title: "Via app" },
      context,
    )) as {
      value: { id: string };
    };
    expect(created.value.id).toMatch(/^[a-f0-9-]{36}$/);
    const readContext: AppContext = {
      sessionId: "s",
      workspace: "/workspace",
      signal: context.signal,
    };
    const listed = (await app.actions["documents.list"]?.handler({}, readContext)) as {
      value: Array<{ id: string }>;
    };
    expect(listed.value.map((d) => d.id)).toEqual([created.value.id]);
    expect(await app.actions["documents.get"]?.handler({ documentId: "bad" }, readContext)).toEqual(
      {
        error: "invalid_id",
      },
    );
    app.dispose?.();
  });

  it("fails open on hosts without api.apps: no throw, everything else still registers", async () => {
    const h = await harness(false);
    expect(h.apps).toHaveLength(0);
    expect([...h.tools.keys()]).toEqual(["scribe_documents"]);
    expect(h.views).toEqual(["documents"]);
    expect(h.agents).toHaveLength(1);
    expect(h.skills).toHaveLength(1);
    expect(await h.commands.get("help")?.("")).toMatch(/no plugin apps API/);
    const tool = h.tools.get("scribe_documents");
    const result = await tool?.execute({}, { session: "s" } as Parameters<
      ToolDefinition["execute"]
    >[1]);
    expect(JSON.stringify(result)).toMatch(/Open Scribe to initialize/);
  });
});
