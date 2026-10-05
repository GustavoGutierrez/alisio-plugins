import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertRelativePath,
  validateCommit,
  validateProjectName,
  validateRole,
} from "../domain/identifiers.js";
import type { Isolation, MergeResult, RolePlacement } from "../ports/isolation.js";
import { atomicWrite, ensureIgnoreEntries } from "../storage.js";

const IGNORE_ENTRIES = [".alisio/swarm/", ".worktrees/"];
const COORDINATOR_IDENTITY = [
  "-c",
  "user.name=Swarm Coordinator",
  "-c",
  "user.email=swarm@localhost.invalid",
];

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  timeoutMs?: number;
}

/** Only these variables reach git: no secrets, no shell state (spec 10). */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: "C", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "SYSTEMROOT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function hookScript(masterRole: string): string {
  return `#!/bin/sh
# Installed by @alisio/plugin-swarm: appends "By <role>." to every commit message.
file="$1"
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
case "$branch" in
  swarm/*/*) role="\${branch##*/}" ;;
  *) role="${masterRole}" ;;
esac
grep -q "^By \${role}\\.$" "$file" || printf '\\nBy %s.\\n' "$role" >> "$file"
`;
}

/** Git-worktree isolation. Every call is `execFile("git", argv)`: never a shell. */
export class GitWorktreeIsolation implements Isolation {
  private readonly timeoutMs: number;

