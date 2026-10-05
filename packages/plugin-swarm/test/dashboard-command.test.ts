import type { PanelNode, PanelProvider, PluginAPI, ViewDefinition } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { GitWorktreeIsolation } from "../src/adapters/git-worktree.js";
import { registerSwarm } from "../src/index.js";
import { ScriptedRunner, tempDir } from "./helpers.js";

interface Options {
  panel?: boolean | "throws";
  views?: boolean;
  openBrowser?: (url: string) => void | Promise<void>;
}

async function harness(options: Options = {}) {
  const workspace = await tempDir();
  const commands = new Map<
    string,
    (args: string, context?: { sessionId?: string }) => Promise<string>
  >();
  const panels = new Map<string, PanelProvider>();
  const views = new Map<string, ViewDefinition>();
  const api = {
    commands: {
      register: (name: string, handler: never) => {
        commands.set(name, handler);
        return () => undefined;
      },
    },
    tools: { register: () => () => undefined },
    resources: { agents: () => undefined, skills: () => undefined },
    sessions: { workspace: () => workspace },
    ...(options.panel
      ? {
          ui: {
            panel: (id: string, provider: PanelProvider) => {
              if (options.panel === "throws") throw new Error("no panel here");
              panels.set(id, provider);
              return () => undefined;
            },
          },
        }
      : {}),
    ...(options.views
      ? {
          views: {
            register: (view: ViewDefinition) => {
              views.set(view.id, view);
              return () => undefined;
            },
          },
        }
      : {}),
  } as unknown as PluginAPI;
  const opened: string[] = [];
  const runner = new ScriptedRunner();
  const coordinator = registerSwarm(api, {
    runner,
    isolation: new GitWorktreeIsolation(),
    autoStart: false,
    gates: null,
    openBrowser: options.openBrowser ?? ((url) => void opened.push(url)),
  });
  const run = (name: string, args = "") => {
    const handler = commands.get(name);
    if (!handler) throw new Error(`No command ${name}`);
    return handler(args, { sessionId: "parent" });
  };
  await run("init");
  return { workspace, panels, views, opened, runner, coordinator, run };
}

const urlOf = (text: string): string =>
  /http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}/.exec(text)?.[0] ?? "";

describe("/swarm:dashboard", () => {
  it("starts the server, returns the URL and tries to open the browser", async () => {
    const h = await harness();
    const text = await h.run("dashboard");
    const url = urlOf(text);
    expect(url).not.toBe("");
    expect(h.opened).toEqual([url]);
    const page = await fetch(url, { redirect: "manual" });
    expect(page.status).toBe(302);
    await h.coordinator.dispose();
  });

  it("deep-links to a card or a project with a hash", async () => {
    const h = await harness();
    const text = await h.run("dashboard", "demo/add-login");
    expect(urlOf(text)).not.toBe("");
    expect(text).toContain("#demo/add-login");
    expect(h.opened[0]).toMatch(/\/\?token=[0-9a-f]{64}#demo\/add-login$/);
    expect(await h.run("dashboard", "demo")).toContain("#demo");
    await expect(h.run("dashboard", "../x")).rejects.toThrow();
    await h.coordinator.dispose();
  });

  it("is idempotent for a workspace and does not reopen the browser", async () => {
    const h = await harness();
    const first = urlOf(await h.run("dashboard"));
    const second = urlOf(await h.run("dashboard"));
    expect(second).toBe(first);
    expect(h.opened).toHaveLength(1);
    await h.coordinator.dispose();
  });

  it("fails open when the browser cannot be opened", async () => {
    const h = await harness({
      openBrowser: () => {
        throw new Error("no display");
      },
    });
    const text = await h.run("dashboard");
    expect(urlOf(text)).not.toBe("");
    expect(text).toMatch(/open the link/i);
    await h.coordinator.dispose();
  });

  it("is stopped by teardown and can be started again", async () => {
    const h = await harness();
    const first = urlOf(await h.run("dashboard"));
    await h.run("teardown", "--confirm TEARDOWN");
    expect(
      await fetch(first).then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    const again = urlOf(await h.run("dashboard"));
    expect(again).not.toBe("");
    expect(again).not.toBe(first);
    await h.coordinator.dispose();
  });

  it("is stopped by dispose", async () => {
    const h = await harness();
    const url = urlOf(await h.run("dashboard"));
    await h.coordinator.dispose();
    expect(
      await fetch(url).then(
        () => false,
        () => true,
      ),
    ).toBe(true);
  });
});

describe("fallbacks", () => {
  it("registers a ui.panel tree of projects, roles and tasks when the host has panels", async () => {
    const h = await harness({ panel: true });
    await h.run("project", "new demo --pack two-pack -- Build it");
    await h.run("task", "demo new -- Add login");
    const provider = h.panels.get("swarm");
    expect(provider?.title).toBe("Swarm");
    const nodes = provider?.nodes({ sessionId: "parent" }) as PanelNode[];
    const project = nodes.find((node) => node.label === "demo");
    expect(project).toBeDefined();
    const roles = nodes.filter((node) => node.parentId === project?.id);
    expect(roles.map((node) => node.label)).toEqual(["coder", "cleaner"]);
    const task = nodes.find((node) => node.label === "add-login");
    expect(task?.parentId).toBe(roles[0]?.id);
    expect(task?.status).toBe("queued");
    const ids = nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.indexOf(project?.id ?? "")).toBeLessThan(ids.indexOf(roles[0]?.id ?? ""));
  });

  it("survives a host whose ui.panel throws", async () => {
    await expect(harness({ panel: "throws" })).resolves.toBeDefined();
  });

  it("works without ui.panel and without views", async () => {
    const h = await harness();
    expect(h.panels.size).toBe(0);
    expect(h.views.size).toBe(0);
  });

  it("registers the swarm-board view returning the dashboard state when views exist", async () => {
    const h = await harness({ views: true });
    await h.run("project", "new demo --pack two-pack -- Build it");
    const view = h.views.get("swarm-board");
    expect(view?.description).toBeTruthy();
    const state = (await view?.handler(
      {},
      {
        sessionId: "parent",
        workspace: h.workspace,
        signal: new AbortController().signal,
      },
    )) as { schemaVersion: number; projects: Array<{ name: string }> };
    expect(state.schemaVersion).toBe(1);
    expect(state.projects[0]?.name).toBe("demo");
  });
});
