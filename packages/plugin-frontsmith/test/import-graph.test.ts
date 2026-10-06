import { afterEach, describe, expect, it } from "vitest";
import { DefaultFileAnalyzer } from "../src/infrastructure/analysis/file-analyzer.js";
import {
  buildImportGraph,
  loadResolveContext,
} from "../src/infrastructure/analysis/import-graph.js";
import { NodeWorkspaceFs } from "../src/infrastructure/fs/workspace-fs.js";
import { type TempWorkspace, tempWorkspace } from "./helpers/workspace.js";

let ws: TempWorkspace | undefined;
afterEach(async () => {
  await ws?.cleanup();
  ws = undefined;
});

const analyze = async (fs: NodeWorkspaceFs) => {
  const analyzer = new DefaultFileAnalyzer();
  const { files } = await fs.listFiles();
  const analyses = [];
  for (const path of files) {
    const read = await fs.read(path);
    if (read.kind === "text") analyses.push(analyzer.analyze(path, read.text));
  }
  return { files, analyses };
};

describe("import graph", () => {
  it("resolves relative, alias, package-import, baseUrl and package edges across script and sfc files", async () => {
    ws = await tempWorkspace({
      "tsconfig.base.json": `{ // base
        "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["src/shared/*"], }, },
      }`,
      "tsconfig.json": `{ "extends": "./tsconfig.base.json", "compilerOptions": { "paths": { "@/*": ["src/*"] } } }`,
      "package.json": `{ "name": "x", "imports": { "#cfg": "./src/config.ts" } }`,
      "src/main.ts": `import a from "./a";\nimport type { T } from "@/types";\nimport cfg from "#cfg";\nimport { z } from "zod";\nimport fs from "node:fs";\nimport nope from "./missing";\nimport v from "./View.vue";\nimport u from "src/util";`,
      "src/a.ts": "export default 1;",
      "src/types.ts": "export type T = 1;",
      "src/config.ts": "export default {};",
      "src/util.ts": "export default 2;",
      "src/View.vue": `<script setup lang="ts">\nimport b from "./a";\n</script>\n<template><i/></template>`,
    });
    const fs = new NodeWorkspaceFs(ws.root);
    const { files, analyses } = await analyze(fs);
    const context = await loadResolveContext(fs, files);
    expect(context.baseUrl).toBe("");
    expect(context.paths.map((p) => p.pattern)).toEqual(["@/*"]);
    const graph = buildImportGraph(analyses, context);
    const main = graph.byFile.get("src/main.ts") ?? [];
    expect(
      main.map((e) => [
        e.specifier,
        e.resolution.kind === "file"
          ? `${e.resolution.path}:${e.resolution.via}`
          : e.resolution.kind,
        e.typeOnly,
      ]),
    ).toEqual([
      ["./a", "src/a.ts:relative", false],
      ["@/types", "src/types.ts:paths", true],
      ["#cfg", "src/config.ts:package-imports", false],
      ["zod", "package", false],
      ["node:fs", "builtin", false],
      ["./missing", "unresolved", false],
      ["./View.vue", "src/View.vue:relative", false],
      ["src/util", "src/util.ts:baseUrl", false],
    ]);
    expect(graph.byFile.get("src/View.vue")?.[0]).toMatchObject({ specifier: "./a", line: 2 });
    expect(graph.edges.every((e) => files.includes(e.from))).toBe(true);
  });

  it("works without any tsconfig or package.json", async () => {
    ws = await tempWorkspace({ "a.js": `import "./b.js";`, "b.js": "" });
    const fs = new NodeWorkspaceFs(ws.root);
    const { files, analyses } = await analyze(fs);
    const context = await loadResolveContext(fs, files);
    expect(context.paths).toEqual([]);
    expect(context.baseUrl).toBeUndefined();
    const graph = buildImportGraph(analyses, context);
    expect(graph.edges[0]?.resolution).toMatchObject({ kind: "file", path: "b.js" });
  });

  it("tolerates a broken tsconfig", async () => {
    ws = await tempWorkspace({ "tsconfig.json": "{ not json", "a.ts": "" });
    const fs = new NodeWorkspaceFs(ws.root);
    const { files } = await analyze(fs);
    const context = await loadResolveContext(fs, files);
    expect(context.paths).toEqual([]);
  });
});
