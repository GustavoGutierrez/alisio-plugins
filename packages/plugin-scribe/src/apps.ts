// Helpers over the plugin apps API shipped in @alisio/sdk 0.11.5 (`api.apps`; approval prompts since 0.11.6). The contract types
// come from the SDK; this module only adds what Scribe checks on its own side.
export type { PluginAppAction, PluginAppContext, PluginAppDefinition } from "@alisio/sdk";

/** Keywords the host rejects in an action `inputSchema`. */
export const UNSUPPORTED_SCHEMA_KEYWORDS = ["$ref", "$id", "$async"] as const;

/** Paths of every unsupported keyword in a schema (empty when the host accepts it). */
export function unsupportedSchemaKeywords(schema: unknown, path = "$"): string[] {
  if (Array.isArray(schema))
    return schema.flatMap((item, index) => unsupportedSchemaKeywords(item, `${path}[${index}]`));
  if (!schema || typeof schema !== "object") return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if ((UNSUPPORTED_SCHEMA_KEYWORDS as readonly string[]).includes(key))
      found.push(`${path}.${key}`);
    found.push(...unsupportedSchemaKeywords(value, `${path}.${key}`));
  }
  return found;
}
