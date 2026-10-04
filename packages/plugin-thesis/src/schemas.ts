import { stringify as stringifyYaml } from "yaml";
import {
  type Approach,
  approaches,
  type ClaimKind,
  claimKinds,
  type EvidenceStatus,
  type EvidenceType,
  evidenceStatuses,
  evidenceTypes,
  type FindingSeverity,
  type PermittedUse,
  permittedUses,
  type ReviewCategory,
  type ReviewRoute,
  reviewCategories,
  reviewRoutes,
  routeOfCategory,
} from "./types.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is stripped
const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Child output is untrusted: remove control characters before any further use. */
export function stripControl(text: string): string {
  return text.replace(controlPattern, "");
}

/**
 * Parse a child's reply: a strict JSON document, or exactly one fenced `json` block. Anything else
 * (prose around the JSON, several blocks) is rejected so the coordinator can retry with the error.
 */
export function parseChildJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("The child returned no output");
  const fences = [...trimmed.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  let candidate = trimmed;
  if (fences.length > 1) throw new Error("The child returned more than one JSON block");
  if (fences.length === 1) {
    const [block, inner] = fences[0] as RegExpMatchArray;
    if (trimmed.replace(block, "").trim())
      throw new Error("The child wrapped its JSON in extra prose");
    candidate = (inner as string).trim();
  }
  try {
    return JSON.parse(candidate);
  } catch {
    throw new Error("The child output is not valid JSON");
  }
}

/** Optional child suggestions during intake: working titles and a detected domain or approach. */
export interface IntakeDraft {
  titles: string[];
  domain?: string;
  approach?: Approach;
  notes?: string;
}

const domainPattern = /^[a-z][a-z0-9_]{1,40}$/;

export function validateIntakeDraft(value: unknown): { value?: IntakeDraft; errors: string[] } {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { errors: ["IntakeDraft must be a JSON object"] };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["titles", "domain", "approach", "notes"].includes(key))
      errors.push(`Unknown field: ${key}`);
  }
  const titles = record.titles;
  const cleanTitles: string[] = [];
  if (!Array.isArray(titles) || titles.length < 1 || titles.length > 3) {
    errors.push("titles must hold 1 to 3 working titles");
  } else {
    for (const title of titles) {
      const clean = typeof title === "string" ? stripControl(title).trim() : "";
      if (!clean || clean.length > 200) errors.push("each title must be 1 to 200 characters");
      else cleanTitles.push(clean);
    }
  }
  const draft: IntakeDraft = { titles: cleanTitles };
  if (record.domain !== undefined) {
    if (typeof record.domain === "string" && domainPattern.test(record.domain))
      draft.domain = record.domain;
    else errors.push("domain must be a snake_case id");
  }
  if (record.approach !== undefined) {
    if (
      typeof record.approach === "string" &&
      (approaches as readonly string[]).includes(record.approach)
    ) {
      draft.approach = record.approach as Approach;
    } else errors.push(`approach must be one of: ${approaches.join(", ")}`);
  }
  if (record.notes !== undefined) {
    if (typeof record.notes === "string" && record.notes.length <= 1000)
      draft.notes = stripControl(record.notes);
    else errors.push("notes must be a string of at most 1000 characters");
  }
  return errors.length > 0 ? { errors } : { value: draft, errors };
}

// ---------------------------------------------------------------------------------------------
// Envelope validation toolkit. Each validator returns { value } or { errors }; text is stripped of
// control characters and capped, unknown fields are errors (spec 4.5).
// ---------------------------------------------------------------------------------------------

export type Validated<T> = { value: T; errors: [] } | { value?: undefined; errors: string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function record(
  value: unknown,
  path: string,
  allowed: readonly string[],
  errors: string[],
): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    errors.push(`${path} must be a JSON object`);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}: unknown field ${key}`);
  }
  return value;
}

function text(
  source: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  max: number,
  options: { optional?: boolean; min?: number } = {},
): string | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    if (!options.optional) errors.push(`${path}.${key} is required`);
    return undefined;
  }
  if (typeof raw !== "string") {
    errors.push(`${path}.${key} must be a string`);
    return undefined;
  }
  const clean = stripControl(raw).trim();
  if (clean.length < (options.min ?? 1) || clean.length > max) {
    errors.push(
      `${path}.${key} must be ${options.min ?? 1} to ${max} characters (got ${clean.length})`,
    );
    return undefined;
  }
  return clean;
}

function list(
  source: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  options: { min?: number; max: number; item: number; optional?: boolean },
): string[] | undefined {
  const raw = source[key];
  if (raw === undefined && options.optional) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${path}.${key} must be a list`);
    return undefined;
  }
  if (raw.length < (options.min ?? 0) || raw.length > options.max) {
    errors.push(
      `${path}.${key} must hold ${options.min ?? 0} to ${options.max} items (got ${raw.length})`,
    );
    return undefined;
  }
  const out: string[] = [];
  raw.forEach((entry, index) => {
    const clean = typeof entry === "string" ? stripControl(entry).trim() : "";
    if (!clean || clean.length > options.item) {
      errors.push(`${path}.${key}[${index}] must be 1 to ${options.item} characters`);
    } else out.push(clean);
  });
  return out;
}

function oneOf<T extends string>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  values: readonly T[],
  optional = false,
): T | undefined {
  const raw = source[key];
  if (raw === undefined && optional) return undefined;
  if (typeof raw !== "string" || !(values as readonly string[]).includes(raw)) {
    errors.push(`${path}.${key} must be one of: ${values.join(", ")}`);
    return undefined;
  }
  return raw as T;
}

function integer(
  source: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  min: number,
  max: number,
  optional = false,
): number | undefined {
  const raw = source[key];
  if (raw === undefined && optional) return undefined;
  if (!Number.isInteger(raw) || (raw as number) < min || (raw as number) > max) {
    errors.push(`${path}.${key} must be an integer from ${min} to ${max}`);
    return undefined;
  }
  return raw as number;
}

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

