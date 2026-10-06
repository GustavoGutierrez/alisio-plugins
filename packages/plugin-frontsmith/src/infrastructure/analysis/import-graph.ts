import type { FileAnalysis } from "../../application/ports/file-analyzer.js";
import type { ImportEdge, ImportGraph } from "../../application/ports/import-graph.js";
import type { WorkspaceFs } from "../../application/ports/workspace-fs.js";
import {
  normalizePath,
  type PathMapping,
  type ResolveContext,
  resolveSpecifier,
} from "../../domain/imports/resolve.js";
import { parseJsonc } from "../../domain/jsonc.js";

interface TsConfigFacts {
  baseUrl?: string;
  paths?: PathMapping[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dirOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

async function readJson(
  fs: WorkspaceFs,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const read = await fs.read(path);
    if (read.kind !== "text") return undefined;
    const parsed = parseJsonc(read.text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `paths` and `baseUrl` of a tsconfig, following relative `extends` (child wins, paths replaced). */
async function readTsConfig(fs: WorkspaceFs, path: string, depth = 0): Promise<TsConfigFacts> {
  const raw = await readJson(fs, path);
  if (!raw) return {};
  let facts: TsConfigFacts = {};
  const extended = raw.extends;
  if (typeof extended === "string" && extended.startsWith(".") && depth < 5) {
    const target = normalizePath(`${dirOf(path)}/${extended}`);
    if (target) {
      const withJson = target.endsWith(".json") ? target : `${target}.json`;
      facts = await readTsConfig(fs, withJson, depth + 1);
    }
  }
  const options = isRecord(raw.compilerOptions) ? raw.compilerOptions : {};
  const here = dirOf(path);
  if (typeof options.baseUrl === "string") {
    const resolved = normalizePath(`${here}/${options.baseUrl}`);
    if (resolved !== undefined) facts = { ...facts, baseUrl: resolved };
  }
  if (isRecord(options.paths)) {
    const root =
      typeof options.baseUrl === "string"
        ? (normalizePath(`${here}/${options.baseUrl}`) ?? here)
        : (facts.baseUrl ?? here);
    facts = {
      ...facts,
      paths: Object.entries(options.paths).flatMap(([pattern, targets]) =>
        Array.isArray(targets)
          ? [
              {
                pattern,
                targets: targets
                  .filter((target): target is string => typeof target === "string")
                  .map((target) => normalizePath(`${root}/${target}`))
                  .filter((target): target is string => target !== undefined),
              },
            ]
          : [],
      ),
    };
  }
  return facts;
}

/** Read `tsconfig.json` (or `jsconfig.json`) and `package.json#imports` into a resolve context. */
export async function loadResolveContext(
  fs: WorkspaceFs,
  files: readonly string[],
): Promise<ResolveContext> {
  let facts = await readTsConfig(fs, "tsconfig.json");
  if (facts.baseUrl === undefined && facts.paths === undefined)
    facts = await readTsConfig(fs, "jsconfig.json");
  const manifest = await readJson(fs, "package.json");
  const imports = isRecord(manifest?.imports) ? manifest.imports : {};
  return {
    files: new Set(files),
    paths: facts.paths ?? [],
    ...(facts.baseUrl !== undefined ? { baseUrl: facts.baseUrl } : {}),
    packageImports: imports,
  };
}

/** Resolve every import of every analysed script piece into a graph. */
export function buildImportGraph(
  analyses: Iterable<FileAnalysis>,
  context: ResolveContext,
): ImportGraph {
  const edges: ImportEdge[] = [];
  const byFile = new Map<string, ImportEdge[]>();
  const files: string[] = [];
  for (const analysis of analyses) {
    files.push(analysis.path);
    const own: ImportEdge[] = [];
    for (const piece of analysis.scripts)
      for (const record of piece.view.imports) {
        own.push({
          from: analysis.path,
          specifier: record.specifier,
          importKind: record.kind,
          typeOnly: record.typeOnly,
          names: record.names,
          line: record.loc.line,
          column: record.loc.column,
          resolution: resolveSpecifier(analysis.path, record.specifier, context),
        });
      }
    byFile.set(analysis.path, own);
    edges.push(...own);
  }
  return { files, edges, byFile };
}
