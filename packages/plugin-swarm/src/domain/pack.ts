import { validateRole } from "./identifiers.js";

export type Isolation = "master" | "worktree";
export type Receive = "task" | "batch";
export type Propagation = "forward-only" | "back-one" | "back-all";

export const gateNames = [
  "tests-green",
  "test-first",
  "coverage",
  "crap",
  "dry",
  "mutation",
  "structure",
  "acceptance",
] as const;
export type GateName = (typeof gateNames)[number];

export interface PackRole {
  id: string;
  agent: string;
  isolation: Isolation;
  receive: Receive;
  propagation: Propagation;
  /** Earlier role that receives this role's `blocked` findings (QA rejection routing, spec 8.4). */
  rejectTo?: string;
}

export interface Thresholds {
  coverage: number;
  complexity: number;
  crap: number;
  mutation: number;
}

export interface Limits {
  maxBounces: number;
  maxAuditRounds: number;
}

export interface Pack {
  schemaVersion: 1;
  name: string;
  description: string;
  toolchain: string;
  approval?: { after: string };
  roles: PackRole[];
  parallel?: string[][];
  gates: Record<string, GateName[]>;
  thresholds: Thresholds;
  limits: Limits;
}

/** Our defaults where upstream states none (spec 8.4). Pack data overrides them. */
export const defaultThresholds: Thresholds = { coverage: 80, complexity: 6, crap: 8, mutation: 80 };
export const defaultLimits: Limits = { maxBounces: 2, maxAuditRounds: 3 };

const packNamePattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const toolchainPattern = /^[a-z][a-z0-9-]{0,31}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unknown key "${key}" in ${label}`);
  }
}

function parseRole(value: unknown, index: number): PackRole {
  if (!isRecord(value)) throw new Error(`Role ${index + 1} must be an object`);
  onlyKeys(
    value,
    ["id", "agent", "isolation", "receive", "propagation", "rejectTo"],
    `role ${index + 1}`,
  );
  const id = validateRole(value.id as string);
  const agent = validateRole(value.agent as string);
  if (value.isolation !== "master" && value.isolation !== "worktree") {
    throw new Error(`Role ${id}: isolation must be "master" or "worktree"`);
  }
  if (value.receive !== "task" && value.receive !== "batch") {
    throw new Error(`Role ${id}: receive must be "task" or "batch"`);
  }
  if (
    value.propagation !== "forward-only" &&
    value.propagation !== "back-one" &&
    value.propagation !== "back-all"
  ) {
    throw new Error(`Role ${id}: propagation must be "forward-only", "back-one" or "back-all"`);
  }
  const rejectTo =
    value.rejectTo === undefined ? undefined : validateRole(value.rejectTo as string);
  return {
    id,
    agent,
    isolation: value.isolation,
    receive: value.receive,
    propagation: value.propagation,
    ...(rejectTo ? { rejectTo } : {}),
  };
}

function parseThresholds(value: unknown): Thresholds {
  if (value === undefined) return { ...defaultThresholds };
  if (!isRecord(value)) throw new Error("Invalid threshold block: expected an object");
  onlyKeys(value, Object.keys(defaultThresholds), "thresholds");
  const result: Thresholds = { ...defaultThresholds };
  for (const key of Object.keys(defaultThresholds) as Array<keyof Thresholds>) {
    const raw = value[key];
    if (raw === undefined) continue;
    const percent = key === "coverage" || key === "mutation";
    if (
      typeof raw !== "number" ||
      !Number.isFinite(raw) ||
      raw < 0 ||
      (percent && raw > 100) ||
      (!percent && raw === 0)
    ) {
      throw new Error(`Invalid threshold ${key}: ${percent ? "0-100" : "a positive number"}`);
    }
    result[key] = raw;
  }
  return result;
}

function parseLimits(value: unknown): Limits {
  if (value === undefined) return { ...defaultLimits };
  if (!isRecord(value)) throw new Error("Invalid limit block: expected an object");
  onlyKeys(value, Object.keys(defaultLimits), "limits");
  const result: Limits = { ...defaultLimits };
  for (const key of Object.keys(defaultLimits) as Array<keyof Limits>) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 20) {
      throw new Error(`Invalid limit ${key}: expected an integer from 0 to 20`);
    }
    result[key] = raw;
  }
  return result;
}

export function parsePack(input: unknown): Pack {
  if (!isRecord(input)) throw new Error("A pack must be a JSON object");
  onlyKeys(
    input,
    [
      "schemaVersion",
      "name",
      "description",
      "toolchain",
      "approval",
      "roles",
      "parallel",
      "gates",
      "thresholds",
      "limits",
    ],
    "pack",
  );
  if (input.schemaVersion !== 1) throw new Error("Unsupported pack schemaVersion (expected 1)");
  if (typeof input.name !== "string" || !packNamePattern.test(input.name)) {
    throw new Error("Invalid pack name: use 1-48 lowercase letters, digits or hyphens");
  }
  if (typeof input.description !== "string" || !input.description.trim()) {
    throw new Error("A pack needs a description");
  }
  if (typeof input.toolchain !== "string" || !toolchainPattern.test(input.toolchain)) {
    throw new Error("Invalid toolchain id in pack");
  }
  if (!Array.isArray(input.roles) || input.roles.length === 0) {
    throw new Error("A pack needs at least one role");
  }
  const roles = input.roles.map(parseRole);
  const ids = roles.map((role) => role.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate role id in pack");
  const masters = roles.filter((role) => role.isolation === "master");
  if (masters.length !== 1) throw new Error("A pack needs exactly one master role");
  if (roles[0]?.isolation !== "master") {
    throw new Error("The master role must be the first role (the pipeline entry)");
  }

  for (const [index, entry] of roles.entries()) {
    const target = entry.rejectTo === undefined ? 0 : ids.indexOf(entry.rejectTo);
    if (entry.rejectTo !== undefined && (target < 0 || target >= index)) {
      throw new Error(`Role ${entry.id}: rejectTo must name an earlier role of the pack`);
    }
  }

  let approval: Pack["approval"];
  if (input.approval !== undefined) {
    if (!isRecord(input.approval)) throw new Error("Invalid approval block");
    onlyKeys(input.approval, ["after"], "approval");
    const after = input.approval.after;
    const position = typeof after === "string" ? ids.indexOf(after) : -1;
    if (position < 0 || position === ids.length - 1) {
      throw new Error("Invalid approval: `after` must name a role that is not the last role");
    }
    approval = { after: after as string };
  }

  const gates: Record<string, GateName[]> = {};
  if (input.gates !== undefined) {
    if (!isRecord(input.gates)) throw new Error("Invalid gates block");
    for (const [roleId, list] of Object.entries(input.gates)) {
      if (!ids.includes(roleId)) throw new Error(`Gates reference unknown role "${roleId}"`);
      if (!Array.isArray(list)) throw new Error(`Gates for ${roleId} must be an array`);
      gates[roleId] = list.map((gate) => {
        if (!(gateNames as readonly string[]).includes(gate as string)) {
          throw new Error(`Unknown gate "${String(gate)}" for ${roleId}`);
        }
        return gate as GateName;
      });
    }
  }

  let parallel: string[][] | undefined;
  if (input.parallel !== undefined) {
    if (!Array.isArray(input.parallel)) throw new Error("Invalid parallel stages");
    parallel = input.parallel.map((stage) => {
      if (!Array.isArray(stage) || stage.length < 2 || !stage.every((id) => ids.includes(id))) {
        throw new Error("Invalid parallel stage: list two or more roles that exist in the pack");
      }
      const positions = (stage as string[]).map((id) => ids.indexOf(id));
      const sorted = [...positions].sort((a, b) => a - b);
      const contiguous = sorted.every(
        (position, i) => i === 0 || position === (sorted[i - 1] as number) + 1,
      );
      if (!contiguous || positions.some((p, i) => p !== sorted[i])) {
        throw new Error("Invalid parallel stage: roles must be adjacent and in pipeline order");
      }
      if ((stage as string[]).includes(ids[ids.length - 1] as string)) {
        throw new Error("Invalid parallel stage: it cannot contain the last role");
      }
      if ((stage as string[]).includes(ids[0] as string)) {
        throw new Error("Invalid parallel stage: it cannot contain the master role");
      }
      return stage as string[];
    });
    if (approval && parallel.some((stage) => stage.includes(approval?.after as string))) {
      throw new Error("Invalid approval: the gate cannot sit inside a parallel stage");
    }
  }

  return {
    schemaVersion: 1,
    name: input.name,
    description: input.description,
    toolchain: input.toolchain,
    ...(approval ? { approval } : {}),
    roles,
    ...(parallel ? { parallel } : {}),
    gates,
    thresholds: parseThresholds(input.thresholds),
    limits: parseLimits(input.limits),
  };
}

export const roleIds = (pack: Pack): string[] => pack.roles.map((role) => role.id);
export const findRole = (pack: Pack, id: string): PackRole | undefined =>
  pack.roles.find((role) => role.id === id);