function finish<T>(errors: string[], value: T): Validated<T> {
  return errors.length > 0 ? { errors } : { value, errors: [] };
}

// ---------------------------------------------------------------------------------------------
// ProtocolDraft
// ---------------------------------------------------------------------------------------------

export interface ProtocolDraft {
  problem: string;
  researchQuestions: string[];
  generalObjective: string;
  specificObjectives: { verb: string; object: string; deliverable: string }[];
  justification: { relevance: string; novelty: string; feasibility: string; beneficiaries: string };
  scope: string;
  limitations: string[];
  hypotheses: string[];
  methodology: {
    design: string;
    population: string;
    instruments: string[];
    analysisPlan: string;
    reportingGuideline: string | null;
  };
  ethics: Record<string, boolean>;
  openQuestions: string[];
}

const ethicsIds = [
  "human_participants",
  "minors",
  "identifiable_personal_data",
  "sensitive_data",
  "intervention",
  "risk_above_minimal",
  "biological_samples",
  "animals",
  "communities",
  "clinical_research",
  "additional_institutional_rules",
] as const;

export function validateProtocolDraft(
  value: unknown,
  context: { approach: Approach },
): Validated<ProtocolDraft> {
  const errors: string[] = [];
  const top = record(
    value,
    "ProtocolDraft",
    [
      "problem",
      "researchQuestions",
      "generalObjective",
      "specificObjectives",
      "justification",
      "scope",
      "limitations",
      "hypotheses",
      "methodology",
      "ethics",
      "openQuestions",
    ],
    errors,
  );
  if (!top) return { errors };
  const problem = text(top, "problem", "ProtocolDraft", errors, 2000);
  const researchQuestions = list(top, "researchQuestions", "ProtocolDraft", errors, {
    min: 1,
    max: 5,
    item: 400,
  });
  const generalObjective = text(top, "generalObjective", "ProtocolDraft", errors, 400);
  const specificObjectives: ProtocolDraft["specificObjectives"] = [];
  if (
    !Array.isArray(top.specificObjectives) ||
    top.specificObjectives.length < 2 ||
    top.specificObjectives.length > 6
  ) {
    errors.push("ProtocolDraft.specificObjectives must hold 2 to 6 objectives");
  } else {
    top.specificObjectives.forEach((entry, index) => {
      const path = `specificObjectives[${index}]`;
      const item = record(entry, path, ["verb", "object", "deliverable"], errors);
      if (!item) return;
      const verb = text(item, "verb", path, errors, 40);
      const object = text(item, "object", path, errors, 300);
      const deliverable = text(item, "deliverable", path, errors, 300);
      if (verb && /\s/.test(verb)) errors.push(`${path}.verb must be a single action verb`);
      if (verb && object && deliverable) specificObjectives.push({ verb, object, deliverable });
    });
  }
  const justificationInput = record(
    top.justification,
    "justification",
    ["relevance", "novelty", "feasibility", "beneficiaries"],
    errors,
  );
  const justification = justificationInput
    ? {
        relevance: text(justificationInput, "relevance", "justification", errors, 1200) ?? "",
        novelty: text(justificationInput, "novelty", "justification", errors, 1200) ?? "",
        feasibility: text(justificationInput, "feasibility", "justification", errors, 1200) ?? "",
        beneficiaries:
          text(justificationInput, "beneficiaries", "justification", errors, 1200) ?? "",
      }
    : undefined;
  const scope = text(top, "scope", "ProtocolDraft", errors, 1500);
  const limitations = list(top, "limitations", "ProtocolDraft", errors, {
    max: 10,
    item: 400,
    optional: true,
  });
  const hypotheses = list(top, "hypotheses", "ProtocolDraft", errors, {
    max: 6,
    item: 400,
    optional: true,
  });
  if (context.approach === "quantitative" && hypotheses && hypotheses.length === 0) {
    errors.push("ProtocolDraft.hypotheses is required for a quantitative approach");
  }
  const methodInput = record(
    top.methodology,
    "methodology",
    ["design", "population", "instruments", "analysisPlan", "reportingGuideline"],
    errors,
  );
  let methodology: ProtocolDraft["methodology"] | undefined;
  if (methodInput) {
    const design = text(methodInput, "design", "methodology", errors, 600);
    const population = text(methodInput, "population", "methodology", errors, 600);
    const instruments = list(methodInput, "instruments", "methodology", errors, {
      max: 8,
      item: 300,
      optional: true,
    });
    const analysisPlan = text(methodInput, "analysisPlan", "methodology", errors, 1200);
    let reportingGuideline: string | null = null;
    if (methodInput.reportingGuideline !== undefined && methodInput.reportingGuideline !== null) {
      reportingGuideline =
        text(methodInput, "reportingGuideline", "methodology", errors, 100) ?? null;
    }
    if (design && population && instruments && analysisPlan) {
      methodology = { design, population, instruments, analysisPlan, reportingGuideline };
    }
  }
  const ethics: Record<string, boolean> = {};
  const ethicsInput = record(top.ethics, "ethics", ethicsIds, errors);
  if (ethicsInput) {
    for (const id of ethicsIds) {
      if (typeof ethicsInput[id] !== "boolean") errors.push(`ethics.${id} must be true or false`);
      else ethics[id] = ethicsInput[id];
    }
  }
  const openQuestions = list(top, "openQuestions", "ProtocolDraft", errors, {
    max: 10,
    item: 400,
    optional: true,
  });
  if (
    !problem ||
    !researchQuestions ||
    !generalObjective ||
    !justification ||
    !scope ||
    !limitations ||
    !hypotheses ||
    !methodology ||
    !openQuestions
  ) {
    return { errors: errors.length ? errors : ["ProtocolDraft is incomplete"] };
  }
  return finish(errors, {
    problem,
    researchQuestions,
    generalObjective,
    specificObjectives,
    justification,
    scope,
    limitations,
    hypotheses,
    methodology,
    ethics,
    openQuestions,
  });
}

