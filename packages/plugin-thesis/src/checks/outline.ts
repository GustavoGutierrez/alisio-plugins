import { flattenOutline, type OutlineNode, parseOutline } from "../outline.js";
import type { ComplianceProfile } from "../policy/resolver.js";
import { parseProtocol } from "../protocol.js";
import { type Finding, idPatterns } from "../types.js";
import type { LoadedProject } from "./project.js";

const file = "outline/outline.json";

// ---------------------------------------------------------------------------------------------
// Required sections from the compliance profile
// ---------------------------------------------------------------------------------------------

/** Items the template generates, or wildcards, which the outline does not host as sections. */
const templateProvided = new Set([
  "cubierta",
  "portada",
  "contenido",
  "listas_especiales",
  "palabras_clave",
  "capitulos",
]);
/** `resumen` and `abstract` are one requirement written in two languages. */
const abstractGroup = ["resumen", "abstract"] as const;

export interface RequiredSections {
  /** Each entry is satisfied by a section whose requiredKey is any of `keys`. */
  groups: { id: string; keys: string[] }[];
  /** Ordered lists from single rules; their relative order is enforced pairwise. */
  orders: string[][];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const idsOf = (value: unknown, onlyRequired: boolean): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        isObject(entry) &&
        typeof entry.id === "string" &&
        (!onlyRequired || entry.required === true)
          ? [entry.id]
          : [],
      )
    : [];

export function requiredSections(profile: ComplianceProfile | undefined): RequiredSections {
  const orders: string[][] = [];
  if (!profile) return { groups: [], orders };
  const required = new Set<string>();
  for (const rule of profile.rules) {
    if (rule.kind === "required_section") {
      const values = rule.values;
      const listed = strings(values.sections);
      if (listed.length > 0) {
        orders.push(listed);
        for (const key of listed) required.add(key);
      }
      const body = strings(values.body);
      const back = idsOf(values.backMatter, true);
      if (body.length > 0 || back.length > 0) {
        const order = [...body, ...back];
        orders.push(order);
        for (const key of order) required.add(key);
      }
    } else if (rule.kind === "front_matter_order") {
      for (const key of idsOf(rule.values.order, true)) required.add(key);
    }
  }
  if (profile.aiDeclaration.required) required.add("ai_declaration");
  const groups: RequiredSections["groups"] = [];
  const abstractKeys = abstractGroup.filter((key) => required.has(key));
  if (abstractKeys.length > 0) groups.push({ id: "abstract", keys: [...abstractGroup] });
  for (const key of [...required].sort()) {
    if (templateProvided.has(key) || (abstractGroup as readonly string[]).includes(key)) continue;
    groups.push({ id: key, keys: [key] });
  }
  const known = new Set(groups.flatMap((group) => group.keys));
  const filteredOrders = orders
    .map((order) => order.filter((key) => known.has(key)))
    .filter((order) => order.length > 1);
  return { groups, orders: filteredOrders };
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

const out = (
  code: string,
  severity: Finding["severity"],
  message: string,
  hint?: string,
): Finding => ({
  code,
  gate: "G4",
  severity,
  file,
  message,
  ...(hint ? { hint } : {}),
});

function findCycle(nodes: readonly OutlineNode[]): string[] | undefined {
  const edges = new Map(nodes.map((node) => [node.id, node.dependsOn]));
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "open") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "open");
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of edges.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return undefined;
}

export interface OutlineContext {
  /** Objective ids of the protocol, split so the general objective needs no coverage. */
  specificObjectiveIds: string[] | undefined;
  allObjectiveIds: string[] | undefined;
  profile: ComplianceProfile | undefined;
}

export function protocolObjectives(
  protocolText: string | undefined,
): Pick<OutlineContext, "specificObjectiveIds" | "allObjectiveIds"> {
  if (protocolText === undefined)
    return { specificObjectiveIds: undefined, allObjectiveIds: undefined };
  const data = parseProtocol(protocolText).data;
  if (!data) return { specificObjectiveIds: undefined, allObjectiveIds: undefined };
  const specific = Array.isArray(data.specificObjectives)
    ? data.specificObjectives.flatMap((entry) =>
        isObject(entry) && typeof entry.id === "string" ? [entry.id] : [],
      )
    : [];
  return { specificObjectiveIds: specific, allObjectiveIds: ["OBJ-G", ...specific] };
}

