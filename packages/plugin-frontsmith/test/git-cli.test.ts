import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitCli } from "../src/infrastructure/git/git-cli.js";
import { ProcessExec } from "../src/infrastructure/process/process-exec.js";
import { type TempWorkspace, tempWorkspace } from "./helpers/workspace.js";

const git = new GitCli(new ProcessExec());
let ws: TempWorkspace | undefined;
afterEach(async () => {
  await ws?.cleanup();
  ws = undefined;
});

const sh = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdio: "pipe" },
  ).toString();

async function repo(files: Record<string, string>): Promise<TempWorkspace> {
  const w = await tempWorkspace(files);
  sh(w.root, "init", "-q", "-b", "main");
  sh(w.root, "add", "-A");
  sh(w.root, "commit", "-q", "-m", "init");
  return w;
}

describe("GitCli", () => {
  it("detects whether a directory is a repository", async () => {
    ws = await tempWorkspace({ "a.txt": "x" });
    expect(await git.isRepo(ws.root)).toBe(false);
    sh(ws.root, "init", "-q");
    expect(await git.isRepo(ws.root)).toBe(true);
  });

  it("lists tracked and untracked files but not ignored ones", async () => {
    ws = await repo({ ".gitignore": "ignored/\n", "src/a.ts": "a", "ignored/x.ts": "x" });
    await ws.write("src/new.ts", "n");
    const files = await git.listFiles(ws.root);
    expect(files).toEqual([".gitignore", "src/a.ts", "src/new.ts"]);
  });

  it("reports changed files against HEAD including untracked files", async () => {
    ws = await repo({ "a.ts": "1", "b.ts": "1", "c.ts": "1" });
    await ws.write("a.ts", "2");
    await rm(join(ws.root, "b.ts"));
    await ws.write("d.ts", "new");
    const changes = await git.changedFiles(ws.root);
    expect(changes).toEqual([
      { path: "a.ts", status: "M" },
      { path: "b.ts", status: "D" },
      { path: "d.ts", status: "?" },
    ]);
  });

  it("diffs against an explicit base and returns numstat", async () => {
    ws = await repo({ "a.ts": "one\n" });
    const base = (await git.headSha(ws.root)) as string;
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    await writeFile(join(ws.root, "a.ts"), "one\ntwo\n");
    sh(ws.root, "add", "-A");
    sh(ws.root, "commit", "-q", "-m", "second");
    const diff = await git.diff(ws.root, base, ["a.ts"]);
    expect(diff).toContain("+two");
    expect(await git.numstat(ws.root, base)).toEqual([
      { path: "a.ts", added: 1, deleted: 0, binary: false },
    ]);
    const changed = await git.changedFiles(ws.root, base);
    expect(changed).toEqual([{ path: "a.ts", status: "M" }]);
  });

  it("shows a file at a revision and returns undefined when absent", async () => {
    ws = await repo({ "a.ts": "v1" });
    expect(await git.show(ws.root, "HEAD", "a.ts")).toBe("v1");
    expect(await git.show(ws.root, "HEAD", "missing.ts")).toBeUndefined();
  });

  it("works in a repository without commits and rejects option-like arguments", async () => {
    ws = await tempWorkspace({ "a.ts": "x" });
    sh(ws.root, "init", "-q");
    expect(await git.headSha(ws.root)).toBeUndefined();
    expect(await git.changedFiles(ws.root)).toEqual([{ path: "a.ts", status: "?" }]);
    await expect(git.show(ws.root, "--output=/scratch/x", "a.ts")).rejects.toThrow();
    await expect(git.diff(ws.root, "--help", [])).rejects.toThrow();
    await expect(git.diff(ws.root, undefined, ["--stat"])).rejects.toThrow();
  });
});
