import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Cache root for downloaded engines (spec 2.2): `api.paths?.cache` when the host provides it, else
 * `ALISIO_CACHE_HOME`, then `$XDG_CACHE_HOME/alisio`, then `~/.cache/alisio`.
 */
export function cacheRoot(
  hostCache: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: () => string = homedir,
): string {
  if (hostCache) return hostCache;
  if (env.ALISIO_CACHE_HOME) return env.ALISIO_CACHE_HOME;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "alisio");
  return join(home(), ".cache", "alisio");
}

/** Directory the setup command installs one Typst version into. */
export function typstInstallDir(root: string, version: string): string {
  return join(root, "thesis", "typst", version);
}
