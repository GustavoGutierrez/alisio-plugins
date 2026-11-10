// Action map of the Lumbre studio, grouped by effect so it is never guessed, with one strict input
// schema per action (bounded strings and arrays, no extra properties, no $ref/$id/$async).
import type { JsonSchema, PluginAppAction, PluginAppContext } from "@alisio/sdk";
import { errorCode } from "./errors.js";

export type { PluginAppAction, PluginAppContext, PluginAppDefinition } from "@alisio/sdk";

export const READ_ACTIONS = [
  "status",
  "models.list",
  "projects.list",
  "projects.get",
  "files.get",
  "proposal.get",
  "preview.snapshot",
  "jobs.get",
  "server.status",
  "project.zip",
] as const;
export const WRITE_ACTIONS = [
  "projects.create",
  "projects.update",
  "projects.delete",
  "chat.send",
  "chat.clear",
  "proposal.apply",
  "proposal.discard",
  "files.save",
  "files.delete",
  "revisions.restore",
  "jobs.cancel",
  "project.export",
  "agent.continue",
  "agent.review",
  "agent.discard",
  "plan.discard",
] as const;
export const PROCESS_ACTIONS = [
  "preview.check",
  "deps.install",
  "server.start",
  "server.stop",
  "server.open",
  "agent.check",
] as const;
export type ActionName =
  | (typeof READ_ACTIONS)[number]
  | (typeof WRITE_ACTIONS)[number]
  | (typeof PROCESS_ACTIONS)[number];

const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const id = { type: "string", pattern: UUID };
const path = { type: "string", minLength: 1, maxLength: 200 };
const paths = { type: "array", maxItems: 150, items: path };
const locale = { type: "string", enum: ["en", "es"] };
const stackId = { type: "string", enum: ["vanilla", "vite", "react", "astro", "next"] };
const object = (properties: Record<string, unknown>, required: string[] = []): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: false }) as JsonSchema;
const project = (extra: Record<string, unknown> = {}, required: string[] = []) =>
  object({ projectId: id, ...extra }, ["projectId", ...required]);

export const SCHEMAS: Record<ActionName, JsonSchema> = {
  status: object({}),
  "models.list": object({}),
  "projects.list": object({}),
  "projects.get": project(),
  "files.get": project({ path }, ["path"]),
  "proposal.get": project(),
  "preview.snapshot": project(),
  "jobs.get": object({ jobId: id }, ["jobId"]),
  "server.status": project(),
  "project.zip": project(),
  "projects.create": object(
    {
      title: { type: "string", maxLength: 100 },
      stack: stackId,
      tailwind: { type: "boolean" },
      model: { type: ["string", "null"], maxLength: 300 },
    },
    ["stack"],
  ),
  "projects.update": project({
    title: { type: "string", maxLength: 100 },
    model: { type: ["string", "null"], maxLength: 300 },
    archived: { type: "boolean" },
  }),
  "projects.delete": project(),
  "chat.send": project(
    {
      text: { type: "string", minLength: 1, maxLength: 8_000 },
      locale,
      mode: { type: "string", enum: ["plan", "build"] },
      planId: id,
    },
    ["text"],
  ),
  "chat.clear": project(),
  "proposal.apply": project(
    {
      proposalId: id,
      files: paths,
      deletes: paths,
      dependencies: { type: "array", maxItems: 20, items: { type: "string", maxLength: 100 } },
    },
    ["proposalId"],
  ),
  "proposal.discard": project({ proposalId: id }, ["proposalId"]),
  "files.save": project(
    { path, content: { type: "string", maxLength: 400_000 }, baseRevision: id },
    ["path", "content", "baseRevision"],
  ),
  "files.delete": project({ path, baseRevision: id }, ["path", "baseRevision"]),
  "revisions.restore": project({ revisionId: id }, ["revisionId"]),
  "jobs.cancel": object({ jobId: id }, ["jobId"]),
  "project.export": project({ folder: { type: "string", minLength: 1, maxLength: 120 } }, [
    "folder",
  ]),
  "preview.check": project({ locale }),
  "agent.continue": project({ goal: { type: "string", maxLength: 2_000 } }),
  "agent.review": project(),
  "agent.discard": project(),
  "plan.discard": project({ messageId: id }, ["messageId"]),
  "agent.check": project(),
  "deps.install": project(),
  "server.start": project(),
  "server.stop": project(),
  "server.open": project(),
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

export function effectOf(action: ActionName): "read" | "write" | "process" {
  if ((READ_ACTIONS as readonly string[]).includes(action)) return "read";
  if ((WRITE_ACTIONS as readonly string[]).includes(action)) return "write";
  return "process";
}

export interface ServiceLike {
  invoke(action: string, input: Record<string, unknown>, ctx: PluginAppContext): Promise<unknown>;
}

export function buildActions(
  service: (context: PluginAppContext) => Promise<ServiceLike>,
): Record<string, PluginAppAction> {
  const actions: Record<string, PluginAppAction> = {};
  for (const action of [...READ_ACTIONS, ...WRITE_ACTIONS, ...PROCESS_ACTIONS])
    actions[action] = {
      effect: effectOf(action),
      inputSchema: SCHEMAS[action],
      async handler(input, context) {
        try {
          context.signal.throwIfAborted();
          const args = (input ?? {}) as Record<string, unknown>;
          return { value: await (await service(context)).invoke(action, args, context) };
        } catch (error) {
          // Codes only: never the input, a path, a log or a stack.
          return { error: errorCode(error) };
        }
      },
    };
  return actions;
}
