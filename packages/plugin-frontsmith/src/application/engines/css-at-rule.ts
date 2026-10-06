import { scansOf } from "./css-util.js";
import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const AT_RULE_PARAMS = ["name", "prelude", "require"] as const;

export const cssAtRule: Engine = {
  id: "css-at-rule",
  validateParams(params) {
    const reader = new ParamReader(params, AT_RULE_PARAMS);
    reader.regex("name", true);
    reader.regex("prelude");
    const require = reader.object("require");
    if (require) {
      const inner = new ParamReader(require, ["property"]);
      inner.regex("property", true);
      for (const error of inner.errors) reader.errors.push(`require.${error}`);
    }
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, AT_RULE_PARAMS);
    const name = reader.regex("name", true) as RegExp;
    const prelude = reader.regex("prelude");
    const requireRaw = reader.object("require");
    const required = requireRaw ? new RegExp(requireRaw.property as string, "u") : undefined;
    const findings: RawFinding[] = [];
    for (const analysis of context.files)
      for (const scan of scansOf(analysis))
        for (const atRule of scan.atRules) {
          if (!name.test(atRule.name) || (prelude && !prelude.test(atRule.prelude))) continue;
          if (required) {
            if (atRule.hasBlock && !atRule.declarations.some((d) => required.test(d.property)))
              findings.push({
                file: analysis.path,
                line: atRule.line,
                column: atRule.column,
                detail: `@${atRule.name} lacks ${required.source}`,
              });
          } else
            findings.push({
              file: analysis.path,
              line: atRule.line,
              column: atRule.column,
              detail: `@${atRule.name} ${atRule.prelude}`.trim(),
            });
        }
    return { findings };
  },
};
