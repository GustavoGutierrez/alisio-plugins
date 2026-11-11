/**
 * Lazy, single-flight lifecycle of the local model. Nothing is downloaded or loaded until the
 * provider is activated (or `/bekko:setup` runs). A load that finishes after a deactivation is
 * discarded through the epoch counter, so a stale engine never becomes "ready".
 */
import type { Engine, EngineFactory, Variant } from "./types.js";

export type RuntimeState = "inactive" | "stopped" | "loading" | "ready" | "failed";

export interface RuntimeSnapshot {
  state: RuntimeState;
  detail: string;
  variant: Variant;
}

export class BekkoRuntime {
  private state: RuntimeState = "inactive";
  private detail = "";
  private engine: Engine | null = null;
  private pending: Promise<void> | null = null;
  private disposed = false;
  private epoch = 0;

  constructor(
    readonly variant: Variant,
    private readonly factory: EngineFactory,
  ) {}

  snapshot(): RuntimeSnapshot {
    return { state: this.state, detail: this.detail, variant: this.variant };
  }

  /** The engine when ready, otherwise `null`. Never blocks. */
  current(): Engine | null {
    return this.state === "ready" ? this.engine : null;
  }

  /** Marks the runtime wanted and starts loading in the background. */
  activate(): void {
    if (this.disposed) return;
    if (this.state === "inactive") this.state = "stopped";
    this.ensureStarted();
  }

  /** Starts (or retries after a failure) a background load; returns immediately. */
  ensureStarted(): void {
    if (this.disposed || this.pending) return;
    if (this.state === "inactive" || this.state === "ready") return;
    const epoch = this.epoch;
    this.state = "loading";
    this.detail = "";
    const task = (async () => {
      try {
        const engine = await this.factory(this.variant, (detail) => {
          if (epoch === this.epoch) this.detail = detail.slice(0, 200);
        });
        if (epoch !== this.epoch || this.disposed) {
          await engine.dispose().catch(() => {});
          return;
        }
        this.engine = engine;
        this.state = "ready";
        this.detail = "";
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.state = "failed";
        this.detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      }
    })();
    this.pending = task;
    void task.finally(() => {
      if (this.pending === task) this.pending = null;
    });
  }

  /** Resolves when the current background load (if any) settles. For tests and status. */
  async settled(): Promise<void> {
    await this.pending;
  }

  async deactivate(): Promise<void> {
    this.epoch++;
    this.pending = null;
    this.state = "inactive";
    this.detail = "";
    const engine = this.engine;
    this.engine = null;
    if (engine) await engine.dispose().catch(() => {});
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.deactivate();
  }
}
