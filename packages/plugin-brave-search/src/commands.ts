import type { PluginAPI } from "@alisio/sdk";
import {
  DASHBOARD_URL,
  describeKeySources,
  ENV,
  type Environment,
  type KeyStore,
  MISSING_KEY_HELP,
  parseApiKey,
  resolveApiKey,
} from "./config.js";
import { redact } from "./errors.js";

/**
 * Registered as `status`, `set-key`, and `clear-key`. Alisio namespaces external
 * plugin commands as `<plugin id>:<name>`, so users run `/brave-search:status`.
 */
export const COMMAND_NAMES = ["status", "set-key", "clear-key"] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export interface CommandDependencies {
  env: Environment;
  keyStore: KeyStore;
}

const STATE_LABEL = {
  set: "set",
  invalid: "set but malformed (ignored)",
  absent: "not set",
} as const;

function status(deps: CommandDependencies): string {
  const described = describeKeySources(deps.env, deps.keyStore);
  const lines = ["Brave Search API key sources (highest precedence first):"];
  for (const { source, state } of described.sources) {
    const label = source === "key file" ? `Key file (${described.keyFile})` : source;
    lines.push(`- ${label}: ${STATE_LABEL[state]}`);
  }
  if (described.keyFileMode !== undefined && (described.keyFileMode & 0o077) !== 0)
    lines.push(
      `Warning: the key file is readable by other users (mode ${described.keyFileMode.toString(8)}); run chmod 600 on it.`,
    );
  lines.push("");
  lines.push(
    described.active === undefined
      ? MISSING_KEY_HELP
      : `Active key: ${described.active} (value hidden).`,
  );
  return lines.join("\n");
}

function setKey(args: string, deps: CommandDependencies): string {
  const raw = args.trim();
  if (raw === "")
    return `Usage: /brave-search:set-key <key>\nCreate a key in the Brave Search API dashboard (${DASHBOARD_URL}).`;
  const key = parseApiKey(raw);
  if (key === undefined)
    return "The value does not look like a Brave Search API key (expected 8-512 characters without spaces). Nothing was saved.";
  try {
    deps.keyStore.write(key);
  } catch {
    return `The key could not be saved to ${deps.keyStore.path}. Export ${ENV.searchKey} instead.`;
  }
  const lines = [`Saved the Brave Search API key to ${deps.keyStore.path} (mode 0600).`];
  const active = resolveApiKey(deps.env, deps.keyStore);
  if (active !== undefined && active.source !== "key file")
    lines.push(`Note: ${active.source} takes precedence over the saved key while it is set.`);
  return redact(lines.join("\n"), [key]);
}

function clearKey(deps: CommandDependencies): string {
  try {
    return deps.keyStore.clear()
      ? `Removed the stored key at ${deps.keyStore.path}. Environment variables, if set, still apply.`
      : "No stored key to remove.";
  } catch {
    return `The key file at ${deps.keyStore.path} could not be removed.`;
  }
}

export async function runCommand(
  name: CommandName,
  args: string,
  deps: CommandDependencies,
): Promise<string> {
  if (name === "status") return status(deps);
  if (name === "set-key") return setKey(args, deps);
  return clearKey(deps);
}

const DESCRIPTIONS: Record<CommandName, { description: string; argumentHint: string }> = {
  status: {
    description: "Show where the Brave Search API key comes from (never prints it)",
    argumentHint: "",
  },
  "set-key": {
    description: "Store a Brave Search API key for this user in a 0600 key file",
    argumentHint: "<key>",
  },
  "clear-key": { description: "Delete the stored Brave Search API key file", argumentHint: "" },
};

export function registerCommands(api: PluginAPI, deps: CommandDependencies): void {
  for (const name of COMMAND_NAMES)
    api.commands.register(name, (args: string) => runCommand(name, args, deps), DESCRIPTIONS[name]);
}
