import { randomUUID } from "node:crypto";
import { errorCode, SemanticPluginError } from "../errors.js";
import type { NotebookDb } from "./db.js";

export interface JobContext {
  signal: AbortSignal;
  progress(value: number): void;
}
export type JobWork = (context: JobContext) => Promise<unknown>;
export interface JobOptions {
  /** Runs after a cancellation, before the job is marked `cancelled` (cleanup of partial work). */
  onCancel?: () => Promise<void> | void;
  /** Runs after a failure with its code (for example to mark a source as failed). */
  onFail?: (code: string) => Promise<void> | void;
}

/**
 * Long work as jobs (D11): the action returns a job id at once and the frame polls `jobs.get`.
 * Jobs of one notebook run one after another; each has its own `AbortController`.
 */
export class JobRunner {
  private readonly db: NotebookDb;
  private readonly controllers = new Map<string, AbortController>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(db: NotebookDb) {
    this.db = db;
  }

  start(
    notebookId: string,
    kind: string,
    sourceId: string | null,
    work: JobWork,
    options: JobOptions = {},
  ) {
    const id = randomUUID();
    this.db.insertJob(id, notebookId, kind, sourceId);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const previous = this.chains.get(notebookId) ?? Promise.resolve();
    const run = previous.then(() => this.execute(id, work, controller, options));
    const tail = run.finally(() => {
      if (this.chains.get(notebookId) === tail) this.chains.delete(notebookId);
    });
    this.chains.set(notebookId, tail);
    return id;
  }

  cancel(id: string): boolean {
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  busy(): boolean {
    return this.controllers.size > 0;
  }

  /** Cancels every job (plugin dispose). */
  dispose() {
    for (const controller of this.controllers.values()) controller.abort();
  }

  /** Resolves when every job queued so far has settled (tests and dispose). */
  async idle() {
    await Promise.all([...this.chains.values()]);
  }

  private async execute(
    id: string,
    work: JobWork,
    controller: AbortController,
    options: JobOptions,
  ) {
    const signal = controller.signal;
    try {
      if (signal.aborted) throw new SemanticPluginError("cancelled");
      this.db.updateJob(id, { state: "running" });
      let last = 0;
      const result = await work({
        signal,
        progress: (value) => {
          const next = Math.max(last, Math.min(1, value));
          if (next - last >= 0.01 || next === 1) {
            last = next;
            this.db.updateJob(id, { progress: next });
          }
        },
      });
      if (signal.aborted) throw new SemanticPluginError("cancelled");
      this.db.updateJob(id, { state: "done", progress: 1, result: result ?? null });
    } catch (error) {
      const code = signal.aborted ? "cancelled" : errorCode(error);
      if (code === "cancelled") {
        await Promise.resolve(options.onCancel?.()).catch(() => {});
        this.db.updateJob(id, { state: "cancelled", error: "cancelled" });
      } else {
        await Promise.resolve(options.onFail?.(code)).catch(() => {});
        this.db.updateJob(id, { state: "failed", error: code });
      }
    } finally {
      this.controllers.delete(id);
    }
  }
}
