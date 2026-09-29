import type { JsonSchema, ToolDefinition, ToolResult } from "@alisio/sdk";
import { safeMessage } from "./errors.js";

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
export function externalTool(spec: ToolSpec): ToolDefinition {
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

/** A mutating tool. Capability gating happens inside `run`, before any request. */
export function writeTool(spec: ToolSpec): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    effect: "write",
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
