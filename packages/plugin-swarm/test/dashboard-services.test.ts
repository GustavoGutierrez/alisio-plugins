import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitWorktreeIsolation } from "../src/adapters/git-worktree.js";
import { SwarmServices } from "../src/app/services.js";
import type { RunnerView } from "../src/ports/agent-runner.js";
import {
  clarificationEnvelope,
  commitFile,
  gitIn,
  handoffEnvelope,
  ScriptedGates,
  ScriptedRunner,
  tempDir,
} from "./helpers.js";

class ViewRunner extends ScriptedRunner {
  readonly views = new Map<string, RunnerView>();
  inspect(key: string): RunnerView | undefined {
    return this.views.get(key);
  }
}

const role = (id: string, isolation = "worktree") => ({
  id,
  agent: `swarm-${id}`,
  isolation,
  receive: "task",
  propagation: "forward-only",
});

async function setup() {
  const workspace = await tempDir();
  const runner = new ViewRunner();
  const services = new SwarmServices({
    isolation: new GitWorktreeIsolation(),
    runner,
    autoStart: false,
  });
  const forge = services.forgeFor(workspace);
  await forge.init();
  const packs = join(workspace, ".alisio", "swarm", "packs");
  await mkdir(packs, { recursive: true });
  await writeFile(
    join(packs, "gated.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "gated",
      description: "Gate after the coder",
      toolchain: "node-ts",
      approval: { after: "coder" },
      roles: [role("coder", "master"), role("cleaner")],
    }),
  );
  return { workspace, runner, services };
}

const head = (dir: string) => gitIn(dir, "rev-parse", "HEAD").slice(0, 10);

async function atApproval() {
  const ctx = await setup();
  const runtime = await ctx.services.newProject(ctx.workspace, {
    name: "demo",
    pack: "gated",
    mission: "Build a login",
  });
  const base = head(runtime.dir);
  await mkdir(join(runtime.dir, "specs"), { recursive: true });
  ctx.runner.script(
    "coder",
    async (request) => {
      await mkdir(join(request.workdir, "specs"), { recursive: true });
      return handoffEnvelope(
        await commitFile(request.workdir, "specs/login.feature", "Feature: login\n"),
      );
    },
    (request) => handoffEnvelope(head(request.workdir)),
  );
  await ctx.services.createTask(ctx.workspace, "demo", "Specify login");
  await runtime.drain();
  expect(runtime.board().tasks[0]?.status).toBe("waiting_approval");
  return { ...ctx, runtime, base };
}

