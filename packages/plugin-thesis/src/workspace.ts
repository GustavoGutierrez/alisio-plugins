import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type LoadedProject, type LoadProjectOptions, loadProject } from "./checks/index.js";
import { atomicWrite, canonicalJson, ensureInside, validateRootName } from "./storage.js";
import type { CheckReport } from "./types.js";

/** Directories of the workspace layout (spec section 4.3). */
export const treeDirectories = [
  "research",
  "outline",
  "evidence/dossiers",
  "claims",
  "chapters/annexes",
  "figures/charts",
  "figures/diagrams",
  "figures/images",
  "data",
  "bibliography",
  "styles/fixtures",
  "policy",
  "reviews",
  "build",
] as const;

/** Resolve the absolute thesis root and verify it stays inside the workspace. */
export async function thesisRootPath(workspace: string, root: string): Promise<string> {
  validateRootName(root);
  const absolute = resolve(workspace, root);
  await ensureInside(workspace, absolute);
  return absolute;
}

/** Create the workspace tree. Idempotent; never overwrites an existing .gitignore. */
export async function createWorkspaceTree(workspace: string, root: string): Promise<string> {
  const base = await thesisRootPath(workspace, root);
  await mkdir(base, { recursive: true, mode: 0o700 });
  for (const directory of treeDirectories) {
    await mkdir(join(base, directory), { recursive: true, mode: 0o700 });
    if (directory !== "build") {
      const keep = join(base, directory, ".gitkeep");
      try {
        await readFile(keep);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Only keep empty-directory markers where the directory has no content yet.
        await atomicWrite(keep, "");
      }
    }
  }
  const ignore = join(base, ".gitignore");
  try {
    await readFile(ignore);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(ignore, "build/\n");
  }
  return base;
}

/** Re-resolve the compliance profile, persist it, and reload the project. */
export async function refreshProject(
  base: string,
  options: LoadProjectOptions = {},
): Promise<LoadedProject> {
  const first = await loadProject(base, options);
  if (first.profile) {
    await atomicWrite(join(base, "compliance-profile.json"), canonicalJson(first.profile));
    return loadProject(base, options);
  }
  return first;
}

export async function writeCheckReport(base: string, report: CheckReport): Promise<void> {
  await atomicWrite(join(base, "build", "check-report.json"), canonicalJson(report));
}
