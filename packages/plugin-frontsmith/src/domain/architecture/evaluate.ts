import { compileGlob } from "../glob.js";
import type { ArchitectureConfig } from "./config.js";
import { buildLayerMap } from "./graph.js";
import { cycles } from "./scc.js";

export type ArchitectureCheck =
  | "direction"
  | "crossSlice"
  | "publicApi"
  | "cycles"
  | "roles"
  | "atomic"
  | "unmapped";

/** One import between two workspace files, or from a file to a bare package. */
export interface ArchitectureEdge {
  from: string;
  specifier: string;
  line: number;
  column: number;
  /** Resolved workspace file, absent for packages and unresolved imports. */
  to?: string;
  /** Bare package name for package imports. */
  packageName?: string;
  typeOnly?: boolean;
}

export interface ArchitectureViolation {
  check: ArchitectureCheck;
  file: string;
  line: number;
  column: number;
  detail: string;
}

/** Evaluate one check of an architecture config over an import graph (spec 14.1, FS-ARC rules). */
export function evaluateArchitecture(
  config: ArchitectureConfig,
  check: ArchitectureCheck,
  input: { edges: readonly ArchitectureEdge[]; files: readonly string[] },
): ArchitectureViolation[] {
  const map = buildLayerMap(config);
  const out: ArchitectureViolation[] = [];
  const sameLayerOk = new Set(config.allowSameLayer);
  const sliced = new Set(config.slices?.layers ?? []);
  const publicApi = new Set(config.slices?.publicApi ?? []);
  const relevant = input.edges.filter(
    (edge) => !map.isIgnored(edge.from) && (edge.to === undefined || !map.isIgnored(edge.to)),
  );

  if (check === "direction" || check === "crossSlice" || check === "publicApi") {
    for (const edge of relevant) {
      if (edge.to === undefined) continue;
      const fromLayer = map.layerOf(edge.from);
      const toLayer = map.layerOf(edge.to);
      if (fromLayer === undefined || toLayer === undefined) continue;
      if (check === "direction") {
        if (fromLayer === toLayer) {
          if (!sameLayerOk.has(fromLayer) && !sliced.has(fromLayer))
            out.push({
              check,
              file: edge.from,
              line: edge.line,
              column: edge.column,
              detail: `${fromLayer} may not import within itself (${edge.to})`,
            });
        } else if (!(config.allow[fromLayer] ?? []).includes(toLayer))
          out.push({
            check,
            file: edge.from,
            line: edge.line,
            column: edge.column,
            detail: `${fromLayer} may not import ${toLayer} (${edge.to})`,
          });
        continue;
      }
      const toSlice = map.sliceOf(edge.to);
      if (!toSlice) continue;
      const fromSlice = map.sliceOf(edge.from);
      const sameSlice =
        fromSlice && fromSlice.layer === toSlice.layer && fromSlice.slice === toSlice.slice;
      if (sameSlice) continue;
      if (check === "crossSlice") {
        if (fromSlice && fromSlice.layer === toSlice.layer)
          out.push({
            check,
            file: edge.from,
            line: edge.line,
            column: edge.column,
            detail: `slice ${fromSlice.slice} imports slice ${toSlice.slice} of ${toSlice.layer}`,
          });
      } else if (
        !(fromSlice && fromSlice.layer === toSlice.layer) &&
        toSlice.rest !== "" &&
        !publicApi.has(toSlice.rest)
      )
        out.push({
          check,
          file: edge.from,
          line: edge.line,
          column: edge.column,
          detail: `${edge.to} bypasses the public API of ${toSlice.layer}/${toSlice.slice}`,
        });
    }
  } else if (check === "cycles") {
    const nodes = new Set<string>();
    const adjacency = new Map<string, string[]>();
    for (const edge of relevant) {
      if (edge.to === undefined || edge.typeOnly) continue;
      nodes.add(edge.from);
      nodes.add(edge.to);
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
    }
    for (const members of cycles([...nodes].sort(), adjacency)) {
      const first = members[0] as string;
      const edge = relevant.find(
        (e) => e.from === first && e.to !== undefined && members.includes(e.to),
      );
      out.push({
        check,
        file: first,
        line: edge?.line ?? 1,
        column: edge?.column ?? 1,
        detail: `import cycle: ${members.join(" -> ")}`,
      });
    }
  } else if (check === "roles") {
    const forbidden = config.roles?.forbiddenForPresentational ?? [];
    const matchers = forbidden.map((entry) => ({
      entry,
      test: /[*?{[]/.test(entry) || entry.includes("/") ? safeGlob(entry) : undefined,
    }));
    for (const edge of relevant) {
      if (!map.isPresentational(edge.from)) continue;
      for (const { entry, test } of matchers) {
        const hit =
          (edge.to && test?.(edge.to)) ||
          (edge.packageName !== undefined &&
            (edge.packageName === entry ||
              edge.specifier === entry ||
              edge.specifier.startsWith(`${entry}/`)));
        if (hit) {
          out.push({
            check,
            file: edge.from,
            line: edge.line,
            column: edge.column,
            detail: `presentational code imports ${edge.to ?? edge.specifier}`,
          });
          break;
        }
      }
    }
  } else if (check === "atomic") {
    const levels = config.atomic?.levels ?? [];
    for (const edge of relevant) {
      if (edge.to === undefined) continue;
      const a = map.levelOf(edge.from);
      const b = map.levelOf(edge.to);
      if (a !== undefined && b !== undefined && b > a)
        out.push({
          check,
          file: edge.from,
          line: edge.line,
          column: edge.column,
          detail: `${levels[a]} imports higher level ${levels[b]} (${edge.to})`,
        });
    }
  } else {
    const roots = config.sourceRoots.map((root) => root.replace(/\/$/, ""));
    for (const file of input.files) {
      if (map.isIgnored(file)) continue;
      if (!roots.some((root) => root === "." || file === root || file.startsWith(`${root}/`)))
        continue;
      if (map.layerOf(file) === undefined)
        out.push({ check, file, line: 1, column: 1, detail: `${file} is not mapped to any layer` });
    }
  }
  return out.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.detail.localeCompare(b.detail),
  );
}

function safeGlob(pattern: string): ((path: string) => boolean) | undefined {
  try {
    return compileGlob(pattern);
  } catch {
    return undefined;
  }
}
