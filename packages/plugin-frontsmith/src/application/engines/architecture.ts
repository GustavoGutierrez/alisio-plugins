import {
  type ArchitectureCheck,
  type ArchitectureEdge,
  evaluateArchitecture,
} from "../../domain/architecture/evaluate.js";
import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const CHECKS = [
  "direction",
  "crossSlice",
  "publicApi",
  "cycles",
  "roles",
  "atomic",
  "unmapped",
] as const;
const SOURCE_KIND = new Set(["script", "sfc"]);

export const architecture: Engine = {
  id: "architecture",
  validateParams(params) {
    const reader = new ParamReader(params, ["check"]);
    reader.oneOf("check", CHECKS, true);
    return reader.errors;
  },
  run(context) {
    if (!context.architecture) return { findings: [], skipped: "no .frontsmith/architecture.json" };
    const check = new ParamReader(context.params, ["check"]).oneOf(
      "check",
      CHECKS,
      true,
    ) as ArchitectureCheck;
    const edges: ArchitectureEdge[] = context.graph.edges.map((edge) => ({
      from: edge.from,
      specifier: edge.specifier,
      line: edge.line,
      column: edge.column,
      ...(edge.resolution.kind === "file" ? { to: edge.resolution.path } : {}),
      ...(edge.resolution.kind === "package" ? { packageName: edge.resolution.name } : {}),
      typeOnly: edge.typeOnly,
    }));
    const files = [...context.all.values()]
      .filter((analysis) => SOURCE_KIND.has(analysis.kind))
      .map((analysis) => analysis.path);
    const selected = new Set(context.files.map((file) => file.path));
    const findings: RawFinding[] = evaluateArchitecture(context.architecture, check, {
      edges,
      files,
    })
      .filter((violation) => selected.has(violation.file))
      .map((violation) => ({
        file: violation.file,
        line: violation.line,
        column: violation.column,
        detail: violation.detail,
      }));
    return { findings };
  },
};