// ---------------------------------------------------------------------------------------------
// OutlineDraft (structure only; coverage, order and cycles are the OUT checks)
// ---------------------------------------------------------------------------------------------

export const evidenceNeeds = [
  "empirical",
  "theoretical",
  "normative",
  "statistical",
  "methodological",
] as const;
export type EvidenceNeed = (typeof evidenceNeeds)[number];

export interface OutlineNodeDraft {
  key: string;
  title: string;
  requiredKey?: string;
  purpose: string;
  objectives: string[];
  researchTopics: string[];
  questionsToAnswer: string[];
  evidenceNeeds: EvidenceNeed[];
  targetWords: number;
  dependsOn: string[];
  children: OutlineNodeDraft[];
}
export interface OutlineDraft {
  sections: OutlineNodeDraft[];
}

const nodeKeys = [
  "key",
  "title",
  "requiredKey",
  "purpose",
  "objectives",
  "researchTopics",
  "questionsToAnswer",
  "evidenceNeeds",
  "targetWords",
  "dependsOn",
  "children",
];
const keyPattern = /^[a-z][a-z0-9-]{0,40}$/;
const requiredKeyPattern = /^[a-z][a-z0-9_]{0,40}$/;
export const maxOutlineNodes = 150;

export function validateOutlineDraft(
  value: unknown,
  context: { objectiveIds: readonly string[] },
): Validated<OutlineDraft> {
  const errors: string[] = [];
  const top = record(value, "OutlineDraft", ["sections"], errors);
  if (!top) return { errors };
  const seen = new Set<string>();
  const dependencies: { path: string; keys: string[] }[] = [];
  let count = 0;

  const readNode = (entry: unknown, path: string, depth: number): OutlineNodeDraft | undefined => {
    count += 1;
    const node = record(entry, path, nodeKeys, errors);
    if (!node) return undefined;
    const key = text(node, "key", path, errors, 41);
    if (key) {
      if (!keyPattern.test(key)) errors.push(`${path}.key must match ${keyPattern}`);
      else if (seen.has(key)) errors.push(`${path}.key "${key}" is used twice`);
      else seen.add(key);
    }
    const title = text(node, "title", path, errors, 200);
    const purpose = text(node, "purpose", path, errors, 300);
    const requiredKey = text(node, "requiredKey", path, errors, 41, { optional: true });
    if (requiredKey && !requiredKeyPattern.test(requiredKey))
      errors.push(`${path}.requiredKey must be snake_case`);
    const objectives = list(node, "objectives", path, errors, { max: 7, item: 10 });
    for (const objective of objectives ?? []) {
      if (!context.objectiveIds.includes(objective)) {
        errors.push(
          `${path}.objectives lists unknown objective ${objective} (known: ${context.objectiveIds.join(", ")})`,
        );
      }
    }
    const researchTopics = list(node, "researchTopics", path, errors, {
      min: 1,
      max: 8,
      item: 200,
    });
    const questionsToAnswer = list(node, "questionsToAnswer", path, errors, { max: 8, item: 300 });
    const needs = list(node, "evidenceNeeds", path, errors, { max: 5, item: 20 });
    for (const need of needs ?? []) {
      if (!(evidenceNeeds as readonly string[]).includes(need)) {
        errors.push(`${path}.evidenceNeeds: "${need}" is not one of ${evidenceNeeds.join(", ")}`);
      }
    }
    const targetWords = integer(node, "targetWords", path, errors, 1, 100000);
    const dependsOn = list(node, "dependsOn", path, errors, { max: 20, item: 41, optional: true });
    if (dependsOn) dependencies.push({ path, keys: dependsOn });
    const children: OutlineNodeDraft[] = [];
    if (node.children !== undefined) {
      if (!Array.isArray(node.children) || node.children.length > 99) {
        errors.push(`${path}.children must be a list of at most 99 sections`);
      } else if (node.children.length > 0 && depth >= 3) {
        errors.push(`${path}: sections nest at most three levels (SEC-01.01.01)`);
      } else {
        node.children.forEach((child, index) => {
          const read = readNode(child, `${path}.children[${index}]`, depth + 1);
          if (read) children.push(read);
        });
      }
    }
    if (
      !key ||
      !title ||
      !purpose ||
      !objectives ||
      !researchTopics ||
      !questionsToAnswer ||
      !needs ||
      targetWords === undefined ||
      !dependsOn
    ) {
      return undefined;
    }
    return {
      key,
      title,
      ...(requiredKey ? { requiredKey } : {}),
      purpose,
      objectives,
      researchTopics,
      questionsToAnswer,
      evidenceNeeds: needs as EvidenceNeed[],
      targetWords,
      dependsOn,
      children,
    };
  };

  const sections: OutlineNodeDraft[] = [];
  if (!Array.isArray(top.sections) || top.sections.length < 1 || top.sections.length > 99) {
    errors.push("OutlineDraft.sections must hold 1 to 99 sections");
  } else {
    top.sections.forEach((entry, index) => {
      const read = readNode(entry, `sections[${index}]`, 1);
      if (read) sections.push(read);
    });
  }
  if (count > maxOutlineNodes)
    errors.push(`The outline has ${count} sections; the limit is ${maxOutlineNodes}`);
  for (const { path, keys } of dependencies) {
    for (const key of keys) {
      if (!seen.has(key)) errors.push(`${path}.dependsOn names unknown section key "${key}"`);
    }
  }
  return finish(errors, { sections });
}

