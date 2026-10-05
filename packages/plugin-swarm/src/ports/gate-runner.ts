import type { GateName, Thresholds } from "../domain/pack.js";

export interface GateRequest {
  project: string;
  task: string;
  role: string;
  gate: GateName;
  workdir: string;
  /** Toolchain profile id (from the pack). */
  toolchain: string;
  /** Pack thresholds: gates never hard-code them. */
  thresholds: Thresholds;
  /** Commit the role started from: gates look at the diff `since..HEAD`. */
  since?: string;
  signal?: AbortSignal;
}

export interface GateReport {
  gate: GateName;
  passed: boolean;
  /** Human-readable findings handed back to the role when the gate fails. */
  findings: string[];
  /** Why the gate did not run a check (for example no deterministic checker exists yet). */
  skipped?: string;
  /** The gate could not run at all (missing tool, unparseable report): a human must look. */
  error?: string;
  timedOut?: boolean;
  durationMs?: number;
}

/** Deterministic quality gate runner (spec AD-6). */
export interface GateRunner {
  run(request: GateRequest): Promise<GateReport>;
  /** Stop gate processes that are still running, optionally only those under a directory. */
  cancelAll?(under?: string): void;
}
