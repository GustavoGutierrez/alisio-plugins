import { type ChildProcess, spawn } from "node:child_process";

/** Bounded process execution for gates: argv arrays, timeouts, output caps, scrubbed environment. */

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  /** Maximum bytes kept per stream; a process that exceeds it is killed. */
  maxOutput: number;
  env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  /** `null` when the process never started or was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  cancelled?: boolean;
  spawnError?: string;
}

export type Exec = (argv: string[], options: ExecOptions) => Promise<ExecResult>;

/** Only these variables reach gate commands: no tokens, no shell state, no tool configuration. */
export function scrubbedGateEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1", LANG: "C", LC_ALL: "C" };
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "COMSPEC"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Tracks running gate processes so close, teardown and dispose can stop them. */
export class ProcessTracker {
  private readonly active = new Map<ChildProcess, { cancelled: boolean; cwd: string }>();

  get size(): number {
    return this.active.size;
  }

  add(child: ChildProcess, cwd: string): { cancelled: boolean; cwd: string } {
    const flag = { cancelled: false, cwd };
    this.active.set(child, flag);
    return flag;
  }

  remove(child: ChildProcess): void {
    this.active.delete(child);
  }

  /** Kill every tracked process, or only those running under a directory. */
  killAll(under?: string): void {
    for (const [child, flag] of this.active) {
      if (under !== undefined && flag.cwd !== under && !flag.cwd.startsWith(`${under}/`)) continue;
      flag.cancelled = true;
      killTree(child);
    }
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    // Detached children lead their own process group, so the whole tree (npx, node) goes at once.
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function createExec(tracker?: ProcessTracker): Exec {
  return (argv, options) =>
    new Promise<ExecResult>((resolvePromise) => {
      const [command, ...args] = argv;
      if (!command) {
        resolvePromise({
          code: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          spawnError: "Empty command",
        });
        return;
      }
      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env ?? scrubbedGateEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      } catch (error) {
        resolvePromise({
          code: null,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          spawnError: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const flag = tracker?.add(child, options.cwd);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let truncated = false;
      let spawnError: string | undefined;
      let finished = false;
      const keep = (current: string, chunk: Buffer): string => {
        const room = options.maxOutput - current.length;
        if (chunk.length > room) {
          truncated = true;
          killTree(child);
        }
        return room > 0 ? current + chunk.toString("utf8", 0, room) : current;
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = keep(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = keep(stderr, chunk);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, options.timeoutMs);
      const done = (code: number | null): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        tracker?.remove(child);
        resolvePromise({
          code,
          stdout,
          stderr,
          timedOut,
          truncated,
          ...(flag?.cancelled ? { cancelled: true } : {}),
          ...(spawnError ? { spawnError } : {}),
        });
      };
      child.on("error", (error) => {
        spawnError = (error as NodeJS.ErrnoException).code ?? error.message;
        done(null);
      });
      child.on("close", (code) => done(code));
    });
}
