import { describe, expect, it } from "vitest";
import { PHANTOM_SENDER } from "../src/domain/handoff.js";
import {
  approvalRequiredAfter,
  entryRole,
  isTerminalRole,
  joinSource,
  laneOrder,
  releasePlan,
  route,
  stageOf,
} from "../src/domain/pipeline.js";
import { makePack } from "./helpers.js";

const four = ["specifier", "coder", "refactorer", "architect"];

describe("pipeline routing", () => {
  it("enters at the master role and lists lanes with done last", () => {
    const pack = makePack(four);
    expect(entryRole(pack)).toBe("specifier");
    expect(laneOrder(pack)).toEqual([...four, "done"]);
  });

  it("routes a new task to the master role only", () => {
    expect(route(makePack(four), PHANTOM_SENDER)).toEqual({
      forward: "specifier",
      mergeOnly: [],
      terminal: false,
    });
  });

  it("forwards to the next role by default", () => {
    expect(route(makePack(four), "coder")).toEqual({
      forward: "refactorer",
      mergeOnly: [],
      terminal: false,
    });
  });

  it("adds a merge-only copy one role back with back-one", () => {
    const pack = makePack(four, {}, { refactorer: { propagation: "back-one" } });
    expect(route(pack, "refactorer")).toEqual({
      forward: "architect",
      mergeOnly: ["coder"],
      terminal: false,
    });
  });

  it("adds merge-only copies to every earlier role with back-all", () => {
    const pack = makePack(four, {}, { refactorer: { propagation: "back-all" } });
    expect(route(pack, "refactorer")).toEqual({
      forward: "architect",
      mergeOnly: ["specifier", "coder"],
      terminal: false,
    });
  });

  it("ignores back propagation when there is no earlier role", () => {
    const pack = makePack(four, {}, { specifier: { propagation: "back-all" } });
    expect(route(pack, "specifier").mergeOnly).toEqual([]);
  });

  it("broadcasts the last role's handoff to every other role and ends the task", () => {
    const pack = makePack(four);
    expect(isTerminalRole(pack, "architect")).toBe(true);
    expect(isTerminalRole(pack, "coder")).toBe(false);
    expect(route(pack, "architect")).toEqual({
      forward: undefined,
      mergeOnly: ["specifier", "coder", "refactorer"],
      terminal: true,
    });
  });

  it("treats a single-role pack as terminal with nobody to notify", () => {
    expect(route(makePack(["solo"]), "solo")).toEqual({
      forward: undefined,
      mergeOnly: [],
      terminal: true,
    });
  });

  it("rejects an unknown sender", () => {
    expect(() => route(makePack(four), "ghost")).toThrow(/unknown role/i);
  });

  it("holds the master handoff for approval only when the pack asks", () => {
    const gated = makePack(four, { approval: { after: "specifier" } });
    expect(approvalRequiredAfter(gated, "specifier")).toBe(true);
    expect(approvalRequiredAfter(gated, "coder")).toBe(false);
    expect(approvalRequiredAfter(makePack(four), "specifier")).toBe(false);
  });
});

describe("release plans with parallel stages", () => {
  const six = ["specifier", "coder", "cleaner", "architect", "hardener", "qa"];
  const pack = makePack(six, { parallel: [["architect", "hardener"]] });

  it("fans out to every role of the stage after the role before it", () => {
    expect(releasePlan(pack, "cleaner")).toEqual({
      to: ["architect", "hardener"],
      terminal: false,
    });
  });

  it("sends a stage role to the role after the stage and marks the stage", () => {
    expect(releasePlan(pack, "architect")).toMatchObject({
      to: ["qa"],
      stage: ["architect", "hardener"],
      terminal: false,
    });
    expect(releasePlan(pack, "hardener")).toMatchObject({ to: ["qa"] });
  });

  it("behaves like route for roles outside any stage", () => {
    expect(releasePlan(pack, "coder")).toEqual({ to: ["cleaner"], terminal: false });
    expect(releasePlan(pack, "qa")).toEqual({
      to: ["specifier", "coder", "cleaner", "architect", "hardener"],
      terminal: true,
    });
    expect(releasePlan(pack, PHANTOM_SENDER)).toEqual({ to: ["specifier"], terminal: false });
  });

  it("knows which role joins a stage", () => {
    expect(joinSource(pack, "qa")).toEqual(["architect", "hardener"]);
    expect(joinSource(pack, "coder")).toBeUndefined();
    expect(stageOf(pack, "hardener")).toEqual(["architect", "hardener"]);
    expect(stageOf(pack, "qa")).toBeUndefined();
  });
});
