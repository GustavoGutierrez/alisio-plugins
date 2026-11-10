// Agent-mode tools (0.2.0). They are registered like any plugin tool, so the main chat sees them
// too; every call first resolves the calling session to a RUNNING Lumbre job and otherwise refuses
// with `not_in_lumbre_job` without touching anything. They only change Lumbre's private per-job
// draft, so they are `read` effect and run in a read-only child session without approvals; the
// project changes only when the person applies the reviewed proposal (a `write` app action).
import { createHash } from "node:crypto";
import type { JsonSchema, PluginAPI } from "@alisio/sdk";
import { textResult } from "@alisio/sdk";
import type { ToolResult } from "./draft.js";

export const PLUGIN_ID = "alisio.lumbre";

/** The host's prefix for an external plugin's tools (`pluginPrefix` in Alisio core). */
export const toolPrefix = (pluginId: string) =>
  `p_${createHash("sha256").update(pluginId).digest("hex").slice(0, 10)}`;

const str = (max: number, extra: Record<string, unknown> = {}) => ({
  type: "string",
  maxLength: max,
  ...extra,
});
const object = (properties: Record<string, unknown>, required: string[] = []): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: false }) as JsonSchema;
const OUTSIDE = " Only works inside a Lumbre build; elsewhere it does nothing.";

export const AGENT_TOOLS = [
  {
    name: "lumbre_list_files",
    description: `List the files of the Lumbre project being built (path, size, changed, managed).${OUTSIDE}`,
    inputSchema: object({}),
  },
  {
    name: "lumbre_read_file",
    description: `Read a file of the Lumbre project (up to 60,000 characters per call; use offset for more).${OUTSIDE}`,
    inputSchema: object(
      {
        path: str(200, { minLength: 1 }),
        offset: { type: "integer", minimum: 0, maximum: 400_000 },
        limit: { type: "integer", minimum: 1, maximum: 60_000 },
      },
      ["path"],
    ),
  },
  {
    name: "lumbre_write_file",
    description: `Create or replace a file of the Lumbre project with its complete content.${OUTSIDE}`,
    inputSchema: object({ path: str(200, { minLength: 1 }), content: str(400_000) }, [
      "path",
      "content",
    ]),
  },
  {
    name: "lumbre_edit_file",
    description: `Replace one exact, unique piece of text in a file of the Lumbre project (cheaper than rewriting it).${OUTSIDE}`,
    inputSchema: object(
      {
        path: str(200, { minLength: 1 }),
        find: str(100_000, { minLength: 1 }),
        replace: str(400_000),
      },
      ["path", "find", "replace"],
    ),
  },
  {
    name: "lumbre_delete_file",
    description: `Delete a file of the Lumbre project.${OUTSIDE}`,
    inputSchema: object({ path: str(200, { minLength: 1 }) }, ["path"]),
  },
  {
    name: "lumbre_add_dependency",
    description: `Add an allowlisted npm package (exact name and version from the prompt) to the Lumbre project.${OUTSIDE}`,
    inputSchema: object({ name: str(100, { minLength: 1 }), version: str(40, { minLength: 1 }) }, [
      "name",
      "version",
    ]),
  },
  {
    name: "lumbre_progress",
    description: `Tell the person, in a short sentence, what you are doing now in the Lumbre build.${OUTSIDE}`,
    inputSchema: object({ message: str(200, { minLength: 1 }) }, ["message"]),
  },
  {
    name: "lumbre_done",
    description: `Finish the Lumbre build: a one-line summary and a short Markdown message for the person.${OUTSIDE}`,
    inputSchema: object({ summary: str(300, { minLength: 1 }), message: str(20_000) }, [
      "summary",
      "message",
    ]),
  },
] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number]["name"];
export const PLAN_TOOLS: readonly AgentToolName[] = ["lumbre_list_files", "lumbre_read_file"];

/** Exact names for a child's `tools.allow` (the host matches the PREFIXED names). */
export function allowedTools(mode: "plan" | "build", pluginId = PLUGIN_ID): string[] {
  const names = mode === "plan" ? PLAN_TOOLS : AGENT_TOOLS.map((t) => t.name);
  return names.map((n) => `${toolPrefix(pluginId)}_${n}`);
}

export interface AgentToolHost {
  agentTool(
    name: AgentToolName,
    input: Record<string, unknown>,
    session: string | undefined,
  ): Promise<ToolResult>;
}

/** Registers the tools; `host` finds the workspace's live service (never creates one). */
export function registerAgentTools(
  api: PluginAPI,
  host: (workspace: string) => AgentToolHost | undefined,
): void {
  for (const tool of AGENT_TOOLS)
    api.tools.register({
      name: tool.name,
      description: tool.description,
      effect: "read",
      inputSchema: tool.inputSchema,
      async execute(input, ctx) {
        const service = host(ctx.workspace);
        const result: ToolResult = service
          ? await service.agentTool(
              tool.name,
              (input ?? {}) as Record<string, unknown>,
              ctx.session,
            )
          : { ok: false, error: "not_in_lumbre_job" };
        return textResult(JSON.stringify(result), !result.ok);
      },
    });
}
