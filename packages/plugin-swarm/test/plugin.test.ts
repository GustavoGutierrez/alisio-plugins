import type { PluginAPI, ToolContext, ToolDefinition, ToolResult } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { GitWorktreeIsolation } from "../src/adapters/git-worktree.js";
import plugin, { registerSwarm } from "../src/index.js";
import { commitFile, gitIn, handoffEnvelope, ScriptedRunner, tempDir } from "./helpers.js";

async function harness(options: { initialise?: boolean } = {}) {
  const workspace = await tempDir();
  const commands = new Map<
    string,
    (args: string, context?: { sessionId?: string }) => Promise<string>
  >();
  const tools = new Map<string, ToolDefinition>();
  const resources: Record<string, string> = {};
  const api = {
    commands: {
      register: (name: string, handler: never) => {
        commands.set(name, handler);
        return () => undefined;
      },
    },
    tools: {
      register: (tool: ToolDefinition) => {
        tools.set(tool.name, tool);
        return () => undefined;
      },
    },
    resources: {
      agents: (path: string) => {
        resources.agents = path;
      },
      skills: (path: string) => {
        resources.skills = path;
      },
    },
    sessions: { workspace: () => workspace },
  } as unknown as PluginAPI;
  const runner = new ScriptedRunner();
  const coordinator = registerSwarm(api, {
    runner,
    isolation: new GitWorktreeIsolation(),
    autoStart: false,
    gates: null,
    doctor: {
      nodeVersion: "22.19.0",
      async exec(command: string) {
        return command === "git" ? "git version 2.34.1" : "10.0.0";
      },
    },
  });
  const run = (name: string, args = "") => {
    const handler = commands.get(name);
    if (!handler) throw new Error(`No command ${name}`);
    return handler(args, { sessionId: "parent" });
  };
  const tool = async (name: string, input: Record<string, unknown> = {}): Promise<ToolResult> => {
    const definition = tools.get(name);
    if (!definition) throw new Error(`No tool ${name}`);
    const context = {
      signal: new AbortController().signal,
      workspace,
      emit: () => undefined,
    } as ToolContext;
    return definition.execute(input, context);
  };
  if (options.initialise !== false) await run("init");
  return { workspace, commands, tools, resources, runner, coordinator, run, tool };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

describe("plugin registration", () => {
  it("is a valid plugin definition", () => {
    expect(plugin.id).toBe("swarm");
    expect(plugin.apiVersion).toBe(1);
    expect(plugin.categories).toEqual(["methodology-harness"]);
  });

  it("registers the agent and skill directories, commands and tools", async () => {
    const h = await harness();
    expect(h.resources).toEqual({ agents: "../.agents/agents", skills: "../.agents/skills" });
    expect([...h.commands.keys()].sort()).toEqual([
      "answer",
      "approve",
      "budget",
      "chat",
      "comment",
      "dashboard",
      "doctor",
      "init",
      "pack",
      "project",
      "reject",
      "run",
      "status",
      "stop",
      "task",
      "teardown",
    ]);
    expect([...h.tools.keys()].sort()).toEqual([
      "swarm_doctor",
      "swarm_gate_run",
      "swarm_status",
      "swarm_task_new",
    ]);
    expect(h.tools.get("swarm_status")?.effect).toBe("read");
    expect(h.tools.get("swarm_task_new")?.effect).toBe("write");
    expect(h.tools.get("swarm_doctor")?.effect).toBe("process");
  });
});

describe("commands", () => {
  it("init creates the forge and reports it, then is idempotent", async () => {
    const h = await harness({ initialise: false });
    expect(await h.run("init")).toMatch(/initialised/i);
    expect(await h.run("init")).toMatch(/already/i);
  });

  it("explains that init is needed before anything else", async () => {
    const h = await harness({ initialise: false });
    await expect(h.run("project", "list")).rejects.toThrow(/init/i);
    await expect(h.run("status")).rejects.toThrow(/init/i);
  });

  it("doctor prints one line per check", async () => {
    const h = await harness();
    const text = await h.run("doctor");
    expect(text).toContain("[ok] git");
    expect(text).toContain("[ok] Forge");
  });

  it("lists and shows packs", async () => {
    const h = await harness();
    const list = await h.run("pack", "list");
    for (const name of ["two-pack", "four-pack", "six-pack"]) expect(list).toContain(name);
    const show = await h.run("pack", "show two-pack");
    expect(show).toContain("coder");
    expect(show).toContain("cleaner");
    expect(show).toMatch(/crap/i);
    await expect(h.run("pack", "show ../x")).rejects.toThrow(/pack name/i);
    await expect(h.run("pack", "show")).rejects.toThrow(/usage/i);
    await expect(h.run("pack", "dance")).rejects.toThrow(/usage/i);
  });

  it("creates, lists, closes and reopens a project", async () => {
    const h = await harness();
    const created = await h.run("project", "new demo --pack two-pack -- Build a todo app");
    expect(created).toMatch(/demo/);
    expect(created).toMatch(/coder → cleaner/);
    expect(await h.run("project", "list")).toMatch(/demo.*two-pack.*running/);
    expect(await h.run("project", "close demo")).toMatch(/closed/i);
    expect(await h.run("project", "list")).toMatch(/demo.*closed/);
    expect(await h.run("project", "open demo")).toMatch(/open/i);
    await expect(h.run("project", "new demo -- again")).rejects.toThrow(/already exists/i);
  });

  it("validates project arguments", async () => {
    const h = await harness();
    await expect(h.run("project", "new")).rejects.toThrow(/usage/i);
    await expect(h.run("project", "new demo")).rejects.toThrow(/mission/i);
    await expect(h.run("project", "new Bad_Name -- m")).rejects.toThrow(/project name/i);
    await expect(h.run("project", "new demo --pack -- m")).rejects.toThrow(/needs a value/i);
    await expect(h.run("project", "open")).rejects.toThrow(/usage/i);
    await expect(h.run("project", "close ghost")).rejects.toThrow(/unknown project/i);
    await expect(h.run("project", "fly")).rejects.toThrow(/usage/i);
  });

  it("creates a task and shows it in the status", async () => {
    const h = await harness();
    await h.run("project", "new demo -- Build it");
    const created = await h.run("task", "demo new -- Add a login form");
    expect(created).toMatch(/add-a-login-form/);
    const status = await h.run("status");
    expect(status).toContain("demo");
    expect(status).toContain("add-a-login-form");
    expect(await h.run("status", "demo")).toContain("add-a-login-form");
    await expect(h.run("status", "ghost")).rejects.toThrow(/unknown project/i);
  });

  it("accepts an explicit task name and rejects a missing text or project", async () => {
    const h = await harness();
    await h.run("project", "new demo -- Build it");
    expect(await h.run("task", "demo new login -- Add login")).toMatch(/login/);
    await expect(h.run("task", "demo new")).rejects.toThrow(/task text/i);
    await expect(h.run("task", "ghost new -- text")).rejects.toThrow(/unknown project|not open/i);
    await expect(h.run("task", "demo remove -- x")).rejects.toThrow(/usage/i);
    await expect(h.run("task", "")).rejects.toThrow(/usage/i);
  });

  it("refuses a task for a project that is closed", async () => {
    const h = await harness();
    await h.run("project", "new demo -- Build it");
    await h.run("project", "close demo");
    await expect(h.run("task", "demo new -- text")).rejects.toThrow(/not open/i);
  });

  it("runs the pipeline through the same services the commands use", async () => {
    const h = await harness();
    await h.run("project", "new demo --pack two-pack -- Build it");
    const runtime = h.coordinator.forgeFor(h.workspace).runtime("demo");
    const head = (dir: string) => gitIn(dir, "rev-parse", "HEAD").slice(0, 10);
    h.runner.script(
      "coder",
      async (r) => handoffEnvelope(await commitFile(r.workdir, "a.ts", "a\n")),
      (r) => handoffEnvelope(head(r.workdir)),
    );
    h.runner.script(
      "cleaner",
      async (r) => handoffEnvelope(await commitFile(r.workdir, "b.ts", "b\n")),
      (r) => handoffEnvelope(head(r.workdir)),
    );
    await h.run("task", "demo new -- Add login");
    await runtime?.drain();
    expect(await h.run("status", "demo")).toMatch(/add-login \[done\] done/);
  });
});

describe("tools", () => {
  it("swarm_status returns text plus UI blocks", async () => {
    const h = await harness();
    await h.run("project", "new demo -- Build it");
    await h.run("task", "demo new -- Add login");
    const result = await h.tool("swarm_status", {});
    expect(textOf(result)).toContain("add-login");
    const kinds = result.content
      .filter((part) => part.type === "ui")
      .map((part) => (part as { block: { kind: string } }).block.kind);
    expect(kinds).toEqual(expect.arrayContaining(["table", "mermaid"]));
    expect((await h.tool("swarm_status", { project: "ghost" })).isError).toBe(true);
  });

  it("swarm_task_new creates a card and validates its input", async () => {
    const h = await harness();
    await h.run("project", "new demo -- Build it");
    const ok = await h.tool("swarm_task_new", { project: "demo", text: "Add login" });
    expect(ok.isError).toBeUndefined();
    expect(textOf(ok)).toContain("add-login");
    expect((await h.tool("swarm_task_new", { project: "demo" })).isError).toBe(true);
    expect((await h.tool("swarm_task_new", { project: "../x", text: "t" })).isError).toBe(true);
    expect((await h.tool("swarm_task_new", { project: "ghost", text: "t" })).isError).toBe(true);
  });

  it("swarm_doctor reports the checks", async () => {
    const h = await harness();
    expect(textOf(await h.tool("swarm_doctor"))).toContain("[ok] git");
  });
});

describe("lifecycle", () => {
  it("dispose stops every running project", async () => {
    const h = await harness();
    await h.run("project", "new demo -- Build it");
    await h.coordinator.dispose();
    expect(h.runner.cancelled).toContain("demo");
    expect(h.coordinator.forgeFor(h.workspace).runtime("demo")).toBeUndefined();
  });

  it("fails clearly without a session workspace", async () => {
    const h = await harness();
    const handler = h.commands.get("status") as (
      args: string,
      context?: { sessionId?: string },
    ) => Promise<string>;
    await expect(handler("", undefined)).rejects.toThrow(/session/i);
  });
});
