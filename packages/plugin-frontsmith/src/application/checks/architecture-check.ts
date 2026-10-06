import type { ArchitectureConfig } from "../../domain/architecture/config.js";
import {
  type ArchitectureCheck,
  type ArchitectureEdge,
  type ArchitectureViolation,
  evaluateArchitecture,
} from "../../domain/architecture/evaluate.js";
import { buildLayerMap } from "../../domain/architecture/graph.js";
import { compileGlob } from "../../domain/glob.js";
import type { Severity } from "../../domain/severity.js";
import { aggregate, statusForFinding, type Verdict } from "../../domain/verdict.js";
import type { FileAnalysis, FileAnalyzer } from "../ports/file-analyzer.js";
import type { ImportGraphBuilder } from "../ports/import-graph-builder.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

export const architectureChecks: readonly ArchitectureCheck[] = [
  "direction",
  "crossSlice",
  "publicApi",
  "cycles",
  "roles",
  "atomic",
  "unmapped",
];

/** Shipped rule id and severity behind every check (spec 13.3, FS-ARC-001..007). */
export const architectureRules: Record<ArchitectureCheck, { ruleId: string; severity: Severity }> =
  {
    direction: { ruleId: "FS-ARC-001", severity: "blocker" },
    crossSlice: { ruleId: "FS-ARC-002", severity: "major" },
    publicApi: { ruleId: "FS-ARC-003", severity: "major" },
    cycles: { ruleId: "FS-ARC-004", severity: "major" },
    roles: { ruleId: "FS-ARC-005", severity: "major" },
    atomic: { ruleId: "FS-ARC-006", severity: "major" },
    unmapped: { ruleId: "FS-ARC-007", severity: "minor" },
  };

export interface ArchitectureFinding extends ArchitectureViolation {
  ruleId: string;
  severity: Severity;
}

export interface LayerGraphEdge {
  from: string;
  to: string;
  count: number;
  violating: boolean;
}

export interface ArchitectureCheckInput {
  fs: WorkspaceFs;
  config: ArchitectureConfig;
  /** Restrict findings to files matching any of these globs; the whole workspace is analysed. */
  paths?: readonly string[];
}

export interface ArchitectureCheckResult {
  verdict: Verdict;
  violations: ArchitectureFinding[];
  byCheck: Record<ArchitectureCheck, number>;
  filesChecked: number;
  graph: { layers: string[]; edges: LayerGraphEdge[] };
  /** The workspace has more files than the analysis limit. */
  truncated: boolean;
}

export interface ArchitectureCheckDeps {
  analyzer: FileAnalyzer;
  graphBuilder: ImportGraphBuilder;
}

const ANALYSABLE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const SOURCE_KINDS = new Set(["script", "sfc"]);

/** Run the seven architecture checks over the workspace import graph (spec 10.5, 14.1). */
export async function runArchitectureCheck(
  input: ArchitectureCheckInput,
  deps: ArchitectureCheckDeps,
): Promise<ArchitectureCheckResult> {
  const { config } = input;
  const listing = await input.fs.listFiles();
  const analyses = new Map<string, FileAnalysis>();
  for (const path of listing.files) {
    if (!ANALYSABLE.test(path)) continue;
    const read = await input.fs.read(path);
    if (read.kind === "text") analyses.set(path, deps.analyzer.analyze(path, read.text));
  }
  const graph = await deps.graphBuilder.build(input.fs, listing.files, analyses.values());
  const useAliases = config.aliases !== "none";
  const edges: ArchitectureEdge[] = graph.edges.map((edge) => {
    const base = {
      from: edge.from,
      specifier: edge.specifier,
      line: edge.line,
      column: edge.column,
      typeOnly: edge.typeOnly,
    };
    const resolution = edge.resolution;
    if (resolution.kind === "file") {
      const viaAlias =
        resolution.via === "paths" ||
        resolution.via === "baseUrl" ||
        resolution.via === "package-imports";
      return !useAliases && viaAlias
        ? { ...base, packageName: edge.specifier }
        : { ...base, to: resolution.path };
    }
    if (resolution.kind === "package") return { ...base, packageName: resolution.name };
    return base;
  });
  const files = [...analyses.values()]
    .filter((analysis) => SOURCE_KINDS.has(analysis.kind))
    .map((analysis) => analysis.path);
  const selected =
    input.paths && input.paths.length > 0 ? input.paths.map((g) => compileGlob(g)) : undefined;
  const inScope = (file: string): boolean => !selected || selected.some((test) => test(file));

  const violations: ArchitectureFinding[] = [];
  const byCheck = Object.fromEntries(architectureChecks.map((check) => [check, 0])) as Record<
    ArchitectureCheck,
    number
  >;
  for (const check of architectureChecks)
    for (const violation of evaluateArchitecture(config, check, { edges, files })) {
      if (!inScope(violation.file)) continue;
      const { ruleId, severity } = architectureRules[check];
      violations.push({ ...violation, ruleId, severity });
      byCheck[check] += 1;
    }
  violations.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.ruleId.localeCompare(b.ruleId),
  );

  const statuses = architectureChecks.map((check) => ({
    required: true,
    status:
      byCheck[check] === 0
        ? ("PASS" as Verdict)
        : statusForFinding(architectureRules[check].severity, "deterministic"),
  }));
  return {
    verdict: aggregate(statuses).verdict,
    violations,
    byCheck,
    filesChecked: files.length,
    graph: layerGraph(config, edges, violations),
    truncated: listing.truncated,
  };
}

function layerGraph(
  config: ArchitectureConfig,
  edges: readonly ArchitectureEdge[],
  violations: readonly ArchitectureFinding[],
): ArchitectureCheckResult["graph"] {
  const map = buildLayerMap(config);
  const violating = new Set(
    violations
      .filter((violation) => violation.check === "direction")
      .map((violation) => `${violation.file}:${violation.line}:${violation.column}`),
  );
  const counts = new Map<string, LayerGraphEdge>();
  for (const edge of edges) {
    if (edge.to === undefined || map.isIgnored(edge.from) || map.isIgnored(edge.to)) continue;
    const from = map.layerOf(edge.from);
    const to = map.layerOf(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}\u0000${to}`;
    const entry = counts.get(key) ?? { from, to, count: 0, violating: false };
    entry.count += 1;
    if (violating.has(`${edge.from}:${edge.line}:${edge.column}`)) entry.violating = true;
    counts.set(key, entry);
  }
  return {
    layers: config.layers.map((layer) => layer.name),
    edges: [...counts.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
    ),
  };
}
