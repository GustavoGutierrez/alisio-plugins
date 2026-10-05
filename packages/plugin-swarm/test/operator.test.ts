import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsHandoffStore } from "../src/adapters/fs-handoff-store.js";
import { GitWorktreeIsolation } from "../src/adapters/git-worktree.js";
import { Forge } from "../src/app/forge.js";
import { systemClock } from "../src/ports/clock.js";
import type { SwarmEvent } from "../src/ports/notifier.js";
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
const repeat = (request: { workdir: string }) => handoffEnvelope(head(request.workdir));
const work = (file: string) => async (request: { workdir: string }) =>
  handoffEnvelope(await commitFile(request.workdir, file, `${file}\n`));

const role = (id: string, isolation = "worktree", extra: Record<string, unknown> = {}) => ({
  id,
  agent: `swarm-${id}`,
  isolation,
  receive: "task",
  propagation: "forward-only",
  ...extra,
});

async function writeLocalPack(workspace: string, pack: Record<string, unknown>) {
  const dir = join(workspace, ".alisio", "swarm", "packs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${pack.name}.json`), JSON.stringify(pack));
}

interface SetupOptions {
  workspace?: string;
  gates?: ScriptedGates;
  tokenBudget?: number;
}

async function setup(options: SetupOptions = {}) {
  const workspace = options.workspace ?? (await tempDir());
  const runner = new ScriptedRunner();
  const events: SwarmEvent[] = [];
  const forge = new Forge({
    workspace,
    isolation: new GitWorktreeIsolation(),
    runner,
    autoStart: false,
    notifier: { notify: (event) => events.push(event) },
    ...(options.gates ? { gates: options.gates } : {}),
    ...(options.tokenBudget !== undefined ? { tokenBudget: options.tokenBudget } : {}),
  });
  await forge.init();
  return { workspace, runner, events, forge };
}

async function gated(options: SetupOptions = {}) {
  const ctx = await setup(options);
  await writeLocalPack(ctx.workspace, {
    schemaVersion: 1,
    name: "gated",
    description: "Gate after the coder",
    toolchain: "node-ts",
    approval: { after: "coder" },
    roles: [role("coder", "master"), role("cleaner")],
  });
  const runtime = await ctx.forge.newProject({ name: "demo", pack: "gated", mission: "m" });
  return { ...ctx, runtime };
}

async function twoPack(options: SetupOptions = {}) {
  const ctx = await setup(options);
  const runtime = await ctx.forge.newProject({ name: "demo", pack: "two-pack", mission: "m" });
  return { ...ctx, runtime };
}

const stateOf = (dir: string) => new FsHandoffStore(dir, systemClock);

/** Take a gated task to the approval gate. */
async function atApproval(options: SetupOptions = {}) {
  const ctx = await gated(options);
  const base = head(ctx.runtime.dir);
  ctx.runner.script("coder", work("spec.md"), repeat);
  await ctx.runtime.newTask("Needs sign-off");
  await ctx.runtime.drain();
  expect(ctx.runtime.board().tasks[0]?.status).toBe("waiting_approval");
  return { ...ctx, base };
}

describe("approve", () => {
  it("releases the held handoff and the pipeline continues", async () => {
    const ctx = await atApproval();
    ctx.runner.script("cleaner", work("clean.ts"), repeat);
    await ctx.runtime.approve("needs-sign-off");
    expect(ctx.runtime.board().tasks[0]).toMatchObject({ lane: "cleaner", status: "queued" });
    await ctx.runtime.drain();
    expect(ctx.runtime.board().tasks[0]).toMatchObject({ lane: "done", status: "done" });
    const { records } = await stateOf(ctx.runtime.dir).scan();
    const copy = records.find((r) => r.location.kind === "inbox" && r.location.role === "cleaner");
    expect(copy?.handoff.approved).toBe(true);
  });

  it("is refused while per-document comments exist and works once they are cleared", async () => {
    const ctx = await atApproval();
    ctx.runner.script("cleaner", work("clean.ts"), repeat);
    await ctx.runtime.addComment("needs-sign-off", "specs/login.feature", "Add an error example");
    await expect(ctx.runtime.approve("needs-sign-off")).rejects.toThrow(/comment/i);
    expect(ctx.runtime.attention()[0]?.actions).not.toContain("approve");
    expect(ctx.runtime.comments("needs-sign-off")).toHaveLength(1);
    await ctx.runtime.clearComments("needs-sign-off");
    await ctx.runtime.approve("needs-sign-off");
    await ctx.runtime.drain();
    expect(ctx.runtime.board().tasks[0]?.status).toBe("done");
  });

  it("rejects hostile comment paths", async () => {
    const ctx = await atApproval();
    await expect(ctx.runtime.addComment("needs-sign-off", "../secret", "x")).rejects.toThrow(
      /path/i,
    );
    await expect(ctx.runtime.addComment("needs-sign-off", "a.md", "   ")).rejects.toThrow(
      /comment/i,
    );
  });

  it("refuses unknown tasks and tasks that are not waiting", async () => {
    const ctx = await twoPack();
    await ctx.runtime.newTask("Add login");
    await expect(ctx.runtime.approve("ghost")).rejects.toThrow(/unknown task/i);
    await expect(ctx.runtime.approve("add-login")).rejects.toThrow(/not waiting for approval/i);
  });
});

describe("reject", () => {
  it("accept unchanged behaves like approve", async () => {
    const ctx = await atApproval();
    ctx.runner.script("cleaner", work("clean.ts"), repeat);
    await ctx.runtime.reject("needs-sign-off", "accept");
    await ctx.runtime.drain();
    expect(ctx.runtime.board().tasks[0]?.status).toBe("done");
  });

  it("retry snapshots the rejected commit, restores the base and re-runs with the findings", async () => {
    const ctx = await atApproval();
    const rejected = head(ctx.runtime.dir);
    ctx.runner.script("coder", work("spec2.md"), repeat);
    await ctx.runtime.addComment("needs-sign-off", "specs/login.feature", "Cover the lockout");
    await ctx.runtime.reject("needs-sign-off", "retry", "Missing error cases");

    expect(
      gitIn(ctx.runtime.dir, "rev-parse", "refs/swarm/rejected/needs-sign-off").slice(0, 10),
    ).toBe(rejected);
    expect(head(ctx.runtime.dir)).toBe(ctx.base);
    expect(existsSync(join(ctx.runtime.dir, "spec.md"))).toBe(false);
    expect(ctx.runtime.board().tasks[0]).toMatchObject({
      lane: "coder",
      status: "queued",
      auditCount: 2,
    });
    expect(ctx.runtime.comments("needs-sign-off")).toEqual([]);

    await ctx.runtime.drain();
    const retryPrompt = ctx.runner.callsFor("coder")[2]?.prompt ?? "";
    expect(retryPrompt).toContain("Needs sign-off");
    expect(retryPrompt).toContain("Missing error cases");
    expect(retryPrompt).toContain("Cover the lockout");
    expect(ctx.runtime.board().tasks[0]?.status).toBe("waiting_approval");
  });

  it("delete archives the card and removes its handoffs and state", async () => {
    const ctx = await atApproval();
    const taskId = ctx.runtime.board().tasks[0]?.taskId as string;
    await ctx.runtime.reject("needs-sign-off", "delete");
    expect(ctx.runtime.board().tasks).toEqual([]);
    expect(ctx.runtime.attention()).toEqual([]);
    const { records } = await stateOf(ctx.runtime.dir).scan();
    expect(records.filter((r) => r.handoff.taskId === taskId)).toEqual([]);
    expect(existsSync(join(ctx.runtime.dir, ".alisio", "swarm", "archive", `${taskId}.json`))).toBe(
      true,
    );
    expect(existsSync(join(ctx.runtime.dir, ".alisio", "swarm", "state", `${taskId}.json`))).toBe(
      false,
    );
  });
});

describe("retry and delete of blocked tasks", () => {
  it("retry re-runs a blocked role with a fresh output allowance", async () => {
    const ctx = await twoPack();
    ctx.runner.script("coder", "nope", "still nope", work("a.ts"), repeat);
    ctx.runner.script("cleaner", work("b.ts"), repeat);
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();
    expect(ctx.runtime.board().tasks[0]?.status).toBe("blocked");
    await ctx.runtime.retryTask("add-login");
    expect(ctx.runtime.board().tasks[0]?.status).toBe("queued");
    await ctx.runtime.drain();
    expect(ctx.runtime.board().tasks[0]?.status).toBe("done");
  });

  it("refuses to retry a task that is not stuck", async () => {
    const ctx = await twoPack();
    await ctx.runtime.newTask("Add login");
    await expect(ctx.runtime.retryTask("add-login")).rejects.toThrow(/nothing to retry/i);
  });

  it("refuses to delete a task that is running", async () => {
    const ctx = await twoPack();
    let refused: unknown;
    ctx.runner.script(
      "coder",
      async (request) => {
        refused = await ctx.runtime.deleteTask("add-login").catch((error) => error);
        return handoffEnvelope(await commitFile(request.workdir, "a.ts", "a\n"));
      },
      repeat,
    );
    ctx.runner.script("cleaner", work("b.ts"), repeat);
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();
    expect(String(refused)).toMatch(/running/i);
    expect(ctx.runtime.board().tasks[0]?.status).toBe("done");
  });

  it("deletes a blocked task and clears its hold", async () => {
    const ctx = await twoPack();
    ctx.runner.script("coder", "nope", "still nope");
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();
    await ctx.runtime.deleteTask("add-login");
    expect(ctx.runtime.board().tasks).toEqual([]);
    expect(await ctx.runtime.drain()).toBeUndefined();
  });
});

describe("holds survive a restart", () => {
  it("keeps a clarification and resumes it with the answer in a fresh session", async () => {
    const first = await twoPack();
    first.runner.script("coder", clarificationEnvelope("Which login method?"));
    await first.runtime.newTask("Add login");
    await first.runtime.drain();

    const second = await setup({ workspace: first.workspace });
    const reopened = await second.forge.openProject("demo");
    expect(reopened.board().tasks[0]?.status).toBe("clarifying");
    expect(reopened.attention()).toMatchObject([
      { kind: "clarification", task: "add-login", detail: "Which login method?" },
    ]);
    // A held role does not run on its own after the restart.
    second.runner.script("coder", work("login.ts"), repeat);
    second.runner.script("cleaner", work("clean.ts"), repeat);
    await reopened.drain();
    expect(second.runner.callsFor("coder")).toHaveLength(0);

    await reopened.answer("add-login", "Use email sign-in");
    await reopened.drain();
    const prompt = second.runner.callsFor("coder")[0]?.prompt ?? "";
    expect(prompt).toContain("Use email sign-in");
    expect(prompt).toContain("Which login method?");
    expect(reopened.board().tasks[0]?.status).toBe("done");
  });

  it("keeps an agent-reported block, while a runtime failure is retried on restart", async () => {
    const first = await twoPack();
    first.runner.script("coder", blockedEnvelope("The test database is missing"));
    await first.runtime.newTask("Needs a database");
    await first.runtime.drain();
    const second = await setup({ workspace: first.workspace });
    const reopened = await second.forge.openProject("demo");
    expect(reopened.board().tasks[0]?.status).toBe("blocked");
    expect(reopened.attention()[0]).toMatchObject({
      kind: "blocked",
      detail: "The test database is missing",
    });
    second.runner.script("coder", work("db.ts"), repeat);
    second.runner.script("cleaner", work("c.ts"), repeat);
    await reopened.retryTask("needs-a-database");
    await reopened.drain();
    expect(reopened.board().tasks[0]?.status).toBe("done");
  });

  it("keeps the approval gate and its comments", async () => {
    const first = await atApproval();
    await first.runtime.addComment("needs-sign-off", "specs/login.feature", "Cover the lockout");
    const second = await setup({ workspace: first.workspace });
    const reopened = await second.forge.openProject("demo");
    expect(reopened.board().tasks[0]?.status).toBe("waiting_approval");
    expect(reopened.comments("needs-sign-off")).toHaveLength(1);
    expect(reopened.attention()[0]?.actions).not.toContain("approve");
  });
});

describe("quality gates and bounces", () => {
  it("bounces a failing gate to the same role with the report, then continues", async () => {
    const gates = new ScriptedGates().script("coder", "tests-green", {
      passed: false,
      findings: ["1 test failing: login"],
    });
    const ctx = await twoPack({ gates });
    const base = head(ctx.runtime.dir);
    ctx.runner.script("coder", work("a.ts"), repeat, work("b.ts"), repeat);
    ctx.runner.script("cleaner", work("c.ts"), repeat);
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();

    const bounce = ctx.runner.callsFor("coder")[2]?.prompt ?? "";
    expect(bounce).toContain("1 test failing: login");
    expect(bounce).toContain("tests-green");
    expect(gates.callsFor("coder", "tests-green")).toHaveLength(2);
    // Gates stop at the first failure, so the later coder gates only ran once the first passed.
    expect(gates.callsFor("coder", "test-first")).toHaveLength(1);
    expect(ctx.runtime.board().tasks[0]?.status).toBe("done");

    const request = gates.callsFor("coder", "tests-green")[0];
    expect(request).toMatchObject({
      project: "demo",
      task: "add-login",
      role: "coder",
      toolchain: "node-ts",
      workdir: ctx.runtime.dir,
      since: base,
    });
    expect(request?.thresholds).toEqual({ coverage: 80, complexity: 6, crap: 8, mutation: 80 });
  });

  it("blocks after maxBounces with a gate-failed decision and lets the operator accept", async () => {
    const failing = { passed: false, findings: ["coverage 40% is below 80%"] };
    const gates = new ScriptedGates().script("coder", "tests-green", failing, failing, failing);
    const ctx = await twoPack({ gates });
    ctx.runner.script("coder", work("a.ts"), repeat, work("b.ts"), repeat, work("c.ts"), repeat);
    ctx.runner.script("cleaner", work("d.ts"), repeat);
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();

    expect(ctx.runtime.board().tasks[0]).toMatchObject({ lane: "coder", status: "blocked" });
    expect(ctx.runtime.attention()).toMatchObject([
      { kind: "gate-failed", detail: expect.stringContaining("coverage 40%") },
    ]);
    expect(ctx.runner.callsFor("cleaner")).toHaveLength(0);

    await ctx.runtime.acceptTask("add-login");
    await ctx.runtime.drain();
    expect(ctx.runtime.board().tasks[0]?.status).toBe("done");
  });

  it("restores the bounce allowance when the operator retries", async () => {
    const failing = { passed: false, findings: ["nope"] };
    const gates = new ScriptedGates().script("coder", "tests-green", failing, failing, failing);
    const ctx = await twoPack({ gates });
    ctx.runner.script("coder", work("a.ts"), repeat, work("b.ts"), repeat, work("c.ts"), repeat);
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();
    expect(ctx.runtime.board().tasks[0]?.status).toBe("blocked");
    ctx.runner.script("coder", work("d.ts"), repeat);
    ctx.runner.script("cleaner", work("e.ts"), repeat);
    await ctx.runtime.retryTask("add-login");
    await ctx.runtime.drain();
    expect(ctx.runtime.board().tasks[0]?.status).toBe("done");
  });

  it("holds immediately, without bouncing, when a gate cannot run at all", async () => {
    const gates = new ScriptedGates().script("coder", "tests-green", {
      passed: false,
      error: "npx could not start: ENOENT",
      findings: ["npx could not start: ENOENT"],
    });
    const ctx = await twoPack({ gates });
    ctx.runner.script("coder", work("a.ts"), repeat);
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();
    expect(ctx.runner.callsFor("coder")).toHaveLength(2);
    expect(ctx.runtime.attention()).toMatchObject([
      { kind: "gate-failed", detail: expect.stringContaining("ENOENT") },
    ]);
  });

  it("runs no gates when none are configured and passes skipped gates", async () => {
    const plain = await twoPack();
    plain.runner.script("coder", work("a.ts"), repeat);
    plain.runner.script("cleaner", work("b.ts"), repeat);
    await plain.runtime.newTask("Add login");
    await plain.runtime.drain();
    expect(plain.runtime.board().tasks[0]?.status).toBe("done");
    const gates = new ScriptedGates().script("coder", "tests-green", {
      passed: true,
      skipped: "nothing to check",
    });
    const skipped = await twoPack({ gates });
    skipped.runner.script("coder", work("a.ts"), repeat);
    skipped.runner.script("cleaner", work("b.ts"), repeat);
    await skipped.runtime.newTask("Add login");
    await skipped.runtime.drain();
    expect(skipped.runtime.board().tasks[0]?.status).toBe("done");
  });
});

describe("QA rejection routing", () => {
  async function qaProject(
    extra: Record<string, unknown> = {},
    qaExtra: Record<string, unknown> = {},
  ) {
    const ctx = await setup();
    await writeLocalPack(ctx.workspace, {
      schemaVersion: 1,
      name: "qa-pack",
      description: "coder, cleaner, qa",
      toolchain: "node-ts",
      roles: [role("coder", "master"), role("cleaner"), role("qa", "worktree", qaExtra)],
      ...extra,
    });
    const runtime = await ctx.forge.newProject({ name: "demo", pack: "qa-pack", mission: "m" });
    return { ...ctx, runtime };
  }

  it("routes QA findings back to the coder, then the pipeline runs again", async () => {
    const ctx = await qaProject();
    ctx.runner.script("coder", work("a.ts"), repeat, work("fix.ts"), repeat);
    ctx.runner.script("cleaner", work("c.ts"), repeat, work("c2.ts"), repeat);
    ctx.runner.script("qa", blockedEnvelope("Requirement 3 has no proof"), repeat, repeat);
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();
    const fixPrompt = ctx.runner.callsFor("coder")[2]?.prompt ?? "";
    expect(fixPrompt).toContain("Requirement 3 has no proof");
    expect(ctx.runner.callsFor("qa")).toHaveLength(3);
    expect(ctx.runtime.board().tasks[0]).toMatchObject({ lane: "done", status: "done" });
  });

  it("honours rejectTo and a route hint naming an earlier role", async () => {
    const ctx = await qaProject({}, { rejectTo: "cleaner" });
    ctx.runner.script("coder", work("a.ts"), repeat);
    ctx.runner.script("cleaner", work("c.ts"), repeat, work("c2.ts"), repeat);
    ctx.runner.script("qa", blockedEnvelope("Missing proof"), repeat, repeat);
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();
    expect(ctx.runner.callsFor("coder")).toHaveLength(2);
    expect(ctx.runner.callsFor("cleaner")[2]?.prompt).toContain("Missing proof");

    const hinted = await qaProject();
    hinted.runner.script("coder", work("a.ts"), repeat);
    hinted.runner.script("cleaner", work("c.ts"), repeat, work("c2.ts"), repeat);
    hinted.runner.script("qa", blockedEnvelope("route: cleaner\nDuplicated code"), repeat, repeat);
    await hinted.runtime.newTask("Add login");
    await hinted.runtime.drain();
    expect(hinted.runner.callsFor("coder")).toHaveLength(2);
    expect(hinted.runner.callsFor("cleaner")[2]?.prompt).toContain("Duplicated code");
  });

  it("blocks for a decision after maxBounces rejections", async () => {
    const ctx = await qaProject();
    ctx.runner.script("coder", work("a.ts"), repeat, work("f1.ts"), repeat, work("f2.ts"), repeat);
    ctx.runner.script(
      "cleaner",
      work("c.ts"),
      repeat,
      work("c1.ts"),
      repeat,
      work("c2.ts"),
      repeat,
    );
    ctx.runner.script(
      "qa",
      blockedEnvelope("no proof"),
      blockedEnvelope("still no proof"),
      blockedEnvelope("really no proof"),
    );
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();
    expect(ctx.runtime.board().tasks[0]).toMatchObject({ lane: "qa", status: "blocked" });
    expect(ctx.runtime.attention()[0]?.detail).toContain("really no proof");
  });
});

describe("parallel stage join", () => {
  async function parallelProject() {
    const ctx = await setup();
    await writeLocalPack(ctx.workspace, {
      schemaVersion: 1,
      name: "par",
      description: "architect and hardener in parallel",
      toolchain: "node-ts",
      roles: [role("coder", "master"), role("architect"), role("hardener"), role("qa")],
      parallel: [["architect", "hardener"]],
    });
    const runtime = await ctx.forge.newProject({ name: "demo", pack: "par", mission: "m" });
    return { ...ctx, runtime };
  }

  it("fans out to both stage roles and joins them into the next role in pack order", async () => {
    const ctx = await parallelProject();
    const order: string[] = [];
    let qaSaw: string[] = [];
    ctx.runner.script("coder", work("a.ts"), repeat);
    ctx.runner.script(
      "architect",
      async (request) => {
        const commit = await commitFile(request.workdir, "arch.ts", "arch\n");
        order.push("architect");
        return handoffEnvelope(commit);
      },
      repeat,
    );
    ctx.runner.script(
      "hardener",
      async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        const commit = await commitFile(request.workdir, "hard.ts", "hard\n");
        order.push("hardener");
        return handoffEnvelope(commit);
      },
      repeat,
    );
    ctx.runner.script(
      "qa",
      (request) => {
        qaSaw = [...order];
        expect(existsSync(join(request.workdir, "arch.ts"))).toBe(true);
        expect(existsSync(join(request.workdir, "hard.ts"))).toBe(true);
        return handoffEnvelope(head(request.workdir));
      },
      repeat,
    );
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();

    expect(qaSaw).toEqual(["architect", "hardener"]);
    expect(ctx.runner.callsFor("qa")).toHaveLength(2);
    expect(ctx.runner.callsFor("architect")).toHaveLength(2);
    expect(ctx.runner.callsFor("hardener")).toHaveLength(2);
    expect(ctx.runtime.board().tasks[0]).toMatchObject({ lane: "done", status: "done" });
  });

  it("does not start the next role while one stage role is still working", async () => {
    const ctx = await parallelProject();
    let qaCallsWhenArchitectDone = -1;
    ctx.runner.script("coder", work("a.ts"), repeat);
    ctx.runner.script(
      "architect",
      async (request) => handoffEnvelope(await commitFile(request.workdir, "arch.ts", "arch\n")),
      async (request) => {
        qaCallsWhenArchitectDone = ctx.runner.callsFor("qa").length;
        // Give the pump time to (wrongly) start qa before the hardener finishes.
        await new Promise((resolve) => setTimeout(resolve, 150));
        return repeat(request);
      },
    );
    ctx.runner.script(
      "hardener",
      async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return handoffEnvelope(await commitFile(request.workdir, "hard.ts", "hard\n"));
      },
      repeat,
    );
    ctx.runner.script("qa", repeat, repeat);
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();
    expect(qaCallsWhenArchitectDone).toBe(0);
    expect(ctx.runtime.board().tasks[0]?.status).toBe("done");
  });
});

