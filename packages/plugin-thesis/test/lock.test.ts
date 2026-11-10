import { afterEach, describe, expect, it } from "vitest";
import { blockedByLock, WorkspaceLock } from "../src/lock.js";
import { json, protocolDraft } from "./helpers/data.js";
import { cleanup, intakeAnswers } from "./helpers/harness.js";
import { studio } from "./helpers/studio.js";

afterEach(cleanup);

describe("WorkspaceLock", () => {
  it("admits one holder per resolved workspace and releases idempotently", () => {
    const lock = new WorkspaceLock();
    const release = lock.tryAcquire("/w/a", "app", "Writing SEC-03");
    expect(release).toBeTypeOf("function");
    expect(lock.tryAcquire("/w/a/", "chat", "/thesis:draft")).toBeUndefined();
    expect(lock.holderOf("/w/a")).toEqual({ holder: "app", label: "Writing SEC-03" });
    // Another workspace is independent.
    const other = lock.tryAcquire("/w/b", "chat", "/thesis:check");
    expect(other).toBeTypeOf("function");
    release?.();
    release?.();
    expect(lock.holderOf("/w/a")).toBeUndefined();
    expect(lock.holderOf("/w/b")).toEqual({ holder: "chat", label: "/thesis:check" });
    // A stale release never frees a later holder.
    const again = lock.tryAcquire("/w/a", "chat", "/thesis:status");
    release?.();
    expect(lock.holderOf("/w/a")?.label).toBe("/thesis:status");
    again?.();
    other?.();
    expect(lock.holderOf("/w/b")).toBeUndefined();
  });

  it("explains a conflict for chat in plain words", () => {
    expect(blockedByLock({ holder: "app", label: "Writing SEC-03" })).toBe(
      "Blocked: Thesis Studio is running Writing SEC-03; wait or cancel it there.",
    );
    expect(blockedByLock({ holder: "chat", label: "/thesis:draft" })).toBe(
      "Blocked: another thesis command is running (/thesis:draft); wait for it to finish.",
    );
  });
});

describe("chat and app share one writer per workspace (THA-AC-06)", () => {
  it("blocks a command while an app job holds the lock, and an app action while a command runs", async () => {
    const s = await studio({ answers: intakeAnswers });
    await s.h.run("init", "--lang es-CO");
    s.h.script("thesis-methodologist", json(protocolDraft()));
    const releaseJob = s.holdChildren();
    const started = await s.call("design.run", {});
    const jobId = (started.value as { jobId: string }).jobId;
    expect(jobId).toEqual(expect.any(String));
    await s.untilChildRuns();
    // A state-mutating command and the thesis_answer tool are blocked with a pointer to the app.
    expect(await s.h.run("check")).toMatch(
      /^Blocked: Thesis Studio is running .+; wait or cancel it there\.$/,
    );
    const tool = await s.h.tools.get("thesis_answer")?.execute({ answers: { language: "es" } }, {
      workspace: s.h.workspace,
      signal: new AbortController().signal,
    } as never);
    expect(JSON.stringify(tool)).toContain("Blocked: Thesis Studio is running");
    // Read-only commands keep working.
    expect(await s.h.run("status")).toContain("Phase: design");
    releaseJob();
    expect((await s.waitJob(jobId)).state).toBe("done");

    // Now a slow command holds the lock: the app action is refused with holder "chat".
    s.h.setInteractive(false);
    const releaseCommand = s.holdChildren();
    s.h.script("thesis-methodologist", json(protocolDraft()));
    const command = s.h.run("revise", "A -- Más foco en el problema");
    await s.untilChildRuns();
    const status = (await s.call("status", {})).value as { revision: string };
    const refused = await s.call("approve", { target: "A", revision: status.revision });
    expect(refused).toEqual({ error: "busy", holder: "chat", label: "/thesis:revise" });
    releaseCommand();
    expect(await command).not.toContain("Blocked");
    // Once the command is done the app may act again.
    const fresh = (await s.call("status", {})).value as { revision: string };
    expect(await s.call("approve", { target: "A", revision: fresh.revision })).toMatchObject({
      value: expect.anything(),
    });
  });
});
