import { type ElementNode, elementGroups, findAttr, hasSpread } from "./elements.js";
import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const PARAMS = ["catalog"] as const;

/** Native elements that already supply the state a role would require (`h2` is a heading level). */
function nativeProvides(role: string, element: ElementNode, selectors: readonly string[]): boolean {
  const type = findAttr(element, "type")?.value?.toLowerCase();
  return (
    selectors.some((selector) => {
      const [tag, kind] = selector.split(":");
      return element.tag === tag && (kind === undefined || kind === type);
    }) ||
    (role === "heading" && /^h[1-6]$/.test(element.tag))
  );
}

export const ariaAttribute: Engine = {
  id: "aria-attribute",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    reader.oneOf("catalog", ["aria-1.2"], true);
    return reader.errors;
  },
  run(context) {
    const aria = context.aria;
    const knownAttributes = new Set(aria.attributes);
    const knownRoles = new Set(aria.roles);
    const findings: RawFinding[] = [];
    for (const analysis of context.files)
      for (const group of elementGroups(analysis, { jsx: true, templates: true }))
        for (const element of group) {
          const report = (detail: string): void => {
            findings.push({
              file: analysis.path,
              line: element.line,
              column: element.column,
              detail,
            });
          };
          for (const attr of element.attrs)
            if (!attr.spread && attr.name.startsWith("aria-") && !knownAttributes.has(attr.name))
              report(`unknown attribute ${attr.rawName}`);
          const role = findAttr(element, "role");
          if (!role || role.value === undefined) continue;
          const tokens = role.value.trim().split(/\s+/).filter(Boolean);
          const known = tokens.find((token) => knownRoles.has(token));
          if (tokens.length > 0 && known === undefined) {
            report(`unknown role "${role.value}"`);
            continue;
          }
          if (!known || hasSpread(element)) continue;
          const required = aria.requiredAttributes[known] ?? [];
          if (nativeProvides(known, element, aria.nativeSemantics[known] ?? [])) continue;
          const missing = required.filter((name) => !findAttr(element, name));
          if (missing.length > 0) report(`role "${known}" requires ${missing.join(", ")}`);
        }
    return { findings };
  },
};
