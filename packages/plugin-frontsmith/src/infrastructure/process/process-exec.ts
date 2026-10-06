import { type ChildProcess, spawn } from "node:child_process";
import type {
  ExecOptions,
  ExecResult,
  ProcessRunner,
} from "../../application/ports/process-runner.js";

const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "NODE_ENV",
  "SYSTEMROOT",
  "COMSPEC",
];

/**
 * Only these variables reach child processes: no tokens, no shell state, no tool configuration.
 * Allowlisted names are preserved only when set; `CI=1` is always forced.
 */
export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1" };
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    // Detached children lead their own process group, so the whole tree goes at once.
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

/** Bounded process execution: argv arrays, process groups, timeouts, output caps, scrubbed env. */
export class ProcessExec implements ProcessRunner {
  run(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
    const started = Date.now();
    const finish = (partial: Partial<ExecResult>): ExecResult => ({
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      cancelled: false,
      durationMs: Date.now() - started,
      ...partial,
    });
    const [command, ...args] = argv;
    if (!command) return Promise.resolve(finish({ spawnError: "Empty command" }));
    if (options.signal?.aborted) return Promise.resolve(finish({ cancelled: true }));
    return new Promise<ExecResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd: options.cwd,
          env: scrubbedEnv(options.env),
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        });
      } catch (error) {
        resolve(finish({ spawnError: error instanceof Error ? error.message : String(error) }));
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let truncated = false;
      let cancelled = false;
      let spawnError: string | undefined;
      let settled = false;
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
      const onAbort = (): void => {
        cancelled = true;
        killTree(child);
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const done = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve(
          finish({
            code: timedOut || cancelled ? null : code,
            stdout,
            stderr,
            timedOut,
            truncated,
            cancelled,
            ...(spawnError ? { spawnError } : {}),
          }),
        );
      };
      child.on("error", (error) => {
        spawnError = (error as NodeJS.ErrnoException).code ?? error.message;
        done(null);
      });
      child.on("close", (code) => done(code));
    });
  }
}
