import { describe, expect, it } from "vitest";
import { deriveAttention } from "../src/domain/attention.js";
import {
  type Handoff,
  type HandoffLocation,
  handoffFileName,
  PHANTOM_SENDER,
  type StoredHandoff,
} from "../src/domain/handoff.js";
import { type Board, emptyBoard, rebuildBoard, validateBoard } from "../src/domain/task.js";
import { makePack } from "./helpers.js";

const pack = makePack(["coder", "cleaner"]);
const TASK_ID = "20260102T030405678000Z-add-login";
let counter = 0;

function record(
  partial: Partial<Handoff> & Pick<Handoff, "from" | "to">,
  location: HandoffLocation,
): StoredHandoff {
  counter += 1;
  const createdAt = new Date(Date.UTC(2026, 0, 2, 3, 4, counter)).toISOString();
  const handoff: Handoff = {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    priority: 50,
    type: "git_handoff",
    task: "add-login",
    taskId: TASK_ID,
    commit: `${String(counter).padStart(10, "0")}`,
    approved: false,
    nonForwarding: false,
    createdAt,
    body: "",
    ...partial,
  };
  return {
    handoff,
    location,
    fileName: handoffFileName({
      priority: handoff.priority,
      createdAt,
      seq: counter,
      from: handoff.from,
      to: handoff.to,
    }),
  };
}

const newTask = (location: HandoffLocation) =>
  record({ from: PHANTOM_SENDER, to: ["coder"], type: "note", body: "Add login" }, location);

const inbox = (role: string, box: "new" | "in_process" | "completed"): HandoffLocation => ({
  kind: "inbox",
  role,
  box,
});

describe("board validation", () => {
  it("accepts an empty board and rejects malformed ones", () => {
    expect(validateBoard(emptyBoard())).toEqual({ schemaVersion: 1, tasks: [] });
    expect(() => validateBoard(null)).toThrow(/board/i);
    expect(() => validateBoard({ schemaVersion: 2, tasks: [] })).toThrow(/schemaVersion/);
    expect(() => validateBoard({ schemaVersion: 1, tasks: [{}] })).toThrow(/task/i);
  });

  it("rejects an unknown status, a bad lane and duplicate task ids", () => {
    const card = {
      name: "add-login",
      taskId: TASK_ID,
      lane: "coder",
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
      auditCount: 0,
      status: "queued",
    };
    expect(validateBoard({ schemaVersion: 1, tasks: [card] }).tasks).toHaveLength(1);
    expect(() =>
      validateBoard({ schemaVersion: 1, tasks: [{ ...card, status: "weird" }] }),
    ).toThrow(/status/);
    expect(() => validateBoard({ schemaVersion: 1, tasks: [{ ...card, lane: "A_B" }] })).toThrow(
      /lane/,
    );
    expect(() => validateBoard({ schemaVersion: 1, tasks: [card, card] })).toThrow(/duplicate/i);
    expect(() => validateBoard({ schemaVersion: 1, tasks: [{ ...card, auditCount: -1 }] })).toThrow(
      /auditCount/,
    );
  });
});

