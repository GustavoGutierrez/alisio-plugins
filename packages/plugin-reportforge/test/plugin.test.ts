import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { PluginAppDefinition } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain build script without declarations
import { buildUi } from "../scripts/copy-ui.mjs";
import { createReportForgePlugin, loadHtml, VERSION } from "../src/index.js";
import { ACTIONS } from "../src/service.js";
import { fakeHost } from "./helpers/fake-api.js";

const UI = new URL("../ui/index.html", import.meta.url);

async function registered(withApps = true) {
  const host = await fakeHost();
  const apps: PluginAppDefinition[] = [];
  const tools: { name: string; effect: string }[] = [];
  const commands: string[] = [];
  const resources: string[] = [];
  const api = {
    ...(host.api as object),
    resources: {
      agents: (p: string) => resources.push(`agents:${p}`),
      skills: (p: string) => resources.push(`skills:${p}`),
      prompts: () => {},
    },
    commands: {
      register: (name: string) => {
        commands.push(name);
        return () => {};
      },
    },
    tools: {
      register: (tool: { name: string; effect: string }) => {
        tools.push(tool);
        return () => {};
      },
    },
    ...(withApps
      ? {
          apps: {
            register: (app: PluginAppDefinition) => {
              apps.push(app);
              return () => {};
            },
          },
        }
      : {}),
  };
  const plugin = createReportForgePlugin();
  await plugin.setup(api as never);
  return { plugin, apps, tools, commands, resources, host };
}

describe("plugin registration", () => {
  it("registers the ReportForge app with its own menu label", async () => {
    const { plugin, apps, tools, commands, resources, host } = await registered();
    expect(plugin).toMatchObject({ id: "alisio.reportforge", version: VERSION, apiVersion: 1 });
    expect(apps).toHaveLength(1);
    const app = apps[0] as PluginAppDefinition;
    expect(app.id).toBe("reportforge");
    expect(app.id).toMatch(/^[a-z][a-z0-9-]{0,39}$/);
    expect(app.label).toEqual({ en: "ReportForge", es: "ReportForge" });
    expect(typeof app.busy).toBe("function");
    expect(typeof app.dispose).toBe("function");
    expect(tools.map((t) => [t.name, t.effect])).toEqual([["reportforge_reports", "read"]]);
    expect(commands).toEqual(["help"]);
    expect(resources).toEqual(["agents:../.agents/agents", "skills:../.agents/skills"]);
    await host.cleanup();
  });

  it("stays usable without the apps API", async () => {
    const { apps, tools, host } = await registered(false);
    expect(apps).toHaveLength(0);
    expect(tools).toHaveLength(1);
    await host.cleanup();
  });

  it("registers every action with an effect and a host-compatible schema", async () => {
    const { apps, host } = await registered();
    const actions = apps[0]?.actions ?? {};
    expect(Object.keys(actions).sort()).toEqual(Object.keys(ACTIONS).sort());
    for (const [name, action] of Object.entries(actions)) {
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
      expect(["read", "write"]).toContain(action.effect);
      expect(action.inputSchema).toMatchObject({ type: "object" });
      expect(JSON.stringify(action.inputSchema)).not.toMatch(/"\$(ref|id|async)"/);
    }
    await host.cleanup();
  });

  it("returns error codes, never raw messages or paths", async () => {
    const { apps, host } = await registered();
    const actions = apps[0]?.actions ?? {};
    const context = { sessionId: "s1", workspace: "/w", signal: new AbortController().signal };
    expect(await actions["reports.get"]?.handler({ id: "../x" }, context)).toEqual({
      error: "invalid_id",
    });
    const created = (await actions["reports.create"]?.handler({ name: "A" }, context)) as {
      value: { id: string };
    };
    expect(created.value.id).toMatch(/^[0-9a-f-]{36}$/);
    // A filesystem failure carries a path in its message: only a generic code may leave.
    const broken = { ...context, sessionId: "s1" };
    (host.api as { paths: { state: string } }).paths.state = new URL(import.meta.url).pathname;
    const other = createReportForgePlugin();
    const failing: PluginAppDefinition[] = [];
    await other.setup({
      ...(host.api as object),
      resources: { agents: () => {}, skills: () => {}, prompts: () => {} },
      commands: { register: () => () => {} },
      tools: { register: () => () => {} },
      apps: { register: (app: PluginAppDefinition) => (failing.push(app), () => {}) },
    } as never);
    const result = (await failing[0]?.actions?.["reports.list"]?.handler({}, broken)) as {
      error: string;
    };
    expect(result.error).toBe("operation_failed");
    expect(JSON.stringify(result)).not.toContain("/proc");
    await host.cleanup();
  });
});

describe("studio frame html", () => {
  it("is served from the build output, identical to the source", async () => {
    await promisify(execFile)(process.execPath, [
      new URL("../scripts/copy-ui.mjs", import.meta.url).pathname,
    ]);
    const built = await readFile(new URL("../dist/ui.html", import.meta.url), "utf8");
    const icon = await readFile(new URL("../icon.svg", import.meta.url), "utf8");
    expect(built).toBe(buildUi(await readFile(UI, "utf8"), icon));
    for (const shape of icon.match(/<(path|rect)\b[^>]*\/>/g) ?? []) expect(built).toContain(shape);
    expect(built).not.toContain("◈");
    expect(await loadHtml()).toBe(built);
  });

  it("meets the frame CSP: nonce on every script, no external resources, no forms, no eval", async () => {
    const html = await readFile(UI, "utf8");
    expect(Buffer.byteLength(html)).toBeLessThan(8 * 1024 * 1024);
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toContain('nonce="__ALISIO_NONCE__"');
      expect(tag).not.toMatch(/\ssrc\s*=/i);
    }
    expect(html).not.toMatch(/<form\b|<link\b|@import/i);
    expect(html).not.toMatch(/\b(?:src|href|action|srcset|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).not.toMatch(
      /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|\beval\s*\(|new Function\b|WebAssembly/,
    );
  });

  it("only calls actions the plugin registers", async () => {
    const html = await readFile(UI, "utf8");
    const called = new Set([...html.matchAll(/\bcall\("([^"]+)"/g)].map((m) => m[1]));
    const generic = [...html.matchAll(/work\("([^"]+)"/g)].map((m) => m[1]);
    for (const name of generic) called.add(name);
    expect(called.size).toBeGreaterThan(10);
    for (const name of called) expect(Object.keys(ACTIONS), name).toContain(name);
  });
});
