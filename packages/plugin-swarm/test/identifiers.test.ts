import { describe, expect, it } from "vitest";
import {
  assertRelativePath,
  makeTaskId,
  slugify,
  validateCommit,
  validateProjectName,
  validateRole,
  validateTaskId,
  validateTaskName,
} from "../src/domain/identifiers.js";

describe("identifier validators", () => {
  it("accepts well-formed project and task names", () => {
    expect(validateProjectName("my-app-2")).toBe("my-app-2");
    expect(validateTaskName("add-login")).toBe("add-login");
  });

  it.each(["", "My", "-a", "a_b", "a/b", "a b", "a".repeat(49), "é"])(
    "rejects project name %j",
    (name) => {
      expect(() => validateProjectName(name)).toThrow(/project name/i);
      expect(() => validateTaskName(name)).toThrow(/task name/i);
    },
  );

  it("accepts roles without underscores or slashes", () => {
    expect(validateRole("coder")).toBe("coder");
    expect(validateRole("qa-2")).toBe("qa-2");
  });

  it.each(["", "1a", "a_b", "a/b", "A", "a".repeat(25), "-a"])("rejects role %j", (role) => {
    expect(() => validateRole(role)).toThrow(/role/i);
  });

  it("derives slugs from free-form text", () => {
    expect(slugify("Add Login Form!")).toBe("add-login-form");
    expect(slugify("  --Hello__World--  ")).toBe("hello-world");
    expect(slugify("x".repeat(80)).length).toBe(48);
    expect(slugify("***")).toBe("");
  });

  it("builds and validates task ids", () => {
    const id = makeTaskId(new Date("2026-01-02T03:04:05.678Z"), "add-login");
    expect(id).toBe("20260102T030405678000Z-add-login");
    expect(makeTaskId(new Date("2026-01-02T03:04:05.678Z"), "add-login", 7)).toBe(
      "20260102T030405678007Z-add-login",
    );
    expect(validateTaskId(id)).toBe(id);
    expect(() => validateTaskId("2026-add")).toThrow(/task id/i);
    expect(() => makeTaskId(new Date(), "Bad Slug")).toThrow(/task name/i);
    expect(() => makeTaskId(new Date(), "ok", 1000)).toThrow(/sequence/i);
  });

  it("validates commits as exactly ten lowercase hex characters", () => {
    expect(validateCommit("0123456789")).toBe("0123456789");
    for (const bad of ["012345678", "01234567890", "0123456789A", "zzzzzzzzzz", "HEAD", ""]) {
      expect(() => validateCommit(bad)).toThrow(/commit/i);
    }
  });

  it("rejects unsafe relative paths", () => {
    expect(assertRelativePath("tasks/a.md")).toBe("tasks/a.md");
    for (const bad of ["", "/x", "../x", "a/../b", "a//b", "./a", "a\\b", "C:x", "a\0b", "a/"]) {
      expect(() => assertRelativePath(bad)).toThrow(/relative path/i);
    }
  });
});
