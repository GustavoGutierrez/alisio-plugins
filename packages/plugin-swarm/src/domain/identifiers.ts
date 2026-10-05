/** Identifier rules (spec 4.1). Every identifier is untrusted input and validated at each boundary. */

export const projectNamePattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const taskNamePattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const rolePattern = /^[a-z][a-z0-9-]{0,23}$/;
export const taskIdPattern = /^\d{8}T\d{12}Z-[a-z0-9][a-z0-9-]{0,47}$/;
export const commitPattern = /^[0-9a-f]{10}$/;

export function validateProjectName(name: string): string {
  if (typeof name !== "string" || !projectNamePattern.test(name)) {
    throw new Error(
      "Invalid project name: use 1-48 lowercase letters, digits or hyphens, starting with a letter or digit",
    );
  }
  return name;
}

export function validateTaskName(name: string): string {
  if (typeof name !== "string" || !taskNamePattern.test(name)) {
    throw new Error(
      "Invalid task name: use 1-48 lowercase letters, digits or hyphens, starting with a letter or digit",
    );
  }
  return name;
}

export function validateRole(role: string): string {
  if (typeof role !== "string" || !rolePattern.test(role)) {
    throw new Error(
      "Invalid role: use 1-24 lowercase letters, digits or hyphens, starting with a letter",
    );
  }
  return role;
}

export function validateTaskId(taskId: string): string {
  if (typeof taskId !== "string" || !taskIdPattern.test(taskId)) {
    throw new Error("Invalid task id: expected YYYYMMDDTHHMMSSffffffZ-<slug>");
  }
  return taskId;
}

export function validateCommit(commit: string): string {
  if (typeof commit !== "string" || !commitPattern.test(commit)) {
    throw new Error("Invalid commit: expected exactly 10 lowercase hexadecimal characters");
  }
  return commit;
}

/** Derive a task slug from free-form text. May return an empty string when nothing is usable. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/** `YYYYMMDDTHHMMSSffffffZ-<slug>`; `sequence` (0-999) disambiguates ids minted in one millisecond. */
export function makeTaskId(now: Date, slug: string, sequence = 0): string {
  validateTaskName(slug);
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 999) {
    throw new Error("Invalid sequence: expected an integer from 0 to 999");
  }
  const iso = now.toISOString(); // 2026-01-02T03:04:05.678Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
  const micros = `${iso.slice(20, 23)}${String(sequence).padStart(3, "0")}`;
  return `${stamp}${micros}Z-${slug}`;
}

/** A relative path made of plain segments: no absolute, drive, backslash, empty, `.` or `..` parts. */
export function assertRelativePath(path: string): string {
  if (
    typeof path !== "string" ||
    !path ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe relative path: ${JSON.stringify(path)}`);
  }
  return path;
}
