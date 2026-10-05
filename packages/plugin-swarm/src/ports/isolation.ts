export interface MergeResult {
  /** `already` = the commit was an ancestor; `merged` = a merge ran cleanly. */
  status: "already" | "merged" | "conflict" | "error";
  files?: string[];
  message?: string;
}

export interface RolePlacement {
  role: string;
  master: boolean;
}

/** Filesystem and git isolation for a project: one working directory per role. */
export interface Isolation {
  /** `git init` on `master` with an initial commit, ignore rules and the commit-msg hook. */
  initProject(projectDir: string, options: { mission: string; masterRole: string }): Promise<void>;
  /** `git clone`; refuses an existing destination. */
  cloneProject(url: string, projectDir: string, options: { masterRole: string }): Promise<void>;
  /** Create (idempotently) the role's working directory and return its absolute path. */
  prepareRole(projectDir: string, project: string, placement: RolePlacement): Promise<string>;
  hasCommit(workdir: string, commit: string): Promise<boolean>;
  /** The ten-character id of HEAD in the working directory. */
  headCommit(workdir: string): Promise<string>;
  merge(workdir: string, commit: string): Promise<MergeResult>;
  /** Abandon a conflicted merge, restoring the working directory. A no-op when none is running. */
  abortMerge(workdir: string): Promise<void>;
  /** Unmerged paths left by a conflicted merge. */
  conflicts(workdir: string): Promise<string[]>;
  /** Point a `refs/swarm/...` ref at a commit (snapshot of rejected work). */
  snapshotRef(workdir: string, ref: string, commit: string): Promise<void>;
  /** Restore the working directory to a commit; refuses when it has uncommitted changes. */
  restoreTo(workdir: string, commit: string): Promise<void>;
  /** Paths changed between two commits (`from` absent: the commit's own changes), relative to the root. */
  changedFiles(workdir: string, from: string | undefined, to: string): Promise<string[]>;
  /** Unified diff between two commits (`from` absent: the commit's own changes). */
  diff(workdir: string, from: string | undefined, to: string): Promise<string>;
  /** Content of a file in a commit, read from the object store (never the working tree); absent when missing. */
  readFileAt(workdir: string, commit: string, path: string): Promise<string | undefined>;
}
