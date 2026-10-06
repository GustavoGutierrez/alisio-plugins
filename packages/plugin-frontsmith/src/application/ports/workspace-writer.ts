/** Writes generated files into a workspace; paths are workspace-relative and contained. */
export interface WorkspaceWriter {
  write(root: string, relative: string, content: string): Promise<void>;
}
