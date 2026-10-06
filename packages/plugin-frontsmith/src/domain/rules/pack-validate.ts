import { compileGlob } from "../glob.js";
import { isPackId, isShippedRuleId, isWorkspaceRuleId } from "../ids.js";
import { isSeverity } from "../severity.js";
import { isLevel } from "../state/levels.js";
import {
  type AppliesWhen,
  type EngineId,
  isEngineId,
  type OverrideDef,
  type PackDef,
  type RuleDef,
  ruleCategories,
  ruleKinds,
} from "./model.js";

export type PackCode =
  | "PCK-001"
  | "PCK-002"
  | "PCK-003"
  | "PCK-004"
  | "PCK-005"
  | "PCK-006"
  | "PCK-007"
  | "PCK-008";

export interface PackDiagnostic {
  code: PackCode;
  pack: string;
  /** Rule id or pointer inside the pack the problem refers to. */
  where: string;
  message: string;
}

export type EngineParamValidator = (params: Record<string, unknown>) => string[];
export type EngineParamValidators = Readonly<Partial<Record<EngineId, EngineParamValidator>>>;

export interface ValidatePackOptions {
  scope: "shipped" | "workspace";
  /** Per-engine parameter validators; an engine without one accepts any params. */
  validators: EngineParamValidators;
}

