import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Verdict } from "../../domain/verdict.js";
import { UsageError } from "./args.js";

export interface CliIo {
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
}

/** Exit codes (spec 10.7): 0 PASS, 1 FAIL, 2 usage or environment error, 3 BLOCKED, 4 REVIEW only. */
export const EXIT = { pass: 0, fail: 1, usage: 2, blocked: 3, review: 4 } as const;

export const EXIT_FOR: Record<Verdict, number> = {
  PASS: EXIT.pass,
  FAIL: EXIT.fail,
  BLOCKED: EXIT.blocked,
  REVIEW: EXIT.review,
  SKIPPED: EXIT.pass,
};

export async function directoryArg(io: CliIo, value: string | undefined): Promise<string> {
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

export const splitList = (value: string | boolean | undefined): string[] | undefined =>
  typeof value === "string"
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined;

export type CliCommand = (argv: string[], io: CliIo) => Promise<number>;
