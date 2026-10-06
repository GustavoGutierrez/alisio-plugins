import type { PluginAPI, ToolContext, ToolDefinition, ToolResult } from "@alisio/sdk";
import { buildInventory, type InventoryRequest } from "../../application/detect/inventory.js";
import { detectStack } from "../../application/detect/stack.js";
import type { FileAnalyzer } from "../../application/ports/file-analyzer.js";
import type { ModuleResolver, WorkspaceFs } from "../../application/ports/workspace-fs.js";
import { errorResult, toolResult } from "../presenters/tool-result.js";

/** Everything the tools need from the outside world; tests substitute fakes. */
export interface ToolDeps {
  fsFor(workspace: string): WorkspaceFs;
  resolver: ModuleResolver;
  analyzer: FileAnalyzer;
}

const KINDS: readonly InventoryRequest[] = ["components", "hooks", "stores", "tokens", "all"];

/** `additionalProperties: false` is advisory for the host, so the tools enforce it themselves. */
export function checkInput(
  input: Record<string, unknown>,
  allowed: readonly string[],
): string | undefined {
  const extra = Object.keys(input).filter((key) => !allowed.includes(key));
  return extra.length > 0 ? `Unknown input: ${extra.join(", ")}` : undefined;
}

const guarded =
  (run: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>) =>
  async (input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> => {
    try {
      return await run(input, context);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  };

export function detectTools(deps: ToolDeps): ToolDefinition[] {
  return [
    {
      name: "fs_detect_stack",
      description:
        "Detect the frontend stack of the workspace: package manager, framework, styling, tests and commands, with evidence.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      execute: guarded(async (input, context) => {
        const problem = checkInput(input, []);
        if (problem) return errorResult(problem);
        const profile = await detectStack(deps.fsFor(context.workspace), deps.resolver);
        const { evidence, scripts, ...facts } = profile;
        const entries: Array<[string, string]> = Object.entries(facts).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(", ") || "-" : String(value),
        ]);
        entries.push(["scripts", Object.keys(scripts).join(", ") || "-"]);
        return toolResult({
          summary: JSON.stringify(profile, null, 2),
          primary: { kind: "key-value", entries, caption: "Stack profile" },
          secondary: [{ kind: "json", value: { evidence }, collapsedDepth: 1 }],
        });
      }),
    },
    {
      name: "fs_inventory",
      description:
        "List the components, hooks, stores and design tokens found in the workspace sources.",
      inputSchema: {
        type: "object",
        properties: { kind: { type: "string", enum: [...KINDS] } },
        additionalProperties: false,
      },
      effect: "read",
      execute: guarded(async (input, context) => {
        const problem = checkInput(input, ["kind"]);
        if (problem) return errorResult(problem);
        const kind = input.kind ?? "all";
        if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind))
          return errorResult(`kind must be one of ${KINDS.join(", ")}`);
        const fs = deps.fsFor(context.workspace);
        const { files } = await fs.listFiles();
        const analyses = [];
        for (const path of files) {
          const read = await fs.read(path);
          if (read.kind === "text") analyses.push(deps.analyzer.analyze(path, read.text));
        }
        const rows = buildInventory(analyses, {
          kinds: [kind as InventoryRequest],
          tokenFiles: ["**/*.css"],
        });
        return toolResult({
          summary: `${rows.length} entries (${kind}): ${rows
            .slice(0, 50)
            .map((r) => `${r.kind}:${r.name}`)
            .join(", ")}${rows.length > 50 ? ", ..." : ""}`,
          primary: {
            kind: "table",
            columns: ["name", "path", "layer", "kind"],
            rows: rows.map((r) => [r.name, r.path, r.layer, r.kind]),
          },
        });
      }),
    },
  ];
}

export function registerDetectTools(api: PluginAPI, deps: ToolDeps): void {
  for (const tool of detectTools(deps)) api.tools.register(tool);
}
