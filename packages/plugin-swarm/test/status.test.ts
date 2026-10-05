import { describe, expect, it } from "vitest";
import type { Board } from "../src/domain/task.js";
import { type ProjectSnapshot, renderStatus } from "../src/status.js";
import { makePack } from "./helpers.js";

const board: Board = {
  schemaVersion: 1,
  tasks: [
    {
      name: "add-login",
      taskId: "20260102T030405678000Z-add-login",
      lane: "coder",
      status: "working",
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
      auditCount: 1,
    },
    {
      name: "fix-bug",
      taskId: "20260102T030406678000Z-fix-bug",
      lane: "cleaner",
      status: "blocked",
      createdAt: "2026-01-02T03:04:06.000Z",
      updatedAt: "2026-01-02T03:04:06.000Z",
      auditCount: 0,
    },
  ],
};

const snapshot = (overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  name: "demo",
  open: true,
  running: true,
  pack: makePack(["coder", "cleaner"]),
  board,
  attention: [
    {
      id: "blocked:demo:fix-bug",
      kind: "blocked",
      project: "demo",
      task: "fix-bug",
      createdAt: "2026-01-02T03:04:06.000Z",
      actions: ["retry", "delete", "accept"],
    },
  ],
  ...overrides,
});

describe("renderStatus", () => {
  it("explains an empty forge", () => {
    const { text, blocks } = renderStatus([]);
    expect(text).toMatch(/no projects/i);
    expect(blocks).toEqual([]);
  });

  it("summarises lanes and attention in text", () => {
    const { text } = renderStatus([snapshot()]);
    expect(text).toContain("demo");
    expect(text).toContain("coder");
    expect(text).toMatch(/add-login/);
    expect(text).toMatch(/Needs your attention/i);
    expect(text).toMatch(/blocked/);
  });

  it("produces a task table, an attention table and a pipeline diagram", () => {
    const { blocks } = renderStatus([snapshot()]);
    const kinds = blocks.map((block) => block.kind);
    expect(kinds).toEqual(["table", "table", "mermaid"]);
    const tasks = blocks[0] as { columns: string[]; rows: string[][] };
    expect(tasks.columns).toEqual(["Task", "Lane", "Status", "Audits"]);
    expect(tasks.rows).toEqual([
      ["add-login", "coder", "working", "1"],
      ["fix-bug", "cleaner", "blocked", "0"],
    ]);
    const diagram = blocks[2] as { source: string };
    expect(diagram.source).toBe("flowchart LR\n  coder --> cleaner --> done");
  });

  it("marks closed projects and skips tables when there is nothing to show", () => {
    const { text, blocks } = renderStatus([
      snapshot({ open: false, running: false, board: undefined, attention: [] }),
    ]);
    expect(text).toMatch(/closed/i);
    expect(blocks.map((b) => b.kind)).toEqual(["mermaid"]);
  });

  it("never lets task text break the diagram", () => {
    const { blocks } = renderStatus([snapshot()]);
    expect((blocks.at(-1) as { source: string }).source).not.toContain("add-login");
  });
});
