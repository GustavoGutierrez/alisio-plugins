import { type EnvelopeResult, type OpenQuestion, openEnvelope, readQuestions } from "./parse.js";

export const stateKinds = [
  "initial",
  "loading",
  "success",
  "empty",
  "partial",
  "validation-error",
  "server-error",
  "offline",
  "forbidden",
  "disabled",
  "submitting",
  "success-feedback",
  "custom",
] as const;
export type StateKind = (typeof stateKinds)[number];
export const priorities = ["must", "should", "could"] as const;

export interface SpecEnvelope {
  schemaVersion: 1;
  kind: "spec";
  problem: string;
  objective: string;
  users: Array<{ role: string; permissions: string[] }>;
  inScope: string[];
  outOfScope: string[];
  requirements: Array<{ id: string; statement: string; priority: (typeof priorities)[number] }>;
  businessRules: string[];
  states: Array<{ id: string; kind: StateKind; description: string }>;
  acceptanceCriteria: Array<{
    id: string;
    requirementId: string;
    given: string;
    when: string;
    then: string;
    critical: boolean;
  }>;
  edgeCases: string[];
  accessibility: string[];
  performance: string[];
  security: string[];
  analytics: string[];
  assumptions: string[];
  openQuestions: OpenQuestion[];
}

const KEYS = [
  "problem",
  "objective",
  "users",
  "inScope",
  "outOfScope",
  "requirements",
  "businessRules",
  "states",
  "acceptanceCriteria",
  "edgeCases",
  "accessibility",
  "performance",
  "security",
  "analytics",
  "assumptions",
  "openQuestions",
] as const;

/** Structural validation of a `SpecEnvelope`; cross references are gate G1's job (spec 7.2). */
export function validateSpec(raw: unknown): EnvelopeResult<SpecEnvelope> {
  const { check, root } = openEnvelope(raw, "spec", KEYS);
  if (!root) return check.result(undefined as never);
  const users = check.array(root, "users", "", (item, at) => {
    const user = check.object(item, at, ["role", "permissions"]);
    if (!user) return undefined;
    return {
      role: check.string(user, "role", at) ?? "",
      permissions: check.strings(user, "permissions", at, { optional: true }),
    };
  });
  const requirements = check.array(root, "requirements", "", (item, at) => {
    const req = check.object(item, at, ["id", "statement", "priority"]);
    if (!req) return undefined;
    return {
      id: check.id(req, "id", at, "requirement") ?? "",
      statement: check.string(req, "statement", at) ?? "",
      priority: check.enum(req, "priority", at, priorities) ?? "must",
    };
  });
  check.unique(requirements, "/requirements");
  const states = check.array(root, "states", "", (item, at) => {
    const state = check.object(item, at, ["id", "kind", "description"]);
    if (!state) return undefined;
    return {
      id: check.id(state, "id", at, "state") ?? "",
      kind: check.enum(state, "kind", at, stateKinds) ?? "custom",
      description: check.string(state, "description", at) ?? "",
    };
  });
  check.unique(states, "/states");
  const acceptanceCriteria = check.array(root, "acceptanceCriteria", "", (item, at) => {
    const ac = check.object(item, at, ["id", "requirementId", "given", "when", "then", "critical"]);
    if (!ac) return undefined;
    return {
      id: check.id(ac, "id", at, "acceptance") ?? "",
      requirementId: check.id(ac, "requirementId", at, "requirement") ?? "",
      given: check.string(ac, "given", at) ?? "",
      when: check.string(ac, "when", at) ?? "",
      // biome-ignore lint/suspicious/noThenProperty: `then` is a field of the spec envelope (given, when, then).
      then: check.string(ac, "then", at) ?? "",
      critical: check.bool(ac, "critical", at, true) ?? false,
    };
  });
  check.unique(acceptanceCriteria, "/acceptanceCriteria");
  const value: SpecEnvelope = {
    schemaVersion: 1,
    kind: "spec",
    problem: check.string(root, "problem", "") ?? "",
    objective: check.string(root, "objective", "") ?? "",
    users,
    inScope: check.strings(root, "inScope", ""),
    outOfScope: check.strings(root, "outOfScope", ""),
    requirements,
    businessRules: check.strings(root, "businessRules", "", { optional: true }),
    states,
    acceptanceCriteria,
    edgeCases: check.strings(root, "edgeCases", "", { optional: true }),
    accessibility: check.strings(root, "accessibility", "", { optional: true }),
    performance: check.strings(root, "performance", "", { optional: true }),
    security: check.strings(root, "security", "", { optional: true }),
    analytics: check.strings(root, "analytics", "", { optional: true }),
    assumptions: check.strings(root, "assumptions", "", { optional: true }),
    openQuestions: readQuestions(check, root, "openQuestions"),
  };
  return check.result(value);
}
