import type { FileAnalysis } from "./file-analyzer.js";
import type { ImportGraph } from "./import-graph.js";
import type { WorkspaceFs } from "./workspace-fs.js";

/** Resolves every import of the analysed files (tsconfig paths, package imports, extensions). */
export interface ImportGraphBuilder {
  build(
    fs: WorkspaceFs,
    files: readonly string[],
    analyses: Iterable<FileAnalysis>,
  ): Promise<ImportGraph>;
}
