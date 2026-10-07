import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { isRecord, stateFromRecord } from "./schemas.js";
import type { EvaluaState } from "./types.js";

export const STATE_SCHEMA_VERSION = 1;

export function assertRelativePath(path: string): string {
  if (
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new Error(`Unsafe relative path: ${path}`);
  }
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe relative path: ${path}`);
  }
  return path;
}

const rootSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const reservedSegments = new Set([".alisio", ".git", "node_modules"]);

/** Validate the workspace-relative evalua root (default `evalua`). */
export function validateRootName(root: string): string {
  assertRelativePath(root);
  const parts = root.split("/");
  if (
    parts.length > 4 ||
    parts.some(
      (part) => !rootSegment.test(part) || reservedSegments.has(part) || part.endsWith("."),
    )
  ) {
    throw new Error(`Invalid evalua root: ${root}`);
  }
  return root;
}

/** Lexically resolve a relative path under `base`; throws when it would leave it. */
export function resolveInside(base: string, relative: string): string {
  assertRelativePath(relative);
  const root = resolve(base);
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes the base directory: ${relative}`);
  }
  return candidate;
}

/** Symlink-aware containment: the nearest existing ancestor must resolve inside `base`. */
export async function ensureInside(base: string, absolute: string): Promise<void> {
  const root = await realpath(resolve(base));
  let probe = resolve(absolute);
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== root && !real.startsWith(`${root}${sep}`)) {
        throw new Error("Path escapes the evalua workspace");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}

/** Write through a `wx` temporary file and `rename`, so readers never see a partial file. */
export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: mode & 0o044 ? 0o755 : 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])]),
    );
  }
  return value;
}

/** JSON with deeply sorted keys, two-space indent and a trailing newline (stable diffs). */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function stateDirectory(workspace: string): string {
  return join(resolve(workspace), ".alisio", "evalua");
}

export function stateFile(workspace: string): string {
  return join(stateDirectory(workspace), "state.json");
}

export function emptyState(root: string, now: string): EvaluaState {
  return {
    schemaVersion: 1,
    root: validateRootName(root),
    activeExamId: null,
    lastExamNumber: 0,
    exams: {},
    createdAt: now,
    updatedAt: now,
  };
}

/** Tolerant reader: unknown fields are dropped, missing ones defaulted, unknown versions refused. */
export function validateState(value: unknown): EvaluaState {
  if (!isRecord(value)) throw new Error("Evalua state.json must be a JSON object");
  if (value.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(
      `Evalua state.json uses schemaVersion ${String(value.schemaVersion)}, but this plugin supports ${STATE_SCHEMA_VERSION}. Upgrade @alisio/plugin-evalua (or restore the file) and try again.`,
    );
  }
  if (typeof value.root !== "string") throw new Error("Evalua state.json is missing its root");
  return stateFromRecord(value, validateRootName(value.root));
}

export async function readState(workspace: string): Promise<EvaluaState | undefined> {
  let text: string;
  try {
    text = await readFile(stateFile(workspace), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Evalua state.json is not valid JSON; fix or remove it and run /evalua:init");
  }
  return validateState(parsed);
}

export async function writeState(workspace: string, state: EvaluaState): Promise<void> {
  await atomicWrite(stateFile(workspace), canonicalJson(state), 0o600);
}
