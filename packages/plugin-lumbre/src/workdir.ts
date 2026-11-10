// Keeps `<project>/work` equal to a revision IN PLACE, so a running dev server hot-reloads: only
// changed files are written (each through a temp file renamed over the target), removed files are
// deleted, and everything Lumbre does not track (node_modules, build output, caches) is left alone.
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LumbreError } from "./errors.js";
import { type Files, filePath } from "./safety.js";
import { writeAtomic } from "./store.js";

const sha = (content: string) => createHash("sha256").update(content).digest("hex");
/** The manifest of each synced folder (the project's `work`, or the agent's `draft-work`). */
const manifestName = (folder: string) =>
  folder === "work" ? "work-manifest.json" : `${folder}-manifest.json`;

/** Each existing component under `work` must be a real folder (no symlink can redirect writes). */
async function assertRealDirs(work: string, path: string) {
  const parts = path.split("/").slice(0, -1);
  let current = work;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new LumbreError("invalid_path");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error instanceof LumbreError ? error : new LumbreError("invalid_path");
    }
  }
  try {
    if ((await lstat(join(work, ...path.split("/")))).isSymbolicLink())
      throw new LumbreError("invalid_path");
  } catch (error) {
    if (error instanceof LumbreError) throw error;
  }
}

export interface SyncResult {
  written: string[];
  deleted: string[];
}

/**
 * Brings the work folder to `files`. `verify` also re-reads tracked files whose manifest hash
 * matches, to repair edits made on disk outside Lumbre (used before builds and exports).
 */
export async function syncWork(
  projectDir: string,
  files: Files,
  options: { verify?: boolean; folder?: string } = {},
): Promise<SyncResult> {
  const folder = options.folder ?? "work";
  const work = join(projectDir, folder);
  const tmpDir = join(projectDir, "tmp");
  await mkdir(work, { recursive: true, mode: 0o700 });
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  let previous: Record<string, string> = {};
  try {
    previous = JSON.parse(await readFile(join(projectDir, manifestName(folder)), "utf8"));
  } catch {
    previous = {};
  }
  const next: Record<string, string> = {};
  const written: string[] = [];
  for (const [path, content] of Object.entries(files)) {
    filePath(path);
    const hash = sha(content);
    next[path] = hash;
    let same = previous[path] === hash;
    if (same && options.verify) {
      try {
        same = sha(await readFile(join(work, ...path.split("/")), "utf8")) === hash;
      } catch {
        same = false;
      }
    }
    if (same) continue;
    await assertRealDirs(work, path);
    const target = join(work, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // The temp file lives outside `work` so watchers never see a half-written or stray file.
    const tmp = join(tmpDir, randomUUID());
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, target);
    written.push(path);
  }
  const deleted: string[] = [];
  for (const path of Object.keys(previous)) {
    if (Object.hasOwn(next, path)) continue;
    try {
      filePath(path);
    } catch {
      continue;
    }
    await assertRealDirs(work, path);
    await rm(join(work, ...path.split("/")), { force: true });
    deleted.push(path);
    // Remove folders the deletion emptied, never above `work`.
    let parent = dirname(path);
    while (parent && parent !== ".") {
      try {
        await rmdir(join(work, ...parent.split("/")));
      } catch {
        break;
      }
      parent = dirname(parent);
    }
  }
  await writeAtomic(join(projectDir, manifestName(folder)), JSON.stringify(next));
  return { written, deleted };
}
