import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitWorktreeIsolation } from "../src/adapters/git-worktree.js";
import { tempDir } from "./helpers.js";

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

async function newProject(masterRole = "coder") {
  const base = await tempDir();
  const projectDir = join(base, "proj");
  const isolation = new GitWorktreeIsolation();
  await isolation.initProject(projectDir, { mission: "Build a thing", masterRole });
  return { base, projectDir, isolation };
}

async function commitFile(dir: string, file: string, content: string, message: string) {
  await writeFile(join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-m", message);
  return git(dir, "rev-parse", "HEAD").slice(0, 10);
}

describe("GitWorktreeIsolation.initProject", () => {
  it("creates a repository on master with the mission and ignore rules committed", async () => {
    const { projectDir } = await newProject();
    expect(git(projectDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
    expect(await readFile(join(projectDir, "mission.md"), "utf8")).toContain("Build a thing");
    const ignore = await readFile(join(projectDir, ".gitignore"), "utf8");
    expect(ignore).toContain(".alisio/swarm/");
    expect(ignore).toContain(".worktrees/");
    expect(git(projectDir, "status", "--porcelain")).toBe("");
    expect(git(projectDir, "ls-files").split("\n").sort()).toEqual([".gitignore", "mission.md"]);
  });

  it("installs an executable commit-msg hook that appends the author role", async () => {
    const { projectDir } = await newProject("specifier");
    const hook = join(projectDir, ".git", "hooks", "commit-msg");
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    await commitFile(projectDir, "a.txt", "a", "feat: add a");
    expect(git(projectDir, "log", "-1", "--format=%B")).toContain("By specifier.");
  });

  it("refuses to initialise over an existing repository", async () => {
    const { projectDir, isolation } = await newProject();
    await expect(
      isolation.initProject(projectDir, { mission: "x", masterRole: "coder" }),
    ).rejects.toThrow(/already/i);
  });

  it("rejects an invalid master role before touching the disk", async () => {
    const base = await tempDir();
    await expect(
      new GitWorktreeIsolation().initProject(join(base, "p"), { mission: "m", masterRole: "a;b" }),
    ).rejects.toThrow(/role/i);
    expect(existsSync(join(base, "p"))).toBe(false);
  });
});

describe("GitWorktreeIsolation.prepareRole", () => {
  it("uses the main checkout for the master role", async () => {
    const { projectDir, isolation } = await newProject();
    expect(await isolation.prepareRole(projectDir, "proj", { role: "coder", master: true })).toBe(
      projectDir,
    );
  });

  it("creates one worktree and branch per other role, idempotently", async () => {
    const { projectDir, isolation } = await newProject();
    const placement = { role: "cleaner", master: false };
    const dir = await isolation.prepareRole(projectDir, "proj", placement);
    expect(dir).toBe(join(projectDir, ".worktrees", "cleaner"));
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("swarm/proj/cleaner");
    expect(await isolation.prepareRole(projectDir, "proj", placement)).toBe(dir);
    expect(git(projectDir, "worktree", "list")).toContain(".worktrees/cleaner");
  });

  it("commits made in a worktree carry the role byline", async () => {
    const { projectDir, isolation } = await newProject();
    const dir = await isolation.prepareRole(projectDir, "proj", { role: "cleaner", master: false });
    await commitFile(dir, "c.txt", "c", "refactor: tidy");
    expect(git(dir, "log", "-1", "--format=%B")).toContain("By cleaner.");
  });

  it("rejects hostile project and role names", async () => {
    const { projectDir, isolation } = await newProject();
    await expect(
      isolation.prepareRole(projectDir, "../x", { role: "cleaner", master: false }),
    ).rejects.toThrow(/project name/i);
    await expect(
      isolation.prepareRole(projectDir, "proj", { role: "../x", master: false }),
    ).rejects.toThrow(/role/i);
  });
});

describe("GitWorktreeIsolation commits and merges", () => {
  it("reads HEAD as ten characters and checks commit existence", async () => {
    const { projectDir, isolation } = await newProject();
    const head = await isolation.headCommit(projectDir);
    expect(head).toMatch(/^[0-9a-f]{10}$/);
    expect(await isolation.hasCommit(projectDir, head)).toBe(true);
    expect(await isolation.hasCommit(projectDir, "0000000000")).toBe(false);
    await expect(isolation.hasCommit(projectDir, "--output=x")).rejects.toThrow(/commit/i);
  });

  it("reports an ancestor commit as already merged", async () => {
    const { projectDir, isolation } = await newProject();
    const head = await isolation.headCommit(projectDir);
    expect(await isolation.merge(projectDir, head)).toEqual({ status: "already" });
  });

  it("merges a commit from another role's worktree into the main checkout", async () => {
    const { projectDir, isolation } = await newProject();
    const dir = await isolation.prepareRole(projectDir, "proj", { role: "cleaner", master: false });
    const commit = await commitFile(dir, "clean.txt", "clean", "refactor: clean");
    expect((await isolation.merge(projectDir, commit)).status).toBe("merged");
    expect(await readFile(join(projectDir, "clean.txt"), "utf8")).toBe("clean");
    expect((await isolation.merge(projectDir, commit)).status).toBe("already");
  });

  it("reports conflicts and leaves them for the receiving role to resolve", async () => {
    const { projectDir, isolation } = await newProject();
    const dir = await isolation.prepareRole(projectDir, "proj", { role: "cleaner", master: false });
    await commitFile(projectDir, "shared.txt", "master side", "feat: master edit");
    const theirs = await commitFile(dir, "shared.txt", "cleaner side", "refactor: cleaner edit");
    const result = await isolation.merge(projectDir, theirs);
    expect(result).toEqual({ status: "conflict", files: ["shared.txt"] });
    expect(await isolation.conflicts(projectDir)).toEqual(["shared.txt"]);
  });

  it("aborts a conflicted merge and restores a clean tree", async () => {
    const { projectDir, isolation } = await newProject();
    const dir = await isolation.prepareRole(projectDir, "proj", { role: "cleaner", master: false });
    await commitFile(projectDir, "shared.txt", "master side", "feat: master edit");
    const theirs = await commitFile(dir, "shared.txt", "cleaner side", "refactor: cleaner edit");
    await isolation.merge(projectDir, theirs);
    await isolation.abortMerge(projectDir);
    expect(await isolation.conflicts(projectDir)).toEqual([]);
    expect(git(projectDir, "status", "--porcelain")).toBe("");
    await expect(isolation.abortMerge(projectDir)).resolves.toBeUndefined();
  });

  it("reports a merge that git refuses for another reason", async () => {
    const { projectDir, isolation } = await newProject();
    const dir = await isolation.prepareRole(projectDir, "proj", { role: "cleaner", master: false });
    const theirs = await commitFile(dir, "untracked.txt", "theirs", "feat: add file");
    await writeFile(join(projectDir, "untracked.txt"), "local only");
    const result = await isolation.merge(projectDir, theirs);
    expect(result.status).toBe("error");
    expect(result.message).toBeTruthy();
  });
});

describe("GitWorktreeIsolation.cloneProject", () => {
  it("clones a repository, ignores swarm state locally and installs the hook", async () => {
    const source = await newProject();
    const base = await tempDir();
    const target = join(base, "clone");
    await new GitWorktreeIsolation().cloneProject(source.projectDir, target, {
      masterRole: "coder",
    });
    expect(git(target, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
    await mkdir(join(target, ".alisio", "swarm"), { recursive: true });
    await mkdir(join(target, ".worktrees"), { recursive: true });
    await writeFile(join(target, ".alisio", "swarm", "x"), "x");
    expect(git(target, "status", "--porcelain")).toBe("");
    expect(existsSync(join(target, ".git", "hooks", "commit-msg"))).toBe(true);
  });

  it("refuses an existing destination", async () => {
    const source = await newProject();
    const target = await tempDir();
    await expect(
      new GitWorktreeIsolation().cloneProject(source.projectDir, target, { masterRole: "coder" }),
    ).rejects.toThrow(/exists/i);
  });

  it("surfaces a failed clone without leaving a directory behind", async () => {
    const base = await tempDir();
    const target = join(base, "clone");
    await expect(
      new GitWorktreeIsolation().cloneProject(join(base, "missing-repo"), target, {
        masterRole: "coder",
      }),
    ).rejects.toThrow(/clone/i);
    expect(existsSync(target)).toBe(false);
  });
});

describe("GitWorktreeIsolation snapshots and restore", () => {
  it("snapshots a commit under a swarm ref and keeps it after a restore", async () => {
    const { projectDir, isolation } = await newProject();
    const base = await isolation.headCommit(projectDir);
    const rejected = await commitFile(projectDir, "work.txt", "rejected work\n", "feat: work");
    await isolation.snapshotRef(projectDir, "refs/swarm/rejected/add-login", rejected);
    await isolation.restoreTo(projectDir, base);
    expect(await isolation.headCommit(projectDir)).toBe(base);
    expect(existsSync(join(projectDir, "work.txt"))).toBe(false);
    expect(git(projectDir, "rev-parse", "refs/swarm/rejected/add-login").slice(0, 10)).toBe(
      rejected,
    );
  });

  it("refuses to restore over uncommitted changes", async () => {
    const { projectDir, isolation } = await newProject();
    const base = await isolation.headCommit(projectDir);
    await commitFile(projectDir, "work.txt", "x\n", "feat: work");
    await writeFile(join(projectDir, "work.txt"), "edited\n");
    await expect(isolation.restoreTo(projectDir, base)).rejects.toThrow(/uncommitted/i);
    expect(await readFile(join(projectDir, "work.txt"), "utf8")).toBe("edited\n");
  });

  it("rejects hostile refs and commits", async () => {
    const { projectDir, isolation } = await newProject();
    const head = await isolation.headCommit(projectDir);
    await expect(isolation.snapshotRef(projectDir, "refs/heads/master", head)).rejects.toThrow(
      /ref/i,
    );
    await expect(
      isolation.snapshotRef(projectDir, "refs/swarm/rejected/../x", head),
    ).rejects.toThrow(/ref/i);
    await expect(isolation.restoreTo(projectDir, "--hard")).rejects.toThrow(/commit/i);
  });
});

describe("GitWorktreeIsolation read-only views", () => {
  it("lists changed files, shows the diff and reads a file at a commit", async () => {
    const { projectDir, isolation } = await newProject();
    const base = await isolation.headCommit(projectDir);
    await mkdir(join(projectDir, "specs"), { recursive: true });
    await writeFile(join(projectDir, "specs", "a b.feature"), "Feature: login\n");
    git(projectDir, "add", "specs");
    git(projectDir, "commit", "-m", "spec");
    const head = await isolation.headCommit(projectDir);
    expect(await isolation.changedFiles(projectDir, base, head)).toEqual(["specs/a b.feature"]);
    expect(await isolation.diff(projectDir, base, head)).toContain("+Feature: login");
    expect(await isolation.readFileAt(projectDir, head, "specs/a b.feature")).toBe(
      "Feature: login\n",
    );
  });

  it("diffs a root-relative commit when no base is known", async () => {
    const { projectDir, isolation } = await newProject();
    await writeFile(join(projectDir, "x.md"), "hello\n");
    git(projectDir, "add", "x.md");
    git(projectDir, "commit", "-m", "x");
    const head = await isolation.headCommit(projectDir);
    expect(await isolation.diff(projectDir, undefined, head)).toContain("+hello");
    expect(await isolation.changedFiles(projectDir, undefined, head)).toEqual(["x.md"]);
  });

  it("returns undefined for a missing file and rejects hostile input", async () => {
    const { projectDir, isolation } = await newProject();
    const head = await isolation.headCommit(projectDir);
    expect(await isolation.readFileAt(projectDir, head, "nope.md")).toBeUndefined();
    await expect(isolation.readFileAt(projectDir, head, "../etc/passwd")).rejects.toThrow(/path/i);
    await expect(isolation.readFileAt(projectDir, "--output=x", "a.md")).rejects.toThrow(/commit/i);
    await expect(isolation.diff(projectDir, "--stat", head)).rejects.toThrow(/commit/i);
  });
});
