import type { FileAnalysis } from "../../application/ports/file-analyzer.js";
import type { ImportGraph } from "../../application/ports/import-graph.js";
import type { ImportGraphBuilder } from "../../application/ports/import-graph-builder.js";
import type { WorkspaceFs } from "../../application/ports/workspace-fs.js";
import { buildImportGraph, loadResolveContext } from "./import-graph.js";

export class DefaultImportGraphBuilder implements ImportGraphBuilder {
  async build(
    fs: WorkspaceFs,
    files: readonly string[],
    analyses: Iterable<FileAnalysis>,
  ): Promise<ImportGraph> {
    return buildImportGraph(analyses, await loadResolveContext(fs, files));
  }
}