// ---------------------------------------------------------------------------------------------
// SearchPlan, CandidateSet, AppraisalSet, Dossier
// ---------------------------------------------------------------------------------------------

export interface SearchPlanQuery {
  topic: string;
  query: string;
  source: "openalex" | "crossref" | "arxiv";
  language?: string;
  fromYear?: number;
  toYear?: number;
  limit: number;
}
export interface SearchPlan {
  queries: SearchPlanQuery[];
  yearRangeReason?: string;
  webToolsAvailable: boolean;
  gaps: string[];
}

export function validateSearchPlan(value: unknown): Validated<SearchPlan> {
  const errors: string[] = [];
  const top = record(
    value,
    "SearchPlan",
    ["queries", "yearRangeReason", "webToolsAvailable", "gaps"],
    errors,
  );
  if (!top) return { errors };
  const queries: SearchPlanQuery[] = [];
  if (!Array.isArray(top.queries) || top.queries.length < 1 || top.queries.length > 24) {
    errors.push("SearchPlan.queries must hold 1 to 24 queries");
  } else {
    top.queries.forEach((entry, index) => {
      const path = `queries[${index}]`;
      const item = record(
        entry,
        path,
        ["topic", "query", "source", "language", "fromYear", "toYear", "limit"],
        errors,
      );
      if (!item) return;
      const topic = text(item, "topic", path, errors, 200);
      const query = text(item, "query", path, errors, 512);
      const source = oneOf(item, "source", path, errors, [
        "openalex",
        "crossref",
        "arxiv",
      ] as const);
      const language = text(item, "language", path, errors, 3, { optional: true, min: 2 });
      const fromYear = integer(item, "fromYear", path, errors, 1600, 2200, true);
      const toYear = integer(item, "toYear", path, errors, 1600, 2200, true);
      const limit = integer(item, "limit", path, errors, 1, 25, true) ?? 10;
      if (fromYear !== undefined && toYear !== undefined && fromYear > toYear)
        errors.push(`${path}: fromYear is after toYear`);
      if (topic && query && source) {
        queries.push({
          topic,
          query,
          source,
          ...(language ? { language: language.toLowerCase() } : {}),
          ...(fromYear !== undefined ? { fromYear } : {}),
          ...(toYear !== undefined ? { toYear } : {}),
          limit,
        });
      }
    });
  }
  const reason = text(top, "yearRangeReason", "SearchPlan", errors, 300, { optional: true });
  const gaps = list(top, "gaps", "SearchPlan", errors, { max: 10, item: 400, optional: true });
  if (top.webToolsAvailable !== undefined && typeof top.webToolsAvailable !== "boolean") {
    errors.push("SearchPlan.webToolsAvailable must be true or false");
  }
  return finish(errors, {
    queries,
    ...(reason ? { yearRangeReason: reason } : {}),
    webToolsAvailable: top.webToolsAvailable === true,
    gaps: gaps ?? [],
  });
}

export interface CandidateItem {
  identifier: string;
  topic: string;
  reason: string;
  title: string;
  firstAuthor: string | null;
  year: number;
  type?: EvidenceType;
  url?: string;
  language?: string;
}
export interface CandidateSet {
  candidates: CandidateItem[];
  gaps: string[];
  webToolsUsed: boolean;
}

export function validateCandidateSet(value: unknown): Validated<CandidateSet> {
  const errors: string[] = [];
  const top = record(value, "CandidateSet", ["candidates", "gaps", "webToolsUsed"], errors);
  if (!top) return { errors };
  const candidates: CandidateItem[] = [];
  if (!Array.isArray(top.candidates) || top.candidates.length > 40) {
    errors.push(
      "CandidateSet.candidates must be a list of at most 40 candidates (it may be empty)",
    );
  } else {
    top.candidates.forEach((entry, index) => {
      const path = `candidates[${index}]`;
      const item = record(
        entry,
        path,
        [
          "identifier",
          "topic",
          "reason",
          "title",
          "firstAuthor",
          "year",
          "type",
          "url",
          "language",
        ],
        errors,
      );
      if (!item) return;
      const identifier = text(item, "identifier", path, errors, 2048);
      const topic = text(item, "topic", path, errors, 200);
      const reason = text(item, "reason", path, errors, 300);
      const title = text(item, "title", path, errors, 500);
      const firstAuthor = text(item, "firstAuthor", path, errors, 120, { optional: true });
      const year = integer(item, "year", path, errors, 1000, 2200);
      const type = oneOf(item, "type", path, errors, evidenceTypes, true);
      const url = text(item, "url", path, errors, 500, { optional: true });
      const language = text(item, "language", path, errors, 12, { optional: true });
      if (identifier && topic && reason && title && year !== undefined) {
        candidates.push({
          identifier,
          topic,
          reason,
          title,
          firstAuthor: firstAuthor ?? null,
          year,
          ...(type ? { type } : {}),
          ...(url ? { url } : {}),
          ...(language ? { language } : {}),
        });
      }
    });
  }
  const gaps = list(top, "gaps", "CandidateSet", errors, { max: 10, item: 400, optional: true });
  if (top.webToolsUsed !== undefined && typeof top.webToolsUsed !== "boolean") {
    errors.push("CandidateSet.webToolsUsed must be true or false");
  }
  return finish(errors, { candidates, gaps: gaps ?? [], webToolsUsed: top.webToolsUsed === true });
}

export interface AppraisalItem {
  handle: string;
  relevance: "high" | "medium" | "low";
  evidenceType: string;
  limitations: string[];
  supports: string[];
  location?: string;
  permittedUse: PermittedUse[];
  status?: EvidenceStatus;
}
export interface AppraisalSet {
  appraisals: AppraisalItem[];
}

