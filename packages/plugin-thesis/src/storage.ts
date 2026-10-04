import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  gateNames,
  type HumanGate,
  type IntakeState,
  idPatterns,
  type PendingQuestions,
  phases,
  sectionStatuses,
  type ThesisState,
} from "./types.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isIso = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
const isCount = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

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

/** Validate the workspace-relative thesis root (default `thesis`). */
export function validateRootName(root: string): string {
  assertRelativePath(root);
  const parts = root.split("/");
  if (
    parts.length > 4 ||
    parts.some(
      (part) => !rootSegment.test(part) || reservedSegments.has(part) || part.endsWith("."),
    )
  ) {
    throw new Error(`Invalid thesis root: ${root}`);
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
        throw new Error("Path escapes the thesis workspace");
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

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
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

/** One-line JSON with deeply sorted keys (JSONL records). */
export function canonicalLine(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function thesisStateDirectory(workspace: string): string {
  return join(resolve(workspace), ".alisio", "thesis");
}

export function statePath(workspace: string): string {
  return join(thesisStateDirectory(workspace), "state.json");
}

export function defaultState(root = "thesis"): ThesisState {
  return {
    schemaVersion: 1,
    root: validateRootName(root),
    phase: "intake",
    humanGates: {
      A: { status: "pending" },
      B: { status: "pending" },
      OUTLINE: { status: "pending" },
      C: { status: "pending" },
    },
    sections: {},
    intake: { answers: {}, completedRounds: [] },
    counters: { evidence: 0, claim: 0, finding: 0 },
  };
}

function fail(reason?: string): never {
  throw new Error(`Invalid thesis state${reason ? `: ${reason}` : ""}`);
}

function validatePending(value: unknown): PendingQuestions {
  if (!isRecord(value) || !Number.isInteger(value.round) || !isIso(value.createdAt)) {
    return fail("pendingQuestions");
  }
  const questions = value.questions;
  if (
    !Array.isArray(questions) ||
    questions.length < 1 ||
    questions.length > 4 ||
    !questions.every(
      (question) =>
        isRecord(question) &&
        typeof question.id === "string" &&
        typeof question.question === "string" &&
        Array.isArray(question.options) &&
        question.options.length >= 2 &&
        question.options.length <= 4,
    )
  ) {
    return fail("pendingQuestions.questions");
  }
  return value as unknown as PendingQuestions;
}

function validateIntake(value: unknown): IntakeState {
  if (value === undefined) return { answers: {}, completedRounds: [] };
  if (
    !isRecord(value) ||
    !isRecord(value.answers) ||
    !Object.values(value.answers).every((answer) => typeof answer === "string") ||
    !Array.isArray(value.completedRounds) ||
    !value.completedRounds.every((round) => Number.isInteger(round) && round >= 1 && round <= 5) ||
    (value.languageHint !== undefined &&
      (typeof value.languageHint !== "string" || value.languageHint.length > 35))
  ) {
    return fail("intake");
  }
  return value as unknown as IntakeState;
}

/** Validates an unknown value and returns it normalized (additive fields filled in). */
export function validateState(value: unknown): ThesisState {
  if (!isRecord(value) || value.schemaVersion !== 1) return fail("schemaVersion");
  if (typeof value.root !== "string") return fail("root");
  try {
    validateRootName(value.root);
  } catch {
    return fail("root");
  }
  if (!phases.includes(value.phase as ThesisState["phase"])) return fail("phase");

  const fresh = defaultState(value.root).humanGates;
  const gatesInput = value.humanGates;
  if (!isRecord(gatesInput)) return fail("humanGates");
  const humanGates = { ...fresh };
  for (const name of gateNames) {
    const gate = gatesInput[name];
    if (gate === undefined) continue;
    if (
      !isRecord(gate) ||
      (gate.status !== "pending" && gate.status !== "approved") ||
      (gate.at !== undefined && !isIso(gate.at)) ||
      (gate.notes !== undefined && typeof gate.notes !== "string")
    ) {
      return fail(`humanGates.${name}`);
    }
    humanGates[name] = gate as unknown as HumanGate;
  }

  const sections = value.sections;
  if (!isRecord(sections)) return fail("sections");
  for (const [id, section] of Object.entries(sections)) {
    if (
      !idPatterns.section.test(id) ||
      !isRecord(section) ||
      !sectionStatuses.includes(section.status as (typeof sectionStatuses)[number]) ||
      (section.updatedAt !== undefined && !isIso(section.updatedAt)) ||
      (section.dossierAt !== undefined && !isIso(section.dossierAt)) ||
      (section.title !== undefined && typeof section.title !== "string") ||
      (section.dependsOn !== undefined &&
        (!Array.isArray(section.dependsOn) ||
          !section.dependsOn.every(
            (entry) => typeof entry === "string" && idPatterns.section.test(entry),
          ))) ||
      (section.contextualApprovals !== undefined &&
        (!Array.isArray(section.contextualApprovals) ||
          !section.contextualApprovals.every(
            (entry) => typeof entry === "string" && idPatterns.evidence.test(entry),
          )))
    ) {
      return fail(`sections.${id}`);
    }
  }

  const counters = value.counters;
  if (
    !isRecord(counters) ||
    !isCount(counters.evidence) ||
    !isCount(counters.claim) ||
    !isCount(counters.finding)
  ) {
    return fail("counters");
  }

  const lastCheck = value.lastCheck;
  if (
    lastCheck !== undefined &&
    (!isRecord(lastCheck) ||
      !isIso(lastCheck.at) ||
      !isCount(lastCheck.errors) ||
      !isCount(lastCheck.warnings))
  ) {
    return fail("lastCheck");
  }
  const lastBuild = value.lastBuild;
  if (
    lastBuild !== undefined &&
    (!isRecord(lastBuild) ||
      !isIso(lastBuild.at) ||
      !["typst-cli", "typst-node", "chrome"].includes(lastBuild.engine as string) ||
      typeof lastBuild.pdf !== "string" ||
      !isCount(lastBuild.ms))
  ) {
    return fail("lastBuild");
  }

  const resolutions = value.ethicsResolutions;
  if (
    resolutions !== undefined &&
    (!isRecord(resolutions) ||
      !Object.entries(resolutions).every(
        ([id, entry]) =>
          /^ETH-[A-Z_]+-\d{2}$/.test(id) &&
          isRecord(entry) &&
          typeof entry.text === "string" &&
          isIso(entry.at),
      ))
  ) {
    return fail("ethicsResolutions");
  }
  const approvedStyles = value.styles;
  if (
    approvedStyles !== undefined &&
    (!isRecord(approvedStyles) ||
      !Object.values(approvedStyles).every((entry) => isRecord(entry) && isIso(entry.approvedAt)))
  ) {
    return fail("styles");
  }
  const review = value.lastReview;
  if (
    review !== undefined &&
    (!isRecord(review) ||
      !isIso(review.at) ||
      typeof review.scope !== "string" ||
      !Array.isArray(review.sections) ||
      !isCount(review.findings))
  ) {
    return fail("lastReview");
  }
  const final = value.finalBuild;
  if (
    final !== undefined &&
    (!isRecord(final) ||
      !isIso(final.at) ||
      typeof final.pdf !== "string" ||
      typeof final.sha256 !== "string")
  ) {
    return fail("finalBuild");
  }
  if (value.submittedAt !== undefined && !isIso(value.submittedAt)) return fail("submittedAt");

  for (const key of ["protocolAt", "outlineAt"] as const) {
    if (value[key] !== undefined && !isIso(value[key])) return fail(key);
  }

  const state: ThesisState = {
    ...(value as unknown as ThesisState),
    humanGates,
    intake: validateIntake(value.intake),
  };
  if (value.pendingQuestions !== undefined)
    state.pendingQuestions = validatePending(value.pendingQuestions);
  return state;
}

export async function readState(workspace: string): Promise<ThesisState | undefined> {
  let raw: string;
  try {
    raw = await readFile(statePath(workspace), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid thesis state JSON");
  }
  return validateState(value);
}

export async function writeState(workspace: string, state: ThesisState): Promise<void> {
  validateState(state);
  await atomicWrite(statePath(workspace), canonicalJson(state));
}
