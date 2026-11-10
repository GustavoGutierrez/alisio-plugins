import { resolve } from "node:path";

/** Who holds the single writer slot of a workspace (D4). */
export type LockHolder = "chat" | "app";

export interface LockInfo {
  holder: LockHolder;
  /** Plain label shown to the other surface ("/thesis:draft", "Writing SEC-03"). */
  label: string;
}

/**
 * One state writer per workspace, shared by the chat commands and the Thesis Studio app of ONE
 * plugin activation. It never waits: a second writer is refused with the holder (Q4: block, no
 * queue), so the user always knows which surface is changing the thesis.
 */
export class WorkspaceLock {
  private readonly held = new Map<string, LockInfo & { token: symbol }>();

  holderOf(workspace: string): LockInfo | undefined {
    const entry = this.held.get(resolve(workspace));
    return entry ? { holder: entry.holder, label: entry.label } : undefined;
  }

  /** Returns an idempotent release function, or undefined when the workspace is busy. */
  tryAcquire(workspace: string, holder: LockHolder, label: string): (() => void) | undefined {
    const key = resolve(workspace);
    if (this.held.has(key)) return undefined;
    const token = Symbol(label);
    this.held.set(key, { holder, label, token });
    return () => {
      // A stale release never frees a later holder.
      if (this.held.get(key)?.token === token) this.held.delete(key);
    };
  }
}

/** The chat-facing text when a command meets a held lock. */
export function blockedByLock(info: LockInfo): string {
  return info.holder === "app"
    ? `Blocked: Thesis Studio is running ${info.label}; wait or cancel it there.`
    : `Blocked: another thesis command is running (${info.label}); wait for it to finish.`;
}
