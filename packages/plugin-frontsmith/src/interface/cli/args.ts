export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ArgSpec {
  flags: Readonly<Record<string, "boolean" | "string">>;
  maxPositionals: number;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Strict argv parser: unknown options, missing values and surplus arguments are usage errors. */
export function parseArgs(argv: readonly string[], spec: ArgSpec): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (literal || !arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new UsageError(`Unknown option ${arg}`);
    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const kind = spec.flags[name];
    if (kind === undefined) throw new UsageError(`Unknown option --${name}`);
    if (kind === "boolean") {
      if (inline !== undefined) throw new UsageError(`Option --${name} does not take a value`);
      flags[name] = true;
    } else {
      const value = inline ?? argv[index + 1];
      if (value === undefined || (inline === undefined && value.startsWith("--")))
        throw new UsageError(`Option --${name} requires a value`);
      if (inline === undefined) index += 1;
      flags[name] = value;
    }
  }
  if (positionals.length > spec.maxPositionals)
    throw new UsageError(`Too many arguments: ${positionals.slice(spec.maxPositionals).join(" ")}`);
  return { positionals, flags };
}
