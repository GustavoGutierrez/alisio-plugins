import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CardsmithError } from "../core/errors.js";

/** Host-provided per-plugin directories; the same shape as the optional `api.paths`. */
export interface PluginPaths {
  state: string;
  config: string;
  cache: string;
}

/** Directories cardsmith owns. Everything below `stateDir` is plugin-private. */
export interface CardsmithStatePaths {
  stateDir: string;
  cacheDir: string;
  workingDir: string;
  draftsDir: string;
}

export interface StateDirInput {
  /** `api.paths` when the host provides it; otherwise state falls back under the workspace. */
  apiPaths?: PluginPaths | undefined;
  workspace: string;
}

function requirePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CardsmithError("INVALID_SPEC", `${label} must be a non-empty path`, { path: value });
  }
  return resolve(value);
}

/**
 * Resolve (and create) the plugin directories. Preferred source is the host-provided
 * `api.paths`; older hosts without it get `<workspace>/.alisio/cardsmith` next to the workspace
 * so drafts and working files stay inside the project the user is editing. Every directory is
 * created recursively with mode 0700.
 */
export async function resolveStateDir(input: StateDirInput): Promise<CardsmithStatePaths> {
  const workspace = requirePath(input.workspace, "workspace");
  const stateDir =
    input.apiPaths?.state !== undefined
      ? requirePath(input.apiPaths.state, "api.paths.state")
      : join(workspace, ".alisio", "cardsmith");
  const cacheDir =
    input.apiPaths?.cache !== undefined
      ? requirePath(input.apiPaths.cache, "api.paths.cache")
      : join(stateDir, "cache");
  const workingDir = join(stateDir, "working");
  const draftsDir = join(stateDir, "drafts");

  for (const dir of [stateDir, cacheDir, workingDir, draftsDir]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return { stateDir, cacheDir, workingDir, draftsDir };
}

/**
 * Durable write: a uniquely named temporary file in the destination directory plus `rename`, so
 * readers never observe a partial file. The temporary file is removed when anything fails.
 */
export async function atomicWriteFile(
  path: string,
  content: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