/** `assigned` maps each candidate handle to the status code gave it; every handle must be appraised. */
export function validateAppraisalSet(
  value: unknown,
  context: { assigned: ReadonlyMap<string, EvidenceStatus> },
): Validated<AppraisalSet> {
  const errors: string[] = [];
  const top = record(value, "AppraisalSet", ["appraisals"], errors);
  if (!top) return { errors };
  const appraisals: AppraisalItem[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(top.appraisals) || top.appraisals.length > 60) {
    errors.push("AppraisalSet.appraisals must be a list of at most 60 entries");
  } else {
    top.appraisals.forEach((entry, index) => {
      const path = `appraisals[${index}]`;
      const item = record(
        entry,
        path,
        [
          "handle",
          "relevance",
          "evidenceType",
          "limitations",
          "supports",
          "location",
          "permittedUse",
          "status",
        ],
        errors,
      );
      if (!item) return;
      const handle = text(item, "handle", path, errors, 20);
      if (handle) {
        if (!context.assigned.has(handle))
          errors.push(
            `${path}.handle "${handle}" is not one of: ${[...context.assigned.keys()].join(", ")}`,
          );
        else if (seen.has(handle)) errors.push(`${path}.handle "${handle}" is appraised twice`);
        else seen.add(handle);
      }
      const relevance = oneOf(item, "relevance", path, errors, ["high", "medium", "low"] as const);
      const evidenceType = text(item, "evidenceType", path, errors, 80);
      const limitations = list(item, "limitations", path, errors, { min: 1, max: 5, item: 300 });
      const supports = list(item, "supports", path, errors, { max: 8, item: 200 });
      const location = text(item, "location", path, errors, 200, { optional: true });
      const uses = list(item, "permittedUse", path, errors, { min: 1, max: 4, item: 30 });
      for (const use of uses ?? []) {
        if (!(permittedUses as readonly string[]).includes(use))
          errors.push(`${path}.permittedUse: "${use}" is not one of ${permittedUses.join(", ")}`);
      }
      const status = oneOf(item, "status", path, errors, evidenceStatuses, true);
      if (handle && status) {
        const assigned = context.assigned.get(handle);
        if (assigned && evidenceStatuses.indexOf(status) < evidenceStatuses.indexOf(assigned)) {
          errors.push(
            `${path}.status ${status} would upgrade ${assigned}; an appraisal may only downgrade a status`,
          );
        }
      }
      if (handle && relevance && evidenceType && limitations && supports && uses) {
        appraisals.push({
          handle,
          relevance,
          evidenceType,
          limitations,
          supports,
          ...(location ? { location } : {}),
          permittedUse: uses as PermittedUse[],
          ...(status ? { status } : {}),
        });
      }
    });
  }
  for (const handle of context.assigned.keys()) {
    if (!seen.has(handle)) errors.push(`AppraisalSet is missing an appraisal for ${handle}`);
  }
  return finish(errors, { appraisals });
}

export interface Dossier {
  synthesis: { topic: string; summary: string; evidence: string[] }[];
  claims: { text: string; kind: ClaimKind; evidence: string[]; topic?: string }[];
  gaps: { topic: string; description: string; critical: boolean }[];
}

export function validateDossier(
  value: unknown,
  context: {
    evidenceIds: readonly string[];
    citeKeys: readonly string[];
    topics: readonly string[];
  },
): Validated<Dossier> {
  const errors: string[] = [];
  const top = record(value, "Dossier", ["synthesis", "claims", "gaps"], errors);
  if (!top) return { errors };
  const knownIds = new Set(context.evidenceIds);
  const knownKeys = new Set(context.citeKeys);
  const checkKeys = (path: string, content: string) => {
    for (const match of content.matchAll(/@([a-z][a-z0-9]*\d{4}[a-z]?)\b/g)) {
      if (!knownKeys.has(match[1] as string)) errors.push(`${path} cites unknown key @${match[1]}`);
    }
  };
  const evidence = (item: Record<string, unknown>, path: string) => {
    const ids = list(item, "evidence", path, errors, { max: 20, item: 20 });
    for (const id of ids ?? [])
      if (!knownIds.has(id)) errors.push(`${path}.evidence names unknown evidence id ${id}`);
    return ids ?? [];
  };
  const synthesis: Dossier["synthesis"] = [];
  if (!Array.isArray(top.synthesis) || top.synthesis.length > 12)
    errors.push("Dossier.synthesis must be a list of at most 12 entries");
  else {
    top.synthesis.forEach((entry, index) => {
      const path = `synthesis[${index}]`;
      const item = record(entry, path, ["topic", "summary", "evidence"], errors);
      if (!item) return;
      const topic = text(item, "topic", path, errors, 200);
      const summary = text(item, "summary", path, errors, 1500);
      const ids = evidence(item, path);
      if (summary) checkKeys(path, summary);
      if (topic && summary) synthesis.push({ topic, summary, evidence: ids });
    });
  }
  const claims: Dossier["claims"] = [];
  if (!Array.isArray(top.claims) || top.claims.length > 30)
    errors.push("Dossier.claims must be a list of at most 30 entries");
  else {
    top.claims.forEach((entry, index) => {
      const path = `claims[${index}]`;
      const item = record(entry, path, ["text", "kind", "evidence", "topic"], errors);
      if (!item) return;
      const claim = text(item, "text", path, errors, 400);
      const kind = oneOf(item, "kind", path, errors, claimKinds);
      const ids = evidence(item, path);
      const topic = text(item, "topic", path, errors, 200, { optional: true });
      if (claim) checkKeys(path, claim);
      if (claim && kind)
        claims.push({ text: claim, kind, evidence: ids, ...(topic ? { topic } : {}) });
    });
  }
  const gaps: Dossier["gaps"] = [];
  if (!Array.isArray(top.gaps) || top.gaps.length > 20)
    errors.push("Dossier.gaps must be a list of at most 20 entries");
  else {
    top.gaps.forEach((entry, index) => {
      const path = `gaps[${index}]`;
      const item = record(entry, path, ["topic", "description", "critical"], errors);
      if (!item) return;
      const topic = text(item, "topic", path, errors, 200);
      const description = text(item, "description", path, errors, 400);
      if (typeof item.critical !== "boolean") errors.push(`${path}.critical must be true or false`);
      if (topic && description && typeof item.critical === "boolean")
        gaps.push({ topic, description, critical: item.critical });
    });
  }
  const covered = new Set([...synthesis, ...gaps].map((entry) => fold(entry.topic)));
  for (const topic of context.topics) {
    if (!covered.has(fold(topic)))
      errors.push(
        `Dossier does not cover the research topic "${topic}" in synthesis or gaps; copy each topic exactly`,
      );
  }
  return finish(errors, { synthesis, claims, gaps });
}

