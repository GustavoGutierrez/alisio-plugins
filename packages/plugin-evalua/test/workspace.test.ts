import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allocateExamFolder,
  evaluaRootPath,
  examFolderName,
  formatExamNumber,
  listExamFolders,
  nextExamNumber,
  slugify,
  validateExamFolderName,
  validateRootName,
  validateSlug,
} from "../src/workspace.js";

const dirs: string[] = [];
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "evalua-ws-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("root name", () => {
  it("accepts simple relative roots and rejects unsafe ones", () => {
    expect(validateRootName("evalua")).toBe("evalua");
    expect(validateRootName("docs/evalua")).toBe("docs/evalua");
    for (const bad of [
      "",
      "/abs",
      "../x",
      ".alisio",
      "a/.git",
      "a/node_modules",
      "a b",
      "es.",
      "a/b/c/d/e",
    ]) {
      expect(() => validateRootName(bad), bad).toThrow();
    }
  });

  it("resolves inside the workspace and blocks symlink escapes", async () => {
    const ws = await scratch();
    const outside = await scratch();
    expect(await evaluaRootPath(ws, "evalua")).toBe(join(ws, "evalua"));
    await symlink(outside, join(ws, "evil"));
    await expect(evaluaRootPath(ws, "evil")).rejects.toThrow(/escapes/);
  });
});

describe("slugs", () => {
  it("builds ASCII lowercase hyphen slugs without accents", () => {
    expect(slugify("CONJUNTO DE LOS NÚMEROS RACIONALES (Q)", "Séptimo")).toBe(
      "conjunto-de-los-numeros-racionales-q-septimo",
    );
  });

  it("caps length at 48 without trailing hyphen", () => {
    const slug = slugify("a ".repeat(60), "Octavo");
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith("-")).toBe(false);
    expect(validateSlug(slug)).toBe(slug);
  });

  it("falls back when nothing usable remains", () => {
    expect(slugify("¿¿??", "")).toBe("examen");
  });

  it("validates slugs and folder names", () => {
    expect(() => validateSlug("-x")).toThrow();
    expect(() => validateSlug("X")).toThrow();
    expect(() => validateSlug("a".repeat(49))).toThrow();
    expect(validateExamFolderName("01-numeros")).toBe("01-numeros");
    expect(validateExamFolderName("100-numeros")).toBe("100-numeros");
    for (const bad of ["1-x", "01_x", "01-", "01-X", "../01-x", "01-x/y"]) {
      expect(() => validateExamFolderName(bad), bad).toThrow(/EVL-EXM-005/);
    }
  });
});

describe("exam numbering", () => {
  it("formats numbers with 2 digits, 3 beyond 99", () => {
    expect(formatExamNumber(1)).toBe("01");
    expect(formatExamNumber(99)).toBe("99");
    expect(formatExamNumber(100)).toBe("100");
    expect(examFolderName(3, "algebra-octavo")).toBe("03-algebra-octavo");
  });

  it("is highest + 1, ignoring non-exam names, and never reuses a number below the floor", () => {
    expect(nextExamNumber([], 0)).toBe(1);
    expect(nextExamNumber(["01-a", "02-b"], 0)).toBe(3);
    expect(nextExamNumber(["01-a", "05-b", "notes", "x-1"], 0)).toBe(6);
    // gap is not refilled
    expect(nextExamNumber(["01-a", "04-b"], 0)).toBe(5);
    // a deleted highest folder is not reused thanks to the recorded floor
    expect(nextExamNumber(["01-a"], 3)).toBe(4);
  });

  it("lists exam folders from disk, tolerating a missing exams dir", async () => {
    const root = await scratch();
    expect(await listExamFolders(root)).toEqual([]);
    await mkdir(join(root, "exams", "01-a"), { recursive: true });
    await mkdir(join(root, "exams", "02-b"));
    await mkdir(join(root, "exams", "junk"));
    expect(await listExamFolders(root)).toEqual(["01-a", "02-b"]);
  });

  it("allocates consecutive folders and never reuses a deleted number", async () => {
    const ws = await scratch();
    const root = await evaluaRootPath(ws, "evalua");
    const first = await allocateExamFolder(ws, root, "numeros-septimo", 0);
    expect(first).toMatchObject({ number: 1, name: "01-numeros-septimo" });
    const second = await allocateExamFolder(ws, root, "algebra-octavo", first.number);
    expect(second.number).toBe(2);
    await rm(second.path, { recursive: true });
    const third = await allocateExamFolder(ws, root, "otro", second.number);
    expect(third.number).toBe(3);
  });

  it("refuses to allocate through a symlinked exams directory", async () => {
    const ws = await scratch();
    const outside = await scratch();
    const root = await evaluaRootPath(ws, "evalua");
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "exams"));
    await expect(allocateExamFolder(ws, root, "x", 0)).rejects.toThrow(/escapes/);
  });

  it("rejects an invalid slug", async () => {
    const ws = await scratch();
    const root = await evaluaRootPath(ws, "evalua");
    await expect(allocateExamFolder(ws, root, "../x", 0)).rejects.toThrow();
  });
});