describe("services.documents", () => {
  it("returns the task documents, the diff from the role base and per-document comments", async () => {
    const ctx = await atApproval();
    await ctx.services.addComment(
      ctx.workspace,
      "demo",
      "specify-login",
      "specs/login.feature",
      "Add an error case",
    );
    const view = await ctx.services.documents(ctx.workspace, "demo", "specify-login");
    expect(view.role).toBe("coder");
    expect(view.base).toBe(ctx.base);
    expect(view.commit).toBe(head(ctx.runtime.dir));
    const doc = view.docs.find((entry) => entry.path === "specs/login.feature");
    expect(doc?.text).toBe("Feature: login\n");
    expect(doc?.comments.map((comment) => comment.text)).toEqual(["Add an error case"]);
    expect(view.diff).toContain("+Feature: login");
    expect(view.approvable).toBe(false);
  });

  it("is approvable once there are no comments", async () => {
    const ctx = await atApproval();
    const view = await ctx.services.documents(ctx.workspace, "demo", "specify-login");
    expect(view.approvable).toBe(true);
    expect(view.comments).toEqual([]);
  });

  it("refuses tasks that are not waiting and hostile names", async () => {
    const ctx = await atApproval();
    await ctx.services.approve(ctx.workspace, "demo", "specify-login");
    await expect(ctx.services.documents(ctx.workspace, "demo", "specify-login")).rejects.toThrow(
      /not waiting for approval/i,
    );
    await expect(ctx.services.documents(ctx.workspace, "demo", "../x")).rejects.toThrow(
      /task name/i,
    );
    await expect(ctx.services.documents(ctx.workspace, "nope", "x")).rejects.toThrow(
      /unknown project/i,
    );
  });

  it("truncates oversized documents instead of failing", async () => {
    const ctx = await setup();
    const runtime = await ctx.services.newProject(ctx.workspace, {
      name: "demo",
      pack: "gated",
      mission: "m",
    });
    ctx.runner.script(
      "coder",
      async (request) =>
        handoffEnvelope(await commitFile(request.workdir, "big.md", `${"a".repeat(200_000)}\n`)),
      (request) => handoffEnvelope(head(request.workdir)),
    );
    await ctx.services.createTask(ctx.workspace, "demo", "Big doc");
    await runtime.drain();
    const view = await ctx.services.documents(ctx.workspace, "demo", "big-doc");
    const doc = view.docs.find((entry) => entry.path === "big.md");
    expect(doc?.truncated).toBe(true);
    expect(doc?.text.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("services.agentTail", () => {
  it("returns the session id and transcript tail of a role", async () => {
    const ctx = await setup();
    await ctx.services.newProject(ctx.workspace, { name: "demo", pack: "gated", mission: "m" });
    ctx.runner.views.set("demo/coder", {
      sessionId: "child-9",
      live: true,
      recentRuns: 2,
      tail: [{ at: "2026-01-02T03:04:05.000Z", kind: "reply", text: "done" }],
    });
    const tail = await ctx.services.agentTail(ctx.workspace, "demo", "coder");
    expect(tail).toMatchObject({ role: "coder", sessionId: "child-9", state: "live" });
    expect(tail.tail[0]?.text).toBe("done");
  });

  it("reports an idle role without a conversation and rejects unknown roles", async () => {
    const ctx = await setup();
    await ctx.services.newProject(ctx.workspace, { name: "demo", pack: "gated", mission: "m" });
    expect(await ctx.services.agentTail(ctx.workspace, "demo", "cleaner")).toMatchObject({
      state: "none",
      tail: [],
    });
    await expect(ctx.services.agentTail(ctx.workspace, "demo", "ghost")).rejects.toThrow(
      /unknown role/i,
    );
    await expect(ctx.services.agentTail(ctx.workspace, "demo", "../x")).rejects.toThrow(/role/i);
  });
});

describe("Lieutenant chat history", () => {
  it("persists the operator message and the reply", async () => {
    const ctx = await setup();
    await ctx.services.newProject(ctx.workspace, { name: "demo", pack: "gated", mission: "m" });
    ctx.runner.script("lieutenant", "All quiet.");
    expect(await ctx.services.chat(ctx.workspace, "demo", "status?")).toBe("All quiet.");
    const history = await ctx.services.chatHistory(ctx.workspace, "demo");
    expect(history.map((entry) => `${entry.from}:${entry.text}`)).toEqual([
      "operator:status?",
      "lieutenant:All quiet.",
    ]);
  });

  it("does not record a conversation that failed", async () => {
    const ctx = await setup();
    await ctx.services.newProject(ctx.workspace, { name: "demo", pack: "gated", mission: "m" });
    await expect(ctx.services.chat(ctx.workspace, "demo", "hello")).rejects.toThrow(
      /could not answer/i,
    );
    expect(await ctx.services.chatHistory(ctx.workspace, "demo")).toEqual([]);
  });
});

describe("services.mission and project control", () => {
  it("reads the mission of open and closed projects and closes and reopens", async () => {
    const ctx = await setup();
    await ctx.services.newProject(ctx.workspace, {
      name: "demo",
      pack: "gated",
      mission: "Ship it",
    });
    expect(await ctx.services.mission(ctx.workspace, "demo")).toBe("Ship it\n");
    await ctx.services.closeProject(ctx.workspace, "demo");
    expect(await ctx.services.mission(ctx.workspace, "demo")).toBe("Ship it\n");
    await ctx.services.openProject(ctx.workspace, "demo");
    expect(await ctx.services.openProjects(ctx.workspace)).toEqual(["demo"]);
    await expect(ctx.services.mission(ctx.workspace, "ghost")).rejects.toThrow(/unknown project/i);
  });

  it("accepts an edited pack definition for a new project and validates it", async () => {
    const ctx = await setup();
    const runtime = await ctx.services.newProject(ctx.workspace, {
      name: "custom",
      mission: "m",
      packDefinition: {
        schemaVersion: 1,
        name: "mine",
        description: "Edited",
        toolchain: "node-ts",
        roles: [role("coder", "master")],
      },
    });
    expect(runtime.pack.name).toBe("mine");
    await expect(
      ctx.services.newProject(ctx.workspace, {
        name: "bad",
        mission: "m",
        packDefinition: { schemaVersion: 1, name: "x", roles: [] },
      }),
    ).rejects.toThrow();
  });
});

describe("services.state", () => {
  it("is not initialised before init", async () => {
    const workspace = await tempDir();
    const services = new SwarmServices({
      isolation: new GitWorktreeIsolation(),
      runner: new ViewRunner(),
      autoStart: false,
    });
    const state = await services.state(workspace);
    expect(state).toMatchObject({
      schemaVersion: 1,
      initialised: false,
      projects: [],
      attention: [],
    });
  });

  it("describes projects, columns, cards, the work queue and attention", async () => {
    const ctx = await atApproval();
    ctx.runner.views.set("demo/coder", {
      sessionId: "child-1",
      live: false,
      recentRuns: 9,
      tail: [],
    });
    const state = await ctx.services.state(ctx.workspace);
    expect(state.initialised).toBe(true);
    expect(state.packs.map((pack) => pack.name)).toEqual(
      expect.arrayContaining(["two-pack", "four-pack", "six-pack", "gated"]),
    );
    const project = state.projects[0];
    expect(project).toMatchObject({
      name: "demo",
      pack: "gated",
      running: true,
      roles: ["coder", "cleaner"],
      columns: ["coder", "cleaner", "done"],
      approvalAfter: "coder",
    });
    expect(project?.tasks[0]).toMatchObject({
      name: "specify-login",
      status: "waiting_approval",
      lane: "coder",
      merging: false,
    });
    expect(project?.tasks[0]?.snippet).toMatch(/approval/i);
    expect(project?.queue).toEqual([
      expect.objectContaining({ role: "coder", task: "specify-login", state: "idle", activity: 6 }),
      expect.objectContaining({ role: "cleaner", state: "none", activity: 0 }),
    ]);
    expect(state.attention).toEqual([
      expect.objectContaining({ kind: "approval", project: "demo", task: "specify-login" }),
    ]);
    expect(JSON.stringify(state)).not.toContain(ctx.workspace);
  });

  it("marks a role live from the pump and shows the clarification question in the card", async () => {
    const ctx = await setup();
    const runtime = await ctx.services.newProject(ctx.workspace, {
      name: "demo",
      pack: "gated",
      mission: "m",
    });
    ctx.runner.script("coder", clarificationEnvelope("Which database?"));
    await ctx.services.createTask(ctx.workspace, "demo", "Pick storage");
    await runtime.drain();
    const state = await ctx.services.state(ctx.workspace);
    const card = state.projects[0]?.tasks[0];
    expect(card?.status).toBe("clarifying");
    expect(card?.snippet).toContain("Which database?");
    expect(state.attention[0]).toMatchObject({ kind: "clarification" });
  });

  it("includes closed projects as not running", async () => {
    const ctx = await setup();
    await ctx.services.newProject(ctx.workspace, { name: "demo", pack: "gated", mission: "m" });
    await ctx.services.closeProject(ctx.workspace, "demo");
    const state = await ctx.services.state(ctx.workspace);
    expect(state.projects[0]).toMatchObject({ name: "demo", running: false, open: false });
  });
});

describe("services.state activity log", () => {
  it("records handoffs, merges, gate results and bounces newest last", async () => {
    const workspace = await tempDir();
    const runner = new ViewRunner();
    const gates = new ScriptedGates().script("coder", "tests-green", false, true);
    const services = new SwarmServices({
      isolation: new GitWorktreeIsolation(),
      runner,
      gates,
      autoStart: false,
    });
    await services.forgeFor(workspace).init();
    await mkdir(join(workspace, ".alisio", "swarm", "packs"), { recursive: true });
    await writeFile(
      join(workspace, ".alisio", "swarm", "packs", "gated2.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "gated2",
        description: "Gate on the coder",
        toolchain: "node-ts",
        gates: { coder: ["tests-green"] },
        roles: [role("coder", "master"), role("cleaner")],
      }),
    );
    const runtime = await services.newProject(workspace, {
      name: "demo",
      pack: "gated2",
      mission: "m",
    });
    const same = (request: { workdir: string }) => handoffEnvelope(head(request.workdir));
    runner.script(
      "coder",
      async (request) => handoffEnvelope(await commitFile(request.workdir, "a.ts", "a\n")),
      same,
      same,
      same,
    );
    runner.script("cleaner", async (request) =>
      handoffEnvelope(await commitFile(request.workdir, "b.ts", "b\n")),
    );
    runner.script("cleaner", same);
    await services.createTask(workspace, "demo", "Do it");
    await runtime.drain();
    const { activity } = await services.state(workspace);
    const kinds = activity.map((entry) => entry.kind);
    expect(kinds).toEqual(expect.arrayContaining(["handoff", "gate", "bounce", "merge"]));
    expect(activity.find((entry) => entry.kind === "bounce")).toMatchObject({
      project: "demo",
      role: "coder",
      task: "do-it",
    });
    const times = activity.map((entry) => entry.at);
    expect([...times].sort()).toEqual(times);
    expect(JSON.stringify(activity)).not.toContain(workspace);
  });

  it("is empty before anything happened", async () => {
    const ctx = await setup();
    expect((await ctx.services.state(ctx.workspace)).activity).toEqual([]);
  });
});

describe("runner label", () => {
  it("names Alisio as the runner in the state and the agent tail", async () => {
    const ctx = await setup();
    await ctx.services.newProject(ctx.workspace, { name: "demo", pack: "gated", mission: "m" });
    expect((await ctx.services.state(ctx.workspace)).runner).toBe("Alisio");
    expect((await ctx.services.agentTail(ctx.workspace, "demo", "coder")).runner).toBe("Alisio");
    const empty = new SwarmServices({
      isolation: new GitWorktreeIsolation(),
      runner: new ViewRunner(),
    });
    expect((await empty.state(await tempDir())).runner).toBe("Alisio");
  });
});
