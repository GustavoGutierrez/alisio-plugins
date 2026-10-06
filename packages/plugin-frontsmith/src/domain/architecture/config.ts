import { compileGlob } from "../glob.js";

/** `.frontsmith/architecture.json` (spec 14.1). */
export interface ArchitectureLayer {
  name: string;
  paths: string[];
}

export interface ArchitectureConfig {
  schemaVersion: 1;
  preset?: string;
  sourceRoots: string[];
  aliases?: "tsconfig" | "none";
  layers: ArchitectureLayer[];
  allow: Record<string, string[]>;
  allowSameLayer: string[];
  slices?: { layers: string[]; depth: number; publicApi: string[] };
  roles?: { presentational: string[]; forbiddenForPresentational: string[] };
  atomic: null | { levels: string[]; paths: Record<string, string[]> };
  ignore: string[];
}

export interface ArchitectureError {
  pointer: string;
  message: string;
}

export type ArchitectureValidation =
  | { ok: true; config: ArchitectureConfig }
  | { ok: false; errors: ArchitectureError[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const KEYS = [
  "$schema",
  "schemaVersion",
  "preset",
  "sourceRoots",
  "aliases",
  "layers",
  "allow",
  "allowSameLayer",
  "slices",
  "roles",
  "atomic",
  "ignore",
];

const validGlobs = (value: unknown): value is string[] => {
  if (!Array.isArray(value)) return false;
  try {
    for (const entry of value) compileGlob(entry as string);
    return true;
  } catch {
    return false;
  }
};

/** Validate and normalise an architecture document (omitted optional lists become empty). */
export function parseArchitectureConfig(raw: unknown): ArchitectureValidation {
  const errors: ArchitectureError[] = [];
  const fail = (pointer: string, message: string): void => {
    errors.push({ pointer, message });
  };
  if (!isRecord(raw))
    return {
      ok: false,
      errors: [{ pointer: "", message: "architecture config must be an object" }],
    };
  for (const key of Object.keys(raw)) if (!KEYS.includes(key)) fail(`/${key}`, "unknown key");
  if (raw.schemaVersion !== 1) fail("/schemaVersion", "schemaVersion must be 1");
  const sourceRoots = raw.sourceRoots ?? ["src"];
  if (
    !Array.isArray(sourceRoots) ||
    !sourceRoots.every(
      (r) => typeof r === "string" && r.length > 0 && !r.startsWith("/") && !r.includes(".."),
    )
  )
    fail("/sourceRoots", "must be an array of relative directories");
  if (raw.aliases !== undefined && raw.aliases !== "tsconfig" && raw.aliases !== "none")
    fail("/aliases", "must be tsconfig or none");
  const layers: ArchitectureLayer[] = [];
  const names = new Set<string>();
  if (!Array.isArray(raw.layers) || raw.layers.length === 0)
    fail("/layers", "layers must be a non-empty array");
  else
    raw.layers.forEach((layer: unknown, index: number) => {
      if (
        !isRecord(layer) ||
        typeof layer.name !== "string" ||
        !/^[a-z][a-z0-9-]*$/.test(layer.name) ||
        !validGlobs(layer.paths) ||
        (layer.paths as string[]).length === 0
      ) {
        fail(
          `/layers/${index}`,
          "layer needs a lowercase name and a non-empty list of valid globs",
        );
        return;
      }
      if (names.has(layer.name)) fail(`/layers/${index}/name`, "duplicate layer name");
      names.add(layer.name);
      layers.push({ name: layer.name, paths: layer.paths as string[] });
    });
  const allow: Record<string, string[]> = {};
  if (!isRecord(raw.allow)) fail("/allow", "allow must be an object");
  else
    for (const [layer, targets] of Object.entries(raw.allow)) {
      if (!names.has(layer)) fail(`/allow/${layer}`, "unknown layer");
      else if (
        !Array.isArray(targets) ||
        !targets.every((t) => typeof t === "string" && names.has(t))
      )
        fail(`/allow/${layer}`, "must list known layers");
      else allow[layer] = targets as string[];
    }
  const allowSameLayer = raw.allowSameLayer ?? [];
  if (
    !Array.isArray(allowSameLayer) ||
    !allowSameLayer.every((t) => typeof t === "string" && names.has(t))
  )
    fail("/allowSameLayer", "must list known layers");
  let slices: ArchitectureConfig["slices"];
  if (raw.slices !== undefined && raw.slices !== null) {
    const s = raw.slices;
    if (
      !isRecord(s) ||
      !Array.isArray(s.layers) ||
      !s.layers.every((l) => typeof l === "string" && names.has(l)) ||
      !Number.isInteger(s.depth) ||
      (s.depth as number) < 1 ||
      !Array.isArray(s.publicApi) ||
      !s.publicApi.every((f) => typeof f === "string")
    )
      fail("/slices", "slices needs known layers, an integer depth >= 1 and a publicApi file list");
    else
      slices = {
        layers: s.layers as string[],
        depth: s.depth as number,
        publicApi: s.publicApi as string[],
      };
  }
  let roles: ArchitectureConfig["roles"];
  if (raw.roles !== undefined && raw.roles !== null) {
    const r = raw.roles;
    if (
      !isRecord(r) ||
      !validGlobs(r.presentational) ||
      !Array.isArray(r.forbiddenForPresentational) ||
      !r.forbiddenForPresentational.every((f) => typeof f === "string")
    )
      fail("/roles", "roles needs presentational globs and a forbiddenForPresentational list");
    else
      roles = {
        presentational: r.presentational as string[],
        forbiddenForPresentational: r.forbiddenForPresentational as string[],
      };
  }
  let atomic: ArchitectureConfig["atomic"] = null;
  if (raw.atomic !== undefined && raw.atomic !== null) {
    const a = raw.atomic;
    if (
      !isRecord(a) ||
      !Array.isArray(a.levels) ||
      !a.levels.every((l) => typeof l === "string") ||
      !isRecord(a.paths)
    )
      fail("/atomic", "atomic needs levels and paths");
    else {
      const paths: Record<string, string[]> = {};
      for (const [level, globs] of Object.entries(a.paths)) {
        if (!(a.levels as string[]).includes(level) || !validGlobs(globs))
          fail(`/atomic/paths/${level}`, "must name a known level with valid globs");
        else paths[level] = globs as string[];
      }
      atomic = { levels: a.levels as string[], paths };
    }
  }
  const ignore = raw.ignore ?? [];
  if (!validGlobs(ignore)) fail("/ignore", "must be an array of valid globs");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    config: {
      schemaVersion: 1,
      ...(typeof raw.preset === "string" ? { preset: raw.preset } : {}),
      sourceRoots: sourceRoots as string[],
      ...(raw.aliases ? { aliases: raw.aliases as "tsconfig" | "none" } : {}),
      layers,
      allow,
      allowSameLayer: allowSameLayer as string[],
      ...(slices ? { slices } : {}),
      ...(roles ? { roles } : {}),
      atomic,
      ignore: ignore as string[],
    },
  };
}
