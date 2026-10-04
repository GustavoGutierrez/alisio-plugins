import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { Brief } from "../types.js";
import { briefContext, matchesWhen, slugify } from "./context.js";
import {
  isRecord,
  type LoadedRule,
  listYaml,
  type PackProblem,
  type PackScope,
  packScopes,
  parseRuleFile,
  readCapped,
  relativeTo,
} from "./rules.js";

export interface PackManifest {
  packId: string;
  scope: PackScope;
  version: string;
  appliesWhen?: Record<string, unknown>;
  extends?: string;
  description?: string;
  maintainer?: string;
  /** Optional ISO country code for country packs whose packId is not the code itself. */
  country?: string;
  files?: string[];
}

export type PackLocation = "shipped" | "workspace";

export interface LoadedPack {
  id: string;
  scope: PackScope;
  version: string;
  location: PackLocation;
  /** Directory name, used to match institution, faculty and program slugs. */
  slug: string;
  /** Directory relative to its packs root. */
  dir: string;
  manifest: PackManifest;
  rules: LoadedRule[];
}

const packIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

export function parseManifest(raw: unknown): { manifest?: PackManifest; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(raw)) return { errors: ["manifest.yaml must be a mapping"] };
  if (typeof raw.packId !== "string" || !packIdPattern.test(raw.packId))
    errors.push("packId is required (letters, digits, dot, dash)");
  if (typeof raw.scope !== "string" || !(packScopes as readonly string[]).includes(raw.scope)) {
    errors.push(`scope is required and must be one of: ${packScopes.join(", ")}`);
  }
  if (typeof raw.version !== "string" && typeof raw.version !== "number")
    errors.push("version is required");
  if (raw.appliesWhen !== undefined && !isRecord(raw.appliesWhen))
    errors.push("appliesWhen must be a mapping");
  if (
    raw.extends !== undefined &&
    (typeof raw.extends !== "string" || !packIdPattern.test(raw.extends))
  ) {
    errors.push("extends must be a packId");
  }
  if (
    raw.country !== undefined &&
    (typeof raw.country !== "string" || !/^[A-Z]{2}$/.test(raw.country))
  ) {
    errors.push("country must be an ISO 3166-1 alpha-2 code");
  }
  if (raw.files !== undefined) {
    if (
      !Array.isArray(raw.files) ||
      !raw.files.every(
        (file) =>
          typeof file === "string" &&
          file &&
          !file.startsWith("/") &&
          !file.includes("..") &&
          !file.includes("\\"),
      )
    ) {
      errors.push("files must be a list of relative paths");
    }
  }
  if (errors.length > 0) return { errors };
  return {
    errors,
    manifest: {
      packId: raw.packId as string,
      scope: raw.scope as PackScope,
      version: String(raw.version),
      ...(isRecord(raw.appliesWhen) ? { appliesWhen: raw.appliesWhen } : {}),
      ...(typeof raw.extends === "string" ? { extends: raw.extends } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.maintainer === "string" ? { maintainer: raw.maintainer } : {}),
      ...(typeof raw.country === "string" ? { country: raw.country } : {}),
      ...(Array.isArray(raw.files) ? { files: raw.files as string[] } : {}),
    },
  };
}

async function findPackDirectories(root: string, depth = 0): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "manifest.yaml")) return [root];
  if (depth >= 6) return [];
  const found: string[] = [];
  for (const entry of entries
    .filter((item) => item.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    found.push(...(await findPackDirectories(join(root, entry.name), depth + 1)));
  }
  return found;
}

function pathScopes(relativeInsidePack: string): { faculty?: string; program?: string } {
  const parts = relativeInsidePack.split("/");
  const result: { faculty?: string; program?: string } = {};
  parts.forEach((part, index) => {
    if (part === "faculties" && parts[index + 1]) result.faculty = parts[index + 1] as string;
    if (part === "programs" && parts[index + 1]) result.program = parts[index + 1] as string;
  });
  return result;
}

/**
 * One loader for shipped and workspace packs; only the root directory and the location label
 * differ. Every directory that holds a manifest.yaml is a pack.
 */
