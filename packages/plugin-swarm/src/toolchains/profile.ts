import { assertRelativePath } from "../domain/identifiers.js";

/** Closed set of built-in output parsers a profile may name (data, never code). */
export const parserNames = [
  "exit-code",
  "istanbul-summary",
  "eslint-complexity",
  "stryker-json",
] as const;
export type ParserName = (typeof parserNames)[number];

export const commandNames = ["test", "coverage", "complexity", "mutation", "acceptance"] as const;
export type CommandName = (typeof commandNames)[number];

export interface ToolchainCommand {
  /** Argument vector run without a shell. */
  argv: string[];
  parser: ParserName;
  /** Report file (relative to the working directory) the parser reads instead of stdout. */
  report?: string;
}

export interface Toolchain {
  schemaVersion: 1;
  id: string;
  description: string;
  detect: string[];
  commands: Partial<Record<CommandName, ToolchainCommand>>;
}

const idPattern = /^[a-z][a-z0-9-]{0,31}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parseToolchain(input: unknown): Toolchain {
  if (!isRecord(input)) throw new Error("A toolchain profile must be a JSON object");
  for (const key of Object.keys(input)) {
    if (!["schemaVersion", "id", "description", "detect", "commands"].includes(key)) {
      throw new Error(`Unknown key "${key}" in toolchain profile`);
    }
  }
  if (input.schemaVersion !== 1)
    throw new Error("Unsupported toolchain schemaVersion (expected 1)");
  if (typeof input.id !== "string" || !idPattern.test(input.id)) {
    throw new Error("Invalid toolchain id: use lowercase letters, digits or hyphens");
  }
  if (typeof input.description !== "string" || !input.description.trim()) {
    throw new Error("A toolchain profile needs a description");
  }
  const detect = Array.isArray(input.detect)
    ? input.detect.map((p) => assertRelativePath(p as string))
    : [];
  if (!isRecord(input.commands)) throw new Error("A toolchain profile needs commands");
  const commands: Toolchain["commands"] = {};
  for (const [name, raw] of Object.entries(input.commands)) {
    if (!(commandNames as readonly string[]).includes(name)) {
      throw new Error(`Unknown command "${name}" in toolchain profile`);
    }
    if (!isRecord(raw)) throw new Error(`Invalid command ${name}: expected an object`);
    for (const key of Object.keys(raw)) {
      if (key !== "argv" && key !== "parser" && key !== "report")
        throw new Error(`Unknown key "${key}" in command ${name}`);
    }
    if (
      !Array.isArray(raw.argv) ||
      raw.argv.length === 0 ||
      !raw.argv.every((item) => typeof item === "string" && item.length > 0 && !item.includes("\0"))
    ) {
      throw new Error(`Invalid argv for command ${name}: expected a non-empty array of strings`);
    }
    if (!(parserNames as readonly string[]).includes(raw.parser as string)) {
      throw new Error(`Invalid parser for command ${name}`);
    }
    commands[name as CommandName] = {
      argv: raw.argv as string[],
      parser: raw.parser as ParserName,
      ...(raw.report !== undefined ? { report: assertRelativePath(raw.report as string) } : {}),
    };
  }
  return { schemaVersion: 1, id: input.id, description: input.description, detect, commands };
}
