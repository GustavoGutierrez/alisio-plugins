import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  ScriptedRunner,
  tempDir,
} from "./helpers.js";

const head = (dir: string) => gitIn(dir, "rev-parse", "HEAD").slice(0, 10);
/** Re-send the current HEAD: the unchanged second envelope of an audit. */
const repeat = (request: { workdir: string }) => handoffEnvelope(head(request.workdir));
/** Make one commit and report it. */
const work = (file: string) => async (request: { workdir: string }) =>
  handoffEnvelope(await commitFile(request.workdir, file, `${file}\n`));

async function writeLocalPack(workspace: string, pack: Record<string, unknown>) {
  const dir = join(workspace, ".alisio", "swarm", "packs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${pack.name}.json`), JSON.stringify(pack));
}

const role = (id: string, isolation = "worktree") => ({
  id,
  agent: id,
  isolation,
  receive: "task",
  propagation: "forward-only",
});

async function setup(packName = "two-pack", workspaceDir?: string) {
  const workspace = workspaceDir ?? (await tempDir());
  const runner = new ScriptedRunner();
  const events: SwarmEvent[] = [];
  const forge = new Forge({
    workspace,
    isolation: new GitWorktreeIsolation(),
    runner,
    autoStart: false,
    notifier: { notify: (event) => events.push(event) },
  });
  await forge.init();
  return { workspace, runner, events, forge, packName };
}

async function project(packName = "two-pack") {
  const ctx = await setup(packName);
  const runtime = await ctx.forge.newProject({ name: "demo", pack: packName, mission: "Build it" });
  return { ...ctx, runtime };
}

describe("two-pack end to end with a fake runner", () => {
  it("runs a task through coder and cleaner, merges in the coordinator and ends in Done", async () => {
    const { runner, runtime, events } = await project();
    let cleanerSawCoderWork = false;
    runner.script("coder", work("login.ts"), repeat);
    runner.script(
      "cleaner",
      async (request) => {
        cleanerSawCoderWork = existsSync(join(request.workdir, "login.ts"));
        return handoffEnvelope(await commitFile(request.workdir, "clean.ts", "tidy\n"));
      },
      repeat,
    );
    const card = await runtime.newTask("Add login");
    expect(card).toMatchObject({
      name: "add-login",
      lane: "coder",
      status: "queued",
      auditCount: 0,
    });

    await runtime.drain();

    expect(cleanerSawCoderWork).toBe(true);
    expect(runtime.board().tasks).toHaveLength(1);
    expect(runtime.board().tasks[0]).toMatchObject({ lane: "done", status: "done", auditCount: 2 });
    // The terminal broadcast merged the cleaner's commit into the master checkout.
    expect(existsSync(join(runtime.dir, "clean.ts"))).toBe(true);
    expect(runner.callsFor("coder")).toHaveLength(2);
    expect(runner.callsFor("cleaner")).toHaveLength(2);
    expect(events.filter((event) => event.type === "task-done")).toEqual([
      { type: "task-done", project: "demo", task: "add-login" },
    ]);
    expect(runner.remaining("coder") + runner.remaining("cleaner")).toBe(0);
  });

  it("delivers the task text to the first role and keeps one session per project and role", async () => {
    const { runner, runtime } = await project();
    runner.script("coder", work("a.ts"), repeat);
    runner.script("cleaner", work("b.ts"), repeat);
    await runtime.newTask("Add a very specific login form");
    await runtime.drain();
    const [first, second] = runner.callsFor("coder");
    expect(first?.prompt).toContain("Add a very specific login form");
    expect(first?.sessionKey).toBe("demo/coder");
    expect(second?.sessionKey).toBe("demo/coder");
    expect(second?.prompt).not.toBe(first?.prompt);
    expect(first?.workdir).toBe(runtime.dir);
    expect(runner.callsFor("cleaner")[0]?.workdir).toBe(join(runtime.dir, ".worktrees", "cleaner"));
  });

  it("leaves the durable handoff trail on disk", async () => {
    const { runner, runtime } = await project();
    runner.script("coder", work("a.ts"), repeat);
    runner.script("cleaner", work("b.ts"), repeat);
    await runtime.newTask("Add login");
    await runtime.drain();
    const { records, invalid } = await new FsHandoffStore(runtime.dir, systemClock).scan();
    expect(invalid).toEqual([]);
    const where = (kind: string, role: string) =>
      records.filter((r) => r.location.kind === kind && r.location.role === role).length;
    expect(where("sent", "coder")).toBe(1);
    expect(where("sent", "cleaner")).toBe(1);
    expect(where("outbox", "coder") + where("outbox", "cleaner")).toBe(0);
    expect(where("audit_pending", "coder") + where("audit_pending", "cleaner")).toBe(0);
    const terminal = records.find(
      (r) =>
        r.handoff.from === "cleaner" && r.location.kind === "inbox" && r.location.role === "coder",
    );
    expect(terminal?.handoff.nonForwarding).toBe(true);
    expect(terminal?.location).toMatchObject({ box: "completed" });
  });

  it("runs several tasks, but a role works on one task at a time", async () => {
    const { runner, runtime } = await project();
    runner.script("coder", work("one.ts"), repeat, work("two.ts"), repeat);
    runner.script("cleaner", work("one-clean.ts"), repeat, work("two-clean.ts"), repeat);
    await runtime.newTask("One");
    await runtime.newTask("Two");
    await runtime.drain();
    expect(runtime.board().tasks.map((t) => t.status)).toEqual(["done", "done"]);
    expect(runner.maxParallel.get("coder")).toBe(1);
    expect(runner.maxParallel.get("cleaner")).toBe(1);
  });
});

describe("audit handshake", () => {
  it("restarts the challenge when the second envelope changes the commit", async () => {
    const { workspace, runner, forge } = await setup();
    await writeLocalPack(workspace, {
      schemaVersion: 1,
      name: "solo",
      description: "One role",
      toolchain: "node-ts",
      roles: [role("builder", "master")],
    });
    const runtime = await forge.newProject({ name: "demo", pack: "solo", mission: "m" });
    runner.script("builder", work("a.ts"), work("b.ts"), repeat);
    await runtime.newTask("Build");
    await runtime.drain();
    expect(runner.callsFor("builder")).toHaveLength(3);
    // A single-role pack ends the task with its own handoff.
    expect(runtime.board().tasks[0]).toMatchObject({ lane: "done", status: "done", auditCount: 1 });
  });

  it("blocks the card when the role never settles on a commit", async () => {
    const { runner, runtime } = await project();
    runner.script("coder", work("a.ts"), work("b.ts"), work("c.ts"), work("d.ts"));
    await runtime.newTask("Never settles");
    await runtime.drain();
    expect(runtime.board().tasks[0]).toMatchObject({ lane: "coder", status: "blocked" });
    expect(runtime.attention().map((item) => item.kind)).toEqual(["blocked"]);
    expect(runner.callsFor("cleaner")).toHaveLength(0);
  });
});

describe("rejected output", () => {
  it("retries once after invalid output and then continues", async () => {
    const { runner, runtime } = await project();
    runner.script("coder", "I am done!", work("a.ts"), repeat);
    runner.script("cleaner", work("b.ts"), repeat);
    await runtime.newTask("Flaky");
    await runtime.drain();
    expect(runner.callsFor("coder")).toHaveLength(3);
    expect(runtime.board().tasks[0]?.status).toBe("done");
  });

  it("blocks after a second invalid output and raises attention", async () => {
    const { runner, runtime, events } = await project();
    runner.script("coder", "nope", "still nope");
    await runtime.newTask("Broken");
    await runtime.drain();
    expect(runner.callsFor("coder")).toHaveLength(2);
    expect(runtime.board().tasks[0]).toMatchObject({ lane: "coder", status: "blocked" });
    expect(events.some((e) => e.type === "attention" && e.item.kind === "blocked")).toBe(true);
  });

  it("rejects an envelope that names a commit the worktree does not have", async () => {
    const { runner, runtime } = await project();
    runner.script("coder", handoffEnvelope("0000000000"), work("a.ts"), repeat);
    runner.script("cleaner", work("b.ts"), repeat);
    await runtime.newTask("Phantom commit");
    await runtime.drain();
    expect(runner.callsFor("coder")).toHaveLength(3);
    expect(runtime.board().tasks[0]?.status).toBe("done");
  });

  it("treats a note envelope as invalid for a role that must hand off", async () => {
    const { runner, runtime } = await project();
    const note = JSON.stringify({ schemaVersion: 1, kind: "note", message: "fyi" });
    runner.script("coder", note, note);
    await runtime.newTask("Chatty");
    await runtime.drain();
    expect(runtime.board().tasks[0]?.status).toBe("blocked");
  });

  it("blocks when the runner fails twice", async () => {
    const { runner, runtime } = await project();
    runner.script(
      "coder",
      { status: "failed", text: "", error: "boom" },
      { status: "failed", text: "", error: "boom" },
    );
    await runtime.newTask("Runner down");
    await runtime.drain();
    expect(runtime.board().tasks[0]?.status).toBe("blocked");
  });

  it("rejects a run that hit its turn limit", async () => {
    const { runner, runtime } = await project();
    const partial = {
      status: "completed" as const,
      text: handoffEnvelope("0123456789"),
      turnsExceeded: true,
    };
    runner.script("coder", partial, partial);
    await runtime.newTask("Too long");
    await runtime.drain();
    expect(runtime.board().tasks[0]?.status).toBe("blocked");
  });

  it("requeues work and stops the pump when a run is cancelled", async () => {
    const { runner, runtime } = await project();
    runner.script("coder", { status: "cancelled", text: "" });
    await runtime.newTask("Interrupted");
    await runtime.drain();
    expect(runner.callsFor("coder")).toHaveLength(1);
    expect(runtime.board().tasks[0]).toMatchObject({ lane: "coder", status: "queued" });
    const store = new FsHandoffStore(runtime.dir, systemClock);
    expect(await store.pending("coder")).toBe(1);
  });
});

describe("clarifications and blocks", () => {
  it("parks the card on a clarification and resumes the same session with the answer", async () => {
    const { runner, runtime } = await project();
    runner.script("coder", clarificationEnvelope("Which login method?"), work("login.ts"), repeat);
    runner.script("cleaner", work("clean.ts"), repeat);
    await runtime.newTask("Add login");
    await runtime.drain();
    expect(runtime.board().tasks[0]?.status).toBe("clarifying");
    expect(runtime.attention()).toMatchObject([{ kind: "clarification", task: "add-login" }]);

    await runtime.answer("add-login", "Use email sign-in");
    await runtime.drain();

    const resumed = runner.callsFor("coder")[1];
    expect(resumed?.prompt).toContain("Use email sign-in");
    expect(resumed?.sessionKey).toBe("demo/coder");
    expect(runtime.board().tasks[0]).toMatchObject({ lane: "done", status: "done" });
  });

  it("refuses an answer when nothing is waiting", async () => {
    const { runtime } = await project();
    await runtime.newTask("Add login");
    await expect(runtime.answer("add-login", "hi")).rejects.toThrow(/not waiting/i);
    await expect(runtime.answer("ghost", "hi")).rejects.toThrow(/unknown task/i);
  });

  it("holds the role and raises attention when it reports blocked", async () => {
    const { runner, runtime } = await project();
    runner.script("coder", blockedEnvelope("The test database is missing"));
    await runtime.newTask("Needs a database");
    await runtime.drain();
    expect(runtime.board().tasks[0]).toMatchObject({ lane: "coder", status: "blocked" });
    expect(runtime.attention()).toMatchObject([{ kind: "blocked" }]);
    expect(runner.callsFor("coder")).toHaveLength(1);
  });
});

describe("approval gate hold", () => {
  it("parks the handoff for approval instead of delivering it", async () => {
    const { workspace, runner, forge } = await setup();
    await writeLocalPack(workspace, {
      schemaVersion: 1,
      name: "gated",
      description: "Gate after the coder",
      toolchain: "node-ts",
      approval: { after: "coder" },
      roles: [role("coder", "master"), role("cleaner")],
    });
    const runtime = await forge.newProject({ name: "demo", pack: "gated", mission: "m" });
    runner.script("coder", work("spec.md"), repeat);
    await runtime.newTask("Needs sign-off");
    await runtime.drain();
    expect(runtime.board().tasks[0]).toMatchObject({ lane: "coder", status: "waiting_approval" });
    expect(runtime.attention()).toMatchObject([
      { kind: "approval", actions: ["documents", "approve", "reject"] },
    ]);
    expect(runner.callsFor("cleaner")).toHaveLength(0);
    const { records } = await new FsHandoffStore(runtime.dir, systemClock).scan();
    expect(records.some((r) => r.location.kind === "pending_approval")).toBe(true);
  });
});

describe("merge conflicts", () => {
  it("hands a conflicting merge to the receiving role as part of its work", async () => {
    const { runner, runtime } = await project();
    const cleanerDir = join(runtime.dir, ".worktrees", "cleaner");
    await commitFile(cleanerDir, "shared.txt", "cleaner side\n");
    let statusDuringResolution: string | undefined;
    runner.script("coder", work("shared.txt"), repeat);
    runner.script(
      "cleaner",
      async (request) => {
        statusDuringResolution = runtime.board().tasks[0]?.status;
        expect(request.prompt).toContain("shared.txt");
        await writeFile(join(request.workdir, "shared.txt"), "resolved\n");
        gitIn(request.workdir, "add", "shared.txt");
        gitIn(request.workdir, "commit", "--no-edit");
        return handoffEnvelope(head(request.workdir));
      },
      repeat,
    );
    await runtime.newTask("Conflicting");
    await runtime.drain();
    expect(statusDuringResolution).toBe("merging");
    expect(runtime.board().tasks[0]?.status).toBe("done");
  });
});

describe("crash and replay", () => {
  it("rebuilds the board and resumes after a crash mid-run", async () => {
    const first = await project();
    await first.runtime.newTask("Add login");
    // Crash: the coder had claimed the work, then the process died and the board file was lost.
    await new FsHandoffStore(first.runtime.dir, systemClock).claim("coder");
    await rm(join(first.runtime.dir, ".alisio", "swarm", "board"), {
      recursive: true,
      force: true,
    });

    const second = await setup("two-pack", first.workspace);
    const reopened = await second.forge.openProject("demo");
    expect(reopened.board().tasks).toHaveLength(1);
    expect(reopened.board().tasks[0]).toMatchObject({ lane: "coder", status: "queued" });

    second.runner.script("coder", work("login.ts"), repeat);
    second.runner.script("cleaner", work("clean.ts"), repeat);
    await reopened.drain();
    expect(reopened.board().tasks[0]).toMatchObject({ lane: "done", status: "done" });
  });

  it("drops a stale audit parking after a crash and redoes the audit", async () => {
    const first = await project();
    first.runner.script("coder", work("a.ts"), () => {
      throw new Error("process died mid-audit");
    });
    await first.runtime.newTask("Add login");
    await first.runtime.drain();
    // Whatever state the dying process left behind, a fresh process must recover from the files.
    const second = await setup("two-pack", first.workspace);
    const reopened = await second.forge.openProject("demo");
    expect(reopened.board().tasks[0]?.status).toBe("queued");
    const { records } = await new FsHandoffStore(reopened.dir, systemClock).scan();
    expect(records.some((r) => r.location.kind === "audit_pending")).toBe(false);
    second.runner.script("coder", repeat, repeat);
    second.runner.script("cleaner", work("clean.ts"), repeat);
    await reopened.drain();
    expect(reopened.board().tasks[0]?.status).toBe("done");
  });

  it("persists the board across a clean close and reopen", async () => {
    const { runner, runtime, forge } = await project();
    runner.script("coder", work("a.ts"), repeat);
    runner.script("cleaner", work("b.ts"), repeat);
    await runtime.newTask("Add login");
    await runtime.drain();
    await forge.closeProject("demo");
    const board = JSON.parse(
      await readFile(join(runtime.dir, ".alisio", "swarm", "board", "tasks.json"), "utf8"),
    );
    expect(board.schemaVersion).toBe(1);
    expect(board.tasks[0]).toMatchObject({ lane: "done", status: "done" });
  });
});
