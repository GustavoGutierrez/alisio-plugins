import { describe, expect, it } from "vitest";
import {
  type Handoff,
  handoffFileName,
  PHANTOM_SENDER,
  parseHandoff,
  parseHandoffFileName,
  serializeHandoff,
} from "../src/domain/handoff.js";

const sample = (): Handoff => ({
  id: "6f1c8c1e-9c1a-4c1e-8f5e-0b8f7b3f2a11",
  from: "coder",
  to: ["cleaner"],
  priority: 50,
  type: "git_handoff",
  task: "add-login",
  taskId: "20260102T030405678000Z-add-login",
  commit: "0123456789",
  taskBaseCommit: "abcdef0123",
  approved: false,
  nonForwarding: false,
  createdAt: "2026-01-02T03:04:05.678Z",
  body: "Merge commit 0123456789 and continue.\nSecond line.",
});

describe("handoff header", () => {
  it("round-trips through serialize and parse", () => {
    const handoff = sample();
    const text = serializeHandoff(handoff);
    expect(text).toMatch(/^id: 6f1c8c1e/);
    expect(text).toContain("\n\nMerge commit");
    expect(parseHandoff(text)).toEqual(handoff);
  });

  it("round-trips optional timestamps, multiple recipients and the phantom sender", () => {
    const handoff: Handoff = {
      ...sample(),
      from: PHANTOM_SENDER,
      to: ["coder", "cleaner"],
      type: "note",
      nonForwarding: true,
      enqueuedAt: "2026-01-02T03:04:06.000Z",
      dequeuedAt: "2026-01-02T03:04:07.000Z",
      completedAt: "2026-01-02T03:04:08.000Z",
    };
    delete (handoff as Partial<Handoff>).commit;
    delete (handoff as Partial<Handoff>).taskBaseCommit;
    expect(parseHandoff(serializeHandoff(handoff))).toEqual(handoff);
  });

  it("keeps an empty body", () => {
    const handoff = { ...sample(), body: "" };
    expect(parseHandoff(serializeHandoff(handoff)).body).toBe("");
  });

  const tamper = (edit: (text: string) => string) => () =>
    parseHandoff(edit(serializeHandoff(sample())));

  it("rejects malformed input", () => {
    expect(tamper((t) => t.replace(/^id: .*\n/, ""))).toThrow(/missing header/i);
    expect(tamper((t) => `${t.split("\n\n")[0]}`)).toThrow(/blank line/i);
    expect(tamper((t) => `x: y\n${t}`)).toThrow(/unknown header/i);
    expect(tamper((t) => `id: other\n${t}`)).toThrow(/duplicate header/i);
    expect(tamper((t) => t.replace("commit: 0123456789", "commit: HEAD"))).toThrow(/commit/i);
    expect(tamper((t) => t.replace("from: coder", "from: co_der"))).toThrow(/role/i);
    expect(tamper((t) => t.replace("priority: 50", "priority: high"))).toThrow(/priority/i);
    expect(tamper((t) => t.replace("approved: false", "approved: maybe"))).toThrow(/approved/i);
    expect(tamper((t) => t.replace("type: git_handoff", "type: rumor"))).toThrow(/type/i);
    expect(tamper((t) => t.replace("task: add-login", "task: ../x"))).toThrow(/task name/i);
    expect(tamper((t) => t.replace(/created_at: .*/, "created_at: yesterday"))).toThrow(
      /created_at/,
    );
    expect(tamper((t) => t.replace("to: cleaner", "to: "))).toThrow(/to/);
  });

  it("requires a commit on a git handoff", () => {
    const handoff = sample();
    delete (handoff as Partial<Handoff>).commit;
    expect(() => serializeHandoff(handoff)).toThrow(/commit/i);
  });

  it("refuses header injection through the body or fields", () => {
    expect(() => serializeHandoff({ ...sample(), task: "a\nb" })).toThrow();
    expect(() => serializeHandoff({ ...sample(), to: ["a\nb"] })).toThrow();
  });
});

describe("handoff file names", () => {
  it("builds and parses names", () => {
    const name = handoffFileName({
      priority: 50,
      createdAt: "2026-01-02T03:04:05.678Z",
      seq: 12,
      from: "coder",
      to: ["cleaner", "qa"],
    });
    expect(name).toBe("50_20260102T030405Z_0012_from_coder_to_cleaner_qa.handoff");
    expect(parseHandoffFileName(name)).toEqual({
      priority: 50,
      stamp: "20260102T030405Z",
      seq: 12,
      from: "coder",
      to: ["cleaner", "qa"],
    });
  });

  it("maps the phantom sender to a safe token", () => {
    const name = handoffFileName({
      priority: 50,
      createdAt: "2026-01-02T03:04:05.678Z",
      seq: 1,
      from: PHANTOM_SENDER,
      to: ["coder"],
    });
    expect(name).toContain("_from_new-task_to_coder");
    expect(parseHandoffFileName(name)?.from).toBe(PHANTOM_SENDER);
  });

  it("ignores foreign files", () => {
    expect(parseHandoffFileName("notes.txt")).toBeUndefined();
    expect(parseHandoffFileName(".tmp-123")).toBeUndefined();
    expect(parseHandoffFileName("50_x_0001_from_a_to_b.handoff")).toBeUndefined();
  });
});
