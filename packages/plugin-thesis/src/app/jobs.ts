import { randomUUID } from "node:crypto";
import { ChildRejectedError } from "../delegate.js";

/** Error codes of Thesis Studio actions and jobs (spec §6.3). */
export type StudioErrorCode =
  | "invalid_input"
  | "not_initialized"
  | "not_found"
  | "busy"
  | "conflict"
  | "blocked"
  | "no_model"
  | "unknown_model"
  | "too_large"
  | "path_not_allowed"
  | "cancelled"
  | "child_rejected"
  | "operation_failed";

/** An action failure that carries a code (and, for some codes, safe extra fields). */
export class StudioError extends Error {
  constructor(
    readonly code: StudioErrorCode,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "StudioError";
  }
}

/** Maps any failure to a code; never exposes a message, an input or a path. */
export function studioErrorOf(error: unknown, signal?: AbortSignal): StudioError {
  if (error instanceof StudioError) return error;
  if (signal?.aborted || (error as { name?: string })?.name === "AbortError")
    return new StudioError("cancelled");
  if (error instanceof ChildRejectedError) return new StudioError("child_rejected");
  if (error instanceof Error && /^No thesis workspace here/.test(error.message))
    return new StudioError("not_initialized");
  return new StudioError("operation_failed");
}

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface JobOutcome {
  /** Coordinator text, already scrubbed of absolute paths (shown as "Details"). */
  text?: string;
  /** Structured result for the frame (e.g. a build outcome). */
  value?: unknown;
  notice?: string;
}

export interface JobHooks {
  signal: AbortSignal;
  progress(text: string): void;
  child(id: string): void;
}

interface Job {
  id: string;
  kind: string;
  label: string;
  target?: string;
  state: JobState;
  progress: string[];
  startedAt: number;
  endedAt?: number;
  outcome?: JobOutcome;
  error?: StudioError;
  children: Set<string>;
  controller: AbortController;
  release: () => void;
}

export interface JobView {
  id: string;
  kind: string;
  label: string;
  target: string | null;
  state: JobState;
  progress: string[];
  elapsedMs: number;
  result?: string;
  value?: unknown;
  notice?: string;
  error?: StudioErrorCode;
  reason?: string;
}

const KEEP = 20;
const PROGRESS_LINES = 20;

/**
 * Background work of ONE activation (D6). One running job per workspace is guaranteed by the
 * caller holding the workspace lock; the job releases it when it ends, is cancelled, or the
 * activation is disposed. Records are in memory only: the effects are durable on disk.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private disposed = false;

  constructor(
    private readonly deps: { cancelChild(id: string): void; now?: () => number } = {
      cancelChild: () => undefined,
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Registers and starts a job; `work` keeps running after this returns. */
  start(
    spec: { kind: string; label: string; target?: string },
    release: () => void,
    work: (hooks: JobHooks) => Promise<JobOutcome>,
  ): JobView {
    if (this.disposed) {
      release();
      throw new StudioError("operation_failed");
    }
    const job: Job = {
      id: `job-${randomUUID()}`,
      kind: spec.kind,
      label: spec.label,
      ...(spec.target ? { target: spec.target } : {}),
      state: "running",
      progress: [],
      startedAt: this.now(),
      children: new Set(),
      controller: new AbortController(),
      release,
    };
    this.jobs.set(job.id, job);
    this.prune();
    const hooks: JobHooks = {
      signal: job.controller.signal,
      progress: (text) => {
        if (job.progress.at(-1) === text) return;
        job.progress.push(text);
        if (job.progress.length > PROGRESS_LINES)
          job.progress.splice(0, job.progress.length - PROGRESS_LINES);
      },
      child: (id) => {
        job.children.add(id);
        // Cancelled before the child existed: stop it at once.
        if (job.controller.signal.aborted) this.deps.cancelChild(id);
      },
    };
    void Promise.resolve()
      .then(() => work(hooks))
      .then(
        (outcome) => {
          if (job.state !== "running") return;
          job.outcome = outcome;
          job.state = "done";
        },
        (error) => {
          if (job.state !== "running") return;
          const failure = studioErrorOf(error, job.controller.signal);
          job.error = failure;
          job.state = failure.code === "cancelled" ? "cancelled" : "failed";
        },
      )
      .finally(() => this.finish(job));
    return this.view(job);
  }

  private finish(job: Job) {
    job.endedAt ??= this.now();
    job.release();
  }

  private prune() {
    const finished = [...this.jobs.values()].filter((job) => job.state !== "running");
    while (this.jobs.size > KEEP && finished.length > 0) {
      const oldest = finished.shift() as Job;
      this.jobs.delete(oldest.id);
    }
  }

  get(id: string): JobView | undefined {
    const job = this.jobs.get(id);
    return job ? this.view(job) : undefined;
  }

  /** The running job, if any. */
  running(): JobView | undefined {
    const job = [...this.jobs.values()].find((entry) => entry.state === "running");
    return job ? this.view(job) : undefined;
  }

  busy(): boolean {
    return [...this.jobs.values()].some((job) => job.state === "running");
  }

  /** Aborts the job and every child it created; the lock is released at once. */
  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (job?.state !== "running") return false;
    job.state = "cancelled";
    job.error = new StudioError("cancelled");
    job.controller.abort();
    for (const child of job.children) {
      try {
        this.deps.cancelChild(child);
      } catch {
        // The host may already have ended it.
      }
    }
    this.finish(job);
    return true;
  }

  /** Synchronous and idempotent: cancels running jobs and releases their locks. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.jobs.values()) if (job.state === "running") this.cancel(job.id);
  }

  private view(job: Job): JobView {
    return {
      id: job.id,
      kind: job.kind,
      label: job.label,
      target: job.target ?? null,
      state: job.state,
      progress: [...job.progress],
      elapsedMs: (job.endedAt ?? this.now()) - job.startedAt,
      ...(job.outcome?.text !== undefined ? { result: job.outcome.text } : {}),
      ...(job.outcome?.value !== undefined ? { value: job.outcome.value } : {}),
      ...(job.outcome?.notice ? { notice: job.outcome.notice } : {}),
      ...(job.error ? { error: job.error.code } : {}),
      ...(typeof job.error?.extra.reason === "string" ? { reason: job.error.extra.reason } : {}),
    };
  }
}
