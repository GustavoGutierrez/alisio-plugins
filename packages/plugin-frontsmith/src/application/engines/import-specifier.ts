import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const PARAMS = ["forbid", "allow", "ignoreTypeOnly"] as const;

/** Imports whose specifier or resolved path matches `forbid` (and not `allow`). */
export const importSpecifier: Engine = {
  id: "import-specifier",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    reader.regex("forbid", true);
    reader.regex("allow");
    reader.bool("ignoreTypeOnly");
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, PARAMS);
    const forbid = reader.regex("forbid", true) as RegExp;
    const allow = reader.regex("allow");
    const ignoreTypeOnly = reader.bool("ignoreTypeOnly") !== false;
    const selected = new Set(context.files.map((file) => file.path));
    const findings: RawFinding[] = [];
    for (const edge of context.graph.edges) {
      if (!selected.has(edge.from) || (ignoreTypeOnly && edge.typeOnly)) continue;
      const candidates = [
        edge.specifier,
        ...(edge.resolution.kind === "file" ? [edge.resolution.path] : []),
      ];
      if (!candidates.some((text) => forbid.test(text))) continue;
      if (allow && candidates.some((text) => allow.test(text))) continue;
      findings.push({
        file: edge.from,
        line: edge.line,
        column: edge.column,
        detail: `import of ${edge.specifier}`,
      });
    }
    return { findings };
  },
};
