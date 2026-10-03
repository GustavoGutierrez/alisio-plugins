/**
 * The single background setup job. Commands cannot run for minutes (no abort signal or progress
 * channel in SDK 0.3.0), so setup is a job that starts, persists its state and is cancellable.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../fs-util.js";
import { InstallCancelled, InstallFailure } from "./installer.js";

export type JobKind = "install" | "repair" | "uninstall";
export type JobState = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";

export interface JobRecord {
  version: 1;
  kind: JobKind;
  state: JobState;
  step?: { n: number; total: number; name: string };
  startedAt: string;
  updatedAt: string;
  failureCode?: string;
  message?: string;
}

export interface JobContext {
  signal: AbortSignal;
  step(n: number, name: string): void;
}

export type JobRun = (context: JobContext) => Promise<string | undefined>;

export interface SetupJobsOptions {
  dir: string;
  now?: () => Date;
  onChange?: (record: JobRecord) => void;
  disposeWaitMs?: number;
}

const STEP_TOTAL = 6;
const STATES: readonly string[] = ["running", "succeeded", "failed", "cancelled", "interrupted"];
const KINDS: readonly string[] = ["install", "repair", "uninstall"];

export class SetupJobs {
  private record: JobRecord | undefined;
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  constructor(private readonly options: SetupJobsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private get file(): string {
    return join(this.options.dir, "current.json");
  }

  current(): JobRecord | undefined {
    return this.record;
  }

  /** Load the persisted record; a `running` record left by a dead host becomes `interrupted`. */
  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Record<string, unknown>;
      if (
        parsed.version === 1 &&
        typeof parsed.state === "string" &&
        STATES.includes(parsed.state) &&
        typeof parsed.kind === "string" &&
        KINDS.includes(parsed.kind) &&
        typeof parsed.startedAt === "string" &&
        typeof parsed.updatedAt === "string"
      ) {
        this.record = parsed as unknown as JobRecord;
        if (this.record.state === "running" && !this.running) {
          this.record = {
            ...this.record,
            state: "interrupted",
            updatedAt: this.now().toISOString(),
          };
          this.persist();
          await this.flush();
        }
      }
    } catch {
      this.record = undefined;
    }
  }

  start(kind: JobKind, run: JobRun): "started" | "busy" {
    if (this.running) return "busy";
    const stamp = this.now().toISOString();
    this.record = { version: 1, kind, state: "running", startedAt: stamp, updatedAt: stamp };
    this.persist();
    const abort = new AbortController();
    this.abort = abort;
    const context: JobContext = {
      signal: abort.signal,
      step: (n, name) => {
        if (this.record?.state !== "running") return;
        this.record = {
          ...this.record,
          step: { n, total: STEP_TOTAL, name },
          updatedAt: this.now().toISOString(),
        };
        this.persist();
      },
    };
    this.running = (async () => {
      try {
        const message = await run(context);
        this.finish("succeeded", typeof message === "string" ? { message } : {});
      } catch (error) {
        if (error instanceof InstallCancelled || abort.signal.aborted) {
          this.finish("cancelled", {});
        } else if (error instanceof InstallFailure) {
          this.finish("failed", { failureCode: error.code, message: error.message });
        } else {
          this.finish("failed", {
            failureCode: "unexpected",
            message: "setup failed unexpectedly",
          });
        }
      } finally {
        this.abort = null;
        this.running = null;
      }
    })();
    return "started";
  }

  cancel(): "cancelled" | "none" {
    if (!this.running || !this.abort) return "none";
    this.abort.abort();
    return "cancelled";
  }

  /** Cancel a running job and wait a bounded time for it to unwind. Never throws. */
  async dispose(): Promise<void> {
    const running = this.running;
    this.cancel();
    if (running) {
      await Promise.race([
        running,
        new Promise<void>((r) => setTimeout(r, this.options.disposeWaitMs ?? 1500).unref()),
      ]);
    }
    await this.flush().catch(() => {});
  }

  async whenIdle(): Promise<void> {
    while (this.running) await this.running;
    await this.flush();
  }

  /** Wait for queued record writes. */
  async flush(): Promise<void> {
    await this.writing;
  }

  private finish(state: JobState, extra: { failureCode?: string; message?: string }): void {
    if (!this.record) return;
    this.record = { ...this.record, state, updatedAt: this.now().toISOString(), ...extra };
    this.persist();
  }

  private persist(): void {
    const record = this.record;
    if (!record) return;
    this.options.onChange?.(record);
    this.writing = this.writing
      .then(() => atomicWriteFile(this.file, `${JSON.stringify(record, null, 2)}\n`))
      .catch(() => {});
  }
}
