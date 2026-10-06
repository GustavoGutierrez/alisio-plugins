import type { FeatureState } from "../../domain/state/feature-state.js";
import type { AttemptRecord, AttemptSink } from "./attempt-sink.js";

export interface OpenedFeature {
  state: FeatureState;
  /** Written by a newer Frontsmith: status works, every mutation refuses (spec 8.3). */
  readOnly: boolean;
  version: number | undefined;
}

export interface JobRecord {
  id: string;
  feature: string;
  unit: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  endedAt?: string;
  ownerPid: number;
  summary?: string;
}

export interface StoredAttempt extends AttemptRecord {
  seq: number;
}

/** Raised when a live process already runs a unit of this feature (lockfile contention). */
export class FeatureLockedError extends Error {
  constructor(
    readonly feature: string,
    readonly pid: number | undefined,
  ) {
    super(
      `Another Frontsmith run is working on ${feature}${pid === undefined ? "" : ` (pid ${pid})`}. Wait for it, or stop it with /frontsmith:stop ${feature}.`,
    );
    this.name = "FeatureLockedError";
  }
}

export interface FeatureLockHandle {
  release(): Promise<void>;
  /** A stale lock of a dead process was removed to take this one. */
  reclaimedStale?: { pid: number | undefined };
}

/** Machine state of features under `.alisio/frontsmith/` (spec 8.1 to 8.3). */
export interface FeatureStore {
  list(root: string): Promise<string[]>;
  read(root: string, feature: string): Promise<OpenedFeature | undefined>;
  /** Writes a new feature; rejects when it already exists. */
  create(root: string, state: FeatureState): Promise<void>;
  /**
   * Serialised per feature: read, mutate the draft, stamp `updatedAt`, validate, write atomically.
   * Rejects for a read-only (newer schema) feature.
   */
  update(
    root: string,
    feature: string,
    mutate: (draft: FeatureState) => void,
    now: string,
  ): Promise<FeatureState>;
  attempts(root: string, feature: string): AttemptSink;
  listAttempts(root: string, feature: string): Promise<StoredAttempt[]>;
  /**
   * Resume (spec 7.5): attempts left `running` by a job whose owner is gone become `interrupted`
   * and a stale `state.job` is cleared. Returns how many attempts were marked.
   */
  recoverInterrupted(root: string, feature: string, now: string): Promise<number>;
  lock(root: string, feature: string): Promise<FeatureLockHandle>;
  writeJob(root: string, job: JobRecord): Promise<void>;
  listJobs(root: string, feature: string): Promise<JobRecord[]>;
}