export async function loadPacks(
  root: string,
  location: PackLocation,
): Promise<{ packs: LoadedPack[]; problems: PackProblem[] }> {
  const packs: LoadedPack[] = [];
  const problems: PackProblem[] = [];
  const prefix = location === "workspace" ? "policy-packs/" : "";
  for (const directory of await findPackDirectories(root)) {
    const dir = relativeTo(root, directory) || basename(directory);
    const manifestFile = `${prefix}${dir}/manifest.yaml`;
    let raw: unknown;
    try {
      raw = parse(await readCapped(join(directory, "manifest.yaml")));
    } catch (error) {
      problems.push({
        code: "PCK-001",
        severity: "error",
        file: manifestFile,
        message: `manifest.yaml is unreadable: ${error instanceof Error ? (error.message.split("\n")[0] ?? "error") : "error"}`,
      });
      continue;
    }
    const { manifest, errors } = parseManifest(raw);
    for (const message of errors)
      problems.push({ code: "PCK-001", severity: "error", file: manifestFile, message });
    if (!manifest) continue;

    const rules: LoadedRule[] = [];
    const seen = new Set<string>();
    const files = (await listYaml(directory, true)).filter(
      (file) => basename(file) !== "manifest.yaml",
    );
    for (const absolute of files) {
      const inside = relativeTo(directory, absolute);
      const file = `${prefix}${dir}/${inside}`;
      let text: string;
      try {
        text = await readCapped(absolute);
      } catch (error) {
        problems.push({
          code: "PCK-001",
          severity: "error",
          file,
          message: error instanceof Error ? error.message : "Unreadable file",
        });
        continue;
      }
      const parsed = parseRuleFile(text, {
        tier: "pack",
        packId: manifest.packId,
        scope: manifest.scope,
        location,
        file,
        ...pathScopes(inside),
      });
      problems.push(...parsed.problems);
      for (const rule of parsed.rules) {
        if (seen.has(rule.ruleId)) {
          problems.push({
            code: "PCK-001",
            severity: "error",
            file,
            message: `Duplicate ruleId ${rule.ruleId} in pack ${manifest.packId}`,
          });
          continue;
        }
        seen.add(rule.ruleId);
        rules.push(rule);
      }
    }
    for (const listed of manifest.files ?? []) {
      if (!files.some((absolute) => relativeTo(directory, absolute) === listed)) {
        problems.push({
          code: "PCK-001",
          severity: "error",
          file: manifestFile,
          message: `Listed file ${listed} does not exist`,
        });
      }
    }
    packs.push({
      id: manifest.packId,
      scope: manifest.scope,
      version: manifest.version,
      location,
      slug: basename(directory),
      dir,
      manifest,
      rules,
    });
  }
  return { packs, problems };
}

/** Cross-pack validation: packId and ruleId collisions, unknown `extends`, stray `overrides`. */
export function crossValidate(packs: readonly LoadedPack[]): PackProblem[] {
  const problems: PackProblem[] = [];
  const ordered = [...packs].sort(
    (a, b) =>
      Number(a.location === "workspace") - Number(b.location === "workspace") ||
      (a.dir < b.dir ? -1 : 1),
  );
  const ids = new Map<string, LoadedPack>();
  for (const pack of ordered) {
    const prefix = pack.location === "workspace" ? "policy-packs/" : "";
    const first = ids.get(pack.id);
    if (first) {
      problems.push({
        code: "PCK-001",
        severity: "error",
        file: `${prefix}${pack.dir}/manifest.yaml`,
        message: `packId ${pack.id} is already used by ${first.location === "workspace" ? "policy-packs/" : ""}${first.dir}; use extends to add rules to an existing pack`,
      });
    } else ids.set(pack.id, pack);
  }
  for (const pack of ordered) {
    const target = pack.manifest.extends;
    if (target && !ids.has(target)) {
      problems.push({
        code: "PCK-001",
        severity: "error",
        file: `${pack.location === "workspace" ? "policy-packs/" : ""}${pack.dir}/manifest.yaml`,
        message: `extends refers to unknown pack ${target}`,
      });
    }
  }
  const definitions = new Map<string, LoadedRule[]>();
  for (const pack of ordered) {
    for (const rule of pack.rules)
      definitions.set(rule.ruleId, [...(definitions.get(rule.ruleId) ?? []), rule]);
  }
  for (const [ruleId, list] of [...definitions.entries()].sort()) {
    const [first, ...rest] = list as [LoadedRule, ...LoadedRule[]];
    if (rest.length === 0) {
      if (first.overrides) {
        problems.push({
          code: "PCK-002",
          severity: "error",
          file: first.origin.file,
          message: `${ruleId} sets overrides: true but no other rule has this ruleId`,
        });
      }
      continue;
    }
    for (const later of rest) {
      if (!later.overrides) {
        problems.push({
          code: "PCK-002",
          severity: "error",
          file: later.origin.file,
          message: `${ruleId} is already defined in ${first.origin.file}; add overrides: true to replace it deliberately, or choose another ruleId`,
        });
      }
    }
  }
  return problems;
}