// ---------------------------------------------------------------------------------------------
// SectionDraft, FigureDraft, EditPass (spec 7.4)
// ---------------------------------------------------------------------------------------------

export interface FigureDraft {
  /** `fig-...` for charts and diagrams, `tbl-...` for tables. */
  label: string;
  kind: "chart" | "diagram" | "table";
  /** Vega-Lite spec without colors or fonts (charts). */
  spec?: Record<string, unknown>;
  /** Mermaid source (diagrams). */
  source?: string;
  /** GFM pipe table (tables). */
  table?: string;
  /** Caption ending in "Source: ..." (Fuente: / Fonte:). */
  caption: string;
  width?: string;
  /** The sentence of the text this figure supports. */
  supports: string;
}

export interface DraftClaim {
  anchor: string;
  text: string;
  kind: ClaimKind;
  evidence: string[];
  /** Anchors of claims in this draft, or CLM ids of earlier claims, that a conclusion rests on. */
  results: string[];
  objectives: string[];
}

export interface SectionDraft {
  markdown: string;
  /** Required for abstracts. */
  keywords: string[];
  claims: DraftClaim[];
  figures: FigureDraft[];
  gaps: string[];
}

const figureLabel = /^(fig|tbl)-[a-z0-9-]{1,48}$/;
const widthText = /^\d{1,3}(?:\.\d+)?%$|^\d{1,3}(?:\.\d+)?(?:cm|mm|in|pt)$/;
const anchorText = /^[A-Za-z0-9_-]{1,40}$/;

export function validateFigureDraft(value: unknown, path = "FigureDraft"): Validated<FigureDraft> {
  const errors: string[] = [];
  const item = record(
    value,
    path,
    ["label", "kind", "spec", "source", "table", "caption", "width", "supports"],
    errors,
  );
  if (!item) return { errors };
  const label = text(item, "label", path, errors, 60);
  if (label !== undefined && !figureLabel.test(label))
    errors.push(`${path}.label must look like fig-adoption-rate or tbl-results`);
  const kind = oneOf(item, "kind", path, errors, ["chart", "diagram", "table"] as const);
  const caption = text(item, "caption", path, errors, 600);
  if (caption !== undefined && /[\n[\]]/.test(caption))
    errors.push(`${path}.caption must be one line without [ or ] (cite sources as @key)`);
  const supports = text(item, "supports", path, errors, 300, { optional: true }) ?? "";
  const width = text(item, "width", path, errors, 12, { optional: true });
  if (width !== undefined && !widthText.test(width))
    errors.push(`${path}.width must look like 80% or 12cm`);
  let spec: Record<string, unknown> | undefined;
  let source: string | undefined;
  let table: string | undefined;
  if (kind === "chart") {
    if (!isObject(item.spec) || JSON.stringify(item.spec).length > 200_000)
      errors.push(`${path}.spec must be a Vega-Lite object of at most 200 KB`);
    else spec = item.spec;
    if (label && !label.startsWith("fig-"))
      errors.push(`${path}.label of a chart must start with fig-`);
  } else if (kind === "diagram") {
    source = text(item, "source", path, errors, 20_000);
    if (label && !label.startsWith("fig-"))
      errors.push(`${path}.label of a diagram must start with fig-`);
  } else if (kind === "table") {
    table = text(item, "table", path, errors, 20_000);
    if (label && !label.startsWith("tbl-"))
      errors.push(`${path}.label of a table must start with tbl-`);
  }
  if (errors.length > 0 || !label || !kind || !caption) return { errors };
  return {
    value: {
      label,
      kind,
      ...(spec ? { spec } : {}),
      ...(source ? { source } : {}),
      ...(table ? { table } : {}),
      caption,
      ...(width ? { width } : {}),
      supports,
    },
    errors: [],
  };
}

