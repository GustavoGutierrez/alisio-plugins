import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { SemanticPluginError } from "../errors.js";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 500;

const outside = (): never => {
  throw new SemanticPluginError("path_outside_workspace");
};

/**
 * Resolves a frame-supplied relative path inside the workspace (§7.2): absolute paths and `..`
 * are rejected, and the real path (symlinks resolved) must stay under the real workspace root.
 */
export async function resolveInside(root: string, path: string): Promise<string> {
  if (typeof path !== "string" || path.includes("\0")) outside();
  if (isAbsolute(path) || win32.isAbsolute(path)) outside();
  if (path.split(/[\\/]+/).some((part) => part === "..")) outside();
  const realRoot = await realpath(root).catch(() => outside());
  const target = resolve(realRoot, path);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new SemanticPluginError("not_found");
  }
  const rel = relative(realRoot, real);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep)[0] === ".."))
    outside();
  return real;
}

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "file" | "dir";
  bytes: number;
}

/** Visible entries of a workspace directory: folders first, then files, at most 500. */
export async function listDirectory(root: string, dir = ""): Promise<WorkspaceEntry[]> {
  const real = await resolveInside(root, dir || ".");
  const realRoot = await realpath(root);
  const entries: WorkspaceEntry[] = [];
  for (const entry of await readdir(real, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(real, entry.name);
    const info = await stat(full).catch(() => undefined);
    if (!info) continue;
    const resolved = await realpath(full).catch(() => undefined);
    if (!resolved || relative(realRoot, resolved).startsWith("..")) continue;
    const path = relative(realRoot, full).split(sep).join("/");
    if (info.isDirectory()) entries.push({ name: entry.name, path, kind: "dir", bytes: 0 });
    else if (info.isFile())
      entries.push({ name: entry.name, path, kind: "file", bytes: info.size });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
  );
}

/** Reads a workspace file after containment and size checks. */
export async function readInside(root: string, path: string): Promise<Buffer> {
  const real = await resolveInside(root, path);
  const handle = await open(real, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new SemanticPluginError("not_found");
    if (info.size > MAX_FILE_BYTES) throw new SemanticPluginError("file_too_large");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
