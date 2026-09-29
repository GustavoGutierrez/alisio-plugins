import { definePlugin, type Plugin, type ToolDefinition, type ToolResult } from "@alisio/sdk";
import { MAX_OUTPUT_CHARS, renderDocumentation, textContentParts } from "./content.js";
import { toContext7Error } from "./errors.js";
import { createMcpClient, type Fetcher, REQUEST_TIMEOUT_MS, type RemoteToolResult } from "./mcp.js";
import {
  apiKeyFromEnvironment,
  MAX_LIBRARY_ID,
  MAX_LIBRARY_NAME,
  MAX_QUERY,
  parseLibraryId,
  parseLibraryName,
  parseQuery,
  parseQueryDocsInput,
  parseResolveInput,
} from "./validation.js";
import { VERSION } from "./version.js";

export * from "./content.js";
export * from "./errors.js";
export * from "./mcp.js";
export * from "./validation.js";
export { VERSION } from "./version.js";

/** Package-local resource directories, registered relative to the built entry. */
export const resourcePaths = {
  skills: "../.agents/skills",
} as const;

/** Local capability names; they must also exist on the fixed remote server. */
export const RESOLVE_TOOL = "resolve-library-id";
export const QUERY_TOOL = "query-docs";

const COMMAND_NAME = "c7-docs";
const COMMAND_USAGE =
  "Usage: /context7:c7-docs <library> -- <question>\n" +
  "Example: /context7:c7-docs next.js -- how do I define a route handler?";

/** Library ids are ASCII and never contain whitespace, so a lookbehind avoids URL paths. */
const ID_IN_TEXT =
  /(?<![A-Za-z0-9._~:@/-])\/[A-Za-z0-9@][A-Za-z0-9._~@-]*\/[A-Za-z0-9@][A-Za-z0-9._~@-]*(?:\/[A-Za-z0-9@][A-Za-z0-9._~@-]*)?/g;

/** First strict, documented library id present in remote resolve output. */
export function extractLibraryId(text: string): string | undefined {
  for (const match of text.matchAll(ID_IN_TEXT)) {
    try {
      return parseLibraryId(match[0]);
    } catch {
      /* keep scanning */
    }
  }
  return undefined;
}

/** Split `<library> -- <question>` (or `<library> <question>`) into its two parts. */
export function parseCommandArguments(
  args: string,
): { library: string; query: string } | undefined {
  const trimmed = args.trim();
  if (trimmed === "" || trimmed.startsWith("--")) return undefined;
  const separator = trimmed.indexOf("--");
  if (separator > 0) {
    const library = trimmed.slice(0, separator).trim();
    const query = trimmed.slice(separator + 2).trim();
    return library !== "" && query !== "" ? { library, query } : undefined;
  }
  const match = /^(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (!match) return undefined;
  const library = match[1] as string;
  const query = (match[2] as string).trim();
  return query === "" ? undefined : { library, query };
}

/** Map any thrown value to the safe vocabulary; never surface raw text. */
function failure(error: unknown): ToolResult {
  return { isError: true, content: [{ type: "text", text: toContext7Error(error).message }] };
}

function toolResult(remote: RemoteToolResult): ToolResult {
  const result: ToolResult = {
    content: [{ type: "text", text: renderDocumentation(remote.content) }],
  };
  if (remote.isError) result.isError = true;
  return result;
}

export function createTools(
  fetcher: Fetcher = fetch,
  apiKey?: string | undefined,
): ToolDefinition[] {
  const client = createMcpClient({ fetcher, apiKey });

  const invoke = async (
    name: string,
    args: Record<string, unknown>,
    context: { signal: AbortSignal },
  ): Promise<ToolResult> => {
    try {
      return toolResult(await client.call(name, args, context.signal));
    } catch (error) {
      return failure(error);
    }
  };

  const resolve: ToolDefinition = {
    name: RESOLVE_TOOL,
    description:
      "Resolve a library, framework, SDK, API, CLI tool, or cloud service name to a Context7 library ID. " +
      "The name and task query are transmitted to the Context7 hosted service.",
    effect: "external",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["libraryName", "query"],
      properties: {
        libraryName: { type: "string", minLength: 1, maxLength: MAX_LIBRARY_NAME },
        query: { type: "string", minLength: 1, maxLength: MAX_QUERY },
      },
    },
    async execute(input, context) {
      try {
        const parsed = parseResolveInput(input);
        return await invoke(
          RESOLVE_TOOL,
          { libraryName: parsed.libraryName, query: parsed.query },
          context,
        );
      } catch (error) {
        return failure(error);
      }
    },
  };

  const query: ToolDefinition = {
    name: QUERY_TOOL,
    description:
      "Fetch documentation for a Context7 library ID. " +
      "The library ID and question are transmitted to the Context7 hosted service.",
    effect: "external",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["libraryId", "query"],
      properties: {
        libraryId: {
          type: "string",
          minLength: 3,
          maxLength: MAX_LIBRARY_ID,
          pattern:
            "^/[A-Za-z0-9@][A-Za-z0-9._~@-]*/[A-Za-z0-9@][A-Za-z0-9._~@-]*(/[A-Za-z0-9@][A-Za-z0-9._~@-]*)?$",
        },
        query: { type: "string", minLength: 1, maxLength: MAX_QUERY },
      },
    },
    async execute(input, context) {
      try {
        const parsed = parseQueryDocsInput(input);
        return await invoke(
          QUERY_TOOL,
          { libraryId: parsed.libraryId, query: parsed.query },
          context,
        );
      } catch (error) {
        return failure(error);
      }
    },
  };

  return [resolve, query];
}

