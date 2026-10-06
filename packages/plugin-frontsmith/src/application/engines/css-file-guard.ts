import { scansOf } from "./css-util.js";
import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const FILE_GUARD_PARAMS = ["whenProperty", "requiresAnywhere"] as const;

export const cssFileGuard: Engine = {
  id: "css-file-guard",
  validateParams(params) {
    const reader = new ParamReader(params, FILE_GUARD_PARAMS);
    const when = reader.object("whenProperty");
    if (!when) reader.errors.push("whenProperty: required");
    else {
      const inner = new ParamReader(when, ["property", "value"]);
      inner.regex("property", true);
      inner.regex("value");
      for (const error of inner.errors) reader.errors.push(`whenProperty.${error}`);
    }
    const requires = reader.object("requiresAnywhere");
    if (!requires) reader.errors.push("requiresAnywhere: required");
    else {
      const inner = new ParamReader(requires, ["selector", "property"]);
      inner.regex("selector", true);
      inner.regex("property", true);
      for (const error of inner.errors) reader.errors.push(`requiresAnywhere.${error}`);
    }
    return reader.errors;
  },
  run(context) {
    const when = context.params.whenProperty as { property: string; value?: string };
    const requires = context.params.requiresAnywhere as { selector: string; property: string };
    const whenProperty = new RegExp(when.property, "u");
    const whenValue = when.value ? new RegExp(when.value, "u") : undefined;
    const selector = new RegExp(requires.selector, "u");
    const replacement = new RegExp(requires.property, "u");
    const findings: RawFinding[] = [];
    for (const analysis of context.files)
      for (const scan of scansOf(analysis)) {
        const satisfied = scan.declarations.some(
          (d) =>
            replacement.test(d.property) && d.selector.split(", ").some((s) => selector.test(s)),
        );
        if (satisfied) continue;
        for (const declaration of scan.declarations)
          if (
            whenProperty.test(declaration.property) &&
            (!whenValue || whenValue.test(declaration.value))
          )
            findings.push({
              file: analysis.path,
              line: declaration.line,
              column: declaration.column,
              detail: `${declaration.property}: ${declaration.value}`,
            });
      }
    return { findings };
  },
};
