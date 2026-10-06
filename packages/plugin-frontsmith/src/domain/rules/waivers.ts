import { matchAny } from "../glob.js";

export interface Waiver {
  id: string;
  ruleId: string;
  paths: string[];
  reason: string;
  approvedBy: "human";
  createdAt: string;
  /** `YYYY-MM-DD`, inclusive. */
  expires: string;
}

export interface WaiverError {
  pointer: string;
  message: string;
}

export type WaiverValidation =
  | { ok: true; waivers: Waiver[] }
  | { ok: false; errors: WaiverError[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const KEYS = ["id", "ruleId", "paths", "reason", "approvedBy", "createdAt", "expires"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate `.frontsmith/waivers.json`: only the human `waive` command writes it. */
export function validateWaivers(raw: unknown): WaiverValidation {
  const errors: WaiverError[] = [];
  const fail = (pointer: string, message: string): void => {
    errors.push({ pointer, message });
  };
  if (!isRecord(raw))
    return { ok: false, errors: [{ pointer: "", message: "waivers file must be an object" }] };
  for (const key of Object.keys(raw))
    if (key !== "schemaVersion" && key !== "waivers") fail(`/${key}`, "unknown key");
  if (raw.schemaVersion !== 1) fail("/schemaVersion", "schemaVersion must be 1");
  if (!Array.isArray(raw.waivers)) fail("/waivers", "waivers must be an array");
  else {
    const ids = new Set<string>();
    raw.waivers.forEach((waiver: unknown, index: number) => {
      const at = `/waivers/${index}`;
      if (!isRecord(waiver)) {
        fail(at, "waiver must be an object");
        return;
      }
      for (const key of Object.keys(waiver))
        if (!KEYS.includes(key)) fail(`${at}/${key}`, "unknown key");
      if (typeof waiver.id !== "string" || !/^W-\d{3}$/.test(waiver.id))
        fail(`${at}/id`, "id must look like W-001");
      else if (ids.has(waiver.id)) fail(`${at}/id`, "duplicate waiver id");
      else ids.add(waiver.id);
      if (typeof waiver.ruleId !== "string" || waiver.ruleId.length === 0)
        fail(`${at}/ruleId`, "ruleId is required");
      if (
        !Array.isArray(waiver.paths) ||
        waiver.paths.length === 0 ||
        !waiver.paths.every((p) => typeof p === "string")
      )
        fail(`${at}/paths`, "paths must be a non-empty array of globs");
      if (typeof waiver.reason !== "string" || waiver.reason.length === 0)
        fail(`${at}/reason`, "reason is required");
      if (waiver.approvedBy !== "human") fail(`${at}/approvedBy`, "approvedBy must be human");
      if (typeof waiver.createdAt !== "string") fail(`${at}/createdAt`, "createdAt is required");
      if (typeof waiver.expires !== "string" || !DATE.test(waiver.expires))
        fail(`${at}/expires`, "expires must be YYYY-MM-DD");
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, waivers: raw.waivers as Waiver[] };
}

/** Split waivers by date: a waiver is valid through its `expires` day, inclusive. */
export function activeWaivers(
  waivers: readonly Waiver[],
  today: string,
): { active: Waiver[]; expired: Waiver[] } {
  const active: Waiver[] = [];
  const expired: Waiver[] = [];
  for (const waiver of waivers) (waiver.expires >= today ? active : expired).push(waiver);
  return { active, expired };
}

/** A waiver covers a finding by rule id and path glob, for any severity. */
export function findWaiver(
  finding: { ruleId: string; file: string },
  active: readonly Waiver[],
): Waiver | undefined {
  return active.find(
    (waiver) => waiver.ruleId === finding.ruleId && matchAny(waiver.paths, finding.file),
  );
}
