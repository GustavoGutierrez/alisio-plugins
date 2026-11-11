import { readFile } from "node:fs/promises";
import type { JsonSchema, PluginAPI, PluginAppAction } from "@alisio/sdk";
import type { EvaluaCoordinator } from "../coordinator.js";
import { errorCode } from "./errors.js";
import { AppJobs } from "./jobs.js";
import { EvaluaAppService } from "./service.js";
import { WIZARD_FIELDS } from "./wizard.js";

/**
 * Host limits of plugin apps, kept as local constants: the SDK exports them as a runtime value
 * only from 0.11.6, and importing a value an older host's SDK lacks would break module linking
 * on every host the peer range allows (app spec D12). A test compares them with the dev SDK.
 */
export const APP_LIMITS = {
  htmlBytes: 8 * 1024 * 1024,
  requestBytes: 37 * 1024 * 1024,
  resultBytes: 90 * 1024 * 1024,
  timeoutMs: 30_000,
  inFlight: 8,
} as const;

/** Lowest Alisio version whose app actions show the approval prompt. */
export const MIN_APP_HOST = "0.11.6";

export const READ_ACTIONS = [
  "status",
  "catalog.list",
  "kb.check",
  "doctor",
  "models.list",
  "draft.get",
  "wording.get",
  "items.get",
  "exam.view",
  "docs.get",
  "jobs.get",
] as const;
export const WRITE_ACTIONS = [
  "profile.save",
  "profile.setLogo",
  "profile.removeLogo",
  "draft.create",
  "draft.discard",
  "exam.approveA",
  "models.choose",
  "wording.draft",
  "wording.save",
  "exam.generate",
  "exam.approveB",
  "jobs.cancel",
] as const;
export const PROCESS_ACTIONS = ["build.start"] as const;

const revision = { type: "string", minLength: 1, maxLength: 40 };
const examId = { type: "string", pattern: "^e[0-9]{2,3}$" };
const jobId = { type: "string", pattern: "^[a-z0-9]{12}$" };
const object = (properties: Record<string, unknown>, required: string[] = []): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: false }) as JsonSchema;
/** A mutation's schema: its own fields plus the revision the frame last saw (D2). */
const mutation = (properties: Record<string, unknown> = {}, required: string[] = []) =>
  object({ ...properties, expectedRevision: revision }, [...required, "expectedRevision"]);

const answerProperties = Object.fromEntries(
  WIZARD_FIELDS.map((field) => [
    field,
    field === "types"
      ? { type: "array", maxItems: 4, items: { type: "string", maxLength: 40 } }
      : { type: "string", maxLength: field === "topic" ? 120 : 40 },
  ]),
);