/** OUT-001..OUT-007 over the text of outline.json. Also used to give the architect feedback. */
export function outlineFindings(outlineText: string, context: OutlineContext): Finding[] {
  const parsed = parseOutline(outlineText);
  if (!parsed.outline) {
    return parsed.errors.map((message) =>
      out("OUT-001", "error", message, "Run /thesis:outline again."),
    );
  }
  const nodes = flattenOutline(parsed.outline.sections);
  const findings: Finding[] = [];

  // OUT-001: ids.
  const seen = new Set<string>();
  const checkIds = (list: readonly OutlineNode[], parent?: OutlineNode) => {
    for (const node of list) {
      if (!idPatterns.section.test(node.id))
        findings.push(
          out("OUT-001", "error", `Section id "${node.id}" does not match SEC-nn[.nn[.nn]]`),
        );
      else if (parent && !node.id.startsWith(`${parent.id}.`))
        findings.push(
          out(
            "OUT-001",
            "error",
            `Section ${node.id} is not numbered under its parent ${parent.id}`,
          ),
        );
      if (seen.has(node.id))
        findings.push(out("OUT-001", "error", `Section id ${node.id} is used more than once`));
      seen.add(node.id);
      checkIds(node.children, node);
    }
  };
  checkIds(parsed.outline.sections);

  // OUT-002: dependencies.
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id)
        findings.push(out("OUT-002", "error", `Section ${node.id} depends on itself`));
      else if (!seen.has(dependency))
        findings.push(
          out("OUT-002", "error", `Section ${node.id} depends on unknown section ${dependency}`),
        );
    }
  }
  const cycle = findCycle(nodes);
  if (cycle)
    findings.push(
      out(
        "OUT-002",
        "error",
        `The dependsOn graph has a cycle: ${cycle.join(" -> ")}`,
        "Remove one dependency so the sections can be ordered.",
      ),
    );

  // OUT-003 and OUT-006: objectives.
  if (context.allObjectiveIds && context.specificObjectiveIds) {
    for (const node of nodes) {
      for (const objective of node.objectives) {
        if (!context.allObjectiveIds.includes(objective)) {
          findings.push(
            out(
              "OUT-006",
              "error",
              `Section ${node.id} lists unknown objective ${objective}`,
              `Known objectives: ${context.allObjectiveIds.join(", ")}.`,
            ),
          );
        }
      }
    }
    for (const objective of context.specificObjectiveIds) {
      if (!nodes.some((node) => node.objectives.includes(objective))) {
        findings.push(
          out(
            "OUT-003",
            "error",
            `Specific objective ${objective} is not covered by any section`,
            "Add the objective to a section that serves it, or add a section for it.",
          ),
        );
      }
    }
  }
  for (const node of nodes) {
    if (node.objectives.length === 0 && !node.requiredKey) {
      findings.push(
        out(
          "OUT-007",
          "warning",
          `Section ${node.id} serves no objective and is not a required section`,
        ),
      );
    }
  }

  // OUT-004 and OUT-005: required sections and their order.
  const required = requiredSections(context.profile);
  const position = (keys: readonly string[]) =>
    nodes.findIndex((node) => node.requiredKey !== undefined && keys.includes(node.requiredKey));
  for (const group of required.groups) {
    if (position(group.keys) < 0) {
      findings.push(
        out(
          "OUT-004",
          "error",
          `Required section "${group.id}" is missing`,
          `Add a section with requiredKey "${group.keys[0]}".`,
        ),
      );
    }
  }
  for (const order of required.orders) {
    let last = -1;
    let lastKey = "";
    for (const key of order) {
      const group = required.groups.find((entry) => entry.keys.includes(key));
      const at = position(group ? group.keys : [key]);
      if (at < 0) continue;
      if (at < last) {
        findings.push(
          out(
            "OUT-005",
            "error",
            `Required section "${key}" must come after "${lastKey}"`,
            `The profile prescribes the order: ${order.join(", ")}.`,
          ),
        );
        break;
      }
      last = at;
      lastKey = key;
    }
  }
  return findings;
}

/** G4: the outline (OUT-*). Nothing is reported until an outline exists. */
export function checkOutline(project: LoadedProject): Finding[] {
  if (project.outlineText === undefined) return [];
  return outlineFindings(project.outlineText, {
    ...protocolObjectives(project.protocolText),
    profile: project.profile,
  });
}
