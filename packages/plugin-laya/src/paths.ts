import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LayaConfigError } from "./errors.js";
import { ensurePrivateDir } from "./fs-util.js";

export interface HostPaths {
  state: string;
  config: string;
  cache: string;
}

export interface LayaPaths {
  /** Plugin-scoped directories. */
  config: string;
  state: string;
  cache: string;
  /** `<config>/config.json`, the only file the plugin writes outside the runtime. */
  configFile: string;
  /** Runtime root: venv, manifest, jobs, pidfile. */
  runtime: string;
  /** `HF_HOME`: the model cache. */
  hf: string;
  source: "host" | "fallback";
}

export interface ResolvePathsInput {
  apiPaths?: HostPaths | undefined;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

function requireAbsolute(value: string, what: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw new LayaConfigError(`${what} must be an absolute path`);
  }
  return resolve(value);
}

function homeFor(
  env: Readonly<Record<string, string | undefined>>,
  explicit: string,
  xdg: string,
  fallback: string[],
  home: string,
): string {
  const override = env[explicit];
  if (override) return requireAbsolute(override, explicit);
  const xdgValue = env[xdg];
  if (xdgValue) return join(requireAbsolute(xdgValue, xdg), "alisio");
  return join(home, ...fallback, "alisio");
}

/**
 * Resolve the plugin-scoped directories: the host's `api.paths` when present (already scoped to
 * the plugin, so nothing is appended), otherwise the same layout from the XDG/`ALISIO_*` rules the
 * sibling plugins use.
 */
export function resolvePaths(input: ResolvePathsInput): LayaPaths {
  const { env, home } = input;
  let config: string;
  let state: string;
  let cache: string;
  let source: LayaPaths["source"];
  if (input.apiPaths) {
    config = requireAbsolute(input.apiPaths.config, "api.paths.config");
    state = requireAbsolute(input.apiPaths.state, "api.paths.state");
    cache = requireAbsolute(input.apiPaths.cache, "api.paths.cache");
    source = "host";
  } else {
    config = join(
      homeFor(env, "ALISIO_CONFIG_HOME", "XDG_CONFIG_HOME", [".config"], home),
      "plugins",
      "laya",
    );
    state = join(
      homeFor(env, "ALISIO_STATE_HOME", "XDG_STATE_HOME", [".local", "state"], home),
      "plugins",
      "laya",
    );
    cache = state;
    source = "fallback";
  }
  const runtime = env.ALISIO_LAYA_HOME
    ? requireAbsolute(env.ALISIO_LAYA_HOME, "ALISIO_LAYA_HOME")
    : join(state, "runtime");
  const hf = cache === state || env.ALISIO_LAYA_HOME ? join(runtime, "hf") : join(cache, "hf");
  return { config, state, cache, configFile: join(config, "config.json"), runtime, hf, source };
}

/** Create the plugin directories with owner-only access. */
export async function ensurePaths(paths: LayaPaths): Promise<void> {
  await ensurePrivateDir(paths.config);
  await ensurePrivateDir(paths.state);
  await ensurePrivateDir(paths.runtime);
}

async function realpathOfExisting(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = await realpath(current);
      return join(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export interface ContainOptions {
  /** Reject a target that is itself a symlink (used before deleting a directory). */
  forbidSymlink?: boolean;
}

/**
 * Prove that `target` stays inside `root` after resolving symlinks (nearest existing ancestor).
 * Returns the lexical target on success; throws `LayaConfigError` otherwise.
 */
export async function assertContained(
  root: string,
  target: string,
  options: ContainOptions = {},
): Promise<string> {
  const lexicalRoot = resolve(root);
  const lexicalTarget = resolve(target);
  const rel = relative(lexicalRoot, lexicalTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new LayaConfigError("path escapes the runtime directory");
  }
  const realRoot = await realpathOfExisting(lexicalRoot);
  const realTarget = await realpathOfExisting(lexicalTarget);
  const realRel = relative(realRoot, realTarget);
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
    throw new LayaConfigError("path escapes the runtime directory");
  }
  if (options.forbidSymlink) {
    try {
      if ((await lstat(lexicalTarget)).isSymbolicLink()) {
        throw new LayaConfigError("path must not be a symlink");
      }
    } catch (error) {
      if (error instanceof LayaConfigError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return lexicalTarget;
}
