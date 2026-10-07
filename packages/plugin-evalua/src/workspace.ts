import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensureInside, validateRootName } from "./storage.js";

export { validateRootName };

/** Resolve the absolute evalua root and verify (through symlinks) that it stays in the workspace. */
export async function evaluaRootPath(workspace: string, root: string): Promise<string> {
  validateRootName(root);
  const absolute = resolve(workspace, root);
  await ensureInside(workspace, absolute);
  return absolute;
}

const slugPattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const folderPattern = /^(\d{2,3})-([a-z0-9][a-z0-9-]{0,47})$/;
const MAX_SLUG = 48;

export function validateSlug(slug: string): string {
  if (!slugPattern.test(slug)) {
    throw new Error(
      `Invalid exam slug "${slug}": use 1 to 48 lowercase letters, digits or hyphens`,
    );
  }
  return slug;
}

export function validateExamFolderName(name: string): string {
  if (!folderPattern.test(name)) {
    throw new Error(`EVL-EXM-005: invalid exam folder name "${name}" (expected NN-slug)`);
  }
  return name;
}

const ascii = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Slug proposed from the theme and grade: ASCII, lowercase, hyphens, at most 48 characters. */
export function slugify(theme: string, grade: string): string {
  const gradePart = ascii(grade);
  const room = gradePart ? MAX_SLUG - gradePart.length - 1 : MAX_SLUG;
  const themePart = ascii(theme).slice(0, Math.max(0, room)).replace(/-+$/, "");
  const slug = [themePart, gradePart].filter(Boolean).join("-").slice(0, MAX_SLUG);
  return slug.replace(/-+$/, "") || "examen";
}

export function formatExamNumber(number: number): string {
  return String(number).padStart(2, "0");
}

export function examFolderName(number: number, slug: string): string {
  return `${formatExamNumber(number)}-${slug}`;
}

/** Highest existing `NN-*` number (or the recorded floor) plus one; gaps are never refilled. */
export function nextExamNumber(names: readonly string[], floor: number): number {
  let highest = floor;
  for (const name of names) {
    const match = folderPattern.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/** Exam folders on disk (`NN-slug` directories under `<root>/exams`), sorted. */
export async function listExamFolders(root: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, "exams"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && folderPattern.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export interface AllocatedFolder {
  number: number;
  name: string;
  path: string;
}

/**
 * Create the next numbered exam folder. Call it only after Gate A: no folder exists before the
 * teacher approves the spec. `floor` is the highest number ever allocated, so a number freed by
 * deleting a folder is never handed out again.
 */
export async function allocateExamFolder(
  workspace: string,
  root: string,
  slug: string,
  floor: number,
): Promise<AllocatedFolder> {
  validateSlug(slug);
  const exams = join(root, "exams");
  await ensureInside(workspace, exams);
  await mkdir(exams, { recursive: true, mode: 0o755 });
  await ensureInside(workspace, exams);
  let lowest = floor;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const number = nextExamNumber(await listExamFolders(root), lowest);
    const name = examFolderName(number, slug);
    const path = join(exams, name);
    try {
      await mkdir(path, { mode: 0o755 });
      return { number, name, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      lowest = number;
    }
  }
  throw new Error("Could not allocate an exam folder number; try again");
}
