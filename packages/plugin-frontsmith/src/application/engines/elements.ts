import type { FileAnalysis } from "../ports/file-analyzer.js";
import type { SourceView } from "../ports/source-parser.js";
import type { TemplateKind, TemplateScan } from "../ports/template-scanner.js";

/** An element of JSX or a template, in one shape the element engines can share. */
export interface ElementAttr {
  /** Normalised name: lower case, binding syntax removed, events as `on<event>`. */
  name: string;
  rawName: string;
  value?: string;
  valueKind: "none" | "string" | "template" | "literal" | "expression";
  spread: boolean;
  line: number;
  column: number;
}

export interface ElementNode {
  index: number;
  tag: string;
  attrs: ElementAttr[];
  hasText: boolean;
  text: string;
  parent: number;
  children: number[];
  line: number;
  column: number;
  file: string;
  origin: "jsx" | "template";
  /** Direct child elements that carry a name for assistive technology (`img` with `alt`). */
  namedChildren: boolean;
}

/**
 * Normalise an attribute name written in any supported syntax: lower case, binding syntax removed
 * (`:key`, `v-bind:key`, `[key]`, `[attr.aria-label]`), events as `on<event>` (`@click.prevent`,
 * `v-on:click`, `(click)`, `on:click|once`, `onClick`), `className` as `class`, `htmlFor` as `for`.
 */
export function normalizeAttrName(raw: string): string {
  let name = raw.trim();
  const event =
    /^(?:@|v-on:)([\w:-]+)/.exec(name) ??
    /^on:([\w-]+)/.exec(name) ??
    /^\(([\w-]+)(?:\.[\w.-]+)?\)$/.exec(name);
  if (event) return `on${(event[1] as string).toLowerCase()}`;
  if (name.startsWith("v-bind:")) name = name.slice("v-bind:".length);
  else if (name.startsWith(":")) name = name.slice(1);
  const bracket = /^\[(?:attr\.)?([^\]]+)\]$/.exec(name);
  if (bracket) name = bracket[1] as string;
  name = name.replace(/\.(?:prop|camel|attr)$/, "").toLowerCase();
  if (name === "classname") return "class";
  if (name === "htmlfor") return "for";
  return name;
}

export function jsxElements(view: SourceView, file: string): ElementNode[] {
  const nodes: ElementNode[] = view.jsx
    .filter((record) => record.tag !== "")
    .map((record) => ({
      index: record.index,
      tag: record.tag,
      attrs: record.attrs.map((a) => ({
        name: a.spread ? "..." : normalizeAttrName(a.name),
        rawName: a.name,
        ...(a.value !== undefined ? { value: a.value } : {}),
        valueKind: a.valueKind,
        spread: a.spread,
        line: a.loc.line,
        column: a.loc.column,
      })),
      hasText: record.hasTextChildren,
      text: "",
      parent: record.parent,
      children: [],
      line: record.loc.line,
      column: record.loc.column,
      file,
      origin: "jsx" as const,
      namedChildren: false,
    }));
  link(nodes);
  return nodes;
}

export function templateElements(scan: TemplateScan, file: string): ElementNode[] {
  const nodes: ElementNode[] = scan.elements.map((element) => ({
    index: element.index,
    tag: element.tag,
    attrs: element.attrs.map((a) => {
      // `{...rest}` (Svelte, Astro) and an argument-less `v-bind="obj"` (Vue) spread unknown attributes.
      const spread = a.name.startsWith("{...") || a.name === "v-bind";
      const staticValue = !a.dynamic && a.hasValue && a.value !== undefined;
      return {
        name: spread
          ? "..."
          : a.name.startsWith("{")
            ? normalizeAttrName(a.name.slice(1, -1))
            : normalizeAttrName(a.name),
        rawName: a.name,
        ...(staticValue ? { value: a.value as string } : {}),
        valueKind: !a.hasValue
          ? ("none" as const)
          : staticValue
            ? ("string" as const)
            : ("expression" as const),
        spread,
        line: a.line,
        column: a.column,
      };
    }),
    hasText: element.hasText,
    text: element.text,
    parent: element.parent,
    children: [...element.childElements],
    line: element.line,
    column: element.column,
    file,
    origin: "template" as const,
    namedChildren: false,
  }));
  link(nodes);
  return nodes;
}

function link(nodes: ElementNode[]): void {
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  for (const node of nodes) {
    node.children = nodes
      .filter((other) => other.parent === node.index)
      .map((other) => other.index);
    node.namedChildren = node.children.some((childIndex) => {
      const child = byIndex.get(childIndex);
      if (!child) return false;
      if (child.tag === "img") {
        const alt = child.attrs.find((a) => a.name === "alt");
        return alt !== undefined && (alt.value === undefined || alt.value.trim() !== "");
      }
      return child.attrs.some((a) => a.name === "aria-label" || a.name === "aria-labelledby");
    });
  }
}

export function templateKindsOf(
  analysis: FileAnalysis,
): Array<{ scan: TemplateScan; kind: TemplateKind }> {
  return analysis.templates.map((piece) => ({ scan: piece.scan, kind: piece.kind }));
}

/** Elements of a file grouped by source (one JSX view or template scan each): indexes are local. */
export function elementGroups(
  analysis: FileAnalysis,
  include: { jsx: boolean; templates: boolean },
): ElementNode[][] {
  const groups: ElementNode[][] = [];
  if (include.jsx)
    for (const piece of analysis.scripts) groups.push(jsxElements(piece.view, analysis.path));
  if (include.templates)
    for (const piece of analysis.templates)
      groups.push(templateElements(piece.scan, analysis.path));
  return groups.filter((group) => group.length > 0);
}

export const findAttr = (element: ElementNode, name: string): ElementAttr | undefined =>
  element.attrs.find((a) => !a.spread && a.name === normalizeAttrName(name));

export const hasSpread = (element: ElementNode): boolean => element.attrs.some((a) => a.spread);

export function ancestors(nodes: readonly ElementNode[], element: ElementNode): ElementNode[] {
  const out: ElementNode[] = [];
  let current = element.parent;
  const byIndex = new Map(nodes.map((n) => [n.index, n]));
  while (current >= 0) {
    const next = byIndex.get(current);
    if (!next) break;
    out.push(next);
    current = next.parent;
  }
  return out;
}

export function descendants(nodes: readonly ElementNode[], element: ElementNode): ElementNode[] {
  const byIndex = new Map(nodes.map((n) => [n.index, n]));
  const out: ElementNode[] = [];
  const stack = [...element.children];
  while (stack.length > 0) {
    const next = byIndex.get(stack.pop() as number);
    if (!next) continue;
    out.push(next);
    stack.push(...next.children);
  }
  return out;
}
