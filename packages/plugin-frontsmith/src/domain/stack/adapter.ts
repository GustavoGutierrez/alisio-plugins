import { compileGlob } from "../glob.js";
import { isPackId } from "../ids.js";

export const templateKinds = ["jsx", "vue-sfc", "svelte", "angular", "astro", "html"] as const;
export type AdapterTemplateKind = (typeof templateKinds)[number];

/** A stack adapter is data: globs, packs and template kind for one framework (spec 15.2). */
export interface StackAdapter {
  schemaVersion: 1;
  id: string;
  extends: string | null;
  detect: { dependencies?: string[]; files?: string[] };
  sourceGlobs: string[];
  templates: { kind: AdapterTemplateKind; globs: string[] };
  componentApi: "react" | "none";
  testGlobs: string[];
  packs: string[];
  commands: { testRelated: string[] | null };
}

export interface AdapterError {
  pointer: string;
  message: string;
}

export type AdapterValidation =
  | { ok: true; adapter: StackAdapter }
  | { ok: false; errors: AdapterError[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ADAPTER_ID = /^[a-z][a-z0-9-]{1,30}$/;

export function validateAdapter(raw: unknown): AdapterValidation {
  const errors: AdapterError[] = [];
  const fail = (pointer: string, message: string): void => {
    errors.push({ pointer, message });
  };
  if (!isRecord(raw))
    return { ok: false, errors: [{ pointer: "", message: "adapter must be an object" }] };
  const allowed = [
    "schemaVersion",
    "id",
    "extends",
    "detect",
    "sourceGlobs",
    "templates",
    "componentApi",
    "testGlobs",
    "packs",
    "commands",
  ];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) fail(`/${key}`, "unknown key");
  if (raw.schemaVersion !== 1) fail("/schemaVersion", "schemaVersion must be 1");
  if (typeof raw.id !== "string" || !ADAPTER_ID.test(raw.id)) fail("/id", "invalid adapter id");
  if (raw.extends !== null && (typeof raw.extends !== "string" || !ADAPTER_ID.test(raw.extends)))
    fail("/extends", "extends must be null or an adapter id");
  const globs = (value: unknown, pointer: string): void => {
    if (!Array.isArray(value)) {
      fail(pointer, "must be an array of globs");
      return;
    }
    value.forEach((entry, index) => {
      try {
        if (typeof entry !== "string") throw new Error("not a string");
        compileGlob(entry);
      } catch {
        fail(`${pointer}/${index}`, "invalid glob");
      }
    });
  };
  if (!isRecord(raw.detect)) fail("/detect", "detect must be an object");
  else {
    for (const key of Object.keys(raw.detect))
      if (key !== "dependencies" && key !== "files") fail(`/detect/${key}`, "unknown key");
    if (
      "dependencies" in raw.detect &&
      !(
        Array.isArray(raw.detect.dependencies) &&
        raw.detect.dependencies.every((d) => typeof d === "string")
      )
    )
      fail("/detect/dependencies", "must be an array of package names");
    if ("files" in raw.detect) globs(raw.detect.files, "/detect/files");
  }
  globs(raw.sourceGlobs, "/sourceGlobs");
  globs(raw.testGlobs, "/testGlobs");
  if (!isRecord(raw.templates)) fail("/templates", "templates must be an object");
  else {
    if (!(templateKinds as readonly unknown[]).includes(raw.templates.kind))
      fail("/templates/kind", "unknown template kind");
    globs(raw.templates.globs, "/templates/globs");
  }
  if (raw.componentApi !== "react" && raw.componentApi !== "none")
    fail("/componentApi", "componentApi must be react or none");
  if (!Array.isArray(raw.packs)) fail("/packs", "must be an array");
  else
    raw.packs.forEach((pack, index) => {
      if (!isPackId(pack)) fail(`/packs/${index}`, "invalid pack id");
    });
  if (!isRecord(raw.commands)) fail("/commands", "commands must be an object");
  else {
    const related = raw.commands.testRelated;
    if (
      related !== null &&
      !(
        Array.isArray(related) &&
        related.length > 0 &&
        related.every((v) => typeof v === "string" && v.length > 0)
      )
    )
      fail("/commands/testRelated", "must be null or a non-empty argv array");
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, adapter: raw as unknown as StackAdapter };
}

export interface ResolveAdapterOptions {
  /** A workspace adapter may not introduce a template kind its ancestors do not have. */
  workspace?: boolean;
}

/** Flatten `extends`: child fields replace the parent's. */
export function resolveAdapter(
  id: string,
  adapters: readonly StackAdapter[],
  options: ResolveAdapterOptions = {},
): StackAdapter {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  const chain: StackAdapter[] = [];
  let current = byId.get(id);
  if (!current) throw new Error(`Adapter ${id} is unknown`);
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) throw new Error(`Adapter extends cycle through ${current.id}`);
    seen.add(current.id);
    chain.unshift(current);
    if (current.extends === null) break;
    const parent: StackAdapter | undefined = byId.get(current.extends);
    if (!parent)
      throw new Error(`Adapter ${current.id} extends unknown adapter ${current.extends}`);
    current = parent;
  }
  if (options.workspace && chain.length > 1) {
    const kinds = new Set(chain.slice(0, -1).map((adapter) => adapter.templates.kind));
    const own = (chain[chain.length - 1] as StackAdapter).templates.kind;
    if (!kinds.has(own)) throw new Error(`Adapter ${id} cannot add the template kind ${own}`);
  }
  const resolved: StackAdapter = { ...(chain[0] as StackAdapter) };
  for (const adapter of chain.slice(1)) Object.assign(resolved, adapter);
  return { ...resolved, id, extends: null };
}

export interface SelectOptions {
  enable?: readonly string[];
  disable?: readonly string[];
}

/** Resolved adapters whose detection matches the workspace, sorted by id. */
export function selectAdapters(
  adapters: readonly StackAdapter[],
  dependencies: ReadonlySet<string>,
  files: readonly string[],
  options: SelectOptions = {},
): StackAdapter[] {
  const disabled = new Set(options.disable ?? []);
  const enabled = new Set(options.enable ?? []);
  const selected: StackAdapter[] = [];
  for (const adapter of adapters) {
    if (disabled.has(adapter.id)) continue;
    const byDependency = (adapter.detect.dependencies ?? []).some((name) => dependencies.has(name));
    const byFiles = (adapter.detect.files ?? []).some((pattern) => {
      const test = compileGlob(pattern);
      return files.some(test);
    });
    if (enabled.has(adapter.id) || byDependency || byFiles)
      selected.push(resolveAdapter(adapter.id, adapters));
  }
  return selected.sort((a, b) => a.id.localeCompare(b.id));
}
