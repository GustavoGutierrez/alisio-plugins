import type { ModelSource } from "../../domain/state/feature-state.js";

/** One child run, gate run or command run, as recorded in `attempts/<seq>.json` (spec 8.2). */
export interface AttemptRecord {
  kind: "child" | "gate" | "command";
  role?: string;
  agent?: string;
  model?: string;
  modelSource?: ModelSource;
  sessionId?: string;
  status: "running" | "completed" | "failed" | "rejected" | "interrupted";
  startedAt: string;
  endedAt?: string;
  usage?: { input: number; output: number };
  error?: string;
  reportPath?: string;
}

export interface AttemptSink {
  /** Records the attempt and returns its sequence number. */
  begin(attempt: AttemptRecord): Promise<number>;
  finish(seq: number, patch: Partial<AttemptRecord>): Promise<void>;
}

export const noAttempts: AttemptSink = {
  async begin() {
    return 0;
  },
  async finish() {},
};
