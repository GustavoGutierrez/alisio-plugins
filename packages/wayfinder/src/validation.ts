import { assertRelativePath } from "./storage.js";
import type {
  ArchiveOutput,
  CommandEvidence,
  DesignOutput,
  DiscoveryOutput,
  ImplementationOutput,
  PlanOutput,
  ProposalOutput,
  SpecificationOutput,
  VerificationOutput,
} from "./types.js";

const object = (value: unknown, field = "output"): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
};
const string = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be non-empty`);
  return value.trim();
};
const strings = (value: unknown, field: string, nonEmpty = false): string[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const result = value.map((item, index) => string(item, `${field}[${index}]`));
  if (nonEmpty && result.length === 0) throw new Error(`${field} must not be empty`);
  if (new Set(result).size !== result.length)
    throw new Error(`${field} must not contain duplicates`);
  return result;
};
const array = (value: unknown, field: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
};
const version = (value: Record<string, unknown>) => {
  if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
};
const boolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
};

function evidence(value: unknown, field: string): CommandEvidence[] {
  const checks = array(value, field).map((item, index) => {
    const entry = object(item, `${field}[${index}]`);
    if (entry.status !== "passed") throw new Error(`${field}[${index}].status must be passed`);
    return {
      command: string(entry.command, `${field}[${index}].command`),
      status: "passed" as const,
      summary: string(entry.summary, `${field}[${index}].summary`),
    };
  });
  if (!checks.length) throw new Error(`${field} must contain successful command evidence`);
  return checks;
}

export function parseChildJson(text: string): unknown {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  try {
    return JSON.parse(match?.[1] ?? trimmed);
  } catch {
    throw new Error("Child output is not a single valid JSON value");
  }
}

export function validateDiscovery(raw: unknown): DiscoveryOutput {
  const value = object(raw);
  version(value);
  return {
    schemaVersion: 1,
    summary: string(value.summary, "summary"),
    findings: strings(value.findings, "findings", true),
    constraints: strings(value.constraints, "constraints"),
    criticalQuestions: strings(value.criticalQuestions, "criticalQuestions"),
  };
}

export function validateProposal(raw: unknown): ProposalOutput {
  const value = object(raw);
  version(value);
  return {
    schemaVersion: 1,
    outcome: string(value.outcome, "outcome"),
    inScope: strings(value.inScope, "inScope", true),
    outOfScope: strings(value.outOfScope, "outOfScope"),
    assumptions: strings(value.assumptions, "assumptions"),
    criticalQuestions: strings(value.criticalQuestions, "criticalQuestions"),
  };
}

export function validateSpecification(raw: unknown): SpecificationOutput {
  const value = object(raw);
  version(value);
  const requirements = array(value.requirements, "requirements").map((item, index) => {
    const entry = object(item, `requirements[${index}]`);
    const id = string(entry.id, `requirements[${index}].id`);
    if (!/^REQ-\d{3}$/.test(id)) throw new Error(`Invalid requirement id: ${id}`);
    return {
      id,
      statement: string(entry.statement, `${id}.statement`),
      acceptance: strings(entry.acceptance, `${id}.acceptance`, true),
    };
  });
  if (
    !requirements.length ||
    new Set(requirements.map(({ id }) => id)).size !== requirements.length
  ) {
    throw new Error("Requirements must be non-empty with unique ids");
  }
  return {
    schemaVersion: 1,
    requirements,
    criticalQuestions: strings(value.criticalQuestions, "criticalQuestions"),
  };
}

export function validateDesign(raw: unknown): DesignOutput {
  const value = object(raw);
  version(value);
  const decisions = array(value.decisions, "decisions").map((item, index) => {
    const entry = object(item, `decisions[${index}]`);
    return {
      topic: string(entry.topic, `decisions[${index}].topic`),
      choice: string(entry.choice, `decisions[${index}].choice`),
      rationale: string(entry.rationale, `decisions[${index}].rationale`),
    };
  });
  if (!decisions.length) throw new Error("decisions must not be empty");
  return {
    schemaVersion: 1,
    summary: string(value.summary, "summary"),
    decisions,
    paths: strings(value.paths, "paths").map(assertRelativePath),
    risks: strings(value.risks, "risks"),
  };
}

export function validatePlan(raw: unknown, requirementIds: Set<string>): PlanOutput {
  const value = object(raw);
  version(value);
  const units = array(value.units, "units").map((item, index) => {
    const entry = object(item, `units[${index}]`);
    const id = string(entry.id, `units[${index}].id`);
    if (!/^UNIT-\d{3}$/.test(id)) throw new Error(`Invalid unit id: ${id}`);
    const requirements = strings(entry.requirements, `${id}.requirements`, true);
    if (requirements.some((requirement) => !requirementIds.has(requirement))) {
      throw new Error(`${id} references an unknown requirement`);
    }
    return {
      id,
      title: string(entry.title, `${id}.title`),
      goal: string(entry.goal, `${id}.goal`),
      requirements,
      paths: strings(entry.paths, `${id}.paths`, true).map(assertRelativePath),
      checks: strings(entry.checks, `${id}.checks`, true),
    };
  });
  if (!units.length || new Set(units.map(({ id }) => id)).size !== units.length) {
    throw new Error("Plan units must be non-empty with unique ids");
  }
  const covered = new Set(units.flatMap((unit) => unit.requirements));
  if (covered.size !== requirementIds.size || [...requirementIds].some((id) => !covered.has(id))) {
    throw new Error("Plan must cover every requirement");
  }
  return { schemaVersion: 1, units };
}

export function validateImplementation(raw: unknown, expectedUnit: string): ImplementationOutput {
  const value = object(raw);
  version(value);
  if (string(value.unitId, "unitId") !== expectedUnit) {
    throw new Error(`Implementation output must describe ${expectedUnit}`);
  }
  return {
    schemaVersion: 1,
    unitId: expectedUnit,
    summary: string(value.summary, "summary"),
    changedPaths: strings(value.changedPaths, "changedPaths", true).map(assertRelativePath),
    checks: evidence(value.checks, "checks"),
    notes: strings(value.notes, "notes"),
  };
}

export function validateVerification(
  raw: unknown,
  requirementIds: Set<string>,
): VerificationOutput {
  const value = object(raw);
  version(value);
  const passed = boolean(value.passed, "passed");
  const requirements = array(value.requirements, "requirements").map((item, index) => {
    const entry = object(item, `requirements[${index}]`);
    const id = string(entry.id, `requirements[${index}].id`);
    if (!requirementIds.has(id)) throw new Error(`Unknown verification requirement: ${id}`);
    if (entry.status !== "passed" && entry.status !== "failed") {
      throw new Error(`${id}.status must be passed or failed`);
    }
    return {
      id,
      status: entry.status,
      evidence: strings(entry.evidence, `${id}.evidence`, true),
    } as { id: string; status: "passed" | "failed"; evidence: string[] };
  });
  const ids = requirements.map(({ id }) => id);
  if (
    ids.length !== requirementIds.size ||
    new Set(ids).size !== ids.length ||
    [...requirementIds].some((id) => !ids.includes(id))
  ) {
    throw new Error("Verification must cover every requirement exactly once");
  }
  const blockers = strings(value.blockers, "blockers");
  if (passed && (blockers.length || requirements.some(({ status }) => status === "failed"))) {
    throw new Error("Passing verification cannot contain failures or blockers");
  }
  if (!passed && !blockers.length) throw new Error("Failed verification must contain blockers");
  return {
    schemaVersion: 1,
    passed,
    summary: string(value.summary, "summary"),
    requirements,
    checks: evidence(value.checks, "checks"),
    blockers,
  };
}

export function validateArchive(
  raw: unknown,
  expected: { artifacts: Set<string>; units: Set<string>; requirements: Set<string> },
): ArchiveOutput {
  const value = object(raw);
  version(value);
  const ready = boolean(value.ready, "ready");
  const artifacts = strings(value.artifacts, "artifacts", true).map(assertRelativePath);
  const completedUnits = strings(value.completedUnits, "completedUnits", true);
  const requirements = strings(value.requirements, "requirements", true);
  const blockers = strings(value.blockers, "blockers");
  const exact = (actual: string[], wanted: Set<string>) =>
    actual.length === wanted.size && actual.every((item) => wanted.has(item));
  if (
    !exact(artifacts, expected.artifacts) ||
    !exact(completedUnits, expected.units) ||
    !exact(requirements, expected.requirements)
  ) {
    throw new Error("Archive readiness must cover all required artifacts, units, and requirements");
  }
  if (!ready || blockers.length) throw new Error("Archive is not ready");
  return {
    schemaVersion: 1,
    ready,
    artifacts,
    completedUnits,
    requirements,
    blockers,
    summary: string(value.summary, "summary"),
  };
}
