import type { ChangedFile, ChangeStatus, Git, NumstatEntry } from "../../application/ports/git.js";
import type { ProcessRunner } from "../../application/ports/process-runner.js";

const REV = /^[A-Za-z0-9._/@^~{}:+-]+$/;
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };

const assertRev = (rev: string): void => {
  if (rev.startsWith("-") || !REV.test(rev)) throw new Error(`Invalid git revision: ${rev}`);
};
const assertPath = (path: string): void => {
  if (path.startsWith("-") || path.includes("\u0000")) throw new Error(`Invalid git path: ${path}`);
};

const statusOf = (letter: string): ChangeStatus => {
  if (letter === "A") return "A";
  if (letter === "D") return "D";
  if (letter === "R" || letter === "C") return "R";
  return "M";
};

/** Read-only git through argv-only subprocesses; arguments are validated, never shell-joined. */
export class GitCli implements Git {
  constructor(private readonly runner: ProcessRunner) {}

  private async git(
    cwd: string,
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const result = await this.runner.run(
      ["git", "--no-pager", "-c", "core.quotepath=off", ...args],
      {
        cwd,
        timeoutMs: TIMEOUT_MS,
        maxOutput: MAX_OUTPUT,
        env: GIT_ENV,
      },
    );
    if (result.spawnError) throw new Error(`git is unavailable: ${result.spawnError}`);
    return result;
  }

  async isRepo(cwd: string): Promise<boolean> {
    try {
      const result = await this.git(cwd, ["rev-parse", "--is-inside-work-tree"]);
      return result.code === 0 && result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async listFiles(cwd: string): Promise<string[]> {
    const result = await this.git(cwd, ["ls-files", "-co", "--exclude-standard", "-z"]);
    if (result.code !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
    return [...new Set(result.stdout.split("\u0000").filter(Boolean))].sort();
  }

  async headSha(cwd: string): Promise<string | undefined> {
    const result = await this.git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async changedFiles(cwd: string, base?: string): Promise<ChangedFile[]> {
    if (base !== undefined) assertRev(base);
    const head = base ?? ((await this.headSha(cwd)) ? "HEAD" : undefined);
    const changes = new Map<string, ChangeStatus>();
    if (head !== undefined) {
      const diff = await this.git(cwd, [
        "diff",
        "--name-status",
        "-z",
        "--relative",
        "--no-renames",
        head,
        "--",
      ]);
      if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
      const tokens = diff.stdout.split("\u0000");
      for (let index = 0; index + 1 < tokens.length; index += 2) {
        const letter = (tokens[index] as string).charAt(0);
        const path = tokens[index + 1] as string;
        if (letter && path) changes.set(path, statusOf(letter));
      }
    }
    const untracked = await this.git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of untracked.stdout.split("\u0000").filter(Boolean)) changes.set(path, "?");
    return [...changes.entries()]
      .map(([path, status]) => ({ path, status }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async diff(
    cwd: string,
    base: string | undefined,
    paths: readonly string[] = [],
  ): Promise<string> {
    if (base !== undefined) assertRev(base);
    for (const path of paths) assertPath(path);
    const head = base ?? ((await this.headSha(cwd)) ? "HEAD" : undefined);
    const args = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--relative",
      ...(head ? [head] : []),
      "--",
      ...paths,
    ];
    const result = await this.git(cwd, args);
    if (result.code !== 0) throw new Error(`git diff failed: ${result.stderr.trim()}`);
    return result.stdout;
  }

  async numstat(cwd: string, base?: string): Promise<NumstatEntry[]> {
    if (base !== undefined) assertRev(base);
    const head = base ?? ((await this.headSha(cwd)) ? "HEAD" : undefined);
    if (head === undefined) return [];
    const result = await this.git(cwd, [
      "diff",
      "--numstat",
      "-z",
      "--relative",
      "--no-renames",
      head,
      "--",
    ]);
    if (result.code !== 0) throw new Error(`git diff failed: ${result.stderr.trim()}`);
    const entries: NumstatEntry[] = [];
    for (const record of result.stdout.split("\u0000").filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
      if (!match) continue;
      const binary = match[1] === "-";
      entries.push({
        path: match[3] as string,
        added: binary ? 0 : Number(match[1]),
        deleted: binary ? 0 : Number(match[2]),
        binary,
      });
    }
    return entries;
  }

  async show(cwd: string, rev: string, path: string): Promise<string | undefined> {
    assertRev(rev);
    assertPath(path);
    const result = await this.git(cwd, ["show", `${rev}:./${path}`]);
    return result.code === 0 ? result.stdout : undefined;
  }
}
