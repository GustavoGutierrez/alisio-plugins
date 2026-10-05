import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsHandoffStore } from "../src/adapters/fs-handoff-store.js";
import { PHANTOM_SENDER, serializeHandoff } from "../src/domain/handoff.js";
import { rebuildBoard } from "../src/domain/task.js";
import { fixedClock, makeHandoff, makePack, tempDir } from "./helpers.js";

const roles = ["coder", "cleaner"];
const handoffsDir = (root: string) => join(root, ".alisio", "swarm", "handoffs");

async function setup() {
  const root = await tempDir();
  const store = new FsHandoffStore(root, fixedClock());
  await store.ensureRoles(roles);
  return { root, store };
}

describe("FsHandoffStore", () => {
  it("creates the per-role directory layout", async () => {
    const { root } = await setup();
    expect((await readdir(join(handoffsDir(root), "coder"))).sort()).toEqual([
      "audit_pending",
      "failed",
      "inbox",
      "join_pending",
      "outbox",
      "pending_approval",
      "sent",
    ]);
    expect((await readdir(join(handoffsDir(root), "coder", "inbox"))).sort()).toEqual([
      "completed",
      "in_process",
      "new",
    ]);
  });

  it("rejects role names that are not valid identifiers", async () => {
    const root = await tempDir();
    await expect(new FsHandoffStore(root, fixedClock()).ensureRoles(["../evil"])).rejects.toThrow(
      /role/i,
    );
  });

  it("writes a handoff file whose name carries the sender and recipients", async () => {
    const { root, store } = await setup();
    const stored = await store.write(makeHandoff(), { kind: "outbox", role: "coder" });
    expect(stored.fileName).toMatch(/^50_\d{8}T\d{6}Z_0001_from_coder_to_cleaner\.handoff$/);
    const text = await readFile(
      join(handoffsDir(root), "coder", "outbox", stored.fileName),
      "utf8",
    );
    expect(text).toBe(serializeHandoff(stored.handoff));
  });

  it("delivers an outbox item: copy into the recipient inbox, original into sent", async () => {
    const { root, store } = await setup();
    const out = await store.write(makeHandoff(), { kind: "outbox", role: "coder" });
    const copies = await store.deliver(out);
    expect(copies).toHaveLength(1);
    expect(copies[0]?.location).toEqual({ kind: "inbox", role: "cleaner", box: "new" });
    expect(await readdir(join(handoffsDir(root), "coder", "outbox"))).toEqual([]);
    expect(await readdir(join(handoffsDir(root), "coder", "sent"))).toEqual([out.fileName]);
    expect(await store.pending("cleaner")).toBe(1);
    expect(copies[0]?.handoff.enqueuedAt).toBeDefined();
  });

  it("delivers to several recipients and is idempotent", async () => {
    const { store } = await setup();
    const out = await store.write(makeHandoff({ to: ["coder", "cleaner"], nonForwarding: true }), {
      kind: "outbox",
      role: "cleaner",
    });
    await store.deliver(out);
    await store.deliver(out);
    expect(await store.pending("coder")).toBe(1);
    expect(await store.pending("cleaner")).toBe(1);
  });

  it("injects a phantom-sender note straight into the recipient inbox", async () => {
    const { store } = await setup();
    const [copy] = await store.inject(
      makeHandoff({ from: PHANTOM_SENDER, to: ["coder"], type: "note" }),
    );
    expect(copy?.location).toEqual({ kind: "inbox", role: "coder", box: "new" });
    expect(copy?.fileName).toContain("_from_new-task_to_coder");
  });

  it("claims the lowest priority number first, then the oldest", async () => {
    const { store } = await setup();
    const late = makeHandoff({ priority: 60 });
    const early = makeHandoff({ priority: 40 });
    const same = makeHandoff({ priority: 40 });
    for (const h of [late, early, same]) {
      await store.deliver(await store.write(h, { kind: "outbox", role: "coder" }));
    }
    const first = await store.claim("cleaner");
    expect(first.map((c) => c.handoff.id)).toEqual([early.id]);
    expect(first[0]?.location).toEqual({ kind: "inbox", role: "cleaner", box: "in_process" });
    expect(first[0]?.handoff.dequeuedAt).toBeDefined();
    expect((await store.claim("cleaner")).map((c) => c.handoff.id)).toEqual([same.id]);
    expect((await store.claim("cleaner")).map((c) => c.handoff.id)).toEqual([late.id]);
    expect(await store.claim("cleaner")).toEqual([]);
  });

  it("batches only equal-priority items of the same task", async () => {
    const { store } = await setup();
    const same = makeHandoff({ priority: 40 });
    const other = makeHandoff({
      priority: 40,
      taskId: "20260102T030405678000Z-other",
      task: "other",
    });
    for (const h of [same, other]) {
      await store.deliver(await store.write(h, { kind: "outbox", role: "coder" }));
    }
    const batch = await store.claim("cleaner", { batch: true });
    expect(batch.map((c) => c.handoff.id)).toEqual([same.id]);
  });

  it("claims every equal-priority item for a batch role", async () => {
    const { store } = await setup();
    const ids: string[] = [];
    for (const priority of [40, 40, 60]) {
      const h = makeHandoff({ priority });
      if (priority === 40) ids.push(h.id);
      await store.deliver(await store.write(h, { kind: "outbox", role: "coder" }));
    }
    const batch = await store.claim("cleaner", { batch: true });
    expect(batch.map((c) => c.handoff.id).sort()).toEqual(ids.sort());
    expect(await store.pending("cleaner")).toBe(1);
  });

  it("completes claimed items", async () => {
    const { store } = await setup();
    await store.deliver(await store.write(makeHandoff(), { kind: "outbox", role: "coder" }));
    const claimed = await store.claim("cleaner");
    const done = await store.complete(claimed);
    expect(done[0]?.location).toEqual({ kind: "inbox", role: "cleaner", box: "completed" });
    expect(done[0]?.handoff.completedAt).toBeDefined();
  });

  it("moves an item between locations, rewriting header fields", async () => {
    const { root, store } = await setup();
    const out = await store.write(makeHandoff(), { kind: "outbox", role: "coder" });
    const parked = await store.move(out, { kind: "audit_pending", role: "coder" });
    expect(parked.location.kind).toBe("audit_pending");
    expect(await readdir(join(handoffsDir(root), "coder", "outbox"))).toEqual([]);
    const approved = await store.move(
      parked,
      { kind: "outbox", role: "coder" },
      { approved: true },
    );
    expect(approved.handoff.approved).toBe(true);
  });

  it("discards a parked handoff", async () => {
    const { root, store } = await setup();
    const parked = await store.write(makeHandoff(), { kind: "audit_pending", role: "coder" });
    await store.discard(parked);
    expect(await readdir(join(handoffsDir(root), "coder", "audit_pending"))).toEqual([]);
    await expect(store.discard(parked)).resolves.toBeUndefined();
  });

  it("scans every location and reports invalid files without throwing", async () => {
    const { root, store } = await setup();
    await store.write(makeHandoff(), { kind: "outbox", role: "coder" });
    const bad = "50_20260102T030405Z_0099_from_coder_to_cleaner.handoff";
    await writeFile(join(handoffsDir(root), "coder", "sent", bad), "garbage");
    await writeFile(join(handoffsDir(root), "coder", "sent", ".leftover.tmp"), "half");
    await mkdir(join(handoffsDir(root), "not_a_role!"), { recursive: true });
    const { records, invalid } = await store.scan();
    expect(records).toHaveLength(1);
    expect(invalid).toEqual([`coder/sent/${bad}`]);
  });

  it("allocates increasing sequence numbers across instances", async () => {
    const { root, store } = await setup();
    await store.write(makeHandoff(), { kind: "outbox", role: "coder" });
    await store.write(makeHandoff(), { kind: "outbox", role: "coder" });
    const next = new FsHandoffStore(root, fixedClock());
    const stored = await next.write(makeHandoff(), { kind: "outbox", role: "coder" });
    expect(stored.fileName).toContain("_0003_");
  });

  describe("crash and replay", () => {
    it("redelivers an outbox item left behind by a crash and requeues in-process work", async () => {
      const { root, store } = await setup();
      const stuck = await store.write(makeHandoff(), { kind: "outbox", role: "coder" });
      const inFlight = makeHandoff({ id: "99999999-2222-4333-8444-555555555555" });
      await store.deliver(await store.write(inFlight, { kind: "outbox", role: "coder" }));
      await store.claim("cleaner");
      // A new process starts: nothing in memory.
      const revived = new FsHandoffStore(root, fixedClock());
      const result = await revived.recover();
      expect(result).toEqual({ redelivered: 1, requeued: 1 });
      expect(await revived.pending("cleaner")).toBe(2);
      expect(await readdir(join(handoffsDir(root), "coder", "outbox"))).toEqual([]);
      expect((await revived.scan()).records.some((r) => r.fileName === stuck.fileName)).toBe(true);
    });

    it("finishes a delivery that crashed after the copy was written", async () => {
      const { root, store } = await setup();
      const out = await store.write(makeHandoff(), { kind: "outbox", role: "coder" });
      await writeFile(
        join(handoffsDir(root), "cleaner", "inbox", "new", out.fileName),
        serializeHandoff(out.handoff),
      );
      const result = await new FsHandoffStore(root, fixedClock()).recover();
      expect(result.redelivered).toBe(1);
      expect(await readdir(join(handoffsDir(root), "cleaner", "inbox", "new"))).toHaveLength(1);
      expect(await readdir(join(handoffsDir(root), "coder", "sent"))).toEqual([out.fileName]);
    });

    it("rebuilds the board from handoff files alone", async () => {
      const { store } = await setup();
      const pack = makePack(roles);
      await store.inject(makeHandoff({ from: PHANTOM_SENDER, to: ["coder"], type: "note" }));
      const claimed = await store.claim("coder");
      await store.complete(claimed);
      const out = await store.write(makeHandoff({ from: "coder", to: ["cleaner"] }), {
        kind: "outbox",
        role: "coder",
      });
      await store.deliver(out);
      const { records } = await store.scan();
      const board = rebuildBoard(pack, records);
      expect(board.tasks).toHaveLength(1);
      expect(board.tasks[0]).toMatchObject({ lane: "cleaner", status: "queued", auditCount: 1 });
    });
  });
});

