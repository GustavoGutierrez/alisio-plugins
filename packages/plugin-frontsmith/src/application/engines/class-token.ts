import type { FileAnalysis } from "../ports/file-analyzer.js";
import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const PARAMS = [
  "dynamicInterpolation",
  "token",
  "conflicts",
  "cssApply",
  "maxApplyPerFile",
  "requireVariantCounterpart",
] as const;
const UNKNOWN = "\u0000";

interface ClassText {
  value: string;
  dynamic: boolean;
  tag?: string;
  attribute: boolean;
  line: number;
  column: number;
}

/** Split `hover:md:p-4` into `{ variant: "hover:md", utility: "p-4" }`, keeping `[&>*]:` intact. */
export function splitVariant(token: string): { variant: string; utility: string } {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i += 1) {
    const char = token[i];
    if (char === "[") depth += 1;
    else if (char === "]") depth = Math.max(0, depth - 1);
    else if (char === ":" && depth === 0) last = i;
  }
  return last === -1
    ? { variant: "", utility: token }
    : { variant: token.slice(0, last), utility: token.slice(last + 1) };
}

/** Class strings of a file: from scripts, plus static `class` attributes of templates. */
function classTexts(analysis: FileAnalysis): ClassText[] {
  const out: ClassText[] = [];
  for (const piece of analysis.scripts)
    for (const record of piece.view.classStrings)
      out.push({
        value: record.value,
        dynamic: record.dynamic,
        ...(record.tag !== undefined ? { tag: record.tag } : {}),
        attribute: record.origin === "attribute",
        line: record.loc.line,
        column: record.loc.column,
      });
  for (const piece of analysis.templates)
    for (const element of piece.scan.elements)
      for (const attr of element.attrs)
        if ((attr.name === "class" || attr.name === "className") && attr.value !== undefined) {
          const interpolated = /\{\{[^}]*\}\}|\{[^}]*\}/.test(attr.value);
          out.push({
            value: attr.value.replace(/\{\{[^}]*\}\}|\{[^}]*\}/g, UNKNOWN),
            dynamic: interpolated,
            tag: element.tag,
            attribute: true,
            line: attr.line,
            column: attr.column,
          });
        }
  return out;
}

function matchesEntry(entry: string, utility: string): boolean {
  if (entry.endsWith("-*")) return utility.startsWith(entry.slice(0, -1));
  return utility === entry;
}

export const classToken: Engine = {
  id: "class-token",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    reader.bool("dynamicInterpolation");
    reader.regex("token");
    const conflicts = reader.params.conflicts;
    if (
      conflicts !== undefined &&
      !(
        Array.isArray(conflicts) &&
        conflicts.every(
          (group) =>
            Array.isArray(group) &&
            group.length >= 2 &&
            group.every((entry) => typeof entry === "string"),
        )
      )
    )
      reader.errors.push("conflicts: must be an array of groups with at least two utility names");
    reader.bool("cssApply");
    reader.number("maxApplyPerFile", 0);
    const variant = reader.object("requireVariantCounterpart");
    if (variant) {
      const inner = new ParamReader(variant, ["variant", "counterparts", "onlyElements"]);
      inner.string("variant", true);
      inner.strings("counterparts", true);
      inner.regex("onlyElements");
      for (const error of inner.errors) reader.errors.push(`requireVariantCounterpart.${error}`);
    }
    if (reader.bool("cssApply") && reader.number("maxApplyPerFile", 0) === undefined)
      reader.errors.push("cssApply: needs maxApplyPerFile");
    const configured = [
      "dynamicInterpolation",
      "token",
      "conflicts",
      "cssApply",
      "requireVariantCounterpart",
    ].some((key) => params[key] !== undefined && params[key] !== false);
    if (!configured) reader.errors.push("no check configured");
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, PARAMS);
    const dynamic = reader.bool("dynamicInterpolation") === true;
    const token = reader.regex("token");
    const conflicts = (context.params.conflicts as string[][] | undefined) ?? [];
    const cssApply = reader.bool("cssApply") === true;
    const maxApply = reader.number("maxApplyPerFile", 0) ?? 0;
    const variantRaw = reader.object("requireVariantCounterpart") as
      | { variant: string; counterparts: string[]; onlyElements?: string }
      | undefined;
    const only = variantRaw?.onlyElements
      ? new RegExp(variantRaw.onlyElements, "u")
      : /^(?:a|button|input|select|textarea|summary)$/;
    const findings: RawFinding[] = [];
    for (const analysis of context.files) {
      if (cssApply) {
        const applies = analysis.styles.flatMap((piece) =>
          piece.scan.atRules.filter((rule) => rule.name === "apply"),
        );
        const excess = applies[maxApply];
        if (excess)
          findings.push({
            file: analysis.path,
            line: excess.line,
            column: excess.column,
            detail: `${applies.length} @apply rules (max ${maxApply})`,
          });
      }
      for (const text of classTexts(analysis)) {
        const tokens = text.value.split(/\s+/).filter(Boolean);
        const at = { file: analysis.path, line: text.line, column: text.column };
        if (dynamic) {
          const mixed = tokens.find((t) => t !== UNKNOWN && t.includes(UNKNOWN));
          if (mixed)
            findings.push({
              ...at,
              detail: `class name built by interpolation: ${mixed.replaceAll(UNKNOWN, "<dynamic>")}`,
            });
        }
        if (token)
          for (const t of tokens)
            if (!t.includes(UNKNOWN) && token.test(t))
              findings.push({ ...at, detail: `arbitrary value ${t}` });
        if (conflicts.length > 0) {
          const byVariant = new Map<string, string[]>();
          for (const t of tokens) {
            if (t.includes(UNKNOWN)) continue;
            const { variant, utility } = splitVariant(t);
            byVariant.set(variant, [...(byVariant.get(variant) ?? []), utility]);
          }
          for (const group of conflicts)
            for (const [variant, utilities] of byVariant) {
              const hits = [
                ...new Set(utilities.filter((u) => group.some((entry) => matchesEntry(entry, u)))),
              ];
              if (hits.length >= 2)
                findings.push({
                  ...at,
                  detail: `conflicting utilities ${hits.map((h) => (variant ? `${variant}:${h}` : h)).join(" ")}`,
                });
            }
        }
        if (variantRaw && text.attribute && text.tag !== undefined && only.test(text.tag)) {
          const parsed = tokens.filter((t) => !t.includes(UNKNOWN)).map(splitVariant);
          const lead = parsed.filter(({ variant }) =>
            variant.split(":").includes(variantRaw.variant),
          );
          const covered = parsed.some(({ variant }) =>
            variant.split(":").some((v) => variantRaw.counterparts.includes(v)),
          );
          if (lead.length > 0 && !covered)
            findings.push({
              ...at,
              detail: `${variantRaw.variant}: styles without ${variantRaw.counterparts.join(" or ")} on <${text.tag}>`,
            });
        }
      }
    }
    return { findings };
  },
};
