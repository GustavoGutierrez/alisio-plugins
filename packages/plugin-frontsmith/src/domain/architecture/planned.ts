import type { ArchitectureConfig } from "./config.js";
import {
  type ArchitectureCheck,
  type ArchitectureEdge,
  type ArchitectureViolation,
  evaluateArchitecture,
} from "./evaluate.js";
import { buildLayerMap } from "./graph.js";

/** The file layout and imports a plan proposes, before any code exists (gate G3). */
export interface PlannedGraph {
  files: readonly string[];
  imports: ReadonlyArray<{ from: string; to: string }>;
}

const CHECKS: readonly ArchitectureCheck[] = [
  "direction",
  "crossSlice",
  "publicApi",
  "cycles",
  "roles",
  "atomic",
  "unmapped",
];
const SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js"];

/**
 * Judge a planned graph with the same rules as the real one: planned files must map to layers,
 * and planned imports must respect direction, slices, public APIs and roles. An import target that
 * names a planned directory resolves to its index file; a target that is no planned file or mapped
 * path is a package.
 */
export function checkPlannedGraph(
  config: ArchitectureConfig,
  planned: PlannedGraph,
): ArchitectureViolation[] {
  const map = buildLayerMap(config);
  const known = new Set(planned.files);
  const resolve = (target: string): string | undefined => {
    for (const suffix of SUFFIXES) {
      const candidate = `${target}${suffix}`;
      if (known.has(candidate)) return candidate;
    }
    return map.layerOf(target) !== undefined ? target : undefined;
  };
  const edges: ArchitectureEdge[] = planned.imports.map((entry, index) => {
    const to = resolve(entry.to);
    return {
      from: entry.from,
      specifier: entry.to,
      line: index + 1,
      column: 1,
      ...(to !== undefined ? { to } : { packageName: entry.to }),
    };
  });
  return CHECKS.flatMap((check) =>
    evaluateArchitecture(config, check, { edges, files: planned.files }),
  ).sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.check.localeCompare(b.check) ||
      a.detail.localeCompare(b.detail),
  );
}