export function validateSectionDraft(
  value: unknown,
  context: { evidenceIds: readonly string[]; objectiveIds: readonly string[] },
): Validated<SectionDraft> {
  const errors: string[] = [];
  const top = record(
    value,
    "SectionDraft",
    ["markdown", "keywords", "claims", "figures", "gaps"],
    errors,
  );
  if (!top) return { errors };
  const markdown = text(top, "markdown", "SectionDraft", errors, 80_000);
  const keywords = list(top, "keywords", "SectionDraft", errors, {
    max: 12,
    item: 80,
    optional: true,
  });
  const gaps = list(top, "gaps", "SectionDraft", errors, { max: 20, item: 400, optional: true });
  const evidenceIds = new Set(context.evidenceIds);
  const objectiveIds = new Set(context.objectiveIds);
  const claims: DraftClaim[] = [];
  const anchors = new Set<string>();
  const rawClaims = top.claims ?? [];
  if (!Array.isArray(rawClaims) || rawClaims.length > 60)
    errors.push("SectionDraft.claims must be a list of at most 60 entries");
  else {
    rawClaims.forEach((entry, index) => {
      const path = `claims[${index}]`;
      const item = record(
        entry,
        path,
        ["anchor", "text", "kind", "evidence", "results", "objectives"],
        errors,
      );
      if (!item) return;
      const anchor = text(item, "anchor", path, errors, 40);
      if (anchor !== undefined) {
        if (!anchorText.test(anchor))
          errors.push(`${path}.anchor must use letters, digits, _ and -`);
        else if (anchors.has(anchor)) errors.push(`${path}.anchor ${anchor} is used twice`);
        else anchors.add(anchor);
      }
      const claim = text(item, "text", path, errors, 400);
      const kind = oneOf(item, "kind", path, errors, claimKinds);
      const evidence =
        list(item, "evidence", path, errors, { max: 20, item: 20, optional: true }) ?? [];
      for (const id of evidence)
        if (!evidenceIds.has(id))
          errors.push(`${path}.evidence names evidence ${id} that is not in the packet`);
      const results =
        list(item, "results", path, errors, { max: 20, item: 40, optional: true }) ?? [];
      const objectives =
        list(item, "objectives", path, errors, { max: 12, item: 10, optional: true }) ?? [];
      for (const id of objectives)
        if (!objectiveIds.has(id)) errors.push(`${path}.objectives names unknown objective ${id}`);
      if (anchor && claim && kind)
        claims.push({ anchor, text: claim, kind, evidence, results, objectives });
    });
  }
  const figures: FigureDraft[] = [];
  const rawFigures = top.figures ?? [];
  if (!Array.isArray(rawFigures) || rawFigures.length > 8)
    errors.push("SectionDraft.figures must be a list of at most 8 entries");
  else {
    const labels = new Set<string>();
    rawFigures.forEach((entry, index) => {
      const checked = validateFigureDraft(entry, `figures[${index}]`);
      if (checked.value === undefined) errors.push(...checked.errors);
      else if (labels.has(checked.value.label))
        errors.push(`figures[${index}].label ${checked.value.label} is used twice`);
      else {
        labels.add(checked.value.label);
        figures.push(checked.value);
      }
    });
  }
  if (errors.length > 0 || !markdown) return { errors };
  return {
    value: { markdown, keywords: keywords ?? [], claims, figures, gaps: gaps ?? [] },
    errors: [],
  };
}

export interface EditPass {
  markdown: string;
  changes: string[];
  queries: string[];
}

export function validateEditPass(value: unknown): Validated<EditPass> {
  const errors: string[] = [];
  const top = record(value, "EditPass", ["markdown", "changes", "queries"], errors);
  if (!top) return { errors };
  const markdown = text(top, "markdown", "EditPass", errors, 80_000);
  const changes = list(top, "changes", "EditPass", errors, { max: 30, item: 300, optional: true });
  const queries = list(top, "queries", "EditPass", errors, { max: 20, item: 400, optional: true });
  if (errors.length > 0 || !markdown) return { errors };
  return { value: { markdown, changes: changes ?? [], queries: queries ?? [] }, errors: [] };
}

// ---------------------------------------------------------------------------------------------
// ReviewReport and RevisionAdvice (spec 7.5)
// ---------------------------------------------------------------------------------------------

export interface ReviewFindingDraft {
  severity: FindingSeverity;
  category: ReviewCategory;
  target: string;
  evidence: string;
  description: string;
  routeTo: ReviewRoute;
}

export interface ReviewReport {
  summary: string;
  findings: ReviewFindingDraft[];
}

const squash = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * `texts` maps each reviewable section id to the text the reviewer saw; a finding must quote that
 * text (a finding without a location is not a finding) and its route must follow the category.
 */
export function validateReviewReport(
  value: unknown,
  context: { texts: ReadonlyMap<string, string> },
): Validated<ReviewReport> {
  const errors: string[] = [];
  const top = record(value, "ReviewReport", ["summary", "findings"], errors);
  if (!top) return { errors };
  const summary = text(top, "summary", "ReviewReport", errors, 1500);
  const findings: ReviewFindingDraft[] = [];
  if (!Array.isArray(top.findings) || top.findings.length > 60)
    errors.push("ReviewReport.findings must be a list of at most 60 entries");
  else {
    top.findings.forEach((entry, index) => {
      const path = `findings[${index}]`;
      const item = record(
        entry,
        path,
        ["severity", "category", "target", "evidence", "description", "routeTo"],
        errors,
      );
      if (!item) return;
      const severity = oneOf(item, "severity", path, errors, [
        "critical",
        "major",
        "minor",
      ] as const);
      const category = oneOf(item, "category", path, errors, reviewCategories);
      const routeTo = oneOf(item, "routeTo", path, errors, reviewRoutes);
      const target = text(item, "target", path, errors, 20);
      const evidence = text(item, "evidence", path, errors, 400, { min: 8 });
      const description = text(item, "description", path, errors, 800);
      if (category && routeTo && routeOfCategory[category] !== routeTo)
        errors.push(
          `${path}.routeTo for category ${category} must be ${routeOfCategory[category]}`,
        );
      if (target !== undefined) {
        const source = context.texts.get(target);
        if (source === undefined)
          errors.push(`${path}.target ${target} is not one of the reviewed sections`);
        else if (evidence !== undefined && !squash(source).includes(squash(evidence)))
          errors.push(`${path}.evidence is not a verbatim quote of ${target}`);
      }
      if (severity && category && routeTo && target && evidence && description)
        findings.push({ severity, category, target, evidence, description, routeTo });
    });
  }
  if (errors.length > 0 || !summary) return { errors };
  return { value: { summary, findings }, errors: [] };
}

/** Guidance from the methodologist or the evidence auditor, applied by the writer. */
export interface RevisionAdvice {
  guidance: string;
  /** True when the fix needs a change to the locked protocol, which only the user can decide. */
  protocolChange: boolean;
}

