import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AskQuestionsRequest,
  AskQuestionsResult,
  ChildRunResult,
  ChildSessionInfo,
  ChildSessionSpec,
  PluginAPI,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { GitWorktreeIsolation } from "../src/adapters/git-worktree.js";
import { registerSwarm } from "../src/index.js";
import {
  blockedEnvelope,
  clarificationEnvelope,
  commitFile,
  gitIn,
  handoffEnvelope,
  ScriptedGates,
  ScriptedRunner,
  tempDir,
} from "./helpers.js";

const head = (dir: string) => gitIn(dir, "rev-parse", "HEAD").slice(0, 10);
const repeat = (r: { workdir: string }) => handoffEnvelope(head(r.workdir));
const work = (file: string) => async (r: { workdir: string }) =>
  handoffEnvelope(await commitFile(r.workdir, file, `${file}\n`));

interface HarnessOptions {
  interactive?: boolean;
  /** Answers for `ui.askQuestions`, by question id. */
  answers?: AskQuestionsResult;
  gates?: ScriptedGates | null;
  options?: Record<string, unknown>;
  withRunner?: boolean;
  sessions?: Record<string, unknown>;
}

async function harness(opts: HarnessOptions = {}) {
  const workspace = await tempDir();
  const commands = new Map<
    string,
    (args: string, context?: { sessionId?: string }) => Promise<string>
  >();
  const tools = new Map<string, ToolDefinition>();
  const asked: AskQuestionsRequest[] = [];
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
    resources: { agents: () => undefined, skills: () => undefined },
    sessions: { workspace: () => workspace, ...opts.sessions },
    ...(opts.options ? { options: opts.options } : {}),
    ui: {
      interactive: () => opts.interactive === true,
      askQuestions: async (request: AskQuestionsRequest) => {
        asked.push(request);
        return opts.answers ?? {};
      },
    },
  } as unknown as PluginAPI;
  const runner = new ScriptedRunner();
  const gates = opts.gates === undefined ? null : opts.gates;
  const coordinator = registerSwarm(api, {
    ...(opts.withRunner === false ? {} : { runner }),
    isolation: new GitWorktreeIsolation(),
    autoStart: false,
    gates,
    doctor: {
      nodeVersion: "22.19.0",
      async exec() {
        return "git version 2.34.1";
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
    return definition.execute(input, {
      signal: new AbortController().signal,
      workspace,
      emit: () => undefined,
    } as ToolContext);
  };
  await run("init");
  const runtime = (project = "demo") => coordinator.forgeFor(workspace).runtime(project);
  return { workspace, commands, tools, runner, coordinator, run, tool, asked, runtime };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

async function writeLocalPack(workspace: string, pack: Record<string, unknown>) {
  const dir = join(workspace, ".alisio", "swarm", "packs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${pack.name}.json`), JSON.stringify(pack));
}

const roleSpec = (id: string, isolation = "worktree") => ({
  id,
  agent: `swarm-${id}`,
  isolation,
  receive: "task",
  propagation: "forward-only",
});

/** A project on a pack with an approval gate after the coder, with one task waiting for approval. */
async function atApproval(opts: HarnessOptions = {}) {
  const h = await harness(opts);
  await writeLocalPack(h.workspace, {
    schemaVersion: 1,
    name: "gated",
    description: "Gate after the coder",
    toolchain: "node-ts",
    approval: { after: "coder" },
    roles: [roleSpec("coder", "master"), roleSpec("cleaner")],
  });
  await h.run("project", "new demo --pack gated -- Build it");
  h.runner.script("coder", work("spec.md"), repeat);
  await h.run("task", "demo new -- Needs sign-off");
  await h.runtime()?.drain();
  return h;
}

describe("registration", () => {
  it("registers every command of the spec plus comment, run and budget", async () => {
    const h = await harness();
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
    expect(h.tools.get("swarm_gate_run")?.effect).toBe("process");
  });
});

describe("approve, reject and comment", () => {
  it("approves by project/task and by attention id, and the pipeline continues", async () => {
    const h = await atApproval();
    h.runner.script("cleaner", work("clean.ts"), repeat);
    expect(await h.run("approve", "approval:demo:needs-sign-off")).toMatch(/approved/i);
    await h.runtime()?.drain();
    expect(await h.run("status", "demo")).toMatch(/needs-sign-off \[done\] done/);
  });

  it("refuses to approve while comments exist and accepts once they are cleared", async () => {
    const h = await atApproval();
    h.runner.script("cleaner", work("clean.ts"), repeat);
    await h.run("comment", "demo/needs-sign-off specs/login.feature -- Add an error example");
    await expect(h.run("approve", "demo/needs-sign-off")).rejects.toThrow(/comment/i);
    expect(await h.run("status", "demo")).not.toMatch(/approve\b/);
    await h.run("comment", "demo/needs-sign-off clear");
    await h.run("approve", "demo/needs-sign-off");
    await h.runtime()?.drain();
    expect(h.runtime()?.board().tasks[0]?.status).toBe("done");
  });

  it("rejects with retry and comments, restoring the base", async () => {
    const h = await atApproval();
    h.runner.script("coder", work("spec2.md"), repeat);
    const text = await h.run("reject", "demo/needs-sign-off retry -- Missing error cases");
    expect(text).toMatch(/retry/i);
    await h.runtime()?.drain();
    expect(h.runner.callsFor("coder")[2]?.prompt).toContain("Missing error cases");
  });

  it("rejects with delete and with accept", async () => {
    const h = await atApproval();
    expect(await h.run("reject", "demo/needs-sign-off delete")).toMatch(/deleted/i);
    expect(h.runtime()?.board().tasks).toEqual([]);
    const other = await atApproval();
    other.runner.script("cleaner", work("clean.ts"), repeat);
    await other.run("reject", "demo/needs-sign-off accept");
    await other.runtime()?.drain();
    expect(other.runtime()?.board().tasks[0]?.status).toBe("done");
  });

  it("validates the arguments", async () => {
    const h = await atApproval();
    await expect(h.run("reject", "demo/needs-sign-off")).rejects.toThrow(/usage/i);
    await expect(h.run("reject", "demo/needs-sign-off explode")).rejects.toThrow(/usage/i);
    await expect(h.run("approve", "nope")).rejects.toThrow(/task reference|usage/i);
    await expect(h.run("approve", "demo/../x")).rejects.toThrow(/task|usage/i);
    await expect(h.run("approve", "ghost/x")).rejects.toThrow(/unknown project|not open/i);
    await expect(h.run("approve", "demo/ghost")).rejects.toThrow(/unknown task/i);
    await expect(h.run("comment", "demo/needs-sign-off specs/a.feature")).rejects.toThrow(
      /usage|text/i,
    );
  });

  it("asks interactively for the missing reject action and falls back to usage headless", async () => {
    const h = await atApproval({ interactive: true, answers: { action: "accept" } });
    h.runner.script("cleaner", work("clean.ts"), repeat);
    await h.run("reject", "demo/needs-sign-off");
    const question = h.asked[0]?.questions[0];
    expect(question?.options.map((o) => o.value)).toEqual(["retry", "delete", "accept"]);
    await h.runtime()?.drain();
    expect(h.runtime()?.board().tasks[0]?.status).toBe("done");

    const skipped = await atApproval({ interactive: true, answers: {} });
    await expect(skipped.run("reject", "demo/needs-sign-off")).rejects.toThrow(/usage/i);
  });

  it("picks the pending approval interactively when no id is given", async () => {
    const h = await atApproval({ interactive: true, answers: { task: "demo/needs-sign-off" } });
    h.runner.script("cleaner", work("clean.ts"), repeat);
    expect(await h.run("approve")).toMatch(/approved/i);
    await h.runtime()?.drain();
    expect(h.runtime()?.board().tasks[0]?.status).toBe("done");
    const headless = await atApproval();
    await expect(headless.run("approve")).rejects.toThrow(/usage/i);
  });
});

describe("answer, retry and delete", () => {
  it("answers a clarification and resumes the role", async () => {
    const h = await harness();
    await h.run("project", "new demo --pack two-pack -- Build it");
    h.runner.script(
      "coder",
      clarificationEnvelope("Which login method?"),
      work("login.ts"),
      repeat,
    );
    h.runner.script("cleaner", work("clean.ts"), repeat);
    await h.run("task", "demo new -- Add login");
    await h.runtime()?.drain();
    expect(await h.run("status", "demo")).toMatch(/clarification/i);
    expect(await h.run("answer", "clarification:demo:add-login -- Use email sign-in")).toMatch(
      /answer/i,
    );
    await h.runtime()?.drain();
    expect(h.runner.callsFor("coder")[1]?.prompt).toContain("Use email sign-in");
    expect(h.runtime()?.board().tasks[0]?.status).toBe("done");
    await expect(h.run("answer", "demo/add-login")).rejects.toThrow(/usage|text/i);
    await expect(h.run("answer", "demo/add-login -- hi")).rejects.toThrow(/not waiting/i);
  });

  it("retries and deletes blocked tasks through the task command", async () => {
    const h = await harness();
    await h.run("project", "new demo --pack two-pack -- Build it");
    h.runner.script("coder", blockedEnvelope("db missing"), work("a.ts"), repeat);
    h.runner.script("cleaner", work("b.ts"), repeat);
    await h.run("task", "demo new -- Add login");
    await h.runtime()?.drain();
    expect(h.runtime()?.board().tasks[0]?.status).toBe("blocked");
    expect(await h.run("task", "demo retry add-login")).toMatch(/retry/i);
    await h.runtime()?.drain();
    expect(h.runtime()?.board().tasks[0]?.status).toBe("done");
    expect(await h.run("task", "demo delete add-login")).toMatch(/deleted/i);
    expect(h.runtime()?.board().tasks).toEqual([]);
    await expect(h.run("task", "demo delete")).rejects.toThrow(/usage/i);
  });
});

describe("chat with the Lieutenant", () => {
  it("sends the operator message to a read-only Lieutenant session and returns its reply", async () => {
    const h = await harness();
    await h.run("project", "new demo --pack two-pack -- Build it");
    await h.run("task", "demo new -- Add login");
    h.runner.script("lieutenant", "The coder has one task queued.");
    const reply = await h.run("chat", "demo -- What is going on?");
    expect(reply).toContain("The coder has one task queued.");
    const call = h.runner.callsFor("lieutenant")[0];
    expect(call).toMatchObject({
      agent: "swarm-lieutenant",
      sessionKey: "demo/lieutenant",
      workdir: h.runtime()?.dir,
    });
    expect(call?.prompt).toContain("What is going on?");
    expect(call?.prompt).toContain("add-login");
  });

  it("infers the only open project, and asks for one when several are open", async () => {
    const h = await harness();
    await h.run("project", "new demo --pack two-pack -- Build it");
    h.runner.script("lieutenant", "Hello.");
    expect(await h.run("chat", "-- Hi")).toContain("Hello.");
    await h.run("project", "new second --pack two-pack -- Another");
    await expect(h.run("chat", "-- Hi")).rejects.toThrow(/project/i);
    await expect(h.run("chat", "demo")).rejects.toThrow(/usage|text/i);
    await h.run("project", "close demo");
    await expect(h.run("chat", "demo -- Hi")).rejects.toThrow(/not open/i);
  });

  it("surfaces a failed Lieutenant run", async () => {
    const h = await harness();
    await h.run("project", "new demo --pack two-pack -- Build it");
    h.runner.script("lieutenant", { status: "failed", text: "", error: "provider down" });
    await expect(h.run("chat", "demo -- Hi")).rejects.toThrow(/provider down/);
  });
});

describe("stop, run and teardown", () => {
  it("stop cancels the agents but keeps the project open for a restart", async () => {
    const h = await harness();
    await h.run("project", "new demo --pack two-pack -- Build it");
    expect(await h.run("stop", "demo")).toMatch(/stopped/i);
    expect(h.runner.cancelled).toContain("demo");
    expect(await h.run("project", "list")).toMatch(/demo.*open \(not running\)/);
    await h.run("project", "open demo");
    expect(await h.run("project", "list")).toMatch(/demo.*running/);
    await expect(h.run("stop", "")).rejects.toThrow(/usage/i);
    await expect(h.run("stop", "ghost")).rejects.toThrow(/unknown project/i);
  });

  it("run drains the project in the foreground within a bound", async () => {
    const h = await harness();
    await h.run("project", "new demo --pack two-pack -- Build it");
    h.runner.script("coder", work("a.ts"), repeat);
    h.runner.script("cleaner", work("b.ts"), repeat);
    await h.run("task", "demo new -- Add login");
    expect(await h.run("run", "demo --seconds 30")).toMatch(/done: 1/i);
    await expect(h.run("run", "demo --seconds 0")).rejects.toThrow(/seconds/i);
    await expect(h.run("run", "")).rejects.toThrow(/usage/i);
  });

  it("teardown needs the exact confirmation and leaves project files alone", async () => {
    const h = await harness();
    await h.run("project", "new demo --pack two-pack -- Build it");
    const dir = h.runtime()?.dir as string;
    await expect(h.run("teardown", "")).rejects.toThrow(/TEARDOWN/);
    await expect(h.run("teardown", "--confirm teardown")).rejects.toThrow(/TEARDOWN/);
    expect(h.runtime()).toBeDefined();
    expect(existsSync(join(h.workspace, ".alisio", "swarm", "swarm.pid"))).toBe(true);
    expect(await h.run("teardown", "--confirm TEARDOWN")).toMatch(/teardown/i);
    expect(h.runtime()).toBeUndefined();
    expect(h.runner.cancelled).toContain("demo");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(h.workspace, ".alisio", "swarm", "swarm.pid"))).toBe(false);
  });

  it("teardown asks interactively when the flag is missing", async () => {
    const yes = await harness({ interactive: true, answers: { confirm: "TEARDOWN" } });
    await yes.run("project", "new demo --pack two-pack -- Build it");
    await yes.run("teardown", "");
    expect(yes.runtime()).toBeUndefined();
    const no = await harness({ interactive: true, answers: { confirm: "cancel" } });
    await no.run("project", "new demo --pack two-pack -- Build it");
    expect(await no.run("teardown", "")).toMatch(/cancelled/i);
    expect(no.runtime()).toBeDefined();
  });

  it("runs disposables registered by other front ends on teardown", async () => {
    const h = await harness();
    let stopped = 0;
    h.coordinator.services.onTeardown(() => {
      stopped += 1;
    });
    await h.run("teardown", "--confirm TEARDOWN");
    expect(stopped).toBe(1);
  });
});

describe("token budget command", () => {
  it("reports the spend and raises the cap", async () => {
    const h = await harness({ options: { tokenBudget: 1000 } });
    expect(await h.run("budget", "")).toMatch(/0 of 1000/);
    await h.run("project", "new demo --pack two-pack -- Build it");
    expect(await h.run("budget", "raise 500")).toMatch(/1500/);
    await expect(h.run("budget", "raise zero")).rejects.toThrow(/usage|positive/i);
  });

  it("explains that no cap is configured", async () => {
    const h = await harness();
    expect(await h.run("budget", "")).toMatch(/no token budget/i);
    await expect(h.run("budget", "raise 10")).rejects.toThrow(/no token budget/i);
  });
});

describe("swarm_gate_run", () => {
  it("runs one named gate for a role and returns the structured report", async () => {
    const gates = new ScriptedGates().script("coder", "coverage", {
      passed: false,
      findings: ["Coverage 40% is below 80%"],
    });
    const h = await harness({ gates });
    await h.run("project", "new demo --pack two-pack -- Build it");
    const failing = await h.tool("swarm_gate_run", {
      project: "demo",
      role: "coder",
      gate: "coverage",
    });
    expect(failing.isError).toBeUndefined();
    expect(textOf(failing)).toMatch(/coverage: failed/);
    expect(textOf(failing)).toContain("Coverage 40% is below 80%");
    const passing = await h.tool("swarm_gate_run", {
      project: "demo",
      role: "coder",
      gate: "coverage",
    });
    expect(textOf(passing)).toMatch(/coverage: passed/);
    expect(gates.calls[0]).toMatchObject({ project: "demo", role: "coder", toolchain: "node-ts" });
  });

  it("validates its input and needs configured gates", async () => {
    const gates = new ScriptedGates();
    const h = await harness({ gates });
    await h.run("project", "new demo --pack two-pack -- Build it");
    expect(
      (await h.tool("swarm_gate_run", { project: "demo", role: "coder", gate: "magic" })).isError,
    ).toBe(true);
    expect(
      (await h.tool("swarm_gate_run", { project: "demo", role: "../x", gate: "coverage" })).isError,
    ).toBe(true);
    expect(
      (await h.tool("swarm_gate_run", { project: "demo", role: "ghost", gate: "coverage" }))
        .isError,
    ).toBe(true);
    expect(
      (await h.tool("swarm_gate_run", { project: "ghost", role: "coder", gate: "coverage" }))
        .isError,
    ).toBe(true);
    expect((await h.tool("swarm_gate_run", { project: "demo" })).isError).toBe(true);
    const bare = await harness();
    await bare.run("project", "new demo --pack two-pack -- Build it");
    const result = await bare.tool("swarm_gate_run", {
      project: "demo",
      role: "coder",
      gate: "coverage",
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/gates/i);
  });
});

describe("the real child-session runner behind the plugin", () => {
  function fakeSessionsApi() {
    const specs = new Map<string, ChildSessionSpec>();
    const cancelled: string[] = [];
    const prompts: string[] = [];
    let count = 0;
    let calls = 0;
    const sessions = {
      async create(spec: ChildSessionSpec) {
        count += 1;
        specs.set(`c${count}`, spec);
        return { id: `c${count}` } as ChildSessionInfo;
      },
      async run(id: string, prompt: string): Promise<ChildRunResult> {
        calls += 1;
        prompts.push(prompt);
        const spec = specs.get(id) as ChildSessionSpec;
        const dir = spec.workspace as string;
        const text =
          spec.agent === "swarm-lieutenant"
            ? "Plain reply"
            : /^Audit/m.test(prompt)
              ? handoffEnvelope(head(dir))
              : handoffEnvelope(await commitFile(dir, `${spec.agent}.txt`, "x\n"));
        return { id, status: "completed", text, usage: { input: 1, output: 1 } };
      },
      cancel(id: string) {
        cancelled.push(id);
        return 1;
      },
    };
    return { sessions, specs, cancelled, prompts, calls: () => calls };
  }

  it("runs a task end to end through child sessions and cancels them on dispose", async () => {
    const fake = fakeSessionsApi();
    const h = await harness({ withRunner: false, sessions: fake.sessions });
    await h.run("project", "new demo --pack two-pack -- Build it");
    await h.run("task", "demo new -- Add login");
    await h.run("run", "demo --seconds 30");
    expect(h.runtime()?.board().tasks[0]).toMatchObject({ lane: "done", status: "done" });
    const specs = [...fake.specs.values()];
    expect(specs.map((s) => s.agent).sort()).toEqual(["swarm-cleaner", "swarm-coder"]);
    expect(specs.every((s) => s.parentId === "parent")).toBe(true);
    expect(specs.find((s) => s.agent === "swarm-cleaner")?.workspace).toMatch(
      /\.worktrees\/cleaner$/,
    );
    await h.coordinator.dispose();
    expect(fake.cancelled.sort()).toEqual(["c1", "c2"]);
  });

  it("chats through a read-only Lieutenant child session", async () => {
    const fake = fakeSessionsApi();
    const h = await harness({ withRunner: false, sessions: fake.sessions });
    await h.run("project", "new demo --pack two-pack -- Build it");
    expect(await h.run("chat", "demo -- Status?")).toContain("Plain reply");
    const spec = [...fake.specs.values()][0];
    expect(spec).toMatchObject({ agent: "swarm-lieutenant", readOnly: true });
  });

  it("never touches the sessions API during setup", async () => {
    const boom = () => {
      throw new Error("sessions used in setup");
    };
    await expect(
      harness({
        withRunner: false,
        sessions: { create: boom, run: boom, cancel: boom, spawn: boom },
      }),
    ).resolves.toBeDefined();
  });

  it("uses the model configured for a role", async () => {
    const fake = fakeSessionsApi();
    const h = await harness({
      withRunner: false,
      sessions: fake.sessions,
      options: { roles: { lieutenant: { model: "provider/model-x" } } },
    });
    await h.run("project", "new demo --pack two-pack -- Build it");
    await h.run("chat", "demo -- Hi");
    expect([...fake.specs.values()][0]?.model).toBe("provider/model-x");
  });
});

describe("services facade", () => {
  it("exposes the same operations to other front ends and lists attention across projects", async () => {
    const h = await atApproval();
    const services = h.coordinator.services;
    const items = await services.attention(h.workspace);
    expect(items).toMatchObject([{ kind: "approval", project: "demo", task: "needs-sign-off" }]);
    h.runner.script("cleaner", work("clean.ts"), repeat);
    await services.approve(h.workspace, "demo", "needs-sign-off");
    await h.runtime()?.drain();
    expect(h.runtime()?.board().tasks[0]?.status).toBe("done");
    expect(await services.attention(h.workspace)).toEqual([]);
  });
});
