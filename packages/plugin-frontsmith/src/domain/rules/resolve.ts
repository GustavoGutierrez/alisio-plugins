import type { RuleOverrideConfig } from "../config/defaults.js";
import { compileGlob } from "../glob.js";
import { compareSeverity, type Severity } from "../severity.js";
import type { StackProfile } from "../stack/profile.js";
import { type Level, levels } from "../state/levels.js";
import type {
  AppliesWhen,
  OverrideDef,
  PackDef,
  ResolvedRule,
  RuleDef,
  TrailStep,
} from "./model.js";
import type { PackDiagnostic } from "./pack-validate.js";

export interface ResolveConfig {
  packs: { enable: readonly string[]; disable: readonly string[]; order: readonly string[] };
  rules: Readonly<Record<string, RuleOverrideConfig>>;
}

export interface ResolveInput {
  stack: StackProfile;
  level: Level;
  config: ResolveConfig;
  shipped: readonly PackDef[];
  workspace: readonly PackDef[];
  /** `.frontsmith/architecture.json` exists. */
  architectureConfig: boolean;
}

export interface InactiveRule {
  ruleId: string;
  packId: string;
  reason: string;
}

export interface DisabledRule {
  ruleId: string;
  packId: string;
  trail: TrailStep[];
}

export interface ResolvedRuleSet {
  rules: ResolvedRule[];
  /** Rules whose own `appliesWhen` does not match this stack or level. */
  inactive: InactiveRule[];
  /** Rules switched off by an override or by `config.rules`. */
  disabled: DisabledRule[];
  diagnostics: PackDiagnostic[];
  activePacks: string[];
  /** Config entries naming a rule that no active pack defines (typos). */
  warnings: string[];
}

const MIN_JUSTIFICATION = 20;

/** Does `appliesWhen` match the workspace? AND across keys, OR within a list. */
export function matchesApplies(
  applies: AppliesWhen,
  context: { stack: StackProfile; level: Level; architectureConfig: boolean },
): { ok: true } | { ok: false; reason: string } {
  const { stack, level } = context;
  const overlap = (wanted: readonly string[] | undefined, actual: readonly string[]): boolean =>
    wanted === undefined || wanted.some((entry) => actual.includes(entry));
  if (!overlap(applies.framework, [stack.framework]))
    return { ok: false, reason: `framework is ${stack.framework}` };
  if (!overlap(applies.meta, [stack.meta]))
    return { ok: false, reason: `meta framework is ${stack.meta}` };
  if (!overlap(applies.styling, stack.styling))
    return { ok: false, reason: "styling does not match" };
  if (!overlap(applies.tests, stack.tests))
    return { ok: false, reason: "no matching test tooling" };
  if (applies.typescript !== undefined && applies.typescript !== stack.typescript)
    return { ok: false, reason: `typescript is ${stack.typescript}` };
  if (applies.level !== undefined && levels.indexOf(level) < levels.indexOf(applies.level))
    return { ok: false, reason: `needs level ${applies.level} (feature is ${level})` };
  if (
    applies.architectureConfig !== undefined &&
    applies.architectureConfig !== context.architectureConfig
  )
    return { ok: false, reason: "architecture config is absent" };
  return { ok: true };
}

const isDowngrade = (from: Severity, to: Severity): boolean => compareSeverity(to, from) > 0;

interface Change {
  source: string;
  severity?: Severity;
  files?: string[];
  params?: Record<string, unknown>;
  enabled?: boolean;
  justification?: string;
}

/**
 * Resolve shipped and workspace packs, overrides and config into the active rule set (spec 13.4).
 * `appliesWhen.architectureConfig` is an official key: it is how `fs-architecture` follows "when
 * .frontsmith/architecture.json exists" (13.3).
 */
