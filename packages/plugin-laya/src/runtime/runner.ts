/** Cancellable child-process runner used by the installer. Injected so tests never spawn pip. */
import { type ChildProcess, spawn } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Cap on captured output per stream, in bytes. */
  maxOutput?: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
}

export interface Runner {
  run(file: string, args: string[], options?: RunOptions): Promise<RunResult>;
}

const KILL_ESCALATION_MS = 1000;

/** Real runner: no shell, argument arrays only, SIGTERM then SIGKILL on abort. */
export const nodeRunner: Runner = {
  run(file, args, options = {}) {
    return new Promise<RunResult>((resolve) => {
      const cap = options.maxOutput ?? 64 * 1024;
      let stdout = "";
      let stderr = "";
      let aborted = false;
      let child: ChildProcess;
      try {
        child = spawn(file, args, {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        resolve({ code: null, stdout, stderr: "spawn failed", aborted });
        return;
      }
      child.stdout?.on("data", (c: Buffer) => {
        stdout = (stdout + c.toString()).slice(-cap);
      });
      child.stderr?.on("data", (c: Buffer) => {
        stderr = (stderr + c.toString()).slice(-cap);
      });
      const abort = () => {
        aborted = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, KILL_ESCALATION_MS).unref();
      };
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", () =>
        resolve({ code: null, stdout, stderr: stderr || "spawn failed", aborted }),
      );
      child.once("close", (code) => {
        options.signal?.removeEventListener("abort", abort);
        resolve({ code, stdout, stderr, aborted });
      });
    });
  },
};