describe("token budget", () => {
  const spend =
    (tokens: number, step: (request: { workdir: string }) => Promise<string> | string) =>
    async (request: { workdir: string }) => ({
      status: "completed" as const,
      text: await step(request),
      usage: { input: tokens / 2, output: tokens / 2 },
    });

  it("pauses the pump past the soft cap, raises a decision and resumes when raised", async () => {
    const ctx = await twoPack({ tokenBudget: 100 });
    ctx.runner.script("coder", spend(120, work("a.ts")), spend(0, repeat));
    ctx.runner.script("cleaner", work("b.ts"), repeat);
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();

    expect(ctx.runner.callsFor("cleaner")).toHaveLength(0);
    expect(ctx.forge.budget()).toMatchObject({ total: 120, limit: 100, exceeded: true });
    expect(ctx.runtime.attention()).toMatchObject([
      { id: "decision:demo:budget", kind: "decision", actions: ["raise", "stop"] },
    ]);
    expect(ctx.events.some((e) => e.type === "attention" && e.item.kind === "decision")).toBe(true);

    await ctx.forge.raiseBudget(1000);
    await ctx.runtime.drain();
    expect(ctx.runtime.board().tasks[0]?.status).toBe("done");
    expect(ctx.runtime.attention()).toEqual([]);
  });

  it("has no cap by default", async () => {
    const ctx = await twoPack();
    ctx.runner.script("coder", spend(10_000_000, work("a.ts")), repeat);
    ctx.runner.script("cleaner", work("b.ts"), repeat);
    await ctx.runtime.newTask("Add login");
    await ctx.runtime.drain();
    expect(ctx.runtime.board().tasks[0]?.status).toBe("done");
    expect(ctx.forge.budget().exceeded).toBe(false);
  });
});
