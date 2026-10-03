/**
 * Orphan reaping. A hard kill of the host leaves the server alive; the pidfile lets the next start
 * reclaim it, but only when the process command line proves it is OUR server.
 */
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { atomicWriteFile } from "../fs-util.js";

export type ReapResult = "none" | "stale" | "foreign" | "killed";

export interface PidfileOptions {
  /** Absolute venv root; the command line must reference it. */
  venvRoot: string;
  isAlive?: (pid: number) => boolean;
  readCommandLine?: (pid: number) => Promise<string | null>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  termGraceMs?: number;
}

export interface Pidfile {
  write(entry: { pid: number; startedAt: number }): Promise<void>;
  remove(): Promise<void>;
  reapOrphan(): Promise<ReapResult>;
}

const run = promisify(execFile);

export async function readLinuxCommandLine(pid: number): Promise<string | null> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").join(" ").trim();
  } catch {
    return null;
  }
}

async function readPsCommandLine(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run("ps", ["-p", String(pid), "-o", "command="], { timeout: 2000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Platform command-line reader; `null` on Windows, where we never kill an unverified pid. */
export function defaultReadCommandLine(pid: number): Promise<string | null> {
  if (process.platform === "linux") return readLinuxCommandLine(pid);
  if (process.platform === "darwin") return readPsCommandLine(pid);
  return Promise.resolve(null);
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createPidfile(path: string, options: PidfileOptions): Pidfile {
  const isAlive = options.isAlive ?? defaultIsAlive;
  const readCommandLine = options.readCommandLine ?? defaultReadCommandLine;
  const kill = options.kill ?? ((pid, signal) => void process.kill(pid, signal));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const grace = options.termGraceMs ?? 1000;

  return {
    async write({ pid, startedAt }) {
      await atomicWriteFile(
        path,
        `${JSON.stringify({ pid, startedAt, venv: options.venvRoot })}\n`,
      );
    },

    async remove() {
      await rm(path, { force: true });
    },

    async reapOrphan() {
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        return "none";
      }
      let entry: { pid: number; venv: string } | null = null;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (
          Number.isInteger(parsed.pid) &&
          (parsed.pid as number) > 0 &&
          typeof parsed.venv === "string" &&
          Number.isFinite(parsed.startedAt)
        ) {
          entry = { pid: parsed.pid as number, venv: parsed.venv };
        }
      } catch {
        entry = null;
      }
      if (!entry) {
        await rm(path, { force: true });
        return "stale";
      }
      if (!isAlive(entry.pid)) {
        await rm(path, { force: true });
        return "stale";
      }
      const commandLine = await readCommandLine(entry.pid);
      if (
        entry.venv !== options.venvRoot ||
        !commandLine ||
        !commandLine.includes(options.venvRoot)
      ) {
        await rm(path, { force: true });
        return "foreign";
      }
      kill(entry.pid, "SIGTERM");
      await sleep(grace);
      if (isAlive(entry.pid)) kill(entry.pid, "SIGKILL");
      await rm(path, { force: true });
      return "killed";
    },
  };
}
