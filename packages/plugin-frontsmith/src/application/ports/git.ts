export type ChangeStatus = "A" | "M" | "D" | "R" | "?";

export interface ChangedFile {
  /** Workspace-relative POSIX path. */
  path: string;
  status: ChangeStatus;
}

export interface NumstatEntry {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}

/** Read-only git access for diff guards and changed-file scoping (spec 10.3). */
export interface Git {
  isRepo(cwd: string): Promise<boolean>;
  /** Files tracked or untracked and not ignored, relative to `cwd`. */
  listFiles(cwd: string): Promise<string[]>;
  /** Working tree changes against `base` (default `HEAD`), including untracked files. */
  changedFiles(cwd: string, base?: string): Promise<ChangedFile[]>;
  diff(cwd: string, base: string | undefined, paths?: readonly string[]): Promise<string>;
  numstat(cwd: string, base?: string): Promise<NumstatEntry[]>;
  /** Content of `path` at `rev`, or `undefined` when it does not exist there. */
  show(cwd: string, rev: string, path: string): Promise<string | undefined>;
  headSha(cwd: string): Promise<string | undefined>;
}