export type PackValidation =
  | { ok: true; pack: PackDef }
  | { ok: false; diagnostics: PackDiagnostic[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PACK_KEYS = [
  "schemaVersion",
  "packId",
  "version",
  "title",
  "description",
  "extends",
  "appliesWhen",
  "rules",
  "overrides",
];
const RULE_KEYS = [
  "id",
  "title",
  "severity",
  "kind",
  "category",
  "engine",
  "params",
  "files",
  "appliesWhen",
  "message",
  "fix",
  "rationale",
  "source",
  "suppressible",
  "tags",
  "fixtures",
];
const OVERRIDE_KEYS = ["id", "override", "severity", "files", "params", "enabled", "justification"];
const APPLIES_KEYS = [
  "framework",
  "meta",
  "styling",
  "tests",
  "typescript",
  "level",
  "architectureConfig",
];

/** Structural validation of a pack document. The first PCK-001 problem of a rule stops its checks. */
export function validatePack(raw: unknown, options: ValidatePackOptions): PackValidation {
  const diagnostics: PackDiagnostic[] = [];
  const name = isRecord(raw) && typeof raw.packId === "string" ? raw.packId : "?";
  const add = (code: PackCode, where: string, message: string): void => {
    diagnostics.push({ code, pack: name, where, message });
  };
  if (!isRecord(raw)) {
    add("PCK-001", "", "pack must be a JSON object");
    return { ok: false, diagnostics };
  }
  for (const key of Object.keys(raw))
    if (!PACK_KEYS.includes(key)) add("PCK-001", `/${key}`, `unknown key "${key}"`);
  if (raw.schemaVersion !== 1) add("PCK-001", "/schemaVersion", "schemaVersion must be 1");
  if (!isPackId(raw.packId)) add("PCK-001", "/packId", "invalid pack id");
  else if (options.scope === "workspace" && raw.packId.startsWith("fs-"))
    add("PCK-005", "/packId", "the fs- pack namespace is reserved for shipped packs");
  for (const key of ["version", "title", "description"] as const)
    if (typeof raw[key] !== "string" || (raw[key] as string).length === 0)
      add("PCK-001", `/${key}`, `${key} must be a non-empty string`);
  if (!Array.isArray(raw.extends) || !raw.extends.every((entry) => isPackId(entry)))
    add("PCK-001", "/extends", "extends must be an array of pack ids");

  const appliesWhen = (value: unknown, where: string): void => {
    if (!isRecord(value)) {
      add("PCK-001", where, "appliesWhen must be an object");
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (!APPLIES_KEYS.includes(key))
        add("PCK-001", `${where}/${key}`, `unknown appliesWhen key "${key}"`);
      else if (key === "typescript" || key === "architectureConfig") {
        if (typeof entry !== "boolean") add("PCK-001", `${where}/${key}`, "must be a boolean");
      } else if (key === "level") {
        if (!isLevel(entry)) add("PCK-001", `${where}/${key}`, "must be L0, L1, L2 or L3");
      } else if (!Array.isArray(entry) || !entry.every((item) => typeof item === "string"))
        add("PCK-001", `${where}/${key}`, "must be an array of strings");
    }
  };
  appliesWhen(raw.appliesWhen, "/appliesWhen");

  const globs = (value: unknown, where: string): void => {
    if (!Array.isArray(value) || value.length === 0) {
      add("PCK-001", where, "must be a non-empty array of globs");
      return;
    }
    value.forEach((entry, index) => {
      try {
        compileGlob(entry as string);
      } catch {
        add("PCK-001", `${where}/${index}`, "invalid glob");
      }
    });
  };

  const seen = new Set<string>();
  if (!Array.isArray(raw.rules)) add("PCK-001", "/rules", "rules must be an array");
  else
    raw.rules.forEach((rule: unknown, index: number) => {
      const where = isRecord(rule) && typeof rule.id === "string" ? rule.id : `/rules/${index}`;
      if (!isRecord(rule)) {
        add("PCK-001", where, "rule must be an object");
        return;
      }
      const before = diagnostics.length;
      for (const key of Object.keys(rule))
        if (!RULE_KEYS.includes(key)) add("PCK-001", where, `unknown rule key "${key}"`);
      const idOk =
        options.scope === "shipped" ? isShippedRuleId(rule.id) : isWorkspaceRuleId(rule.id);
      if (!idOk) {
        if (
          options.scope === "workspace" &&
          typeof rule.id === "string" &&
          rule.id.startsWith("FS-")
        )
          add("PCK-005", where, "workspace rules must not use the FS- namespace");
        else add("PCK-001", where, "invalid rule id for this scope");
      }
      if (typeof rule.id === "string") {
        if (seen.has(rule.id)) add("PCK-002", where, "duplicate rule id in this pack");
        seen.add(rule.id);
      }
      for (const key of ["title", "message", "fix", "rationale"] as const)
        if (typeof rule[key] !== "string" || (rule[key] as string).length === 0)
          add("PCK-001", where, `${key} must be a non-empty string`);
      if (typeof rule.source !== "string") add("PCK-001", where, "source must be a string");
      if (!isSeverity(rule.severity)) add("PCK-001", where, "invalid severity");
      if (!(ruleKinds as readonly unknown[]).includes(rule.kind))
        add("PCK-001", where, "invalid kind");
      if (!(ruleCategories as readonly unknown[]).includes(rule.category))
        add("PCK-001", where, "invalid category");
      if (typeof rule.suppressible !== "boolean")
        add("PCK-001", where, "suppressible must be a boolean");
      else if (rule.suppressible && (rule.severity === "blocker" || rule.severity === "major"))
        add(
          "PCK-001",
          where,
          "only minor and nit rules may be suppressible; use a human waiver otherwise",
        );
      if (!Array.isArray(rule.tags) || !rule.tags.every((tag) => typeof tag === "string"))
        add("PCK-001", where, "tags must be an array of strings");
      if (!isRecord(rule.params)) add("PCK-001", where, "params must be an object");
      globs(rule.files, `${where}#files`);
      appliesWhen(rule.appliesWhen, `${where}#appliesWhen`);
      if (rule.fixtures !== undefined) {
        const f = rule.fixtures;
        if (!isRecord(f) || !Array.isArray(f.pass) || !Array.isArray(f.fail))
          add("PCK-001", where, "fixtures must hold pass and fail arrays");
      }
      if (!isEngineId(rule.engine))
        add("PCK-006", where, `unknown engine "${String(rule.engine)}"`);
      else {
        if ((rule.kind === "advisory") !== (rule.engine === "advisory"))
          add("PCK-001", where, "kind advisory and engine advisory must go together");
        if (rule.engine === "advisory") {
          if (
            !isRecord(rule.params) ||
            typeof rule.params.guidance !== "string" ||
            rule.params.guidance.length === 0
          )
            add("PCK-001", where, "advisory rules need params.guidance");
          if (rule.fixtures !== undefined)
            add("PCK-001", where, "advisory rules carry no fixtures");
        } else if (isRecord(rule.params) && diagnostics.length === before) {
          const problems = options.validators[rule.engine]?.(rule.params) ?? [];
          for (const problem of problems) add("PCK-006", where, `${rule.engine}: ${problem}`);
        }
      }
    });

  if (!Array.isArray(raw.overrides)) add("PCK-001", "/overrides", "overrides must be an array");
  else
    raw.overrides.forEach((override: unknown, index: number) => {
      const where = `/overrides/${index}`;
      if (!isRecord(override)) {
        add("PCK-001", where, "override must be an object");
        return;
      }
      for (const key of Object.keys(override))
        if (!OVERRIDE_KEYS.includes(key)) add("PCK-001", where, `unknown override key "${key}"`);
      if (
        typeof override.id !== "string" ||
        !(isShippedRuleId(override.id) || isWorkspaceRuleId(override.id))
      )
        add("PCK-001", where, "override id must be a rule id");
      if (override.override !== true) add("PCK-001", where, "override must be true");
      if ("severity" in override && !isSeverity(override.severity))
        add("PCK-001", where, "invalid severity");
      if ("enabled" in override && typeof override.enabled !== "boolean")
        add("PCK-001", where, "enabled must be a boolean");
      if ("params" in override && !isRecord(override.params))
        add("PCK-001", where, "params must be an object");
      if ("files" in override) globs(override.files, `${where}/files`);
      if (typeof override.justification !== "string")
        add("PCK-001", where, "justification must be a string");
    });

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, pack: raw as unknown as PackDef };
}

export type { AppliesWhen, OverrideDef, RuleDef };
