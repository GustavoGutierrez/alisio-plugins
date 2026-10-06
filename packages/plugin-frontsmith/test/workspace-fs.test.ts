import { execFileSync } from "node:child_process";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeModuleResolver, NodeWorkspaceFs } from "../src/infrastructure/fs/workspace-fs.js";
import { GitCli } from "../src/infrastructure/git/git-cli.js";
import { ProcessExec } from "../src/infrastructure/process/process-exec.js";
import { type TempWorkspace, tempWorkspace } from "./helpers/workspace.js";

let ws: TempWorkspace | undefined;
afterEach(async () => {
  await ws?.cleanup();
  ws = undefined;
});

const FILES = {
  "src/a.ts": "a",
  "src/deep/b.tsx": "b",
  "node_modules/x/index.js": "x",
  "dist/out.js": "o",
  "build/o.js": "o",
  ".alisio/state.json": "{}",
  "coverage/c.json": "{}",
  "README.md": "r",
};

describe("NodeWorkspaceFs", () => {
  it("walks a plain directory skipping dependency and output folders", async () => {
    ws = await tempWorkspace(FILES);
    const fs = new NodeWorkspaceFs(ws.root);
    const listing = await fs.listFiles();
    expect(listing).toEqual({
      files: ["README.md", "src/a.ts", "src/deep/b.tsx"],
      truncated: false,
    });
    expect((await fs.listFiles({ roots: ["src/deep"] })).files).toEqual(["src/deep/b.tsx"]);
    expect((await fs.listFiles({ roots: ["nope"] })).files).toEqual([]);
  });

  it("uses git to honour .gitignore and drops files deleted from disk", async () => {
    ws = await tempWorkspace({ ...FILES, ".gitignore": "src/ignored.ts\n", "src/ignored.ts": "i" });
    execFileSync("git", ["init", "-q"], { cwd: ws.root });
    execFileSync("git", ["add", "-A", "-f"], { cwd: ws.root });
    const fs = new NodeWorkspaceFs(ws.root, { git: new GitCli(new ProcessExec()) });
    const { rm } = await import("node:fs/promises");
    await rm(join(ws.root, "README.md"));
    const files = (await fs.listFiles()).files;
    expect(files).toContain("src/a.ts");
    expect(files).not.toContain("README.md");
    expect(files).not.toContain("node_modules/x/index.js");
  });

  it("truncates beyond the file limit", async () => {
    ws = await tempWorkspace({ "a.ts": "1", "b.ts": "1", "c.ts": "1" });
    const fs = new NodeWorkspaceFs(ws.root, { maxFiles: 2 });
    const listing = await fs.listFiles();
    expect(listing.files).toHaveLength(2);
    expect(listing.truncated).toBe(true);
  });

  it("reads text, reports missing and too-large files", async () => {
    ws = await tempWorkspace({ "a.ts": "hello", "big.txt": "x".repeat(50) });
    const fs = new NodeWorkspaceFs(ws.root, { maxBytes: 10 });
    expect(await fs.read("a.ts")).toEqual({ kind: "text", text: "hello", size: 5 });
    expect(await fs.read("nope.ts")).toEqual({ kind: "missing" });
    expect(await fs.read("big.txt")).toEqual({ kind: "too-large", size: 50 });
    expect(await fs.exists("a.ts")).toBe(true);
    expect(await fs.exists("nope.ts")).toBe(false);
  });

  it("refuses paths that escape the workspace and does not follow symlinked directories", async () => {
    ws = await tempWorkspace({ "a.ts": "a" });
    const outside = await tempWorkspace({ "secret.ts": "s" });
    try {
      await symlink(outside.root, join(ws.root, "link"));
      const fs = new NodeWorkspaceFs(ws.root);
      await expect(fs.read("../x")).rejects.toThrow();
      await expect(fs.read("link/secret.ts")).rejects.toThrow(/symlink/);
      expect((await fs.listFiles()).files).toEqual(["a.ts"]);
    } finally {
      await outside.cleanup();
    }
  });
});

describe("NodeModuleResolver", () => {
  it("resolves a package declared in the workspace and reports an absent one", async () => {
    ws = await tempWorkspace({
      "node_modules/fake-pkg/package.json": '{"name":"fake-pkg","version":"1.0.0"}',
    });
    const resolver = new NodeModuleResolver();
    expect(resolver.resolvable(ws.root, "fake-pkg")).toBe(true);
    expect(resolver.resolvable(ws.root, "definitely-missing-pkg")).toBe(false);
  });
});
