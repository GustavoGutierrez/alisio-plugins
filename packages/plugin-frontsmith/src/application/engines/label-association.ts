import { ancestors, type ElementNode, elementGroups, findAttr, hasSpread } from "./elements.js";
import { ParamReader } from "./params.js";
import type { Engine, RawFinding } from "./types.js";

const PARAMS = ["controls", "requirePlaceholder"] as const;
const EXCLUDED_TYPES = /^(?:hidden|submit|button|reset|image)$/i;

/**
 * Form controls need an accessible label: `aria-label`, `aria-labelledby`, a wrapping `<label>` or
 * a `<label for>` whose target is the control's `id` in the same file. Dynamic ids and spread
 * attributes cannot be checked, so they never produce a finding.
 */
export const labelAssociation: Engine = {
  id: "jsx-label-association",
  validateParams(params) {
    const reader = new ParamReader(params, PARAMS);
    reader.regex("controls");
    reader.bool("requirePlaceholder");
    return reader.errors;
  },
  run(context) {
    const reader = new ParamReader(context.params, PARAMS);
    const controls = reader.regex("controls") ?? /^(?:input|select|textarea)$/;
    const needPlaceholder = reader.bool("requirePlaceholder") === true;
    const findings: RawFinding[] = [];
    for (const analysis of context.files)
      for (const group of elementGroups(analysis, { jsx: true, templates: true })) {
        const labelTargets = new Set<string>();
        let dynamicLabelFor = false;
        for (const element of group) {
          if (element.tag !== "label") continue;
          const target = findAttr(element, "for");
          if (target?.value !== undefined) labelTargets.add(target.value);
          else if (target) dynamicLabelFor = true;
        }
        for (const element of group) {
          if (!controls.test(element.tag) || hasSpread(element)) continue;
          const type = findAttr(element, "type");
          if (
            element.tag === "input" &&
            type?.value !== undefined &&
            EXCLUDED_TYPES.test(type.value)
          )
            continue;
          if (needPlaceholder && !findAttr(element, "placeholder")) continue;
          if (findAttr(element, "aria-label") || findAttr(element, "aria-labelledby")) continue;
          if (ancestors(group, element).some((a: ElementNode) => a.tag === "label")) continue;
          const id = findAttr(element, "id");
          if (id) {
            if (id.value === undefined) continue;
            if (labelTargets.has(id.value)) continue;
          }
          if (dynamicLabelFor) continue;
          findings.push({
            file: analysis.path,
            line: element.line,
            column: element.column,
            detail: `<${element.tag}> has no label`,
          });
        }
      }
    return { findings };
  },
};
