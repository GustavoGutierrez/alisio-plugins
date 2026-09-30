import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BraveSearchError } from "./errors.js";

/**
 * API key configuration. The installed Alisio SDK exposes no tool-level secret
 * API, so the key comes from, in order of precedence:
 *   1. `BRAVE_SEARCH_API_KEY`
 *   2. `BRAVE_API_KEY` (the variable Brave's official MCP server uses)
 *   3. a plugin-owned key file at `<configHome>/brave-search/api-key`, written by
 *      `/brave-search:set-key` atomically with `0600` permissions.
 * The key is resolved on every call, so `set-key` takes effect immediately. It is
 * never accepted through tool input, logged, echoed, or included in any result.
 */
export type Environment = Record<string, string | undefined>;

export const ENV = {
  searchKey: "BRAVE_SEARCH_API_KEY",
  braveKey: "BRAVE_API_KEY",
  configHome: "ALISIO_CONFIG_HOME",
  xdgConfigHome: "XDG_CONFIG_HOME",
  home: "HOME",
} as const;

export type KeySource = typeof ENV.searchKey | typeof ENV.braveKey | "key file";

/** Where users create a key. */
export const DASHBOARD_URL = "https://api-dashboard.search.brave.com";

const MIN_API_KEY = 8;
const MAX_API_KEY = 512;
/** Conservative header-safe token shape: printable ASCII, no whitespace or control bytes. */
const API_KEY_SHAPE = /^[A-Za-z0-9._~+/=-]+$/;

/** Validate a candidate key; absent or implausible values resolve to `undefined`. */
export function parseApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length < MIN_API_KEY || trimmed.length > MAX_API_KEY) return undefined;
  return API_KEY_SHAPE.test(trimmed) ? trimmed : undefined;
}

/** Resolve the Alisio config home: `ALISIO_CONFIG_HOME`, `$XDG_CONFIG_HOME/alisio`, `~/.config/alisio`. */
export function resolveConfigHome(env: Environment = process.env): string {
  const home = env[ENV.home]?.trim() || homedir();
  const xdg = env[ENV.xdgConfigHome]?.trim();
  return (
    env[ENV.configHome]?.trim() || (xdg ? join(xdg, "alisio") : join(home, ".config", "alisio"))
  );
}

/** The plugin-owned key file: `<configHome>/brave-search/api-key`. */
export function resolveKeyFile(env: Environment = process.env): string {
  return join(resolveConfigHome(env), "brave-search", "api-key");
}

export interface KeyFileInfo {
  exists: boolean;
  valid: boolean;
  /** POSIX permission bits, when the file exists and could be inspected. */
  mode: number | undefined;
}

/** Plugin-owned key persistence with atomic `0600` writes and a `0700` parent. */
export class KeyStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The stored key, or `undefined` when absent, unreadable, or malformed. */
  read(): string | undefined {
    try {
      return parseApiKey(readFileSync(this.path, "utf8"));
    } catch {
      return undefined;
    }
  }

  inspect(): KeyFileInfo {
    let mode: number | undefined;
    try {
      mode = statSync(this.path).mode & 0o777;
    } catch {
      return { exists: false, valid: false, mode: undefined };
    }
    return { exists: true, valid: this.read() !== undefined, mode };
  }

  write(key: string): void {
    const parsed = parseApiKey(key);
    if (parsed === undefined)
      throw new BraveSearchError("invalid input", "the value does not look like an API key");
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Hardening only.
    }
    const temp = `${this.path}.${process.pid}.tmp`;
    const descriptor = openSync(temp, "w", 0o600);
    try {
      writeSync(descriptor, `${parsed}\n`, 0, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      chmodSync(temp, 0o600);
    } catch {
      // Hardening only.
    }
    renameSync(temp, this.path);
  }

  /** Remove the stored key; returns whether a file was removed. */
  clear(): boolean {
    if (!this.inspect().exists) return false;
    rmSync(this.path, { force: true });
    return true;
  }
}

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

/** Resolve the active key by precedence; malformed values are skipped. */
export function resolveApiKey(env: Environment, store: KeyStore): ResolvedKey | undefined {
  for (const name of [ENV.searchKey, ENV.braveKey] as const) {
    const key = parseApiKey(env[name]);
    if (key !== undefined) return { key, source: name };
  }
  const stored = store.read();
  return stored === undefined ? undefined : { key: stored, source: "key file" };
}

export type SourceState = "set" | "invalid" | "absent";

export interface KeySourcesDescription {
  active: KeySource | undefined;
  sources: Array<{ source: KeySource; state: SourceState }>;
  keyFile: string;
  keyFileMode: number | undefined;
}

function envState(value: string | undefined): SourceState {
  if (value === undefined || value.trim() === "") return "absent";
  return parseApiKey(value) === undefined ? "invalid" : "set";
}

/** A secret-free description of every key source, for `/brave-search:status`. */
export function describeKeySources(env: Environment, store: KeyStore): KeySourcesDescription {
  const file = store.inspect();
  return {
    active: resolveApiKey(env, store)?.source,
    sources: [
      { source: ENV.searchKey, state: envState(env[ENV.searchKey]) },
      { source: ENV.braveKey, state: envState(env[ENV.braveKey]) },
      { source: "key file", state: file.exists ? (file.valid ? "set" : "invalid") : "absent" },
    ],
    keyFile: store.path,
    keyFileMode: file.mode,
  };
}

/** Actionable guidance shown whenever a key is needed and none is configured. */
export const MISSING_KEY_HELP =
  `No Brave Search API key is configured. Create one in the Brave Search API dashboard (${DASHBOARD_URL}), ` +
  `then either export ${ENV.searchKey}=<key> (${ENV.braveKey} also works) and restart Alisio, ` +
  "or run /brave-search:set-key <key> to store it for this user. Check with /brave-search:status.";