export function resolveRules(input: ResolveInput): ResolvedRuleSet {
  const diagnostics: PackDiagnostic[] = [];
  const warnings: string[] = [];
  const fail = (
    code: PackDiagnostic["code"],
    pack: string,
    where: string,
    message: string,
  ): void => {
    diagnostics.push({ code, pack, where, message });
  };
  const disabledPacks = new Set(input.config.packs.disable);
  const enabledPacks = new Set(input.config.packs.enable);
  const context = {
    stack: input.stack,
    level: input.level,
    architectureConfig: input.architectureConfig,
  };

  const active: Array<{ pack: PackDef; origin: string }> = [];
  for (const pack of input.shipped) {
    if (disabledPacks.has(pack.packId)) continue;
    if (enabledPacks.has(pack.packId) || matchesApplies(pack.appliesWhen, context).ok)
      active.push({ pack, origin: `shipped:${pack.packId}` });
  }
  const workspaceActive = input.workspace.filter(
    (pack) => !disabledPacks.has(pack.packId) && matchesApplies(pack.appliesWhen, context).ok,
  );
  for (const pack of workspaceActive) active.push({ pack, origin: `workspace:${pack.packId}` });

  // extends validation across every provided workspace pack
  const knownPacks = new Map<string, PackDef>(
    [...input.shipped, ...input.workspace].map((pack) => [pack.packId, pack]),
  );
  for (const pack of input.workspace)
    for (const parent of pack.extends)
      if (!knownPacks.has(parent))
        fail("PCK-007", pack.packId, "/extends", `extends unknown pack "${parent}"`);
  const workspaceById = new Map(input.workspace.map((pack) => [pack.packId, pack]));
  for (const pack of input.workspace) {
    const stack = [pack.packId];
    const visited = new Set<string>();
    let cyclic = false;
    while (stack.length > 0 && !cyclic) {
      const next = workspaceById.get(stack.pop() as string);
      for (const parent of next?.extends ?? []) {
        if (parent === pack.packId) cyclic = true;
        else if (!visited.has(parent)) {
          visited.add(parent);
          stack.push(parent);
        }
      }
    }
    if (cyclic) fail("PCK-007", pack.packId, "/extends", "extends cycle");
  }

  // definitions
  interface Entry {
    rule: RuleDef;
    packId: string;
    origin: string;
    trail: TrailStep[];
    changes: Change[];
  }
  const byId = new Map<string, Entry>();
  const owner = new Map<string, string>();
  for (const pack of knownPacks.values())
    for (const rule of pack.rules) if (!owner.has(rule.id)) owner.set(rule.id, pack.packId);
  for (const { pack, origin } of active)
    for (const rule of pack.rules) {
      if (byId.has(rule.id)) {
        fail(
          "PCK-002",
          pack.packId,
          rule.id,
          `rule id also defined by pack ${(byId.get(rule.id) as Entry).packId}`,
        );
        continue;
      }
      byId.set(rule.id, {
        rule,
        packId: pack.packId,
        origin,
        trail: [{ source: origin, change: "defined" }],
        changes: [],
      });
    }

  // workspace overrides
  // Overrides of one rule apply in `config.packs.order`, so the LAST listed pack wins (spec 13.4).
  const order = input.config.packs.order;
  const rank = (packId: string): number => order.indexOf(packId) + 1;
  const overridesByRule = new Map<string, Array<{ pack: PackDef; override: OverrideDef }>>();
  for (const pack of workspaceActive)
    for (const override of pack.overrides) {
      const target = owner.get(override.id);
      const allowed =
        target !== undefined && (target === pack.packId || pack.extends.includes(target));
      if (!allowed) {
        fail(
          "PCK-007",
          pack.packId,
          override.id,
          target === undefined
            ? "override of an unknown rule"
            : `override of ${override.id} needs extends: ["${target}"]`,
        );
        continue;
      }
      const list = overridesByRule.get(override.id) ?? [];
      list.push({ pack, override });
      overridesByRule.set(override.id, list);
    }
  for (const [ruleId, list] of overridesByRule) {
    const entry = byId.get(ruleId);
    if (!entry) continue;
    const unranked = list.filter(({ pack }) => rank(pack.packId) === 0);
    const ranked = list
      .filter(({ pack }) => rank(pack.packId) > 0)
      .sort((a, b) => rank(a.pack.packId) - rank(b.pack.packId));
    let applied = ranked;
    if (unranked.length > 1) {
      fail(
        "PCK-003",
        unranked.map(({ pack }) => pack.packId).join(", "),
        ruleId,
        `packs ${unranked.map(({ pack }) => pack.packId).join(" and ")} both override ${ruleId}; list them in config.packs.order`,
      );
    } else applied = [...unranked, ...ranked];
    for (const { pack, override } of applied)
      entry.changes.push({
        source: `workspace:${pack.packId}`,
        ...(override.severity ? { severity: override.severity } : {}),
        ...(override.files ? { files: override.files } : {}),
        ...(override.params ? { params: override.params } : {}),
        ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
        justification: override.justification,
      });
  }

  // config.rules wins last
  for (const [ruleId, config] of Object.entries(input.config.rules)) {
    const entry = byId.get(ruleId);
    if (!entry) {
      warnings.push(`config.rules names ${ruleId}, which no active pack defines`);
      continue;
    }
    entry.changes.push({
      source: "config",
      ...(config.severity ? { severity: config.severity } : {}),
      ...(config.files ? { files: config.files } : {}),
      ...(config.params ? { params: config.params } : {}),
      ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
      ...(config.justification !== undefined ? { justification: config.justification } : {}),
    });
  }

  const rules: ResolvedRule[] = [];
  const inactive: InactiveRule[] = [];
  const disabled: DisabledRule[] = [];
  for (const entry of byId.values()) {
    let severity = entry.rule.severity;
    let files = entry.rule.files;
    let params = entry.rule.params;
    let enabled = true;
    const trail = [...entry.trail];
    for (const change of entry.changes) {
      const notes: string[] = [];
      const wasBlocker = severity === "blocker";
      if (change.severity && change.severity !== severity) {
        notes.push(`severity ${severity} -> ${change.severity}`);
        if (
          wasBlocker &&
          isDowngrade(severity, change.severity) &&
          (change.justification ?? "").length < MIN_JUSTIFICATION
        )
          fail(
            "PCK-004",
            entry.packId,
            entry.rule.id,
            `downgrading blocker ${entry.rule.id} needs a justification of at least ${MIN_JUSTIFICATION} characters`,
          );
        severity = change.severity;
      }
      if (change.enabled === false && enabled) {
        notes.push("disabled");
        if (wasBlocker && (change.justification ?? "").length < MIN_JUSTIFICATION)
          fail(
            "PCK-004",
            entry.packId,
            entry.rule.id,
            `disabling blocker ${entry.rule.id} needs a justification of at least ${MIN_JUSTIFICATION} characters`,
          );
        enabled = false;
      } else if (change.enabled === true) enabled = true;
      if (change.files) {
        files = change.files;
        notes.push("files replaced");
      }
      if (change.params) {
        params = change.params;
        notes.push("params replaced");
      }
      if (notes.length > 0) trail.push({ source: change.source, change: notes.join("; ") });
    }
    if (!enabled) {
      disabled.push({ ruleId: entry.rule.id, packId: entry.packId, trail });
      continue;
    }
    const applies = matchesApplies(entry.rule.appliesWhen, context);
    if (!applies.ok) {
      inactive.push({ ruleId: entry.rule.id, packId: entry.packId, reason: applies.reason });
      continue;
    }
    for (const glob of files) compileGlob(glob);
    rules.push({
      ...entry.rule,
      severity,
      files,
      params,
      packId: entry.packId,
      origin: entry.origin,
      trail,
    });
  }
  return {
    rules,
    inactive,
    disabled,
    diagnostics,
    activePacks: active.map(({ pack }) => pack.packId),
    warnings,
  };
}
