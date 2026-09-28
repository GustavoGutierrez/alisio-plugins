import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type ChangeState, phases, type WorkUnit } from "./types.js";

export const changeNamePattern = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function validateChangeName(name: string): string {
  if (!changeNamePattern.test(name)) {
    throw new Error(
      "Change name must use 1-48 lowercase letters, digits, or hyphens and start with a letter or digit",
    );
  }
  return name;
}

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
  const normalized = path.split("/");
  if (normalized.some((part) => part === "" || part === "." || part === ".."))
    throw new Error(`Unsafe relative path: ${path}`);
  return path;
}

export function wayfinderRoot(workspace: string): string {
  return join(resolve(workspace), ".alisio", "wayfinder");
}

export function changeDirectory(workspace: string, name: string): string {
  validateChangeName(name);
  const root = join(wayfinderRoot(workspace), "changes");
  const candidate = resolve(root, name);
  if (!candidate.startsWith(`${resolve(root)}${sep}`))
    throw new Error("Change path escapes Wayfinder root");
  return candidate;
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    const { rm } = await import("node:fs/promises");
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeState(workspace: string, state: ChangeState): Promise<void> {
  await atomicWrite(
    join(changeDirectory(workspace, state.name), "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export async function readState(workspace: string, name: string): Promise<ChangeState> {
  const raw = await readFile(join(changeDirectory(workspace, name), "state.json"), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid Wayfinder state JSON for ${name}`);
  }
  return validateState(value, name);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const isIso = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

function validUnit(value: unknown): value is WorkUnit {
  if (!isRecord(value)) return false;
  const base =
    typeof value.id === "string" &&
    /^UNIT-\d{3}$/.test(value.id) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    typeof value.goal === "string" &&
    value.goal.length > 0 &&
    isStrings(value.requirements) &&
    isStrings(value.paths) &&
    isStrings(value.checks) &&
    (value.status === "pending" || value.status === "completed");
  if (!base) return false;
  if (value.status === "pending")
    return value.changedPaths === undefined && value.evidence === undefined;
  return (
    isStrings(value.changedPaths) &&
    value.changedPaths.length > 0 &&
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.every(
      (item) =>
        isRecord(item) &&
        typeof item.command === "string" &&
        item.command.length > 0 &&
        item.status === "passed" &&
        typeof item.summary === "string" &&
        item.summary.length > 0,
    )
  );
}

export function validateState(value: unknown, expectedName?: string): ChangeState {
  if (!isRecord(value)) throw new Error("Wayfinder state must be an object");
  const units = value.units;
  const verification = value.verification;
  const validVerification =
    verification === undefined ||
    (isRecord(verification) &&
      typeof verification.passed === "boolean" &&
      typeof verification.summary === "string" &&
      verification.summary.length > 0 &&
      isStrings(verification.blockers) &&
      isIso(verification.checkedAt));
  if (
    value.schemaVersion !== 2 ||
    typeof value.name !== "string" ||
    !changeNamePattern.test(value.name) ||
    (expectedName !== undefined && value.name !== expectedName) ||
    typeof value.intent !== "string" ||
    !value.intent.trim() ||
    !phases.includes(value.phase as ChangeState["phase"]) ||
    !isIso(value.createdAt) ||
    !isIso(value.updatedAt) ||
    typeof value.proposalApproved !== "boolean" ||
    typeof value.planApproved !== "boolean" ||
    !isStrings(value.requirementIds) ||
    new Set(value.requirementIds).size !== value.requirementIds.length ||
    !Array.isArray(units) ||
    !units.every(validUnit) ||
    new Set(units.map((unit) => unit.id)).size !== units.length ||
    !Number.isInteger(value.remediationCount) ||
    (value.remediationCount as number) < 0 ||
    (value.remediationCount as number) > 2 ||
    !validVerification
  ) {
    throw new Error(`Invalid Wayfinder state${expectedName ? ` for ${expectedName}` : ""}`);
  }
  return value as unknown as ChangeState;
}

export async function readArtifact(workspace: string, name: string, file: string): Promise<string> {
  assertRelativePath(file);
  return readFile(join(changeDirectory(workspace, name), file), "utf8");
}

export async function writeArtifact(
  workspace: string,
  name: string,
  file: string,
  content: string,
): Promise<void> {
  assertRelativePath(file);
  await atomicWrite(
    join(changeDirectory(workspace, name), file),
    content.endsWith("\n") ? content : `${content}\n`,
  );
}

export async function listChanges(workspace: string): Promise<string[]> {
  try {
    return (await readdir(join(wayfinderRoot(workspace), "changes"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && changeNamePattern.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function archiveChange(workspace: string, state: ChangeState): Promise<string> {
  const source = changeDirectory(workspace, state.name);
  const stamp = new Date().toISOString().slice(0, 10);
  const destination = join(wayfinderRoot(workspace), "archive", `${stamp}-${state.name}`);
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  try {
    await atomicWrite(join(destination, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  } catch (error) {
    await rename(destination, source);
    throw error;
  }
  return destination;
}
