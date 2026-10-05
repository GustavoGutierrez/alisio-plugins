import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { assertRelativePath } from "./domain/identifiers.js";

export { assertRelativePath };

/** Atomic durable write: private temp file in the target directory, then rename (mode 0600). */
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

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

/**
 * Resolve a relative path under `root`, refusing `..` and any symlink that leads outside it.
 * The deepest existing ancestor is resolved with `realpath`, so a not-yet-created file is safe too.
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

/** Serialises async work per instance (single writer per file within the process, AD-11). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Append missing lines to a `.gitignore`, idempotently. */
export async function ensureIgnoreEntries(file: string, entries: string[]): Promise<boolean> {
  const current = (await readText(file)) ?? "";
  const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !present.has(entry));
  if (missing.length === 0) return false;
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await atomicWrite(file, `${current}${prefix}${missing.join("\n")}\n`);
  return true;
}
