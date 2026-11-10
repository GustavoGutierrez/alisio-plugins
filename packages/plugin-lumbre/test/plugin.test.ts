import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginAPI, PluginAppDefinition, ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../src/index.js";
import { resolveLocale } from "../src/messages.js";
import { VERSION } from "../src/version.js";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function host(options: { apps?: boolean; locale?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "lmb-plugin-"));
  roots.push(root);
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, (args: string) => Promise<string>>();
  const apps: PluginAppDefinition[] = [];
  const resources: string[] = [];
  const api = {
    paths: { state: join(root, "state"), config: join(root, "config"), cache: join(root, "cache") },
    options: { locale: options.locale ?? "en" },
    resources: {
      agents: (p: string) => resources.push(`agents:${p}`),
      skills: (p: string) => resources.push(`skills:${p}`),
    },
    models: { list: async () => [], resolve: async () => ({}) },
    sessions: {
      create: async () => ({}),
      run: async () => ({}),
      cancel: () => 0,
      model: () => "acme/fast",
    },
    tools: {
      register: (t: ToolDefinition) => {
        tools.set(t.name, t);
        return () => tools.delete(t.name);
      },
    },
    commands: {
      register: (name: string, h: (a: string) => Promise<string>) => {
        commands.set(name, h);
        return () => commands.delete(name);
      },
    },
    ...(options.apps === false
      ? {}
      : {
          apps: {
            register: (app: PluginAppDefinition) => {
              apps.push(app);
              return () => app.dispose?.();
            },
          },
        }),
  } as unknown as PluginAPI;
  await plugin.setup(api);
  return { api, tools, commands, apps, resources, root };
}

describe("plugin entry (LMB-AC-01, LMB-AC-03)", () => {
  it("uses the synced version and registers the packaged agent and skills", async () => {
    const h = await host();
    expect(plugin.version).toBe(VERSION);
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
    expect(h.resources).toEqual(["agents:../.agents/agents", "skills:../.agents/skills"]);
    expect(h.apps.map((a) => a.id)).toEqual(["studio"]);
    expect(h.apps[0]?.label).toEqual({ en: "Lumbre · Web builder", es: "Lumbre · Creador web" });
  });

  it("explains itself in the user's language, with and without the apps API", async () => {
    expect(await (await host())?.commands.get("help")?.("")).toMatch(/Apps group/);
    expect(await (await host({ locale: "es" })).commands.get("help")?.("")).toMatch(/Aplicaciones/);
    const old = await host({ apps: false });
    expect(old.apps).toEqual([]);
    expect(await old.commands.get("help")?.("")).toMatch(/0\.11\.6/);
    expect(resolveLocale(undefined, { LANG: "es_CO.UTF-8" })).toBe("es");
    expect(resolveLocale(undefined, {})).toBe("en");
  });

  it("lists projects with the read-only tool without creating any state", async () => {
    const h = await host({ apps: false });
    const tool = h.tools.get("lumbre_projects");
    expect(tool?.effect).toBe("read");
    const out = await tool?.execute({}, {
      workspace: h.root,
      signal: new AbortController().signal,
    } as never);
    expect(JSON.stringify(out)).toContain("No Lumbre projects yet");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(h.root)).toEqual([]);
  });

  it("serves the built page lazily, is idle when nothing runs and disposes idempotently", async () => {
    const h = await host();
    const app = h.apps[0] as PluginAppDefinition;
    expect(app.busy?.()).toBe(false);
    const status = await app.actions?.status?.handler(
      {},
      {
        sessionId: "s",
        workspace: h.root,
        signal: new AbortController().signal,
      },
    );
    expect(status).toMatchObject({ value: { minHost: "0.11.6" } });
    app.dispose?.();
    app.dispose?.();
    const after = await app.actions?.status?.handler(
      {},
      { sessionId: "s", workspace: h.root, signal: new AbortController().signal },
    );
    expect(after).toEqual({ error: "unavailable" });
    await plugin.dispose?.();
  });
});
