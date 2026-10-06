import { describe, expect, it } from "vitest";
import { compileGlob, GlobError, matchAny, matchGlob } from "../src/domain/glob.js";

describe("glob", () => {
  it("matches * within one segment and ** across segments", () => {
    expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(matchGlob("src/**/*.ts", "src/a/b/c.ts")).toBe(true);
    expect(matchGlob("src/**/*.ts", "src/c.ts")).toBe(true);
    expect(matchGlob("**/*.css", "a.css")).toBe(true);
    expect(matchGlob("**/*.css", "x/y/a.css")).toBe(true);
    expect(matchGlob("src/**", "src/a/b")).toBe(true);
    expect(matchGlob("src/**", "other/a")).toBe(false);
  });

  it("supports ? and character classes", () => {
    expect(matchGlob("a?.ts", "ab.ts")).toBe(true);
    expect(matchGlob("a?.ts", "a/.ts")).toBe(false);
    expect(matchGlob("file[abc].js", "fileb.js")).toBe(true);
    expect(matchGlob("file[abc].js", "filed.js")).toBe(false);
    expect(matchGlob("v[0-9].md", "v7.md")).toBe(true);
  });

  it("supports brace alternatives including nesting", () => {
    expect(matchGlob("**/*.{css,scss,less}", "x/a.scss")).toBe(true);
    expect(matchGlob("**/*.{css,scss,less}", "x/a.ts")).toBe(false);
    expect(matchGlob("src/{a,b/{c,d}}.ts", "src/b/d.ts")).toBe(true);
    expect(matchGlob("src/{a,b/{c,d}}.ts", "src/b/e.ts")).toBe(false);
  });

  it("escapes regular expression metacharacters in literals", () => {
    expect(matchGlob("a+b(c).ts", "a+b(c).ts")).toBe(true);
    expect(matchGlob("a.ts", "aXts")).toBe(false);
  });

  it("matches any of several patterns and compiles once", () => {
    expect(matchAny(["**/*.ts", "**/*.tsx"], "a/b.tsx")).toBe(true);
    expect(matchAny([], "a")).toBe(false);
    const test = compileGlob("**/__snapshots__/**");
    expect(test("a/__snapshots__/x.snap")).toBe(true);
    expect(test("a/x.snap")).toBe(false);
  });

  it("rejects negation, backslashes, absolute and unbalanced patterns", () => {
    for (const bad of ["!src/**", "a\\b", "/abs/**", "src/{a,b", "src/[abc", "[!a]x", "[^a]x", ""])
      expect(() => compileGlob(bad)).toThrow(GlobError);
  });

  it("only matches POSIX relative paths", () => {
    expect(matchGlob("**", "a\\b")).toBe(false);
    expect(matchGlob("**", "/abs")).toBe(false);
  });
});
