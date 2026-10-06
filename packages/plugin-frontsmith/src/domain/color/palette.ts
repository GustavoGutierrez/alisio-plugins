import { canonicalJson } from "../canonical-json.js";
import { type ContrastKind, contrastRatio } from "./contrast.js";
import { type AccentFamily, type Theme, themes } from "./pairs.js";
import { isHex6, parseColor, type Rgba } from "./parse.js";

/**
 * Catalog-constrained palette solver (spec 12.3). The language model never chooses colour values:
 * it names a family and constraints, this module chooses values or returns UNSAT.
 */
export interface ChooseRole {
  role: string;
  /** A scale id of the catalog, or `$family` for the requested family. */
  scale: string;
  /** Target scale index per theme (absent when `relativeTo` is used). */
  target?: Record<Theme, number>;
  /** Choose relative to the scale index of an earlier role. */
  relativeTo?: string;
  offset?: Record<Theme, number>;
  /** Restrict candidates to indices below or above the reference index. */
  direction?: Record<Theme, "below" | "above">;
  /** Each candidate must contrast at least `min` with the named role's value. */
  against: Array<{ role: string; min: number }>;
}

export interface ProfilePair {
  fg: string;
  bg: string;
  min: number;
  kind: ContrastKind;
}

export interface PaletteProfile {
  id: string;
  /** Output order of the roles. */
  roles: string[];
  /** Custom property written for each role. */
  tokenNames: Record<string, string>;
  fixed: Record<Theme, Record<string, string>>;
  choose: ChooseRole[];
  pairs: ProfilePair[];
}

export interface PaletteCatalog {
  schemaVersion: 1;
  catalogVersion: string;
  defaultProfile?: string;
  /** Family ids the solver accepts; each needs an entry in `scales`. */
  families: string[];
  /** Ordered scales, darkest first; the order is part of the contract. */
  scales: Record<string, string[]>;
  neutral: Record<string, Record<string, string>>;
  ramps?: Record<string, Record<string, string>>;
  accents: AccentFamily[];
  roleTemplates: Record<string, Partial<Record<Theme, Record<string, string>>>>;
  profiles: Record<string, PaletteProfile>;
}

export interface PaletteRequest {
  family: string;
  themes: readonly Theme[];
  /**
   * Role id -> `#RRGGBB`, fixed inputs for every requested theme.
   * TODO(owner): spec 10.5 types `locked` as a record without naming its keys; role ids of the
   * profile are used, and one colour applies to every requested theme.
   */
  locked?: Record<string, string>;
  profile?: string;
}

export interface SolvedPair {
  fg: string;
  bg: string;
  kind: ContrastKind;
  min: number;
  /** Unrounded. */
  ratio: number;
  pass: boolean;
}

export interface SolvedTheme {
  theme: Theme;
  tokens: Record<string, string>;
  pairs: SolvedPair[];
}

export type PaletteResult =
  | {
      ok: true;
      family: string;
      profile: string;
      themes: SolvedTheme[];
      catalogVersion: string;
      inputsSha256: string;
      outputSha256: string;
    }
  | { ok: false; kind: "unsat" | "invalid"; reason: string };

export type PaletteCatalogValidation =
  | { ok: true; catalog: PaletteCatalog }
  | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hexList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(isHex6);

/** Validate a catalog document; the shipped one and test catalogs both pass through here. */
export function parsePaletteCatalog(raw: unknown): PaletteCatalogValidation {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["catalog must be an object"] };
  if (raw.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof raw.catalogVersion !== "string" || raw.catalogVersion === "")
    errors.push("catalogVersion is required");
  const scales = isRecord(raw.scales) ? raw.scales : {};
  if (!isRecord(raw.scales) || !Object.values(raw.scales).every(hexList))
    errors.push("scales must map ids to lists of #RRGGBB");
  if (
    !Array.isArray(raw.families) ||
    !raw.families.every((id) => typeof id === "string" && id in scales)
  )
    errors.push("families must name scales");
  if (!Array.isArray(raw.accents) || !raw.accents.every(isAccent))
    errors.push("accents need an id and light and dark solid and on colours");
  if (!isRecord(raw.profiles) || !Object.values(raw.profiles).every(isProfile))
    errors.push("profiles are malformed");
  for (const key of ["neutral", "roleTemplates"])
    if (!isRecord(raw[key])) errors.push(`${key} must be an object`);
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, catalog: raw as unknown as PaletteCatalog };
}