export interface PackSelection {
  active: LoadedPack[];
  inactive: { packId: string; location: PackLocation; reason: string }[];
  problems: PackProblem[];
}

/** Decide which packs apply to a brief. Pure; never depends on load order. */
export function selectPacks(all: readonly LoadedPack[], brief: Brief): PackSelection {
  const context = briefContext(brief);
  const institution = slugify(brief.institution.name ?? "");
  const faculty = slugify(brief.institution.faculty ?? "");
  const program = slugify(brief.institution.program ?? "");
  const setting = brief.policy.packs;
  const problems: PackProblem[] = [];
  const reasons = new Map<string, string>();

  if (setting !== "auto") {
    for (const id of setting) {
      if (!all.some((pack) => pack.id === id)) {
        problems.push({
          code: "PCK-001",
          severity: "error",
          file: "thesis.yaml",
          message: `policy.packs lists unknown pack ${id}`,
        });
      }
    }
  }

  const directMatch = (pack: LoadedPack): string | undefined => {
    if (pack.scope === "global") return undefined;
    if (setting !== "auto")
      return setting.includes(pack.id) ? undefined : "not listed in policy.packs";
    const when = matchesWhen(pack.manifest.appliesWhen, context);
    if (!when.ok)
      return when.unknownKey
        ? `unknown appliesWhen key ${when.unknownKey}`
        : "appliesWhen does not match the brief";
    switch (pack.scope) {
      case "country": {
        const country = pack.manifest.country ?? (/^[A-Z]{2}$/.test(pack.id) ? pack.id : undefined);
        if (
          pack.manifest.appliesWhen?.country === undefined &&
          country !== undefined &&
          country !== brief.institution.country
        ) {
          return `country pack ${country} does not match ${brief.institution.country}`;
        }
        return undefined;
      }
      case "institution":
        return pack.slug === institution ? undefined : "institution does not match";
      case "faculty":
        return pack.slug === faculty ? undefined : "faculty does not match";
      case "program":
        return pack.slug === program ? undefined : "program does not match";
      default:
        return undefined;
    }
  };

  const active = new Set<string>();
  for (const pack of all)
    if (pack.scope === "global" || directMatch(pack) === undefined) active.add(pack.id);
  for (const pack of all) {
    const reason = directMatch(pack);
    if (reason) reasons.set(pack.id, reason);
  }
  // A pack that extends another is only active while its base is.
  for (let pass = 0; pass < all.length; pass += 1) {
    let changed = false;
    for (const pack of all) {
      const base = pack.manifest.extends;
      if (active.has(pack.id) && base && !active.has(base)) {
        active.delete(pack.id);
        reasons.set(pack.id, `extends ${base}, which is not active`);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const selected: LoadedPack[] = [];
  const inactive: PackSelection["inactive"] = [];
  for (const pack of [...all].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!active.has(pack.id)) {
      inactive.push({
        packId: pack.id,
        location: pack.location,
        reason: reasons.get(pack.id) ?? "not selected",
      });
      continue;
    }
    // Faculty and program sub-folders of an institution pack apply only to that faculty/program.
    const rules = pack.rules.filter(
      (rule) =>
        (rule.origin.faculty === undefined || rule.origin.faculty === faculty) &&
        (rule.origin.program === undefined || rule.origin.program === program),
    );
    selected.push({ ...pack, rules });
  }
  return { active: selected, inactive, problems };
}