describe("FsHandoffStore join parking and purge", () => {
  it("parks a handoff while a parallel stage waits and scans it", async () => {
    const { store } = await setup();
    const stored = await store.write(makeHandoff({ from: "coder", to: ["cleaner"] }), {
      kind: "join_pending",
      role: "coder",
    });
    const { records } = await store.scan();
    expect(records.map((r) => r.location)).toEqual([{ kind: "join_pending", role: "coder" }]);
    const moved = await store.move(stored, { kind: "outbox", role: "coder" });
    expect(moved.location.kind).toBe("outbox");
  });

  it("purges every file of one task and leaves other tasks alone", async () => {
    const { store } = await setup();
    const other = makeHandoff({ taskId: "20260102T030405678000Z-other", task: "other" });
    await store.inject(
      makeHandoff({
        from: PHANTOM_SENDER,
        to: ["coder"],
        type: "note",
        commit: undefined as never,
      }),
    );
    await store.write(makeHandoff(), { kind: "pending_approval", role: "coder" });
    await store.write(other, { kind: "outbox", role: "coder" });
    const removed = await store.purge("20260102T030405678000Z-add-login");
    expect(removed).toHaveLength(2);
    const left = (await store.scan()).records;
    expect(left.map((r) => r.handoff.task)).toEqual(["other"]);
  });
});
