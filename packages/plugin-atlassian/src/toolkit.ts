import type { JsonSchema, ToolDefinition, ToolResult } from "@alisio/sdk";
import { AtlassianError, safeMessage } from "./errors.js";
import type { AtlassianClient } from "./http.js";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run(input: Record<string, unknown>, context: { signal: AbortSignal }): Promise<string>;
}

function errorResult(error: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: safeMessage(error) }] };
}

/** A read-only tool: it transmits data but never mutates remote state. */
export function readTool(spec: ToolSpec): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    effect: "external",
    inputSchema: spec.inputSchema,
    async execute(input, context): Promise<ToolResult> {
      try {
        return { content: [{ type: "text", text: await spec.run(input, context) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

/**
 * A mutating tool. It refuses before any network request unless the operator
 * opted in with `ATLASSIAN_ALLOW_WRITES=1`.
 */
export function writeTool(client: AtlassianClient, spec: ToolSpec): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    effect: "write",
    inputSchema: spec.inputSchema,
    async execute(input, context): Promise<ToolResult> {
      try {
        if (!client.config.allowWrites)
          throw new AtlassianError(
            "writes disabled",
            "set ATLASSIAN_ALLOW_WRITES=1 to enable mutating calls",
          );
        return { content: [{ type: "text", text: await spec.run(input, context) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}
