// Action map of the Thesis Studio app (spec §6.3), grouped by effect so it is never guessed (D8).
import type { JsonSchema } from "@alisio/sdk";

export const READ_ACTIONS = [
  "status",
  "interview.get",
  "artifact.get",
  "evidence.list",
  "claims.list",
  "findings.list",
  "check.last",
  "packs.list",
  "packs.explain",
  "packs.check",
  "styles.list",
  "files.list",
  "files.read",
  "pdf.get",
  "models.list",
  "jobs.get",
] as const;

export const WRITE_ACTIONS = [
  "project.init",
  "interview.answer",
  "approve",
  "revise",
  "design.run",
  "outline.run",
  "research.run",
  "draft.run",
  "figure.run",
  "review.run",
  "next.run",
  "check.run",
  "packs.new",
  "styles.new",
  "norms.import",
  "files.write",
  "settings.setModel",
  "jobs.cancel",
] as const;

export const PROCESS_ACTIONS = ["build.run", "finalize.run", "engine.setup", "doctor.run"] as const;

export type StudioAction =
  | (typeof READ_ACTIONS)[number]
  | (typeof WRITE_ACTIONS)[number]
  | (typeof PROCESS_ACTIONS)[number];

export const ALL_ACTIONS: readonly StudioAction[] = [
  ...READ_ACTIONS,
  ...WRITE_ACTIONS,
  ...PROCESS_ACTIONS,
];

export function effectOf(action: StudioAction): "read" | "write" | "process" {
  if ((READ_ACTIONS as readonly string[]).includes(action)) return "read";
  if ((PROCESS_ACTIONS as readonly string[]).includes(action)) return "process";
  return "write";
}

/** Actions that create child sessions: refused with `no_model` when no model exists (§7.1). */
export const CHILD_ACTIONS: readonly StudioAction[] = [
  "revise",
  "design.run",
  "outline.run",
  "research.run",
  "draft.run",
  "figure.run",
  "review.run",
  "next.run",
  "styles.new",
  "norms.import",
];

const section = { type: "string", pattern: "^SEC-\\d{2}(\\.\\d{2}){0,2}$", maxLength: 20 };
const sectionOrNext = {
  type: "string",
  pattern: "^(next|SEC-\\d{2}(\\.\\d{2}){0,2})$",
  maxLength: 20,
};
const revision = { type: "string", pattern: "^([a-f0-9]{64}|none)$", maxLength: 64 };
const jobId = { type: "string", pattern: "^job-[a-z0-9-]{1,60}$", maxLength: 64 };
const relativePath = { type: "string", minLength: 1, maxLength: 300 };
const text = (max: number, min = 0) => ({
  type: "string",
  maxLength: max,
  ...(min ? { minLength: min } : {}),
});
const object = (properties: Record<string, unknown>, required: string[] = []): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: false }) as JsonSchema;

export const approveTarget =
  "^(A|B|OUTLINE|C|SEC-\\d{2}(\\.\\d{2}){0,2}|FND-\\d{4}|ETH-[A-Z_]+-\\d{2}|norms|style:[a-z0-9][a-z0-9-]{0,62})$";
export const reviseTarget =
  "^(A|B|OUTLINE|SEC-\\d{2}(\\.\\d{2}){0,2}|FND-\\d{4}|norms|style:[a-z0-9][a-z0-9-]{0,62})$";

