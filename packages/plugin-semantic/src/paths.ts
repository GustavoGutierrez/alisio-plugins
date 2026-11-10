import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PluginPaths {
  state: string;
  /** Root of model snapshots: `<cache>/models`, else `<state>/models` (D3). */
  models: string;
  /** LanceDB directory (§6.2). */
  lance: string;
  /** Notebook SQLite file (§7.1). */
  notebook: string;
}

/** Host paths (Alisio >= 0.11.5); a host without them gets `$XDG_STATE_HOME/alisio/semantic`. */
export function resolvePaths(
  host: { state: string; cache: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PluginPaths {
  const state =
    host?.state ??
    join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "alisio", "semantic");
  return {
    state,
    models: host?.cache ? join(host.cache, "models") : join(state, "models"),
    lance: join(state, "lance"),
    notebook: join(state, "notebook.db"),
  };
}

/** Bytes under `dir` (0 when missing); for `/semantic:status` only. */
export async function diskUse(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }))
      if (entry.isFile())
        total += (await stat(join(entry.parentPath, entry.name)).catch(() => undefined))?.size ?? 0;
  } catch {
    return 0;
  }
  return total;
}
