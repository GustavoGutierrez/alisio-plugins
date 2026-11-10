import { randomBytes } from "node:crypto";
import { AppError, type AppErrorCode, errorCode } from "./errors.js";

export type JobKind = "build" | "wording";
export type JobState = "running" | "done" | "failed" | "cancelled";

/** What `jobs.get` returns: a JSON-serializable snapshot. */
export interface JobSnapshot {
  kind: JobKind;
  state: JobState;
  step: number;
  total: number;
  phase: string;
  result?: unknown;
  error?: AppErrorCode;
}

export interface JobContext {
  signal: AbortSignal;
  progress(step: number, total: number, phase: string): void;
}

interface Job extends JobSnapshot {
  controller: AbortController;
  done: Promise<void>;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** Finished jobs kept for `jobs.get` after they end. */
const KEEP_FINISHED = 20;

/** A 12-character lowercase base32 id (`^[a-z2-7]{12}$`). */
export function jobId(): string {
  return [...randomBytes(12)].map((byte) => ALPHABET[byte % 32]).join("");
}

/**
 * Background work of ONE app activation (app spec §7): at most one job per kind, polled by the
 * frame. Nothing here is module-level; `dispose` cancels only this activation's jobs.
 */
export class AppJobs {
  private readonly jobs = new Map<string, Job>();
  private disposed = false;

  /** Starts `work` as a job; `busy` when a job of the same kind is already running. */
  start(kind: JobKind, work: (context: JobContext) => Promise<unknown>): string {
    if (this.disposed) throw new AppError("operation_failed");
    if (this.running(kind)) throw new AppError("busy");
    const id = jobId();
    const controller = new AbortController();
    const job: Job = {
      kind,
      state: "running",
      step: 0,
      total: 0,
      phase: "",
      controller,
      done: Promise.resolve(),
    };
    this.jobs.set(id, job);
    const context: JobContext = {
      signal: controller.signal,
      progress: (step, total, phase) => {
        if (job.state !== "running") return;
        job.step = step;
        job.total = total;
        job.phase = phase;
      },
    };
    job.done = (async () => {
      try {
        const result = await work(context);
        if (controller.signal.aborted) job.state = "cancelled";
        else {
          job.state = "done";
          job.result = result;
        }
      } catch (error) {
        if (controller.signal.aborted) {
          job.state = "cancelled";
          job.error = "cancelled";
        } else {
          job.state = "failed";
          job.error = errorCode(error);
        }
      }
      this.prune();
    })();
    return id;
  }

  get(id: string): JobSnapshot | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const { controller: _controller, done: _done, ...snapshot } = job;
    return { ...snapshot };
  }

  /** The running job of a kind, if any. */
  current(kind: JobKind): string | undefined {
    for (const [id, job] of this.jobs) if (job.kind === kind && job.state === "running") return id;
    return undefined;
  }

  running(kind?: JobKind): boolean {
    for (const job of this.jobs.values()) {
      if (job.state === "running" && (kind === undefined || job.kind === kind)) return true;
    }
    return false;
  }

  /** Requests cancellation; the job ends after the step in progress. */
  cancel(id: string): JobState | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.state === "running") job.controller.abort();
    return job.state;
  }

  /** True while any job runs: keeps the workspace from idle eviction. */
  busy(): boolean {
    return this.running();
  }

  /** Synchronous and idempotent: cancels this activation's jobs and refuses new ones. */
  dispose(): void {
    this.disposed = true;
    for (const job of this.jobs.values()) if (job.state === "running") job.controller.abort();
  }

  /** Resolves when every job started so far has settled (tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((job) => job.done));
  }

  private prune(): void {
    const finished = [...this.jobs.entries()].filter(([, job]) => job.state !== "running");
    for (const [id] of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.jobs.delete(id);
    }
  }
}
