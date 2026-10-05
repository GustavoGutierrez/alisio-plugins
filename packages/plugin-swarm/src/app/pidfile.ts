import { rm } from "node:fs/promises";
import { atomicWrite, readText } from "../storage.js";

/** Whether a process with this pid exists (signal 0 only probes, it never signals). */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface PidClaim {
  /** A previous owner died without cleaning up; its pidfile was reaped. */
  stale?: number;
  /** A corrupt pidfile was replaced. */
  corrupt?: true;
  /** Another live process owns the forge; the file was left alone. */
  other?: number;
}

/**
 * Record that this process runs the swarm forge. A stale file (dead owner, or garbage) is reaped
 * so the next start is clean; a live foreign owner is reported, never overwritten or killed.
 */
export async function claimPidfile(file: string): Promise<PidClaim> {
  const raw = await readText(file);
  const claim: PidClaim = {};
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown };
      const pid = parsed.pid;
      if (typeof pid !== "number" || !Number.isInteger(pid)) throw new Error("bad pid");
      if (pid === process.pid) return claim;
      if (isAlive(pid)) return { other: pid };
      claim.stale = pid;
    } catch {
      claim.corrupt = true;
    }
  }
  await atomicWrite(
    file,
    `${JSON.stringify({ schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  );
  return claim;
}

/** Remove the pidfile when it is ours. */
export async function releasePidfile(file: string): Promise<void> {
  const raw = await readText(file);
  if (raw === undefined) return;
  try {
    if ((JSON.parse(raw) as { pid?: unknown }).pid !== process.pid) return;
  } catch {
    // Garbage: remove it.
  }
  await rm(file, { force: true });
}
