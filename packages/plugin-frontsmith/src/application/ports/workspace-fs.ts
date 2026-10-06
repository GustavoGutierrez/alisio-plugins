export interface ListOptions {
  /** Workspace-relative directories to list; defaults to the whole workspace. */
  roots?: readonly string[];
}

export interface FileListing {
  /** Sorted workspace-relative POSIX paths. */
  files: string[];
  /** The workspace holds more files than the analysis limit. */
  truncated: boolean;
}

export type ReadResult =
  | { kind: "text"; text: string; size: number }
  | { kind: "missing" }
  | { kind: "too-large"; size: number };

/** Workspace file access with the analysis limits of spec 10.3. */
export interface WorkspaceFs {
  readonly root: string;
  listFiles(options?: ListOptions): Promise<FileListing>;
  read(path: string): Promise<ReadResult>;
  exists(path: string): Promise<boolean>;
}

/** Resolves bare module names from a workspace (`playwright`, `axe-core`), without loading them. */
export interface ModuleResolver {
  resolvable(workspaceRoot: string, name: string): boolean;
}

export const MAX_ANALYSIS_FILES = 20_000;
export const MAX_ANALYSIS_BYTES = 1024 * 1024;
