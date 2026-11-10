import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginAPI, PluginAppContext, PluginAppDefinition, ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { unsupportedSchemaKeywords } from "../src/apps.js";
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
  apps: PluginAppDefinition[];
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
            register: (app: PluginAppDefinition) => {
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
    expect(app.id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
    expect(app.id).toBe("studio");
    const actions = app.actions ?? {};
    expect(actions["jobs.cancel"]?.effect).toBe("write");
    expect(actions["pdf.compile"]?.effect).toBe("process");
    expect(actions["documents.list"]?.effect).toBe("read");
    expect(await h.commands.get("help")?.("")).toMatch(/project sidebar/);

    const context: PluginAppContext = {
      sessionId: "s",
      workspace: "/workspace",
      signal: new AbortController().signal,
      idempotencyKey: randomUUID(),
    };
    const created = (await actions["documents.create"]?.handler({ title: "Via app" }, context)) as {
      value: { id: string };
    };
    expect(created.value.id).toMatch(/^[a-f0-9-]{36}$/);
    const readContext: PluginAppContext = {
      sessionId: "s",
      workspace: "/workspace",
      signal: context.signal,
    };
    const listed = (await actions["documents.list"]?.handler({}, readContext)) as {
      value: Array<{ id: string }>;
    };
    expect(listed.value.map((d) => d.id)).toEqual([created.value.id]);
    expect(await actions["documents.get"]?.handler({ documentId: "bad" }, readContext)).toEqual({
      error: "invalid_id",
    });
    app.dispose?.();
  });

  it("keeps one workspace's studio working when another workspace's activation is disposed", async () => {
    // The host runs setup once per open workspace on the same module object.
    const home = await harness(true);
    const project = await harness(true);
    home.apps[0]?.dispose?.();
    const actions = project.apps[0]?.actions ?? {};
    const context: PluginAppContext = {
      sessionId: "s2",
      workspace: "/workspace",
      signal: new AbortController().signal,
      idempotencyKey: randomUUID(),
    };
    const created = (await actions["documents.create"]?.handler(
      { title: "Still here" },
      context,
    )) as {
      value: { id: string };
    };
    expect(created.value.id).toMatch(/^[a-f0-9-]{36}$/);
    // A fresh activation after dispose registers and works again.
    const again = await harness(true);
    expect(again.apps).toHaveLength(1);
    expect(
      await again.apps[0]?.actions?.["documents.list"]?.handler({}, {
        ...context,
        idempotencyKey: undefined,
      } as PluginAppContext),
    ).toEqual({ value: [] });
    project.apps[0]?.dispose?.();
    again.apps[0]?.dispose?.();
  });

  it("declares action names and input schemas the host accepts", async () => {
    const h = await harness(true);
    const actions = h.apps[0]?.actions ?? {};
    expect(Object.keys(actions).length).toBeGreaterThan(0);
    for (const [name, action] of Object.entries(actions)) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
      expect(action.inputSchema.type).toBe("object");
      expect(unsupportedSchemaKeywords(action.inputSchema), name).toEqual([]);
    }
    expect(
      unsupportedSchemaKeywords({ properties: { a: { $ref: "#/x" } }, anyOf: [{ $id: "y" }] }),
    ).toEqual(["$.properties.a.$ref", "$.anyOf[0].$id"]);
  });

  it("fails open on hosts without api.apps: no throw, everything else still registers", async () => {
    const h = await harness(false);
    expect(h.apps).toHaveLength(0);
    expect([...h.tools.keys()]).toEqual(["scribe_documents"]);
    expect(h.views).toEqual(["documents"]);
    expect(h.agents).toHaveLength(1);
    expect(h.skills).toHaveLength(1);
    expect(await h.commands.get("help")?.("")).toMatch(/no plugin apps API.*Alisio 0\.11\.6/);
    const tool = h.tools.get("scribe_documents");
    const result = await tool?.execute({}, { session: "s" } as Parameters<
      ToolDefinition["execute"]
    >[1]);
    expect(JSON.stringify(result)).toMatch(/Open Scribe to initialize/);
  });
});
