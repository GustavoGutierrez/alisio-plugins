import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRelativePath,
  atomicWrite,
  canonicalJson,
  defaultState,
  ensureInside,
  readState,
  resolveInside,
  statePath,
  validateRootName,
  validateState,
  writeState,
} from "../src/storage.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thesis-storage-"));
  dirs.push(dir);
  return dir;
}

describe("path guards", () => {
  it("rejects unsafe relative paths", () => {
    for (const bad of ["", "../x", "a/../b", "/abs", "a\\b", "C:/x", "a//b", "./a", "a\0b"]) {
      expect(() => assertRelativePath(bad)).toThrow(/Unsafe relative path/);
    }
    expect(assertRelativePath("chapters/01-intro.md")).toBe("chapters/01-intro.md");
  });

  it("validates workspace root names", () => {
    expect(validateRootName("thesis")).toBe("thesis");
    expect(validateRootName("work/thesis-2026")).toBe("work/thesis-2026");
    for (const bad of [
      ".alisio",
      "a/.git",
      "node_modules",
      "../up",
      "/abs",
      "a b",
      "x".repeat(70),
    ]) {
      expect(() => validateRootName(bad)).toThrow();
    }
  });

  it("resolves inside a base and refuses escapes", async () => {
    const base = await temp();
    expect(resolveInside(base, "a/b.txt")).toBe(join(base, "a/b.txt"));
    expect(() => resolveInside(base, "../x")).toThrow();
    const outside = await temp();
    await symlink(outside, join(base, "link"));
    await expect(ensureInside(base, join(base, "link", "file"))).rejects.toThrow(/escapes/);
    await expect(ensureInside(base, join(base, "fresh", "file"))).resolves.toBeUndefined();
  });
});

describe("atomic writes", () => {
  it("writes files 0600 and directories 0700 without leaving temp files", async () => {
    const base = await temp();
    const target = join(base, "deep", "dir", "file.json");
    await atomicWrite(target, "{}\n");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect((await stat(join(base, "deep"))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(base, "deep", "dir"))).toEqual(["file.json"]);
    await atomicWrite(target, "[]\n");
    expect(await readFile(target, "utf8")).toBe("[]\n");
  });

  it("emits canonical JSON with sorted keys and a trailing newline", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });
});

describe("state", () => {
  it("round-trips a default state", async () => {
    const workspace = await temp();
    const state = defaultState("thesis");
    await writeState(workspace, state);
    expect(statePath(workspace)).toBe(join(workspace, ".alisio", "thesis", "state.json"));
    expect(await readState(workspace)).toEqual(state);
    expect(await readState(await temp())).toBeUndefined();
  });

  it("normalizes additive fields on older states", () => {
    const old = {
      schemaVersion: 1,
      root: "thesis",
      phase: "intake",
      humanGates: { A: { status: "pending" } },
      sections: {},
      counters: { evidence: 0, claim: 0, finding: 0 },
    };
    const state = validateState(old);
    expect(state.intake).toEqual({ answers: {}, completedRounds: [] });
    expect(Object.keys(state.humanGates).sort()).toEqual(["A", "B", "C", "OUTLINE"]);
  });

  it("rejects malformed states", () => {
    const base = defaultState("thesis");
    const cases: unknown[] = [
      null,
      { ...base, schemaVersion: 2 },
      { ...base, phase: "nope" },
      { ...base, root: "../x" },
      { ...base, counters: { evidence: -1, claim: 0, finding: 0 } },
      { ...base, sections: { bad: { status: "planned" } } },
      { ...base, sections: { "SEC-01": { status: "weird" } } },
      { ...base, humanGates: { ...base.humanGates, A: { status: "maybe" } } },
      { ...base, intake: { answers: { a: 1 }, completedRounds: [] } },
      { ...base, pendingQuestions: { round: 1, createdAt: "x", questions: [] } },
    ];
    for (const value of cases) expect(() => validateState(value)).toThrow(/Invalid thesis state/);
  });

  it("fails loudly on corrupt JSON", async () => {
    const workspace = await temp();
    await mkdir(join(workspace, ".alisio", "thesis"), { recursive: true });
    await atomicWrite(statePath(workspace), "{nope");
    await expect(readState(workspace)).rejects.toThrow(/Invalid thesis state JSON/);
  });
});
