import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { DesignFormat } from "../core/design-spec.js";
import { CardsmithError } from "../core/errors.js";

export interface WorkspaceResolveOptions {
  /** Mediated path policy from `ToolContext.resolvePath`; the result is still containment-checked. */
  resolvePath?: (path: string) => Promise<string>;
}

export interface CopyOptions {
  overwrite?: boolean;
}

export interface MoveOptions extends CopyOptions {
  deleteSource?: boolean;
  /** Destructive primitive override (defaults to `unlink`); useful to exercise delete failures. */
  removeSource?: (path: string) => Promise<void>;
}

export interface CopiedFile {
  path: string;
  bytes: number;
}

function invalidPath(target: unknown, reason: string, message: string): CardsmithError {
  return new CardsmithError("EXPORT_INVALID_PATH", message, { path: target, reason });
}

/**
 * Validate a workspace-relative target. Absolute paths (POSIX or drive-letter), NUL bytes and
 * `..` traversal are rejected before touching the filesystem; both separators are treated as
 * path separators so a target validated here is safe on every platform.
 */
export function assertWorkspaceRelative(target: unknown): string {
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) {
    throw invalidPath(
      target,
      "invalid",
      "The path must be a non-empty string relative to the workspace",
    );
  }
  if (isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) {
    throw invalidPath(
      target,
      "absolute",
      `The path must be relative to the workspace, got "${target}"`,
    );
  }
  const segments = target.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw invalidPath(target, "traversal", `The path must not contain "..", got "${target}"`);
  }
  if (segments.length === 0) {
    throw invalidPath(target, "empty", "The path must name a file inside the workspace");
  }
  return segments.join("/");
}

async function realWorkspaceRoot(workspace: string): Promise<string> {
  if (typeof workspace !== "string" || workspace.length === 0) {
    throw invalidPath(workspace, "workspace_missing", "The workspace path is empty");
  }
  try {
    return await realpath(resolve(workspace));
  } catch {
    throw invalidPath(
      workspace,
      "workspace_missing",
      `The workspace "${workspace}" does not exist`,
    );
  }
}

/**
 * Symlink-aware containment: the target itself when it exists, or its deepest existing ancestor,
 * must resolve inside the workspace root. Lexical checks alone would miss a symlink that points
 * outside the workspace.
 */
async function assertRealContainment(
  root: string,
  candidate: string,
  target: unknown,
): Promise<void> {
  let probe = candidate;
  for (;;) {
    try {
      const real = await realpath(probe);
      if (real !== root && !real.startsWith(`${root}${sep}`)) {
        throw invalidPath(target, "symlink", `The path "${String(target)}" escapes the workspace`);
      }
      return;
    } catch (error) {
      if (error instanceof CardsmithError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(probe);
      if (parent === probe) {
        throw invalidPath(target, "outside", `The path "${String(target)}" escapes the workspace`);
      }
      probe = parent;
    }
  }
}

/**
 * Resolve `target` inside the workspace and prove containment, including symlink escapes. With a
 * `resolvePath` policy the host-resolved absolute path is used and re-checked against the
 * workspace, so an approval for another directory still cannot write outside this workspace.
 */
export async function resolveInsideWorkspace(
  workspace: string,
  target: unknown,
  options: WorkspaceResolveOptions = {},
): Promise<string> {
  const relative = assertWorkspaceRelative(target);
  const root = await realWorkspaceRoot(workspace);
  let candidate = resolve(root, relative);
  if (options.resolvePath !== undefined) {
    const resolved = await options.resolvePath(relative);
    if (typeof resolved !== "string" || resolved.length === 0) {
      throw invalidPath(target, "resolve_path", "resolvePath returned an empty path");
    }
    candidate = resolve(resolved);
  }
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw invalidPath(target, "outside", `The path "${String(target)}" escapes the workspace`);
  }
  await assertRealContainment(root, candidate, target);
  return candidate;
}

/** `card-<id8>.png|jpg`, where `id8` is the first eight characters of the draft id. */
export function defaultExportName(draftId: string, format: DesignFormat): string {
  const extension = format === "jpeg" ? "jpg" : "png";
  return `card-${draftId.slice(0, 8)}.${extension}`;
}

/** Non-colliding sibling suggestion, e.g. `card-1a2b3c4d-2.png`. */
export function suggestionFor(destAbs: string): string {
  const extension = extname(destAbs);
  const stem = extension === "" ? destAbs : destAbs.slice(0, -extension.length);
  return `${stem}-2${extension}`;
}

function conflictError(destAbs: string): CardsmithError {
  return new CardsmithError(
    "EXPORT_CONFLICT",
    `"${basename(destAbs)}" already exists in the workspace`,
    { path: destAbs, suggestion: suggestionFor(destAbs) },
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic copy into the workspace: the bytes land in a temporary file in the destination directory
 * and are renamed into place. Without `overwrite` an existing destination is an `EXPORT_CONFLICT`
 * carrying the suggested free name; parent directories are created as needed.
 */
export async function copyIntoWorkspace(
  sourceFile: string,
  destAbs: string,
  options: CopyOptions = {},
): Promise<CopiedFile> {
  const overwrite = options.overwrite === true;
  if (!overwrite && (await exists(destAbs))) throw conflictError(destAbs);
  const dir = dirname(destAbs);
  await mkdir(dir, { recursive: true });
  const temporary = join(dir, `.cardsmith-${randomUUID()}.tmp`);
  try {
    await copyFile(sourceFile, temporary);
    if (!overwrite && (await exists(destAbs))) throw conflictError(destAbs);
    await rename(temporary, destAbs);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const info = await stat(destAbs);
  return { path: destAbs, bytes: info.size };
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Copy, verify both files share a sha256, and only then remove the source. A failed copy keeps
 * the source; a failed removal reports `EXPORT_DELETE_FAILED` and leaves the verified destination
 * copy in place, so the user never loses the exported file.
 */
export async function moveIntoWorkspace(
  sourceFile: string,
  destAbs: string,
  options: MoveOptions = {},
): Promise<CopiedFile> {
  const copied = await copyIntoWorkspace(
    sourceFile,
    destAbs,
    options.overwrite === undefined ? {} : { overwrite: options.overwrite },
  );
  const [sourceHash, destinationHash] = await Promise.all([
    sha256File(sourceFile),
    sha256File(destAbs),
  ]);
  if (sourceHash !== destinationHash) {
    throw new CardsmithError(
      "RENDER_FAILED",
      "The exported copy does not match the working file; the working file was kept",
      { source: sourceFile, path: destAbs },
    );
  }
  if (options.deleteSource === false) return copied;
  try {
    await (options.removeSource ?? unlink)(sourceFile);
  } catch (error) {
    throw new CardsmithError(
      "EXPORT_DELETE_FAILED",
      `The copy was saved to "${basename(destAbs)}", but the working file could not be removed`,
      {
        path: destAbs,
        source: sourceFile,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  return copied;
}
