/** Binary file access for build output and images (budgets, spec 10.6). */
export interface AssetReader {
  /** Workspace-relative paths of every file under `directory` (build output is usually gitignored). */
  list(root: string, directory: string): Promise<string[]>;
  read(root: string, relative: string): Promise<Uint8Array | undefined>;
  /** Write a binary file atomically (baselines, evidence); the path is contained in the workspace. */
  write(root: string, relative: string, bytes: Uint8Array): Promise<void>;
  /** gzip level 9, reported in bytes (spec 10.6). */
  gzipSize(bytes: Uint8Array): number;
}
