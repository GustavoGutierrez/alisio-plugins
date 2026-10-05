import type { Handoff, HandoffLocation, InboxBox, StoredHandoff } from "../domain/handoff.js";

export interface ScanResult {
  records: StoredHandoff[];
  /** Files that failed strict revalidation (relative to the store root). */
  invalid: string[];
}

export interface RecoveryResult {
  redelivered: number;
  requeued: number;
}

/** Durable, file-based handoff queue. Files are the source of truth for crash recovery. */
export interface HandoffStore {
  ensureRoles(roles: string[]): Promise<void>;
  /** Write a new handoff at a location, allocating its sequence number and file name. */
  write(handoff: Handoff, location: HandoffLocation): Promise<StoredHandoff>;
  /** Move a handoff to another location, optionally rewriting its header fields. */
  move(
    stored: StoredHandoff,
    to: HandoffLocation,
    patch?: Partial<Pick<Handoff, "approved" | "completedAt" | "dequeuedAt" | "enqueuedAt">>,
  ): Promise<StoredHandoff>;
  /** Remove a handoff file (used for superseded audit parkings). Missing files are ignored. */
  discard(stored: StoredHandoff): Promise<void>;
  /** Outbox -> sent, with a copy in every recipient's `inbox/new`. Idempotent. */
  deliver(stored: StoredHandoff): Promise<StoredHandoff[]>;
  /** Phantom-sender handoffs go straight to the recipients' `inbox/new`. */
  inject(handoff: Handoff): Promise<StoredHandoff[]>;
  /** Move the next inbox item (or all equal-priority items of the same task for `batch`) to `in_process`. */
  claim(role: string, options?: { batch?: boolean }): Promise<StoredHandoff[]>;
  /** Move claimed items to `completed`. */
  complete(items: StoredHandoff[]): Promise<StoredHandoff[]>;
  /** Remove every file of one task everywhere (task deletion); returns what was removed. */
  purge(taskId: string): Promise<StoredHandoff[]>;
  scan(): Promise<ScanResult>;
  /** Replay after a crash: redeliver outbox items, requeue `in_process` items. */
  recover(): Promise<RecoveryResult>;
  /** Count items waiting in a role's `inbox/new`. */
  pending(role: string): Promise<number>;
}

export type { InboxBox };
