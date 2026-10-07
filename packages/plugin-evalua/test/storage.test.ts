import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertRelativePath,
  atomicWrite,
  canonicalJson,
  emptyState,
  ensureInside,
  readState,
  resolveInside,
  stateFile,
  validateState,
  writeState,
} from "../src/storage.js";

const dirs: string[] = [];
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "evalua-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("path helpers", () => {
  it("rejects unsafe relative paths", () => {
    for (const bad of ["", "/abs", "a/../b", "a//b", "./a", "a\\b", "C:x", "a\0b"]) {
      expect(() => assertRelativePath(bad)).toThrow(/Unsafe relative path/);
    }
    expect(assertRelativePath("a/b.yaml")).toBe("a/b.yaml");
  });

  it("resolves inside a base lexically", () => {
    expect(resolveInside("/scratch/p", "exams/01-x")).toBe("/scratch/p/exams/01-x");
    expect(() => resolveInside("/scratch/p", "../x")).toThrow();
  });

  it("blocks symlink escapes via realpath", async () => {
    const base = await scratch();
    const outside = await scratch();
    await symlink(outside, join(base, "link"));
    await expect(ensureInside(base, join(base, "link", "file"))).rejects.toThrow(/escapes/);
    await mkdir(join(base, "ok"));
    await expect(ensureInside(base, join(base, "ok", "new", "file"))).resolves.toBeUndefined();
  });
});

describe("atomic writes", () => {
  it("writes with mode 0600 and leaves no temporary file", async () => {
    const base = await scratch();
    const target = join(base, "a", "b.json");
    await atomicWrite(target, "{}\n");
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(base, "a"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("accepts a mode and binary content", async () => {
    const base = await scratch();
    const target = join(base, "logo.png");
    await atomicWrite(target, new Uint8Array([1, 2, 3]), 0o644);
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });

  it("canonicalJson sorts keys deeply", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } })).toBe(
      '{\n  "a": {\n    "c": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ],\n    "d": 1\n  },\n  "b": 1\n}\n',
    );
  });
});

describe("state", () => {
  it("returns undefined when there is no state", async () => {
    expect(await readState(await scratch())).toBeUndefined();
  });

  it("round-trips and stores under .alisio/evalua/state.json", async () => {
    const base = await scratch();
    const state = emptyState("evalua", "2026-01-01T00:00:00.000Z");
    await writeState(base, state);
    expect(stateFile(base)).toBe(join(base, ".alisio", "evalua", "state.json"));
    expect(await readState(base)).toEqual(state);
    expect((await stat(stateFile(base))).mode & 0o777).toBe(0o600);
  });

  it("rejects an unknown schemaVersion with an actionable message", () => {
    expect(() => validateState({ schemaVersion: 99 })).toThrow(/schemaVersion 99.*upgrade/is);
  });

  it("is tolerant of unknown extra fields and fills defaults", () => {
    const state = validateState({
      schemaVersion: 1,
      root: "evalua",
      future: { x: 1 },
    });
    expect(state.lastExamNumber).toBe(0);
    expect(state.exams).toEqual({});
    expect(state.activeExamId).toBeNull();
  });

  it("rejects an invalid root and malformed JSON", async () => {
    expect(() => validateState({ schemaVersion: 1, root: "../x" })).toThrow();
    const base = await scratch();
    await mkdir(join(base, ".alisio", "evalua"), { recursive: true });
    await writeFile(stateFile(base), "{nope");
    await expect(readState(base)).rejects.toThrow(/not valid JSON/);
  });

  it("drops a malformed pending round instead of crashing", () => {
    const state = validateState({
      schemaVersion: 1,
      root: "evalua",
      interview: { answers: {}, completedRounds: [], pending: { round: 5 } },
    });
    expect(state.interview?.pending).toBeUndefined();
  });
});
