import type { ChildRunResult, ChildSessionInfo, ChildSessionSpec } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ChildSessionRunner } from "../src/adapters/child-session-runner.js";

type Sessions = ConstructorParameters<typeof ChildSessionRunner>[0]["sessions"];

function fakeSessions(
  replies: Array<
    Partial<ChildRunResult> | Error | ((signal?: AbortSignal) => Promise<ChildRunResult>)
  > = [],
) {
  const created: ChildSessionSpec[] = [];
  const runs: Array<{ id: string; prompt: string; signal: AbortSignal | undefined }> = [];
  const cancelled: string[] = [];
  let counter = 0;
  const sessions: Sessions = {
    async create(spec) {
      created.push(spec);
      counter += 1;
      return { id: `child-${counter}` } as ChildSessionInfo;
    },
    async run(id, prompt, options) {
      runs.push({ id, prompt, signal: options?.signal });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next(options?.signal);
      return { id, status: "completed", text: "{}", usage: { input: 3, output: 4 }, ...next };
    },
    cancel(id) {
      cancelled.push(id);
      return 1;
    },
  };
  return { sessions, created, runs, cancelled };
}

const request = (extra: Record<string, unknown> = {}) => ({
  sessionKey: "demo/coder",
  project: "demo",
  role: "coder",
  agent: "swarm-coder",
  workdir: "/scratch/p/.worktrees/coder",
  prompt: "do it",
  ...extra,
});

const make = (
  fake: ReturnType<typeof fakeSessions>,
  extra: Partial<ConstructorParameters<typeof ChildSessionRunner>[0]> = {},
) =>
  new ChildSessionRunner({
    sessions: fake.sessions,
    parentSession: () => "parent-1",
    roleOptions: () => ({}),
    ...extra,
  });

describe("ChildSessionRunner session spec", () => {
  it("creates a child with the role's worktree, instructions, tools and limits", async () => {
    const fake = fakeSessions();
    const result = await make(fake).run(request());
    expect(result).toMatchObject({ status: "completed", usage: { input: 3, output: 4 } });
    const spec = fake.created[0] as ChildSessionSpec;
    expect(spec).toMatchObject({
      parentId: "parent-1",
      agent: "swarm-coder",
      workspace: "/scratch/p/.worktrees/coder",
      readOnly: false,
      permission: { write: "allow", process: "allow" },
      maxTurns: 40,
    });
    expect(spec.title).toBe("demo/coder");
    expect(spec.instructions).toContain("# Loaded skill: swarm-tdd-slice");
    expect(spec.tools?.allow).toEqual(
      expect.arrayContaining(["read_file", "write_file", "run_process"]),
    );
    expect(spec.tools?.deny).toEqual(
      expect.arrayContaining(["task", "delegate", "subagent", "sessions_create"]),
    );
    expect(spec.timeoutMs).toBeGreaterThan(0);
    expect(spec.maxOutputTokens).toBeGreaterThan(0);
    expect(spec.model).toBeUndefined();
  });

  it("makes read-only roles read-only with no write permission", async () => {
    const fake = fakeSessions();
    await make(fake).run(request({ sessionKey: "demo/qa", role: "qa", agent: "swarm-qa" }));
    expect(fake.created[0]).toMatchObject({
      readOnly: true,
      permission: { write: "deny", process: "allow" },
    });
    const lieutenant = fakeSessions();
    await make(lieutenant).run(
      request({ sessionKey: "demo/lieutenant", role: "lieutenant", agent: "swarm-lieutenant" }),
    );
    expect(lieutenant.created[0]).toMatchObject({
      readOnly: true,
      permission: { write: "deny", process: "deny" },
    });
  });

  it("takes the model from options.roles.<role>.model", async () => {
    const fake = fakeSessions();
    await make(fake, { roleOptions: () => ({ coder: { model: "provider/model-x" } }) }).run(
      request(),
    );
    expect(fake.created[0]?.model).toBe("provider/model-x");
  });

  it("reuses one session per key and creates separate ones per role", async () => {
    const fake = fakeSessions();
    const runner = make(fake);
    await runner.run(request());
    await runner.run(request({ prompt: "again" }));
    await runner.run(request({ sessionKey: "demo/qa", role: "qa", agent: "swarm-qa" }));
    expect(fake.created).toHaveLength(2);
    expect(fake.runs.map((r) => [r.id, r.prompt])).toEqual([
      ["child-1", "do it"],
      ["child-1", "again"],
      ["child-2", "do it"],
    ]);
  });

  it("starts a new session when the working directory changes", async () => {
    const fake = fakeSessions();
    const runner = make(fake);
    await runner.run(request());
    await runner.run(request({ workdir: "/scratch/p/.worktrees/other" }));
    expect(fake.created).toHaveLength(2);
  });
});