function isAccent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string") return false;
  return themes.every((theme) => {
    const entry = value[theme];
    return isRecord(entry) && isHex6(entry.solid) && isHex6(entry.on);
  });
}

function isProfile(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    Array.isArray(value.roles) &&
    isRecord(value.tokenNames) &&
    isRecord(value.fixed) &&
    Array.isArray(value.choose) &&
    Array.isArray(value.pairs)
  );
}

const MAX_STEPS = 200_000;

interface Failure {
  depth: number;
  reason: string;
}

/** Solve every requested theme; the first theme that cannot be solved decides the UNSAT reason. */
export function solvePalette(
  catalog: PaletteCatalog,
  request: PaletteRequest,
  sha256: (text: string) => string,
): PaletteResult {
  const invalid = (reason: string): PaletteResult => ({ ok: false, kind: "invalid", reason });
  const profileId = request.profile ?? catalog.defaultProfile ?? Object.keys(catalog.profiles)[0];
  const profile = profileId ? catalog.profiles[profileId] : undefined;
  if (!profile) return invalid(`Unknown palette profile: ${profileId ?? "(none)"}`);
  if (!catalog.families.includes(request.family))
    return invalid(
      `Family "${request.family}" is not curated; use one of: ${catalog.families.join(", ")}`,
    );
  const requested = [...new Set(request.themes)];
  if (requested.length === 0) return invalid("Pick at least one theme");
  if (requested.some((theme) => !themes.includes(theme)))
    return invalid("Themes must be light or dark");
  const locked = request.locked ?? {};
  const known = new Set([...profile.roles]);
  for (const [role, value] of Object.entries(locked)) {
    if (!known.has(role)) return invalid(`Unknown locked role: ${role}`);
    if (!isHex6(value)) return invalid(`Locked colour of ${role} must be #RRGGBB`);
  }
  const lockedNormalised = Object.fromEntries(
    Object.entries(locked).map(([role, value]) => [role, value.toUpperCase()]),
  );

  const solved: SolvedTheme[] = [];
  for (const theme of requested) {
    const outcome = solveTheme(catalog, profile, request.family, theme, lockedNormalised);
    if (!outcome.ok) return { ok: false, kind: "unsat", reason: outcome.reason };
    solved.push(outcome.theme);
  }
  const tokens = Object.fromEntries(solved.map((entry) => [entry.theme, entry.tokens]));
  return {
    ok: true,
    family: request.family,
    profile: profile.id,
    themes: solved,
    catalogVersion: catalog.catalogVersion,
    inputsSha256: sha256(
      canonicalJson({
        catalogVersion: catalog.catalogVersion,
        profile: profile.id,
        family: request.family,
        themes: requested,
        locked: lockedNormalised,
      }),
    ),
    outputSha256: sha256(canonicalJson(tokens)),
  };
}

