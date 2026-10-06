export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  /** Maximum bytes kept per stream; a process that exceeds it is killed. */
  maxOutput: number;
  /** Extra variables merged over the scrubbed environment. */
  env?: Record<string, string>;
  /** Kills the process tree when aborted. */
  signal?: AbortSignal;
}

export interface ExecResult {
  /** `null` when the process never started or was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  cancelled: boolean;
  spawnError?: string;
  durationMs: number;
}

/** Runs a command as an argv array with a scrubbed environment: never a shell (spec 19). */
export interface ProcessRunner {
  run(argv: readonly string[], options: ExecOptions): Promise<ExecResult>;
}
