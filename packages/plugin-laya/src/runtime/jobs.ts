/**
 * The single background setup job. Commands cannot run for minutes (no abort signal or progress
 * channel in SDK 0.3.0), so setup is a job that starts, persists its state and is cancellable.
 */
import { readFileSync } from "node:fs";
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
  /** Owner process id; absent on records written before 0.1.1. */
  pid?: number;
  /** Process start token (Linux /proc starttime) guarding against pid reuse; best effort. */
  ownerStart?: string;
  /** Outcome of the host activation attempt after a successful install or repair. */
  activation?: ActivationRecord;
}

export type ActivationStatus =
  | "activated"
  | "already_active"
  | "other_provider_active"
  | "declined"
  | "needs_confirmation"
  | "disabled"
  | "unavailable";

export interface ActivationRecord {
  status: ActivationStatus;
  at: string;
  active?: string;
}

export interface ProcessProbe {
  alive(pid: number): boolean;
  startToken(pid: number): string | undefined;
}

export const nodeProbe: ProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
  startToken(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name may contain spaces; fields restart after the last ")". starttime is field 22.
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return rest[19];
    } catch {
      return undefined;
    }
  },
};

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
  pid?: number;
  probe?: ProcessProbe;
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
  private readonly pid: number;
  private readonly probe: ProcessProbe;
  private foreign = false;

  constructor(private readonly options: SetupJobsOptions) {
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    this.probe = options.probe ?? nodeProbe;
  }

  /** True when the current record is a live setup job owned by another process (read-only view). */
  ownedElsewhere(): boolean {
    return this.foreign;
  }

  /** Whether the record's owner may still be running. Legacy records (no pid) count as dead. */
  private ownerAlive(record: JobRecord): boolean {
    if (typeof record.pid !== "number") return false;
    if (record.pid === this.pid) return true;
    if (!this.probe.alive(record.pid)) return false;
    if (record.ownerStart !== undefined) {
      const token = this.probe.startToken(record.pid);
      if (token !== undefined && token !== record.ownerStart) return false;
    }
    return true;
  }

  /** Re-read the record while nothing is running here, so another process's progress is visible. */
  async refresh(): Promise<void> {
    if (!this.running) await this.load();
  }

  setActivation(outcome: { status: ActivationStatus; active?: string }): void {
    if (!this.record || this.foreign) return;
    this.record = {
      ...this.record,
      activation: {
        status: outcome.status,
        at: this.now().toISOString(),
        ...(outcome.active ? { active: outcome.active } : {}),
      },
    };
    this.persist();
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
        this.foreign = false;
        if (this.record.state === "running" && !this.running && this.ownerAlive(this.record)) {
          this.foreign = true;
        } else if (this.record.state === "running" && !this.running) {
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
      this.foreign = false;
    }
  }

  start(kind: JobKind, run: JobRun): "started" | "busy" {
    if (this.running || this.foreign) return "busy";
    const stamp = this.now().toISOString();
    const ownerStart = this.probe.startToken(this.pid);
    this.record = {
      version: 1,
      kind,
      state: "running",
      startedAt: stamp,
      updatedAt: stamp,
      pid: this.pid,
      ...(ownerStart !== undefined ? { ownerStart } : {}),
    };
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

  cancel(): "cancelled" | "none" | "other_process" {
    if (this.foreign) return "other_process";
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