/** Closed schemas with bounded strings and arrays; no `$ref`/`$id`/`$async` (host rule). */
export const SCHEMAS: Record<string, JsonSchema> = {
  status: object({}),
  "catalog.list": object({ grade: { type: "string", maxLength: 40 } }),
  "kb.check": object({}),
  doctor: object({}),
  "models.list": object({}),
  "draft.get": object({}),
  "wording.get": object({}),
  "items.get": object({
    offset: { type: "integer", minimum: 0, maximum: 400 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  }),
  "exam.view": object(
    {
      examId,
      offset: { type: "integer", minimum: 0, maximum: 400 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    ["examId"],
  ),
  "docs.get": object(
    {
      examId,
      doc: { type: "string", enum: ["exam", "sheet", "book", "rubric"] },
      format: { type: "string", enum: ["pdf", "html"] },
    },
    ["examId", "doc", "format"],
  ),
  "jobs.get": object({ jobId }, ["jobId"]),
  "profile.save": mutation(
    {
      teacherName: { type: "string", minLength: 1, maxLength: 100 },
      institution: { type: "string", minLength: 1, maxLength: 150 },
      subject: { type: "string", minLength: 1, maxLength: 80 },
      paper: { type: "string", enum: ["letter", "a4"] },
      language: { type: "string", maxLength: 16 },
    },
    ["teacherName", "institution", "subject", "paper", "language"],
  ),
  "profile.setLogo": mutation(
    {
      dataBase64: { type: "string", maxLength: 2_796_208 },
      mime: { type: "string", enum: ["image/png", "image/jpeg", "image/webp"] },
    },
    ["dataBase64", "mime"],
  ),
  "profile.removeLogo": mutation(),
  "draft.create": mutation(
    {
      answers: { type: "object", properties: answerProperties, additionalProperties: false },
      replace: { type: "boolean" },
    },
    ["answers"],
  ),
  "draft.discard": mutation(),
  "exam.approveA": mutation(),
  "models.choose": object({ reference: { type: ["string", "null"], maxLength: 200 } }, [
    "reference",
  ]),
  "wording.draft": mutation(),
  "wording.save": mutation(
    {
      prompts: {
        type: "object",
        maxProperties: 20,
        additionalProperties: {
          type: "array",
          maxItems: 5,
          items: { type: "string", maxLength: 200 },
        },
      },
    },
    ["prompts"],
  ),
  "exam.generate": mutation(),
  "exam.approveB": mutation({ examId, acknowledgeFindings: { type: "boolean" } }, ["examId"]),
  "jobs.cancel": object({ jobId }, ["jobId"]),
  "build.start": mutation(),
};

/** Keywords the host rejects in an action `inputSchema`. */
export const UNSUPPORTED_SCHEMA_KEYWORDS = ["$ref", "$id", "$async"] as const;

/** Paths of every unsupported keyword in a schema (empty when the host accepts it). */
export function unsupportedSchemaKeywords(schema: unknown, at = "$"): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, i) => unsupportedSchemaKeywords(item, `${at}[${i}]`));
  }
  if (!schema || typeof schema !== "object") return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if ((UNSUPPORTED_SCHEMA_KEYWORDS as readonly string[]).includes(key))
      found.push(`${at}.${key}`);
    found.push(...unsupportedSchemaKeywords(value, `${at}.${key}`));
  }
  return found;
}

const effectOf = (action: string): PluginAppAction["effect"] =>
  (READ_ACTIONS as readonly string[]).includes(action)
    ? "read"
    : (PROCESS_ACTIONS as readonly string[]).includes(action)
      ? "process"
      : "write";

/** The action map, grouped by effect so the effect is never guessed. */
export function buildActions(service: EvaluaAppService): Record<string, PluginAppAction> {
  const actions: Record<string, PluginAppAction> = {};
  for (const action of [...READ_ACTIONS, ...WRITE_ACTIONS, ...PROCESS_ACTIONS]) {
    actions[action] = {
      effect: effectOf(action),
      inputSchema: SCHEMAS[action] as JsonSchema,
      async handler(input, context) {
        context.signal.throwIfAborted();
        try {
          const args =
            typeof input === "object" && input !== null && !Array.isArray(input)
              ? (input as Record<string, unknown>)
              : {};
          // The session and its workspace come from the host's context, never from the input.
          return { value: await service.invoke(action, args, context) };
        } catch (error) {
          // Codes only: never the input, a path or a stack.
          return { error: errorCode(error) };
        }
      },
    };
  }
  return actions;
}

/**
 * Registers the Evalua app when the host has `api.apps` (Alisio >= 0.11.5). Fail-open: a host
 * without apps, or any failure here, leaves the commands and tools exactly as they are. State is
 * per activation: this call owns its jobs and `dispose` cancels only them.
 */
export function registerEvaluaApp(
  api: PluginAPI,
  coordinator: EvaluaCoordinator,
): (() => void) | undefined {
  if (!api.apps) return undefined;
  const jobs = new AppJobs();
  try {
    const service = new EvaluaAppService({ api, coordinator, jobs });
    coordinator.setAppBuildGuard(() => jobs.running("build"));
    return api.apps.register({
      id: "evalua",
      label: { en: "Evalua", es: "Evalúa" },
      html: () => readFile(new URL("../embedded.html", import.meta.url), "utf8"),
      actions: buildActions(service),
      busy: () => jobs.busy(),
      dispose: () => jobs.dispose(),
    });
  } catch {
    jobs.dispose();
    coordinator.setAppBuildGuard(() => false);
    return undefined;
  }
}
