import { describe, expect, it } from "vitest";
import {
  packageNameOf,
  type ResolveContext,
  resolveSpecifier,
} from "../src/domain/imports/resolve.js";

const ctx = (files: string[], extra: Partial<ResolveContext> = {}): ResolveContext => ({
  files: new Set(files),
  paths: [],
  packageImports: {},
  ...extra,
});

describe("resolveSpecifier", () => {
  const files = [
    "src/app/main.ts",
    "src/app/util.ts",
    "src/app/view.tsx",
    "src/app/dir/index.ts",
    "src/app/legacy.js",
    "src/shared/ui/Button.tsx",
    "src/shared/ui/index.ts",
    "src/app/Panel.vue",
    "src/data.json",
    "src/app/mod.mts",
  ];

  it("resolves relative specifiers with extensions and index files", () => {
    const c = ctx(files);
    const from = "src/app/main.ts";
    expect(resolveSpecifier(from, "./util", c)).toEqual({
      kind: "file",
      path: "src/app/util.ts",
      via: "relative",
    });
    expect(resolveSpecifier(from, "./view", c)).toMatchObject({ path: "src/app/view.tsx" });
    expect(resolveSpecifier(from, "./dir", c)).toMatchObject({ path: "src/app/dir/index.ts" });
    expect(resolveSpecifier(from, "./legacy", c)).toMatchObject({ path: "src/app/legacy.js" });
    expect(resolveSpecifier(from, "./Panel.vue", c)).toMatchObject({ path: "src/app/Panel.vue" });
    expect(resolveSpecifier(from, "../data.json", c)).toMatchObject({ path: "src/data.json" });
    expect(resolveSpecifier(from, "../shared/ui", c)).toMatchObject({
      path: "src/shared/ui/index.ts",
    });
  });

  it("maps TypeScript .js specifiers back to their sources", () => {
    const c = ctx(files);
    expect(resolveSpecifier("src/app/main.ts", "./util.js", c)).toMatchObject({
      path: "src/app/util.ts",
    });
    expect(resolveSpecifier("src/app/main.ts", "./view.jsx", c)).toMatchObject({
      path: "src/app/view.tsx",
    });
    expect(resolveSpecifier("src/app/main.ts", "./mod.mjs", c)).toMatchObject({
      path: "src/app/mod.mts",
    });
  });

  it("reports an unresolved relative import", () => {
    expect(resolveSpecifier("src/app/main.ts", "./missing", ctx(files))).toMatchObject({
      kind: "unresolved",
    });
    expect(resolveSpecifier("src/app/main.ts", "../../../outside", ctx(files))).toMatchObject({
      kind: "unresolved",
    });
  });

  it("resolves tsconfig paths with the longest matching pattern", () => {
    const c = ctx(files, {
      paths: [
        { pattern: "@/*", targets: ["src/*"] },
        { pattern: "@ui/*", targets: ["src/missing/*", "src/shared/ui/*"] },
        { pattern: "@ui", targets: ["src/shared/ui/index.ts"] },
      ],
    });
    expect(resolveSpecifier("src/app/main.ts", "@/app/util", c)).toEqual({
      kind: "file",
      path: "src/app/util.ts",
      via: "paths",
    });
    expect(resolveSpecifier("src/app/main.ts", "@ui/Button", c)).toMatchObject({
      path: "src/shared/ui/Button.tsx",
      via: "paths",
    });
    expect(resolveSpecifier("src/app/main.ts", "@ui", c)).toMatchObject({
      path: "src/shared/ui/index.ts",
    });
    expect(resolveSpecifier("src/app/main.ts", "@/nope", c)).toMatchObject({ kind: "unresolved" });
  });

  it("resolves bare specifiers through baseUrl before falling back to packages", () => {
    const c = ctx(files, { baseUrl: "src" });
    expect(resolveSpecifier("src/app/main.ts", "shared/ui/Button", c)).toEqual({
      kind: "file",
      path: "src/shared/ui/Button.tsx",
      via: "baseUrl",
    });
    expect(resolveSpecifier("src/app/main.ts", "react", c)).toEqual({
      kind: "package",
      name: "react",
    });
  });

  it("resolves package.json imports maps with wildcards and conditions", () => {
    const c = ctx(files, {
      packageImports: {
        "#util": "./src/app/util.ts",
        "#ui/*": { import: "./src/shared/ui/*.tsx", default: "./x" },
      },
    });
    expect(resolveSpecifier("src/app/main.ts", "#util", c)).toMatchObject({
      path: "src/app/util.ts",
      via: "package-imports",
    });
    expect(resolveSpecifier("src/app/main.ts", "#ui/Button", c)).toMatchObject({
      path: "src/shared/ui/Button.tsx",
    });
    expect(resolveSpecifier("src/app/main.ts", "#nope", c)).toMatchObject({ kind: "unresolved" });
  });

  it("classifies node built-ins and package names", () => {
    const c = ctx(files);
    expect(resolveSpecifier("src/app/main.ts", "node:fs", c)).toEqual({ kind: "builtin" });
    expect(resolveSpecifier("src/app/main.ts", "fs", c)).toEqual({ kind: "builtin" });
    expect(resolveSpecifier("src/app/main.ts", "@scope/pkg/sub/deep", c)).toEqual({
      kind: "package",
      name: "@scope/pkg",
    });
    expect(resolveSpecifier("src/app/main.ts", "lodash/fp", c)).toEqual({
      kind: "package",
      name: "lodash",
    });
    expect(resolveSpecifier("src/app/main.ts", "virtual:uno.css", c)).toEqual({
      kind: "package",
      name: "virtual:uno.css",
    });
  });

  it("extracts package names", () => {
    expect(packageNameOf("react")).toBe("react");
    expect(packageNameOf("react-dom/client")).toBe("react-dom");
    expect(packageNameOf("@a/b/c")).toBe("@a/b");
    expect(packageNameOf("@a")).toBe("@a");
  });
});
