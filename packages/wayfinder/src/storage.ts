import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type ChangeState, type NormalizedChangeState, phases, type WorkUnit } from "./types.js";

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

/**
 * Single normalization point for additively optional fields. Older `schemaVersion: 2` states predate
 * the mutation fields, so every loaded state gets `mutationRemediationCount: 0` when it is absent.
 * `mutation` itself stays optional and is never synthesized.
 */
function normalizeState(state: ChangeState): NormalizedChangeState {
  return { ...state, mutationRemediationCount: state.mutationRemediationCount ?? 0 };
}

export async function readState(workspace: string, name: string): Promise<NormalizedChangeState> {
  const raw = await readFile(join(changeDirectory(workspace, name), "state.json"), "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid Wayfinder state JSON for ${name}`);
  }
  return normalizeState(validateState(value, name));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const isIso = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const mutationStacks = ["javascript", "rust", "python", "go", "java", "unknown"] as const;
const mutationModes = ["changed", "full"] as const;

function validSurvivor(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.file !== "string" ||
    !value.file.length ||
    typeof value.description !== "string" ||
    !value.description.length ||
    typeof value.equivalent !== "boolean" ||
    typeof value.justification !== "string"
  ) {
    return false;
  }
  if (value.line !== undefined && !isPositiveInt(value.line)) return false;
  if (value.equivalent && !value.justification.length) return false;
  return true;
}

function validMutation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const decision = value.decision;
  if (decision !== undefined) {
    if (!isRecord(decision)) return false;
    if (
      (decision.decision !== "run" && decision.decision !== "skip") ||
      !mutationModes.includes(decision.mode as (typeof mutationModes)[number]) ||
      typeof decision.reason !== "string" ||
      !decision.reason.trim() ||
      !isIso(decision.decidedAt) ||
      !mutationStacks.includes(decision.stack as (typeof mutationStacks)[number]) ||
      (decision.source !== "recommended" && decision.source !== "manual") ||
      (decision.tool !== undefined && (typeof decision.tool !== "string" || !decision.tool.length))
    ) {
      return false;
    }
  }
  const run = value.run;
  if (run !== undefined) {
    if (!isRecord(run)) return false;
    if (
      typeof run.tool !== "string" ||
      !run.tool.length ||
      !mutationStacks.includes(run.stack as (typeof mutationStacks)[number]) ||
      !mutationModes.includes(run.mode as (typeof mutationModes)[number]) ||
      (run.scopeSupport !== undefined &&
        run.scopeSupport !== "paths" &&
        run.scopeSupport !== "none") ||
      (run.concurrencyApplied !== undefined && typeof run.concurrencyApplied !== "boolean") ||
      !isStrings(run.scope) ||
      typeof run.command !== "string" ||
      !Array.isArray(run.survivors) ||
      !run.survivors.every(validSurvivor) ||
      !Number.isInteger(run.failingSurvivors) ||
      (run.failingSurvivors as number) < 0 ||
      !Number.isInteger(run.equivalentSurvivors) ||
      (run.equivalentSurvivors as number) < 0 ||
      (run.mutationScore !== undefined && typeof run.mutationScore !== "number") ||
      typeof run.summary !== "string" ||
      !run.summary.length ||
      !isIso(run.ranAt) ||
      (run.truncated !== undefined && typeof run.truncated !== "boolean") ||
      (run.unavailableReason !== undefined &&
        (typeof run.unavailableReason !== "string" || !run.unavailableReason.length))
    ) {
      return false;
    }
  }
  const targeted = value.targeted;
  if (targeted !== undefined) {
    if (!isRecord(targeted)) return false;
    if (
      !isStrings(targeted.files) ||
      !isStrings(targeted.requirementIds) ||
      !isPositiveInt(targeted.attempt)
    ) {
      return false;
    }
  }
  return true;
}

function validTdd(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.decision === "strict" || value.decision === "off") &&
    typeof value.reason === "string" &&
    Boolean(value.reason.trim()) &&
    isIso(value.decidedAt) &&
    (value.source === "recommended" || value.source === "manual")
  );
}

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
    (value.kind === undefined ||
      value.kind === "implementation" ||
      value.kind === "test-strengthening") &&
    (value.tddExempt === undefined || typeof value.tddExempt === "boolean") &&
    (value.tddExemptReason === undefined ||
      (typeof value.tddExemptReason === "string" && value.tddExemptReason.trim().length > 0)) &&
    (value.tddExempt !== true ||
      (typeof value.tddExemptReason === "string" && value.tddExemptReason.trim().length > 0)) &&
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
  const mutation = value.mutation;
  const validMutationBlock = mutation === undefined || validMutation(mutation);
  const tdd = value.tdd;
  const validTddBlock = tdd === undefined || validTdd(tdd);
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
    (value.mutationRemediationCount !== undefined &&
      (!Number.isInteger(value.mutationRemediationCount) ||
        (value.mutationRemediationCount as number) < 0 ||
        (value.mutationRemediationCount as number) > 2)) ||
    !validVerification ||
    !validMutationBlock ||
    !validTddBlock
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