/**
 * Manual resolve+query flow for the `/context7:c7-docs` command. Returns text only;
 * failures are classified into the safe vocabulary and never leak raw service data.
 */
export async function runDocsCommand(
  args: string,
  fetcher: Fetcher = fetch,
  apiKey?: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const parsed = parseCommandArguments(args);
  if (!parsed) return COMMAND_USAGE;
  let libraryName: string;
  let query: string;
  try {
    libraryName = parseLibraryName(parsed.library);
    query = parseQuery(parsed.query);
  } catch {
    return COMMAND_USAGE;
  }

  const client = createMcpClient({ fetcher, apiKey });
  const callSignal = signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const blocks: string[] = [];
  try {
    let libraryId: string | undefined;
    try {
      libraryId = parseLibraryId(libraryName);
    } catch {
      libraryId = undefined;
    }
    if (!libraryId) {
      const resolved = await client.call(RESOLVE_TOOL, { libraryName, query }, callSignal);
      blocks.push(renderDocumentation(resolved.content));
      if (!resolved.isError)
        libraryId = extractLibraryId(textContentParts(resolved.content).join("\n"));
    }
    if (!libraryId) {
      blocks.push(
        "No Context7 library ID was found in the result; pass a library ID explicitly as the first argument.",
      );
      return blocks.join("\n\n").slice(0, MAX_OUTPUT_CHARS * 2);
    }
    const docs = await client.call(QUERY_TOOL, { libraryId, query }, callSignal);
    blocks.push(renderDocumentation(docs.content));
    return blocks.join("\n\n").slice(0, MAX_OUTPUT_CHARS * 2);
  } catch (error) {
    return toContext7Error(error).message;
  }
}

export function createContext7Plugin(fetcher: Fetcher = fetch): Plugin {
  return definePlugin({
    id: "context7",
    name: "Context7 Docs",
    description:
      "Resolve library names and fetch third-party documentation from the Context7 hosted service",
    categories: ["tools"],
    version: VERSION,
    apiVersion: 1,
    setup(api) {
      const apiKey = apiKeyFromEnvironment(process.env);
      for (const tool of createTools(fetcher, apiKey)) api.tools.register(tool);
      api.resources.skills(resourcePaths.skills);
      api.commands.register(COMMAND_NAME, (args: string) => runDocsCommand(args, fetcher, apiKey), {
        description: "Resolve a library and fetch its documentation from Context7",
        argumentHint: "<library> -- <question>",
      });
    },
  });
}

export default createContext7Plugin();
