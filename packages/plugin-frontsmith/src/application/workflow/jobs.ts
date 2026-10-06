import type { Clock } from "../ports/clock.js";
import type { FeatureStore, JobRecord } from "../ports/feature-store.js";

/**
 * Longest command that returns intact from the web server (Phase 0, S-R4: 600 s on the server;
 * browser and remote limits stay PENDING). Units that can exceed it run as jobs or through
 * `fs_phase_run`, never inline.
 */
export const FOREGROUND_COMMAND_LIMIT_MS = 600_000;

export interface JobManagerDeps {
  store: FeatureStore;
  clock: Clock;
  newId(): string;
  pid: number;
}

export interface StartJobInput {
  root: string;
  feature: string;
  unit: string;
  /** Resolves to a one-line summary of the outcome. */
  run(signal: AbortSignal): Promise<string>;
  /** Called by `stop` after the signal aborts (cancels the running child sessions). */
  onStop?: () => void;
}

/** What the interface layer hears about units starting and settling (`ui.status`, spec 18.1). */
export interface JobEvent {
  type: "started" | "settled";
  /** `job` runs in the background and has an id; `inline` runs inside the command. */
  kind: "job" | "inline";
  root: string;
  feature: string;
  unit: string;
  id?: string;
}
export type JobListener = (event: JobEvent) => void;

interface Running {
  id: string;
  controller: AbortController;
  done: Promise<void>;
  onStop: (() => void) | undefined;
  stopped: boolean;
}

/**
 * Background jobs (AD-11, spec 7.5): one per feature, guarded by the feature lockfile. `start`
 * takes the lock before it returns, so contention is reported to the command that asked, and
 * releases it when the unit settles.
 */
export class JobManager {
  private readonly running = new Map<string, Running>();
  private readonly listeners = new Set<JobListener>();

  constructor(private readonly deps: JobManagerDeps) {}

  /** Listen to unit starts and ends; a listener that throws never affects the unit. */
  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Features whose unit is running as a background job. */
  runningCount(): number {
    return this.running.size;
  }

  private emit(event: JobEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Presentation only.
      }
    }
  }

  isRunning(feature: string): boolean {
    return this.running.has(feature);
  }

  async start(input: StartJobInput): Promise<{ id: string }> {
    const { store, clock } = this.deps;
    const lock = await store.lock(input.root, input.feature);
    const id = this.deps.newId();
    const startedAt = clock.now().toISOString();
    const base: JobRecord = {
      id,
      feature: input.feature,
      unit: input.unit,
      status: "running",
      startedAt,
      ownerPid: this.deps.pid,
    };
    try {
      await store.writeJob(input.root, base);
      await store.update(
        input.root,
        input.feature,
        (draft) => {
          draft.job = { id, unit: input.unit, startedAt, ownerPid: this.deps.pid };
        },
        startedAt,
      );
    } catch (error) {
      await lock.release();
      throw error;
    }
    const controller = new AbortController();
    const entry: Running = {
      id,
      controller,
      onStop: input.onStop,
      stopped: false,
      done: Promise.resolve(),
    };
    entry.done = (async () => {
      let status: JobRecord["status"] = "completed";
      let summary = "";
      try {
        summary = await input.run(controller.signal);
        if (entry.stopped) status = "cancelled";
      } catch (error) {
        status = entry.stopped ? "cancelled" : "failed";
        summary = error instanceof Error ? error.message : String(error);
      }
      const endedAt = clock.now().toISOString();
      try {
        await store.writeJob(input.root, { ...base, status, endedAt, summary });
        await store.update(input.root, input.feature, (draft) => void delete draft.job, endedAt);
      } finally {
        this.running.delete(input.feature);
        await lock.release();
        this.emit({
          type: "settled",
          kind: "job",
          root: input.root,
          feature: input.feature,
          unit: input.unit,
          id,
        });
      }
    })();
    this.running.set(input.feature, entry);
    this.emit({
      type: "started",
      kind: "job",
      root: input.root,
      feature: input.feature,
      unit: input.unit,
      id,
    });
    return { id };
  }

  /** Abort the running job of a feature; false when none runs here. */
  async stop(feature: string): Promise<boolean> {
    const entry = this.running.get(feature);
    if (!entry) return false;
    entry.stopped = true;
    entry.controller.abort();
    entry.onStop?.();
    return true;
  }

  /** Resolves when the job of a feature has settled (tests and `fs_phase_run`). */
  async wait(feature: string): Promise<void> {
    await this.running.get(feature)?.done;
  }

  /** Run a unit in the foreground under the feature lock. */
  async runInline<T>(input: {
    root: string;
    feature: string;
    unit: string;
    run(): Promise<T>;
  }): Promise<T> {
    const lock = await this.deps.store.lock(input.root, input.feature);
    const event = {
      kind: "inline" as const,
      root: input.root,
      feature: input.feature,
      unit: input.unit,
    };
    this.emit({ type: "started", ...event });
    try {
      return await input.run();
    } finally {
      await lock.release();
      this.emit({ type: "settled", ...event });
    }
  }
}
