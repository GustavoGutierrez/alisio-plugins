/**
 * Digests of workspace files that include what a content hash alone would miss: the file mode and
 * the target of a symbolic link (Phase 0, S-R16). A digest is opaque; equal digests mean the same
 * bytes, mode and link target.
 */
export interface IntegrityReader {
  /** Digest per workspace-relative file under `directory`; symlinks are not followed. */
  digestTree(root: string, directory: string): Promise<Record<string, string>>;
  /** Digest of one workspace-relative file, or `undefined` when it does not exist. */
  digestFile(root: string, relative: string): Promise<string | undefined>;
}
