#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectStack } from "../../application/detect/stack.js";
import type { Verdict } from "../../domain/verdict.js";
import { NodeModuleResolver, NodeWorkspaceFs } from "../../infrastructure/fs/workspace-fs.js";
import { GitCli } from "../../infrastructure/git/git-cli.js";
import { ProcessExec } from "../../infrastructure/process/process-exec.js";
import { compose } from "../composition.js";
import { checkMarkdown } from "../presenters/rules.js";
import { parseArgs, UsageError } from "./args.js";
import { EXTRA_USAGE, extraCommands } from "./extra-commands.js";

export interface CliIo {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Exit codes (spec 10.7): 0 PASS, 1 FAIL, 2 usage or environment error, 3 BLOCKED, 4 REVIEW only. */
export const EXIT = { pass: 0, fail: 1, usage: 2, blocked: 3, review: 4 } as const;

const USAGE = `Usage: alisio-frontsmith <command> [options]

Commands:
  alisio-frontsmith detect [dir] [--json]   Detect the frontend stack of a directory
  alisio-frontsmith check [dir] [--paths <glob,...>] [--packs <id,...>] [--json]
                                            Run the active rule packs (rules that need a unit diff are skipped)

${EXTRA_USAGE}
Exit codes: 0 PASS, 1 FAIL, 2 usage or environment error, 3 BLOCKED, 4 REVIEW only.
`;

async function directoryArg(io: CliIo, value: string | undefined): Promise<string> {
  const dir = resolve(io.cwd, value ?? ".");
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(dir);
  } catch {
    throw new UsageError(`Directory does not exist: ${value ?? "."}`);
  }
  if (!info.isDirectory()) throw new UsageError(`Not a directory: ${value}`);
  return dir;
}

async function detect(argv: string[], io: CliIo): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { flags: { json: "boolean" }, maxPositionals: 1 });
  const dir = await directoryArg(io, positionals[0]);
  const fs = new NodeWorkspaceFs(dir, { git: new GitCli(new ProcessExec()) });
  const profile = await detectStack(fs, new NodeModuleResolver());
  if (flags.json === true) {
    io.stdout(`${JSON.stringify(profile, null, 2)}\n`);
    return EXIT.pass;
  }
  const { evidence, ...facts } = profile;
  const lines = Object.entries(facts).map(([key, value]) => {
    const text = Array.isArray(value)
      ? value.join(", ") || "-"
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
    return `${key}: ${text}`;
  });
  lines.push("evidence:", ...evidence.map((entry) => `  ${entry.fact} (${entry.source})`));
  io.stdout(`${lines.join("\n")}\n`);
  return EXIT.pass;
}

const EXIT_FOR: Record<Verdict, number> = {
  PASS: EXIT.pass,
  FAIL: EXIT.fail,
  BLOCKED: EXIT.blocked,
  REVIEW: EXIT.review,
  SKIPPED: EXIT.pass,
};

const splitList = (value: string | boolean | undefined): string[] | undefined =>
  typeof value === "string"
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined;

async function check(argv: string[], io: CliIo): Promise<number> {
  const { positionals, flags } = parseArgs(argv, {
    flags: { json: "boolean", paths: "string", packs: "string" },
    maxPositionals: 1,
  });
  const dir = await directoryArg(io, positionals[0]);
  const paths = splitList(flags.paths);
  const packs = splitList(flags.packs);
  const outcome = await compose().rules.check(dir, {
    ...(paths ? { paths } : {}),
    ...(packs ? { packs } : {}),
  });
  if (outcome.blocked) {
    if (flags.json === true)
      io.stdout(
        `${JSON.stringify({ schema: "frontsmith.rules-report/v1", verdict: "BLOCKED", problems: outcome.context.problems }, null, 2)}\n`,
      );
    else io.stdout(`${checkMarkdown(outcome)}\n`);
    return EXIT.blocked;
  }
  const { result } = outcome;
  if (flags.json === true)
    // Rule checks are read-only: nothing is persisted, the report is printed (spec 10.7).
    io.stdout(`${JSON.stringify({ schema: "frontsmith.rules-report/v1", ...result }, null, 2)}\n`);
  else io.stdout(`${checkMarkdown(outcome)}\n`);
  return EXIT_FOR[result.verdict];
}

/** Run the CLI; returns the exit code and never throws. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined) throw new UsageError("Missing command");
    if (command === "--help" || command === "-h" || command === "help") {
      io.stdout(USAGE);
      return EXIT.pass;
    }
    if (command === "detect") return await detect(rest, io);
    if (command === "check") return await check(rest, io);
    const extra = extraCommands[command];
    if (extra) return await extra(rest, io);
    throw new UsageError(`Unknown command: ${command}`);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\n${USAGE}`);
      return EXIT.usage;
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.usage;
  }
}

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
  }).then((code) => {
    process.exitCode = code;
  });
}