describe("ChildSessionRunner results", () => {
  it.each([
    ["cancelled", "cancelled"],
    ["interrupted", "cancelled"],
    ["failed", "failed"],
    ["queued", "failed"],
    ["running", "failed"],
  ] as const)("maps the %s status to %s", async (status, expected) => {
    const fake = fakeSessions([{ status, text: "x", error: "why" }]);
    expect((await make(fake).run(request())).status).toBe(expected);
  });

  it("passes a turn-limit result through so the pump can reject partial output", async () => {
    const fake = fakeSessions([{ status: "completed", text: "partial", turnsExceeded: true }]);
    expect(await make(fake).run(request())).toMatchObject({
      status: "completed",
      text: "partial",
      turnsExceeded: true,
    });
  });

  it("reports a thrown error as a failed run", async () => {
    const fake = fakeSessions([new Error("provider down")]);
    expect(await make(fake).run(request())).toMatchObject({
      status: "failed",
      error: expect.stringContaining("provider down"),
    });
  });

  it("fails visibly for an unknown agent or when there is no parent session", async () => {
    const fake = fakeSessions();
    expect(await make(fake).run(request({ agent: "swarm-ghost" }))).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/unknown agent/i),
    });
    expect(await make(fake, { parentSession: () => undefined }).run(request())).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/session/i),
    });
    expect(fake.created).toEqual([]);
  });

  it("does not touch the sessions API until a run starts", () => {
    const fake = fakeSessions();
    make(fake);
    expect(fake.created).toEqual([]);
    expect(fake.runs).toEqual([]);
  });
});

describe("ChildSessionRunner cancellation", () => {
  it("cancels every session of a project and aborts the running call", async () => {
    let aborted = false;
    const fake = fakeSessions([
      (signal) =>
        new Promise<ChildRunResult>((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve({
              id: "child-1",
              status: "cancelled",
              text: "",
              usage: { input: 0, output: 0 },
            });
          });
        }),
    ]);
    const runner = make(fake);
    const pending = runner.run(request());
    await new Promise((resolve) => setTimeout(resolve, 20));
    runner.cancelProject("demo");
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(aborted).toBe(true);
    expect(fake.cancelled).toEqual(["child-1"]);
  });

  it("leaves other projects alone and recreates a session after a cancel", async () => {
    const fake = fakeSessions();
    const runner = make(fake);
    await runner.run(request());
    await runner.run(request({ sessionKey: "other/coder", project: "other" }));
    runner.cancelProject("demo");
    expect(fake.cancelled).toEqual(["child-1"]);
    await runner.run(request());
    expect(fake.created).toHaveLength(3);
  });

  it("cancels everything on cancelAll", async () => {
    const fake = fakeSessions();
    const runner = make(fake);
    await runner.run(request());
    await runner.run(request({ sessionKey: "other/coder", project: "other" }));
    runner.cancelAll();
    expect(fake.cancelled.sort()).toEqual(["child-1", "child-2"]);
  });

  it("honours a caller abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeSessions([
      (signal) =>
        Promise.resolve({
          id: "c",
          status: signal?.aborted ? "cancelled" : "completed",
          text: "",
          usage: { input: 0, output: 0 },
        }),
    ]);
    expect(await make(fake).run(request({ signal: controller.signal }))).toMatchObject({
      status: "cancelled",
    });
  });
});

describe("ChildSessionRunner inspect", () => {
  it("reports nothing before a role has run", () => {
    expect(make(fakeSessions()).inspect("demo/coder")).toBeUndefined();
  });

  it("exposes the child session id and a bounded tail of prompts and replies", async () => {
    const fake = fakeSessions([{ text: "first reply" }, { text: "second reply" }]);
    const runner = make(fake);
    await runner.run(request({ prompt: "one" }));
    await runner.run(request({ prompt: "two" }));
    const view = runner.inspect("demo/coder");
    expect(view?.sessionId).toBe("child-1");
    expect(view?.live).toBe(false);
    expect(view?.recentRuns).toBe(2);
    expect(view?.tail.map((entry) => `${entry.kind}:${entry.text}`)).toEqual([
      "prompt:one",
      "reply:first reply",
      "prompt:two",
      "reply:second reply",
    ]);
  });

  it("is live while a run is in flight and truncates long text and old entries", async () => {
    let release: (value: ChildRunResult) => void = () => undefined;
    const fake = fakeSessions([
      () =>
        new Promise<ChildRunResult>((resolve) => {
          release = resolve;
        }),
    ]);
    const runner = make(fake);
    const pending = runner.run(request({ prompt: "x".repeat(5000) }));
    for (let wait = 0; wait < 200 && !runner.inspect("demo/coder")?.live; wait += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runner.inspect("demo/coder")?.live).toBe(true);
    release({ id: "child-1", status: "completed", text: "ok", usage: { input: 1, output: 1 } });
    await pending;
    const view = runner.inspect("demo/coder");
    expect(view?.live).toBe(false);
    expect(view?.tail[0]?.text.length).toBeLessThanOrEqual(2001);
    for (let index = 0; index < 60; index += 1) {
      fake.sessions.run = async (id) => ({
        id,
        status: "completed",
        text: `r${index}`,
        usage: { input: 0, output: 0 },
      });
      await runner.run(request({ prompt: `p${index}` }));
    }
    expect(runner.inspect("demo/coder")?.tail.length).toBeLessThanOrEqual(40);
  });

  it("forgets a role when its project is cancelled", async () => {
    const runner = make(fakeSessions());
    await runner.run(request());
    runner.cancelProject("demo");
    expect(runner.inspect("demo/coder")).toBeUndefined();
  });
});