/** Every schema bounds its strings and arrays; no `$ref`/`$id`/`$async` (host rule). */
export const SCHEMAS: Record<StudioAction, JsonSchema> = {
  status: object({}),
  "interview.get": object({}),
  "artifact.get": object(
    { kind: { type: "string", enum: ["protocol", "outline", "chapter", "dossier"] }, section },
    ["kind"],
  ),
  "evidence.list": object({
    tab: { type: "string", enum: ["library", "rejected", "log"] },
    section,
    status: { type: "string", pattern: "^[A-Z_]{1,40}$", maxLength: 40 },
    text: text(200),
    offset: { type: "integer", minimum: 0, maximum: 100_000 },
    limit: { type: "integer", minimum: 1, maximum: 200 },
  }),
  "claims.list": object({ section }),
  "findings.list": object({
    status: { type: "string", enum: ["open", "resolved", "dismissed", "superseded"] },
  }),
  "check.last": object({}),
  "packs.list": object({}),
  "packs.explain": object({ query: text(120, 1) }, ["query"]),
  "packs.check": object({}),
  "styles.list": object({}),
  "files.list": object({}),
  "files.read": object({ path: relativePath }, ["path"]),
  "pdf.get": object({ which: { type: "string", enum: ["last", "final"] } }, ["which"]),
  "models.list": object({}),
  "jobs.get": object({ jobId }, ["jobId"]),
  "project.init": object({
    dir: { type: "string", pattern: "^(\\./)?[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$", maxLength: 200 },
    lang: { type: "string", pattern: "^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$", maxLength: 35 },
    presentation: { type: "boolean" },
  }),
  "interview.answer": object(
    {
      answers: {
        type: "object",
        additionalProperties: { type: "string", maxLength: 2000 },
        propertyNames: { maxLength: 80 },
        minProperties: 1,
        maxProperties: 20,
      },
    },
    ["answers"],
  ),
  approve: object(
    {
      target: { type: "string", pattern: approveTarget, maxLength: 70 },
      notes: text(4000),
      revision,
    },
    ["target", "revision"],
  ),
  revise: object(
    {
      target: { type: "string", pattern: reviseTarget, maxLength: 70 },
      feedback: text(4000, 1),
      revision,
    },
    ["target", "feedback", "revision"],
  ),
  "design.run": object({}),
  "outline.run": object({}),
  "research.run": object({ section: sectionOrNext, more: text(1000), add: text(1000) }, [
    "section",
  ]),
  "draft.run": object({ section: sectionOrNext, feedback: text(4000) }, ["section"]),
  "figure.run": object({ section, request: text(2000, 1) }, ["section", "request"]),
  "review.run": object(
    { target: { type: "string", pattern: "^(all|SEC-\\d{2}(\\.\\d{2}){0,2})$", maxLength: 20 } },
    ["target"],
  ),
  "next.run": object({}),
  "check.run": object({
    gates: {
      type: "array",
      items: { type: "string", pattern: "^G(0|[1-9]|10)$", maxLength: 3 },
      maxItems: 11,
      uniqueItems: true,
    },
  }),
  "packs.new": object(
    {
      scope: {
        type: "string",
        enum: [
          "international",
          "country",
          "region",
          "institution",
          "faculty",
          "program",
          "writing",
        ],
      },
      id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$", maxLength: 63 },
    },
    ["scope", "id"],
  ),
  "styles.new": object(
    {
      id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,62}$", maxLength: 63 },
      guide: text(50_000, 1),
    },
    ["id", "guide"],
  ),
  "norms.import": object({ guide: text(50_000, 1) }, ["guide"]),
  "files.write": object({ path: relativePath, content: text(262_144), revision }, [
    "path",
    "content",
    "revision",
  ]),
  "settings.setModel": object({ model: { type: ["string", "null"], maxLength: 200 }, revision }, [
    "model",
    "revision",
  ]),
  "jobs.cancel": object({ jobId }, ["jobId"]),
  "build.run": object(
    {
      scope: { type: "string", enum: ["full", "approved", "section"] },
      section,
      pdfa: { type: "boolean" },
      format: { type: "string", enum: ["pdf", "html"] },
    },
    ["scope"],
  ),
  "finalize.run": object({}),
  "engine.setup": object({}),
  "doctor.run": object({}),
};

/** Keywords the host rejects in an action `inputSchema`. */
export const UNSUPPORTED_SCHEMA_KEYWORDS = ["$ref", "$id", "$async"] as const;

/** Paths of every unsupported keyword in a schema (empty when the host accepts it). */
export function unsupportedSchemaKeywords(schema: unknown, at = "$"): string[] {
  if (Array.isArray(schema))
    return schema.flatMap((item, i) => unsupportedSchemaKeywords(item, `${at}[${i}]`));
  if (!schema || typeof schema !== "object") return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if ((UNSUPPORTED_SCHEMA_KEYWORDS as readonly string[]).includes(key))
      found.push(`${at}.${key}`);
    found.push(...unsupportedSchemaKeywords(value, `${at}.${key}`));
  }
  return found;
}

type Schema = Record<string, unknown>;

/**
 * Defensive check of an input against the subset of JSON Schema used above. The host validates
 * first; this keeps a handler safe on a host (or a test) that does not.
 */
export function matchesSchema(value: unknown, schema: Schema): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const typeOk = types.some((type) => {
    switch (type) {
      case "object":
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
      case "array":
        return Array.isArray(value);
      case "string":
        return typeof value === "string";
      case "integer":
        return Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "null":
        return value === null;
      default:
        return type === undefined;
    }
  });
  if (!typeOk) return false;
  if (typeof value === "string") {
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return false;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.uniqueItems && new Set(value).size !== value.length) return false;
    const items = schema.items as Schema | undefined;
    if (items && !value.every((item) => matchesSchema(item, items))) return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties)
      return false;
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties)
      return false;
    for (const required of (schema.required ?? []) as string[])
      if (record[required] === undefined) return false;
    const names = schema.propertyNames as Schema | undefined;
    for (const key of keys) {
      if (names && !matchesSchema(key, { type: "string", ...names })) return false;
      const property = properties[key];
      if (property) {
        if (!matchesSchema(record[key], property)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        if (!matchesSchema(record[key], schema.additionalProperties as Schema)) return false;
      }
    }
  }
  return true;
}
