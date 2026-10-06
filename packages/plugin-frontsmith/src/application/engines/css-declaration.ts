import type { CssDeclaration, CssScan } from "../ports/css-scanner.js";
import { contextText, scansOf } from "./css-util.js";
import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

/** `{ property, value? }` sibling selector shared by css-declaration. */
interface SiblingSpec {
  property: RegExp;
  value?: RegExp;
}

function siblingSpec(reader: ReaderLike, key: string): SiblingSpec | undefined {
  const raw = reader.object(key);
  if (!raw) return undefined;
  const inner = new ParamReader(raw, ["property", "value"]);
  const property = inner.regex("property", true);
  const value = inner.regex("value");
  for (const error of inner.errors) reader.errors.push(`${key}.${error}`);
  return property ? { property, ...(value ? { value } : {}) } : undefined;
}

type ReaderLike = ParamReader;

const hasSibling = (scan: CssScan, declaration: CssDeclaration, spec: SiblingSpec): boolean =>
  scan.declarations.some(
    (other) =>
      other !== declaration &&
      other.blockId === declaration.blockId &&
      spec.property.test(other.property) &&
      (spec.value === undefined || spec.value.test(other.value)),
  );

const CSS_DECLARATION_PARAMS = [
  "selector",
  "property",
  "value",
  "notInsideAtRule",
  "insideAtRule",
  "selectorOrAtRule",
  "requireSiblingProperty",
  "forbidSiblingProperty",
  "important",
  "unlessFileHasAtRule",
] as const;

export const cssDeclaration: Engine = {
  id: "css-declaration",
  validateParams(params) {
    const reader = new ParamReader(params, CSS_DECLARATION_PARAMS);
    reader.regex("selector");
    reader.regex("property", true);
    reader.regex("value");
    reader.regex("notInsideAtRule");
    reader.regex("insideAtRule");
    reader.bool("selectorOrAtRule");
    siblingSpec(reader, "requireSiblingProperty");
    siblingSpec(reader, "forbidSiblingProperty");
    reader.bool("important");
    reader.regex("unlessFileHasAtRule");
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, CSS_DECLARATION_PARAMS);
    const selector = reader.regex("selector");
    const property = reader.regex("property", true) as RegExp;
    const value = reader.regex("value");
    const notInside = reader.regex("notInsideAtRule");
    const inside = reader.regex("insideAtRule");
    const either = reader.bool("selectorOrAtRule") === true;
    const require = siblingSpec(reader, "requireSiblingProperty");
    const forbid = siblingSpec(reader, "forbidSiblingProperty");
    const important = reader.bool("important");
    const unless = reader.regex("unlessFileHasAtRule");
    const findings: RawFinding[] = [];
    for (const analysis of context.files) {
      for (const scan of scansOf(analysis)) {
        if (unless && scan.atRules.some((atRule) => unless.test(contextText(atRule)))) continue;
        for (const declaration of scan.declarations) {
          if (!property.test(declaration.property)) continue;
          if (value && !value.test(declaration.value)) continue;
          if (important !== undefined && declaration.important !== important) continue;
          const selectors = declaration.selector === "" ? [] : declaration.selector.split(", ");
          const selectorHit = selector ? selectors.some((s) => selector.test(s)) : undefined;
          const insideHit = inside
            ? declaration.atRules.some((a) => inside.test(contextText(a)))
            : undefined;
          if (selector && inside && either) {
            if (!selectorHit && !insideHit) continue;
          } else {
            if (selector && !selectorHit) continue;
            if (inside && !insideHit) continue;
          }
          if (notInside && declaration.atRules.some((a) => notInside.test(contextText(a))))
            continue;
          if (require && !hasSibling(scan, declaration, require)) continue;
          if (forbid && hasSibling(scan, declaration, forbid)) continue;
          findings.push({
            file: analysis.path,
            line: declaration.line,
            column: declaration.column,
            detail: `${declaration.property}: ${declaration.value}${declaration.important ? " !important" : ""}`,
          });
        }
      }
    }
    return { findings };
  },
};
