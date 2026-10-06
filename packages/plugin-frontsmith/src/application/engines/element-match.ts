import {
  ancestors,
  descendants,
  type ElementNode,
  elementGroups,
  findAttr,
  hasSpread,
  normalizeAttrName,
} from "./elements.js";
import { ParamReader } from "./params.js";
import type { EngineContext, RawFinding } from "./types.js";

/** Params shared by `jsx-element` and `template-element` (spec 10.4 plus the owner extensions). */
export const ELEMENT_PARAMS = [
  "element",
  "hasAttr",
  "hasAttrMode",
  "lacksAttr",
  "lacksAttrMode",
  "attrValue",
  "lacksAccessibleName",
  "insideElement",
  "lacksDescendant",
  "exemptAttrValue",
] as const;

interface AttrValueSpec {
  name: string;
  value: RegExp;
}

export interface ElementSpec {
  element?: RegExp;
  hasAttr: string[];
  hasAttrMode: "allOf" | "anyOf";
  lacksAttr: string[];
  lacksAttrMode: "allOf" | "anyOf";
  attrValue?: AttrValueSpec;
  lacksAccessibleName: boolean;
  insideElement?: RegExp;
  lacksDescendant?: RegExp;
  exemptAttrValue?: { names: string[]; value: RegExp };
}

/** Read and validate the shared element params; errors land on the reader. */
export function readElementSpec(reader: ParamReader, requireElement: boolean): ElementSpec {
  const element = reader.regex("element", requireElement);
  const spec: ElementSpec = {
    ...(element ? { element } : {}),
    hasAttr: reader.strings("hasAttr") ?? [],
    hasAttrMode: reader.oneOf("hasAttrMode", ["allOf", "anyOf"]) ?? "allOf",
    lacksAttr: reader.strings("lacksAttr") ?? [],
    lacksAttrMode: reader.oneOf("lacksAttrMode", ["allOf", "anyOf"]) ?? "allOf",
    lacksAccessibleName: reader.bool("lacksAccessibleName") === true,
  };
  const attrValue = reader.object("attrValue");
  if (attrValue) {
    const inner = new ParamReader(attrValue, ["name", "value"]);
    const name = inner.string("name", true);
    const value = inner.regex("value", true);
    for (const error of inner.errors) reader.errors.push(`attrValue.${error}`);
    if (name && value) spec.attrValue = { name: normalizeAttrName(name), value };
  }
  const inside = reader.regex("insideElement");
  if (inside) spec.insideElement = inside;
  const lacksDescendant = reader.regex("lacksDescendant");
  if (lacksDescendant) spec.lacksDescendant = lacksDescendant;
  const exempt = reader.object("exemptAttrValue");
  if (exempt) {
    const inner = new ParamReader(exempt, ["names", "value"]);
    const names = inner.strings("names", true);
    const value = inner.regex("value", true);
    for (const error of inner.errors) reader.errors.push(`exemptAttrValue.${error}`);
    if (names && value) spec.exemptAttrValue = { names: names.map(normalizeAttrName), value };
  }
  return spec;
}

const present = (element: ElementNode, name: string): boolean =>
  findAttr(element, name) !== undefined;

const staticValue = (element: ElementNode, name: string): string | undefined => {
  const attr = findAttr(element, name);
  return attr && attr.valueKind !== "expression" && attr.valueKind !== "none"
    ? attr.value
    : undefined;
};

/** Does `element` satisfy every precondition of the spec? Spread attributes block "lacks" claims. */
export function elementMatches(
  spec: ElementSpec,
  element: ElementNode,
  all: readonly ElementNode[],
): boolean {
  if (spec.element && !spec.element.test(element.tag)) return false;
  if (spec.hasAttr.length > 0) {
    const has = spec.hasAttr.map((name) => present(element, name));
    if (spec.hasAttrMode === "allOf" ? !has.every(Boolean) : !has.some(Boolean)) return false;
  }
  if (spec.lacksAttr.length > 0) {
    if (hasSpread(element)) return false;
    const missing = spec.lacksAttr.map((name) => !present(element, name));
    if (spec.lacksAttrMode === "allOf" ? !missing.every(Boolean) : !missing.some(Boolean))
      return false;
  }
  if (spec.attrValue) {
    const value = staticValue(element, spec.attrValue.name);
    if (value === undefined || !spec.attrValue.value.test(value)) return false;
  }
  if (spec.lacksAccessibleName) {
    if (hasSpread(element) || element.hasText || element.namedChildren) return false;
    if (["aria-label", "aria-labelledby", "title"].some((name) => present(element, name)))
      return false;
  }
  if (spec.insideElement && !ancestors(all, element).some((a) => spec.insideElement?.test(a.tag)))
    return false;
  if (spec.lacksDescendant) {
    const pattern = spec.lacksDescendant;
    if (descendants(all, element).some((d) => pattern.test(d.tag))) return false;
  }
  if (spec.exemptAttrValue) {
    const { names, value } = spec.exemptAttrValue;
    if (
      names.some((name) => {
        const v = staticValue(element, name);
        return v !== undefined && value.test(v);
      })
    )
      return false;
  }
  return true;
}

/** Run an element spec over the files of a context. */
export function runElementSpec(
  context: EngineContext,
  spec: ElementSpec,
  include: { jsx: boolean; templates: boolean },
): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const analysis of context.files)
    for (const group of elementGroups(analysis, include))
      for (const element of group)
        if (elementMatches(spec, element, group))
          findings.push({
            file: analysis.path,
            line: element.line,
            column: element.column,
            detail: `<${element.tag}>`,
          });
  return findings;
}