  constructor(options: GitOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  private git(cwd: string, args: string[]): Promise<GitResult> {
    return new Promise((resolvePromise, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          env: scrubbedEnv(),
          timeout: this.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (!error) return resolvePromise({ code: 0, stdout, stderr });
          const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          if (typeof code === "number") return resolvePromise({ code, stdout, stderr });
          reject(new Error(`git failed to run: ${error.message}`));
        },
      );
    });
  }

  private async mustGit(cwd: string, args: string[], label: string): Promise<string> {
    const result = await this.git(cwd, args);
    if (result.code !== 0) {
      throw new Error(
        `git ${label} failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}`,
      );
    }
    return result.stdout;
  }

  private async finishRepo(projectDir: string, masterRole: string): Promise<void> {
    const hook = join(projectDir, ".git", "hooks", "commit-msg");
    await atomicWrite(hook, hookScript(masterRole));
    await chmod(hook, 0o755);
    for (const [key, value] of [
      ["user.name", "Swarm Agent"],
      ["user.email", "swarm@localhost.invalid"],
    ] as const) {
      const existing = await this.git(projectDir, ["config", "--get", key]);
      if (existing.code !== 0) await this.mustGit(projectDir, ["config", key, value], "config");
    }
  }

  async initProject(
    projectDir: string,
    options: { mission: string; masterRole: string },
  ): Promise<void> {
    validateRole(options.masterRole);
    const dir = resolve(projectDir);
    if (existsSync(join(dir, ".git")))
      throw new Error("Project directory is already a git repository");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await this.mustGit(dir, ["init", "--initial-branch=master"], "init");
      await atomicWrite(join(dir, "mission.md"), `${options.mission.trim()}\n`);
      await ensureIgnoreEntries(join(dir, ".gitignore"), IGNORE_ENTRIES);
      await this.mustGit(dir, ["add", "mission.md", ".gitignore"], "add");
      await this.finishRepo(dir, options.masterRole);
      await this.mustGit(
        dir,
        [
          ...COORDINATOR_IDENTITY,
          "commit",
          "--no-verify",
          "-m",
          "chore: initial commit\n\nBy swarm.",
        ],
        "commit",
      );
    } catch (error) {
      await rm(join(dir, ".git"), { recursive: true, force: true });
      throw error;
    }
  }

  async cloneProject(
    url: string,
    projectDir: string,
    options: { masterRole: string },
  ): Promise<void> {
    validateRole(options.masterRole);
    const dir = resolve(projectDir);
    if (existsSync(dir)) throw new Error("Project directory already exists");
    await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
    const result = await this.git(dirname(dir), ["clone", "--", url, dir]);
    if (result.code !== 0) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(
        `git clone failed: ${result.stderr.trim().slice(0, 300) || `exit ${result.code}`}`,
      );
    }
    // A clone must stay clean, so swarm state is excluded locally instead of editing .gitignore.
    const exclude = join(dir, ".git", "info", "exclude");
    await ensureIgnoreEntries(exclude, IGNORE_ENTRIES);
    await this.finishRepo(dir, options.masterRole);
  }

  async prepareRole(
    projectDir: string,
    project: string,
    placement: RolePlacement,
  ): Promise<string> {
    validateProjectName(project);
    validateRole(placement.role);
    const root = resolve(projectDir);
    if (placement.master) return root;
    const path = join(root, ".worktrees", placement.role);
    if (existsSync(join(path, ".git"))) return path;
    await mkdir(join(root, ".worktrees"), { recursive: true, mode: 0o700 });
    await this.mustGit(
      root,
      ["worktree", "add", "-B", `swarm/${project}/${placement.role}`, path],
      "worktree add",
    );
    return path;
  }

  async hasCommit(workdir: string, commit: string): Promise<boolean> {
    validateCommit(commit);
    return (await this.git(workdir, ["cat-file", "-e", `${commit}^{commit}`])).code === 0;
  }

  async headCommit(workdir: string): Promise<string> {
    const out = await this.mustGit(workdir, ["rev-parse", "HEAD"], "rev-parse");
    return validateCommit(out.trim().slice(0, 10));
  }

  async conflicts(workdir: string): Promise<string[]> {
    const out = await this.mustGit(workdir, ["diff", "--name-only", "--diff-filter=U"], "diff");
    return out.split("\n").filter(Boolean).sort();
  }

  async snapshotRef(workdir: string, ref: string, commit: string): Promise<void> {
    validateCommit(commit);
    if (!/^refs\/swarm\/[a-z]+\/[a-z0-9][a-z0-9-]{0,47}$/.test(ref)) {
      throw new Error(`Invalid ref: ${JSON.stringify(ref)}`);
    }
    await this.mustGit(workdir, ["update-ref", ref, commit], "update-ref");
  }

  async restoreTo(workdir: string, commit: string): Promise<void> {
    validateCommit(commit);
    const status = await this.mustGit(
      workdir,
      ["status", "--porcelain", "--untracked-files=no"],
      "status",
    );
    if (status.trim()) {
      throw new Error(
        "The working directory has uncommitted changes; commit or discard them first",
      );
    }
    await this.mustGit(workdir, ["reset", "--hard", commit], "reset");
  }

  async abortMerge(workdir: string): Promise<void> {
    await this.git(workdir, ["merge", "--abort"]);
  }

  async merge(workdir: string, commit: string): Promise<MergeResult> {
    validateCommit(commit);
    if ((await this.git(workdir, ["merge-base", "--is-ancestor", commit, "HEAD"])).code === 0) {
      return { status: "already" };
    }
    const result = await this.git(workdir, [...COORDINATOR_IDENTITY, "merge", "--no-edit", commit]);
    if (result.code === 0) return { status: "merged" };
    const files = await this.conflicts(workdir);
    if (files.length > 0) return { status: "conflict", files };
    return {
      status: "error",
      message: (result.stderr || result.stdout).trim().slice(0, 300) || `exit ${result.code}`,
    };
  }

  async changedFiles(workdir: string, from: string | undefined, to: string): Promise<string[]> {
    validateCommit(to);
    const range =
      from === undefined
        ? ["diff-tree", "--root", "-r", "--no-commit-id", "--name-only", "-z", "--no-renames", to]
        : ["diff", "--name-only", "-z", "--no-renames", validateCommit(from), to];
    const out = await this.mustGit(workdir, range, "diff");
    return out.split("\0").filter(Boolean).sort();
  }

  async diff(workdir: string, from: string | undefined, to: string): Promise<string> {
    validateCommit(to);
    const args =
      from === undefined
        ? ["show", "--format=", "--no-color", "--no-ext-diff", "--no-textconv", to]
        : ["diff", "--no-color", "--no-ext-diff", "--no-textconv", validateCommit(from), to];
    return this.mustGit(workdir, args, "diff");
  }

  async readFileAt(workdir: string, commit: string, path: string): Promise<string | undefined> {
    validateCommit(commit);
    assertRelativePath(path);
    const result = await this.git(workdir, ["show", `${commit}:${path}`]);
    return result.code === 0 ? result.stdout : undefined;
  }
}