export function validateRevisionAdvice(value: unknown): Validated<RevisionAdvice> {
  const errors: string[] = [];
  const top = record(value, "RevisionAdvice", ["guidance", "protocolChange"], errors);
  if (!top) return { errors };
  const guidance = text(top, "guidance", "RevisionAdvice", errors, 2000);
  if (typeof top.protocolChange !== "boolean")
    errors.push("RevisionAdvice.protocolChange must be true or false");
  if (errors.length > 0 || !guidance) return { errors };
  return { value: { guidance, protocolChange: top.protocolChange as boolean }, errors: [] };
}

// ---------------------------------------------------------------------------------------------
// StyleDraft and NormsDraft (spec 10.4.1 and 11.1.1)
// ---------------------------------------------------------------------------------------------

export interface RuleTraceEntry {
  rule: string;
  guide: string;
  effect: string;
}

export interface StyleDraft {
  csl: string;
  /** YAML text of a declarative presentation profile (an object is serialized). */
  profile?: string;
  questions: string[];
  ruleTrace: RuleTraceEntry[];
}

function profileText(
  top: Record<string, unknown>,
  path: string,
  errors: string[],
): string | undefined {
  const raw = top.profile;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") {
    const clean = stripControl(raw).trim();
    if (!clean || clean.length > 60_000)
      errors.push(`${path}.profile must be 1 to 60000 characters`);
    return clean;
  }
  if (isObject(raw)) return stringifyYaml(raw, { lineWidth: 0 });
  errors.push(`${path}.profile must be YAML text or an object`);
  return undefined;
}

function trace(
  top: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  fields: readonly [string, string, string],
): RuleTraceEntry[] {
  const raw = top[key] ?? [];
  const out: RuleTraceEntry[] = [];
  if (!Array.isArray(raw) || raw.length > 80) {
    errors.push(`${path}.${key} must be a list of at most 80 entries`);
    return out;
  }
  raw.forEach((entry, index) => {
    const where = `${key}[${index}]`;
    const item = record(entry, where, [...fields], errors);
    if (!item) return;
    const first = text(item, fields[0], where, errors, 300);
    const second = text(item, fields[1], where, errors, 600);
    const third =
      item[fields[2]] === ""
        ? ""
        : (text(item, fields[2], where, errors, 600, { optional: true }) ?? "");
    if (first && second) out.push({ rule: first, guide: second, effect: third });
  });
  return out;
}

export function validateStyleDraft(value: unknown): Validated<StyleDraft> {
  const errors: string[] = [];
  const top = record(value, "StyleDraft", ["csl", "profile", "questions", "ruleTrace"], errors);
  if (!top) return { errors };
  const csl = text(top, "csl", "StyleDraft", errors, 400_000);
  const profile = profileText(top, "StyleDraft", errors);
  const questions = list(top, "questions", "StyleDraft", errors, {
    max: 8,
    item: 400,
    optional: true,
  });
  const ruleTrace = trace(top, "ruleTrace", "StyleDraft", errors, ["rule", "guide", "effect"]);
  if (errors.length > 0 || !csl) return { errors };
  return {
    value: { csl, ...(profile ? { profile } : {}), questions: questions ?? [], ruleTrace },
    errors: [],
  };
}

export const normsScopes = [
  "institution",
  "faculty",
  "program",
  "writing",
  "international",
] as const;
export type NormsScope = (typeof normsScopes)[number];

export interface NormsDraft {
  pack: {
    scope: NormsScope;
    id: string;
    description: string;
    appliesWhen: Record<string, unknown>;
  };
  /** Raw rule objects in the section 11.2 format; code validates each with the pack loader. */
  rules: Record<string, unknown>[];
  profile?: string;
  questions: string[];
  sourceTrace: RuleTraceEntry[];
}

export function validateNormsDraft(value: unknown): Validated<NormsDraft> {
  const errors: string[] = [];
  const top = record(
    value,
    "NormsDraft",
    ["pack", "rules", "profile", "questions", "sourceTrace"],
    errors,
  );
  if (!top) return { errors };
  const packSource = record(
    top.pack,
    "NormsDraft.pack",
    ["scope", "id", "description", "appliesWhen"],
    errors,
  );
  let pack: NormsDraft["pack"] | undefined;
  if (packSource) {
    const scope = oneOf(packSource, "scope", "NormsDraft.pack", errors, normsScopes);
    const id = text(packSource, "id", "NormsDraft.pack", errors, 60);
    const description = text(packSource, "description", "NormsDraft.pack", errors, 300);
    if (packSource.appliesWhen !== undefined && !isObject(packSource.appliesWhen))
      errors.push("NormsDraft.pack.appliesWhen must be a mapping");
    if (scope && id && description)
      pack = {
        scope,
        id,
        description,
        appliesWhen: isObject(packSource.appliesWhen) ? packSource.appliesWhen : {},
      };
  }
  const rules: Record<string, unknown>[] = [];
  if (!Array.isArray(top.rules) || top.rules.length < 1 || top.rules.length > 80)
    errors.push("NormsDraft.rules must hold 1 to 80 rules");
  else {
    top.rules.forEach((entry, index) => {
      if (!isObject(entry)) errors.push(`rules[${index}] must be a mapping`);
      else rules.push(entry);
    });
  }
  const profile = profileText(top, "NormsDraft", errors);
  const questions = list(top, "questions", "NormsDraft", errors, {
    max: 8,
    item: 400,
    optional: true,
  });
  const sourceTrace = trace(top, "sourceTrace", "NormsDraft", errors, ["rule", "guide", "effect"]);
  if (errors.length > 0 || !pack) return { errors };
  return {
    value: {
      pack,
      rules,
      ...(profile ? { profile } : {}),
      questions: questions ?? [],
      sourceTrace,
    },
    errors: [],
  };
}