describe("rebuildBoard", () => {
  it("derives a queued card from a fresh note in the master inbox", () => {
    const board = rebuildBoard(pack, [newTask(inbox("coder", "new"))]);
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0]).toMatchObject({
      name: "add-login",
      taskId: TASK_ID,
      lane: "coder",
      status: "queued",
      auditCount: 0,
    });
  });

  it("derives working while the role processes its inbox item", () => {
    const board = rebuildBoard(pack, [newTask(inbox("coder", "in_process"))]);
    expect(board.tasks[0]).toMatchObject({ lane: "coder", status: "working" });
  });

  it("moves the card to the receiver once a handoff is delivered", () => {
    const start = newTask(inbox("coder", "completed"));
    const forward = record({ from: "coder", to: ["cleaner"] }, { kind: "sent", role: "coder" });
    const copy = { ...forward, location: inbox("cleaner", "new") };
    const board = rebuildBoard(pack, [start, forward, copy]);
    expect(board.tasks[0]).toMatchObject({ lane: "cleaner", status: "queued", auditCount: 1 });
  });

  it("treats an undelivered outbox handoff as queued for the receiver", () => {
    const start = newTask(inbox("coder", "completed"));
    const forward = record({ from: "coder", to: ["cleaner"] }, { kind: "outbox", role: "coder" });
    const board = rebuildBoard(pack, [start, forward]);
    expect(board.tasks[0]).toMatchObject({ lane: "cleaner", status: "queued" });
  });

  it("shows a parked audit as working in the sender lane, without counting it", () => {
    const parked = record(
      { from: "coder", to: ["cleaner"] },
      { kind: "audit_pending", role: "coder" },
    );
    const board = rebuildBoard(pack, [newTask(inbox("coder", "in_process")), parked]);
    expect(board.tasks[0]).toMatchObject({ lane: "coder", status: "working", auditCount: 0 });
  });

  it("shows a held approval", () => {
    const start = newTask(inbox("coder", "completed"));
    const held = record(
      { from: "coder", to: ["cleaner"] },
      { kind: "pending_approval", role: "coder" },
    );
    const board = rebuildBoard(pack, [start, held]);
    expect(board.tasks[0]).toMatchObject({ lane: "coder", status: "waiting_approval" });
  });

  it("blocks the card when a handoff failed", () => {
    const start = newTask(inbox("coder", "completed"));
    const failed = record({ from: "coder", to: ["cleaner"] }, { kind: "failed", role: "coder" });
    const board = rebuildBoard(pack, [start, failed]);
    expect(board.tasks[0]).toMatchObject({ lane: "coder", status: "blocked" });
  });

  it("marks the card done once the last role's handoff is released", () => {
    const start = newTask(inbox("coder", "completed"));
    const first = record({ from: "coder", to: ["cleaner"] }, { kind: "sent", role: "coder" });
    const last = record(
      { from: "cleaner", to: ["coder"], nonForwarding: true },
      { kind: "inbox", role: "coder", box: "new" },
    );
    const board = rebuildBoard(pack, [start, first, last]);
    expect(board.tasks[0]).toMatchObject({ lane: "done", status: "done", auditCount: 2 });
  });

  it("does not finish the card while the last role's handoff is still parked", () => {
    const start = newTask(inbox("coder", "completed"));
    const first = record({ from: "coder", to: ["cleaner"] }, { kind: "sent", role: "coder" });
    const parked = record(
      { from: "cleaner", to: ["coder"], nonForwarding: true },
      { kind: "audit_pending", role: "cleaner" },
    );
    const board = rebuildBoard(pack, [start, first, parked]);
    expect(board.tasks[0]).toMatchObject({ lane: "cleaner", status: "working" });
  });

  it("keeps board-only statuses that files cannot express", () => {
    const records = [newTask(inbox("coder", "in_process"))];
    const previous: Board = {
      schemaVersion: 1,
      tasks: [
        {
          name: "add-login",
          taskId: TASK_ID,
          lane: "coder",
          status: "clarifying",
          createdAt: "2026-01-02T03:04:01.000Z",
          updatedAt: "2026-01-02T03:04:09.000Z",
          auditCount: 3,
        },
      ],
    };
    const board = rebuildBoard(pack, records, previous);
    expect(board.tasks[0]).toMatchObject({ status: "clarifying", auditCount: 3 });
  });

  it("drops board-only status when the lane moved on", () => {
    const start = newTask(inbox("coder", "completed"));
    const forward = record({ from: "coder", to: ["cleaner"] }, { kind: "sent", role: "coder" });
    const previous: Board = {
      schemaVersion: 1,
      tasks: [
        {
          name: "add-login",
          taskId: TASK_ID,
          lane: "coder",
          status: "blocked",
          createdAt: "2026-01-02T03:04:01.000Z",
          updatedAt: "2026-01-02T03:04:01.000Z",
          auditCount: 0,
        },
      ],
    };
    const board = rebuildBoard(pack, [start, forward], previous);
    expect(board.tasks[0]).toMatchObject({ lane: "cleaner", status: "queued" });
  });

  it("ignores handoffs addressed to roles outside the pack", () => {
    const stray = record({ from: "coder", to: ["ghost"] }, { kind: "outbox", role: "coder" });
    const board = rebuildBoard(pack, [newTask(inbox("coder", "new")), stray]);
    expect(board.tasks[0]).toMatchObject({ lane: "coder" });
  });

  it("is deterministic regardless of record order", () => {
    const a = newTask(inbox("coder", "completed"));
    const b = record({ from: "coder", to: ["cleaner"] }, { kind: "outbox", role: "coder" });
    expect(rebuildBoard(pack, [a, b])).toEqual(rebuildBoard(pack, [b, a]));
  });
});

describe("attention derivation", () => {
  const card = (status: Board["tasks"][number]["status"]): Board["tasks"][number] => ({
    name: "add-login",
    taskId: TASK_ID,
    lane: "coder",
    status,
    createdAt: "2026-01-02T03:04:01.000Z",
    updatedAt: "2026-01-02T03:04:09.000Z",
    auditCount: 0,
  });

  it("raises one item per card that needs a human", () => {
    const items = deriveAttention("demo", {
      schemaVersion: 1,
      tasks: [card("waiting_approval")],
    });
    expect(items).toEqual([
      {
        id: "approval:demo:add-login",
        kind: "approval",
        project: "demo",
        task: "add-login",
        createdAt: "2026-01-02T03:04:09.000Z",
        actions: ["documents", "approve", "reject"],
      },
    ]);
  });

  it("maps each status to its attention kind and actions", () => {
    const kinds = (status: Board["tasks"][number]["status"]) =>
      deriveAttention("demo", { schemaVersion: 1, tasks: [card(status)] }).map((item) => [
        item.kind,
        item.actions,
      ]);
    expect(kinds("clarifying")).toEqual([["clarification", ["answer"]]]);
    expect(kinds("blocked")).toEqual([["blocked", ["retry", "delete", "accept"]]]);
    expect(kinds("rejected")).toEqual([["decision", ["retry", "delete", "accept"]]]);
    for (const quiet of ["queued", "working", "merging", "done"] as const) {
      expect(kinds(quiet)).toEqual([]);
    }
  });
});

describe("rebuildBoard with a parallel stage join", () => {
  const stagePack = makePack(["coder", "cleaner", "architect", "hardener", "qa"], {
    parallel: [["architect", "hardener"]],
  });

  it("shows a parked stage handoff as working in the sender lane", () => {
    const board = rebuildBoard(stagePack, [
      record({ from: "architect", to: ["qa"] }, { kind: "join_pending", role: "architect" }),
    ]);
    expect(board.tasks[0]).toMatchObject({ lane: "architect", status: "working" });
  });
});
