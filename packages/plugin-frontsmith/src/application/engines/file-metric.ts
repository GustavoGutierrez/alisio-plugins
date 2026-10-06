import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const PARAMS = ["metric", "max", "callee"] as const;
const METRICS = ["lines", "components", "absolutePositionDecls", "snapshotAssertions"] as const;
const SNAPSHOT_CALL =
  /(?:^|\.)(?:toMatchSnapshot|toMatchInlineSnapshot|toHaveScreenshot|toMatchAriaSnapshot)$/;

export const fileMetric: Engine = {
  id: "file-metric",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    reader.oneOf("metric", METRICS, true);
    reader.number("max", 0, true);
    reader.regex("callee");
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, PARAMS);
    const metric = reader.oneOf("metric", METRICS, true);
    const max = reader.number("max", 0, true) as number;
    const callee = reader.regex("callee") ?? SNAPSHOT_CALL;
    const findings: RawFinding[] = [];
    for (const analysis of context.files) {
      if (metric === "lines") {
        if (analysis.lineCount > max)
          findings.push({
            file: analysis.path,
            line: max + 1,
            column: 1,
            detail: `${analysis.lineCount} lines (max ${max})`,
          });
      } else if (metric === "components") {
        const components = analysis.scripts.flatMap((piece) => piece.view.components);
        const excess = components[max];
        if (excess)
          findings.push({
            file: analysis.path,
            line: excess.loc.line,
            column: excess.loc.column,
            detail: `${components.length} components (max ${max})`,
          });
      } else if (metric === "absolutePositionDecls") {
        const declarations = analysis.styles
          .flatMap((piece) => piece.scan.declarations)
          .filter((d) => d.property === "position" && /^absolute$/i.test(d.value));
        const excess = declarations[max];
        if (excess)
          findings.push({
            file: analysis.path,
            line: excess.line,
            column: excess.column,
            detail: `${declarations.length} absolute positions (max ${max})`,
          });
      } else if (metric === "snapshotAssertions") {
        const calls = analysis.scripts
          .flatMap((piece) => piece.view.calls)
          .filter((call) => callee.test(call.callee));
        const excess = calls[max];
        if (excess)
          findings.push({
            file: analysis.path,
            line: excess.loc.line,
            column: excess.loc.column,
            detail: `${calls.length} snapshot assertions (max ${max})`,
          });
      }
    }
    return { findings };
  },
};
