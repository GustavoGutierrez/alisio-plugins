// Action map of the Notebook app (§7.7), grouped by effect so it is never guessed (D15).
import type { JsonSchema, PluginAppAction, PluginAppContext } from "@alisio/sdk";
import { errorCode } from "./errors.js";
import type { NotebookService } from "./notebook/service.js";

export type { PluginAppAction, PluginAppContext, PluginAppDefinition } from "@alisio/sdk";

export const READ_ACTIONS = [
  "status",
  "notebooks.list",
  "notebooks.get",
  "workspace.list",
  "sources.read",
  "sources.passage",
  "chat.history",
  "jobs.get",
  "models.list",
] as const;
export const WRITE_ACTIONS = [
  "notebooks.create",
  "notebooks.rename",
  "notebooks.delete",
  "sources.upload",
  "sources.addFromWorkspace",
  "sources.delete",
  "chat.ask",
  "chat.clear",
  "notebook.guide",
  "sources.summary",
  "index.rebuild",
  "jobs.cancel",
  "notice.ack",
  "engine.setup",
  "notebooks.setModel",
  "notebooks.setScope",
] as const;

const notebookId = { type: "string", pattern: "^[a-z2-7]{12}$" };
const sourceId = notebookId;
const locale = { type: "string", enum: ["en", "es"] };
const jobId = { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9-]+$" };
const path = { type: "string", minLength: 1, maxLength: 1024 };
const object = (properties: Record<string, unknown>, required: string[] = []): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: false }) as JsonSchema;

/** Every schema bounds its strings and arrays; no `$ref`/`$id`/`$async` (host rule). */
export const SCHEMAS: Record<string, JsonSchema> = {
  status: object({}),
  "notebooks.list": object({}),
  "notebooks.get": object({ id: notebookId }, ["id"]),
  "notebooks.create": object({ title: { type: "string", maxLength: 200 } }, ["title"]),
  "notebooks.rename": object({ id: notebookId, title: { type: "string", maxLength: 200 } }, [
    "id",
    "title",
  ]),
  "notebooks.delete": object({ id: notebookId }, ["id"]),
  "sources.upload": {
    type: "object",
    properties: {
      notebookId,
      name: { type: "string", minLength: 1, maxLength: 255 },
      mime: { type: "string", maxLength: 120 },
      base64: { type: "string", maxLength: 36_000_000 },
      pages: { type: "array", maxItems: 5000, items: { type: "string", maxLength: 200_000 } },
    },
    required: ["notebookId", "name"],
    additionalProperties: false,
  } as JsonSchema,
  "workspace.list": object({ dir: { type: "string", maxLength: 1024 } }),
  "sources.read": object({ path }, ["path"]),
  "sources.addFromWorkspace": object({ notebookId, path }, ["notebookId", "path"]),
  "sources.delete": object({ sourceId }, ["sourceId"]),
  "sources.passage": object(
    { sourceId, ordinal: { type: "integer", minimum: 0, maximum: 100_000 } },
    ["sourceId", "ordinal"],
  ),
  "chat.ask": object(
    {
      notebookId,
      question: { type: "string", minLength: 1, maxLength: 4000 },
      sourceIds: { type: "array", maxItems: 50, items: sourceId },
      locale,
    },
    ["notebookId", "question"],
  ),
  "chat.history": object({ notebookId, before: { type: "integer", minimum: 1 } }, ["notebookId"]),
  "chat.clear": object({ notebookId }, ["notebookId"]),
  "notebook.guide": object({ notebookId, locale }, ["notebookId"]),
  "sources.summary": object({ sourceId, locale }, ["sourceId"]),
  "index.rebuild": object({ notebookId }, ["notebookId"]),
  "jobs.get": object({ jobId }, ["jobId"]),
  "jobs.cancel": object({ jobId }, ["jobId"]),
  "notice.ack": object({ notebookId }, ["notebookId"]),
  "engine.setup": object({}),
  "models.list": object({}),
  "notebooks.setScope": object(
    { id: notebookId, excluded: { type: "array", maxItems: 50, items: sourceId } },
    ["id", "excluded"],
  ),
  "notebooks.setModel": object(
    { id: notebookId, model: { type: ["string", "null"], maxLength: 300 } },
    ["id", "model"],
  ),
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

/** Engine side of the app (status and the setup job), kept outside `notebook/*` (§5.2). */
export interface EngineFacade {
  status(): Promise<Record<string, unknown>>;
  setup(): { jobId: string };
  job(id: string): Record<string, unknown> | undefined;
  cancel(id: string): boolean;
}

export interface AppDeps {
  service: () => NotebookService;
  engine: EngineFacade;
}

async function run(
  action: string,
  input: Record<string, unknown>,
  ctx: PluginAppContext,
  deps: AppDeps,
) {
  switch (action) {
    case "status":
      return { ...(await deps.engine.status()), notebooks: deps.service().db.countNotebooks() };
    case "engine.setup":
      return deps.engine.setup();
    case "jobs.get":
    case "jobs.cancel": {
      const id = String(input.jobId ?? "");
      if (id.startsWith("setup-")) {
        const job = deps.engine.job(id);
        if (!job) return deps.service().invoke(action, input, ctx); // not_found
        return action === "jobs.get" ? job : { cancelled: deps.engine.cancel(id) };
      }
      return deps.service().invoke(action, input, ctx);
    }
    default:
      return deps.service().invoke(action, input, ctx);
  }
}

export function buildActions(deps: AppDeps): Record<string, PluginAppAction> {
  const actions: Record<string, PluginAppAction> = {};
  for (const action of [...READ_ACTIONS, ...WRITE_ACTIONS])
    actions[action] = {
      effect: (READ_ACTIONS as readonly string[]).includes(action) ? "read" : "write",
      inputSchema: SCHEMAS[action] as JsonSchema,
      async handler(input, context) {
        context.signal.throwIfAborted();
        try {
          const args = (input ?? {}) as Record<string, unknown>;
          return { value: await run(action, args, context, deps) };
        } catch (error) {
          // Codes only: never the input, a path or a stack.
          return { error: errorCode(error) };
        }
      },
    };
  return actions;
}