function solveTheme(
  catalog: PaletteCatalog,
  profile: PaletteProfile,
  family: string,
  theme: Theme,
  locked: Record<string, string>,
): { ok: true; theme: SolvedTheme } | { ok: false; reason: string } {
  const values: Record<string, string> = { ...profile.fixed[theme] };
  for (const [role, value] of Object.entries(locked)) values[role] = value;
  const colour = (role: string): Rgba | undefined => {
    const value = values[role];
    return value ? parseColor(value) : undefined;
  };
  const ratioOf = (a: string, b: string): number | undefined => {
    const fg = colour(a);
    const bg = colour(b);
    return fg && bg ? contrastRatio(fg, bg) : undefined;
  };
  const failingPair = (onlyLocked: boolean): string | undefined => {
    for (const pair of profile.pairs) {
      const ratio = ratioOf(pair.fg, pair.bg);
      if (ratio === undefined || ratio >= pair.min) continue;
      const culprit = [pair.fg, pair.bg].find((role) => role in locked);
      if (onlyLocked && !culprit) continue;
      return culprit
        ? `UNSAT: locked ${culprit} violates ${pair.fg}/${pair.bg}`
        : `UNSAT: ${pair.fg}/${pair.bg} is below ${pair.min} in the fixed roles of ${theme}`;
    }
    return undefined;
  };
  // Pairs between fixed and locked colours are decided before any search.
  const early = failingPair(false);
  if (early) return { ok: false, reason: early };

  const free = profile.choose.filter((role) => !(role.role in locked));
  const scaleOf = (role: ChooseRole): string[] =>
    catalog.scales[role.scale === "$family" ? family : role.scale] ?? [];
  /** Scale index the role is positioned from: its reference role's index, or its own target. */
  const anchor = (role: ChooseRole): number => {
    if (!role.relativeTo) return (role.target as Record<Theme, number>)[theme];
    const reference = profile.choose.find((entry) => entry.role === role.relativeTo);
    const found = reference ? scaleOf(reference).indexOf(values[role.relativeTo] ?? "") : -1;
    return found >= 0 ? found : (reference?.target?.[theme] ?? 0);
  };
  const candidates = (role: ChooseRole): string[] => {
    const scale = scaleOf(role);
    const pivot = anchor(role);
    const target = role.relativeTo ? pivot + (role.offset?.[theme] ?? 0) : pivot;
    const direction = role.direction?.[theme];
    return scale
      .map((_, index) => index)
      .filter((index) =>
        direction === "below" ? index < pivot : direction === "above" ? index > pivot : true,
      )
      .filter((index) =>
        role.against.every((rule) => {
          const other = colour(rule.role);
          const own = parseColor(scale[index] as string);
          return !other || !own || contrastRatio(own, other) >= rule.min;
        }),
      )
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)
      .map((index) => scale[index] as string);
  };

  const state: { steps: number; failure?: Failure } = { steps: 0 };
  const note = (depth: number, reason: string): void => {
    if (!state.failure || depth >= state.failure.depth) state.failure = { depth, reason };
  };
  const search = (depth: number): boolean => {
    if (depth === free.length) {
      const bad = failingPair(false);
      if (bad) note(depth, bad);
      return bad === undefined;
    }
    const role = free[depth] as ChooseRole;
    const options = candidates(role);
    if (options.length === 0) {
      const needs = role.against.map((rule) => `${rule.role} >= ${rule.min}`).join(", ");
      note(depth, `UNSAT: no candidate for ${role.role} in ${theme}${needs ? ` (${needs})` : ""}`);
      return false;
    }
    for (const option of options) {
      state.steps += 1;
      if (state.steps > MAX_STEPS) return false;
      values[role.role] = option;
      if (search(depth + 1)) return true;
    }
    delete values[role.role];
    return false;
  };
  if (!search(0))
    return {
      ok: false,
      reason:
        state.steps > MAX_STEPS
          ? `UNSAT: search budget exhausted for ${theme}`
          : (state.failure?.reason ?? `UNSAT: no palette for ${theme}`),
    };
  const tokens = Object.fromEntries(profile.roles.map((role) => [role, values[role] as string]));
  const pairs: SolvedPair[] = profile.pairs.map((pair) => {
    const ratio = ratioOf(pair.fg, pair.bg) as number;
    return {
      fg: pair.fg,
      bg: pair.bg,
      kind: pair.kind,
      min: pair.min,
      ratio,
      pass: ratio >= pair.min,
    };
  });
  return { ok: true, theme: { theme, tokens, pairs } };
}
