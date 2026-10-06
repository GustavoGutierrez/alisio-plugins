import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const TEMP_FILE = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
/** A temp file older than this is a crashed writer's leftover, never an in-flight write. */
const STALE_TEMP_MS = 60_000;

/** Remove leftover `.<uuid>.tmp` files of crashed writers; never touches fresh or foreign files. */
async function sweepStaleTemps(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TEMP_MS;
  await Promise.all(
    names
      .filter((name) => TEMP_FILE.test(name))
      .map(async (name) => {
        const path = join(directory, name);
        try {
          if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
        } catch {
          // Raced with another sweeper; nothing to do.
        }
      }),
  );
}

/** Atomic durable write: private temp file in the target directory, then rename (mode 0600). */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await sweepStaleTemps(directory);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Atomic durable write of bytes (same discipline as `atomicWrite`, mode 0600). */
export async function atomicWriteBytes(path: string, bytes: Uint8Array): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await sweepStaleTemps(directory);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** File text, or `undefined` when the file does not exist. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const within = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${sep}`);

function assertRelativePath(relative: string): void {
  if (relative.length === 0) throw new Error("Path must not be empty");
  if (relative.includes("\u0000")) throw new Error("Path must not contain NUL");
  if (relative.includes("\\")) throw new Error(`Path must use forward slashes: ${relative}`);
  if (relative.startsWith("/")) throw new Error(`Path must be relative: ${relative}`);
  if (/^[A-Za-z]:/.test(relative)) throw new Error(`Path must be relative: ${relative}`);
  if (relative.split("/").includes(".."))
    throw new Error(`Path must not contain '..': ${relative}`);
}

/**
 * Resolve a relative path under `root`, refusing `..` and any symlink that leads outside it. The
 * deepest existing ancestor is resolved with `realpath`, so a not-yet-created file is safe too.
 */
export async function resolveContained(root: string, relative: string): Promise<string> {
  assertRelativePath(relative);
  const base = resolve(root);
  const target = resolve(base, relative);
  if (!within(base, target)) throw new Error(`Path escapes its root: ${relative}`);
  const realBase = await realpath(base);
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (!within(realBase, real))
        throw new Error(`Path escapes its root through a symlink: ${relative}`);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(probe);
      if (parent === probe || !within(base, parent)) return target;
      probe = parent;
    }
  }
}

/** Serialises async work per instance: one writer per resource inside the process. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Append missing lines to a `.gitignore`, idempotently. Returns true when the file changed. */
export async function ensureIgnoreEntries(file: string, entries: string[]): Promise<boolean> {
  const current = (await readText(file)) ?? "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return false;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await atomicWrite(file, `${current}${prefix}${missing.join("\n")}\n`);
  return true;
}
