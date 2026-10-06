import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Raised when a live process already holds the lock. */
export class LockHeldError extends Error {
  constructor(
    readonly path: string,
    readonly pid: number | undefined,
  ) {
    super(`Another Frontsmith run holds ${path}${pid === undefined ? "" : ` (pid ${pid})`}`);
    this.name = "LockHeldError";
  }
}

export interface FeatureLock {
  release(): Promise<void>;
  /** Set when a stale lock of a dead process was removed to take this one. */
  reclaimedStale?: { pid: number | undefined };
}

export interface LockOptions {
  pid?: number;
  /** `process.kill` seam: throws `ESRCH` when the process is gone. */
  kill?: (pid: number, signal: number) => void;
  now?: () => string;
}

function isAlive(pid: number, kill: (pid: number, signal: number) => void): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else: it is alive.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readOwner(path: string): Promise<number | undefined | "corrupt"> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : "corrupt";
  } catch {
    return "corrupt";
  }
}

/**
 * Take `<feature>/.lock` with flag `wx`. A lock whose owner is gone (`ESRCH`) or whose body is
 * unreadable is stale: it is removed and reported through `reclaimedStale`.
 */
export async function acquireLock(path: string, options: LockOptions = {}): Promise<FeatureLock> {
  const pid = options.pid ?? process.pid;
  const kill = options.kill ?? ((target, signal) => void process.kill(target, signal));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({
    pid,
    startedAt: (options.now ?? (() => new Date().toISOString()))(),
    host: "frontsmith",
  });
  let reclaimed: { pid: number | undefined } | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, body, { flag: "wx", mode: 0o600 });
      const lock: FeatureLock = {
        release: async () => {
          await rm(path, { force: true });
        },
        ...(reclaimed ? { reclaimedStale: reclaimed } : {}),
      };
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readOwner(path);
      if (owner !== "corrupt" && owner !== undefined && isAlive(owner, kill))
        throw new LockHeldError(path, owner);
      reclaimed = { pid: owner === "corrupt" ? undefined : owner };
      await rm(path, { force: true });
    }
  }
  throw new LockHeldError(path, undefined);
}
