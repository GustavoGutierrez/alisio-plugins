import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AriaCatalog } from "../../application/ports/aria-catalog.js";
import { type PatternsCatalog, parsePatternsCatalog } from "../../domain/architecture/patterns.js";
import { type PairGraph, parsePairGraph } from "../../domain/color/pairs.js";
import { type PaletteCatalog, parsePaletteCatalog } from "../../domain/color/palette.js";
import { packageRoot } from "./adapter-loader.js";

export type { AriaCatalog };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stringList = (value: unknown, what: string): string[] => {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
    throw new Error(`aria catalog: ${what} must be a string array`);
  return value as string[];
};

export function parseAriaCatalog(raw: unknown): AriaCatalog {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.catalog !== "string")
    throw new Error("aria catalog: invalid header");
  const attributes = stringList(raw.attributes, "attributes");
  const roles = stringList(raw.roles, "roles");
  if (!isRecord(raw.requiredAttributes) || !isRecord(raw.nativeSemantics))
    throw new Error("aria catalog: invalid maps");
  const requiredAttributes: Record<string, string[]> = {};
  for (const [role, required] of Object.entries(raw.requiredAttributes)) {
    if (!roles.includes(role)) throw new Error(`aria catalog: unknown role ${role}`);
    requiredAttributes[role] = stringList(required, `requiredAttributes.${role}`);
    for (const attribute of requiredAttributes[role] as string[])
      if (!attributes.includes(attribute))
        throw new Error(`aria catalog: unknown attribute ${attribute}`);
  }
  const nativeSemantics: Record<string, string[]> = {};
  for (const [role, selectors] of Object.entries(raw.nativeSemantics)) {
    if (!roles.includes(role)) throw new Error(`aria catalog: unknown role ${role}`);
    nativeSemantics[role] = stringList(selectors, `nativeSemantics.${role}`);
  }
  return {
    schemaVersion: 1,
    catalog: raw.catalog,
    attributes,
    roles,
    requiredAttributes,
    nativeSemantics,
  };
}

export async function loadAriaCatalog(root = packageRoot()): Promise<AriaCatalog> {
  return parseAriaCatalog(JSON.parse(await readFile(join(root, "catalog", "aria.json"), "utf8")));
}

export async function loadPatternsCatalog(root = packageRoot()): Promise<PatternsCatalog> {
  const parsed = parsePatternsCatalog(
    JSON.parse(await readFile(join(root, "catalog", "patterns.json"), "utf8")),
  );
  if (!parsed.ok) throw new Error(`patterns catalog is invalid: ${parsed.errors.join("; ")}`);
  return parsed.catalog;
}

export async function loadPaletteCatalog(root = packageRoot()): Promise<PaletteCatalog> {
  const parsed = parsePaletteCatalog(
    JSON.parse(await readFile(join(root, "catalog", "palettes.json"), "utf8")),
  );
  if (!parsed.ok) throw new Error(`palette catalog is invalid: ${parsed.errors.join("; ")}`);
  return parsed.catalog;
}

export async function loadPairGraph(root = packageRoot()): Promise<PairGraph> {
  const parsed = parsePairGraph(
    JSON.parse(await readFile(join(root, "catalog", "pair-graph.json"), "utf8")),
  );
  if (!parsed.ok) throw new Error(`pair graph is invalid: ${parsed.errors.join("; ")}`);
  return parsed.graph;
}
