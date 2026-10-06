import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isPackId } from "../../domain/ids.js";
import type { PackDef } from "../../domain/rules/model.js";
import {
  type EngineParamValidators,
  type PackDiagnostic,
  validatePack,
} from "../../domain/rules/pack-validate.js";
import { packageRoot } from "./adapter-loader.js";

const MAX_PACK_BYTES = 1024 * 1024;

async function readPack(path: string): Promise<unknown> {
  const info = await stat(path);
  if (info.size > MAX_PACK_BYTES)
    throw new Error(`pack file is larger than ${MAX_PACK_BYTES} bytes`);
  return JSON.parse(await readFile(path, "utf8"));
}

/** Load every shipped `rule-packs/<id>/pack.json`; an invalid shipped pack is a packaging bug. */
export async function loadShippedPacks(
  validators: EngineParamValidators,
  root = packageRoot(),
): Promise<PackDef[]> {
  const base = join(root, "rule-packs");
  const names = (await readdir(base, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const packs: PackDef[] = [];
  for (const name of names) {
    const result = validatePack(await readPack(join(base, name, "pack.json")), {
      scope: "shipped",
      validators,
    });
    if (!result.ok)
      throw new Error(
        `Shipped pack ${name} is invalid: ${result.diagnostics.map((d) => `${d.code} ${d.where} ${d.message}`).join("; ")}`,
      );
    if (result.pack.packId !== name)
      throw new Error(`Shipped pack directory ${name} declares packId ${result.pack.packId}`);
    packs.push(result.pack);
  }
  return packs;
}

export interface WorkspacePacks {
  packs: PackDef[];
  diagnostics: PackDiagnostic[];
}

/** Load `.frontsmith/packs/<id>/pack.json`; invalid packs are reported and left out, never executed. */
export async function loadWorkspacePacks(
  workspaceRoot: string,
  validators: EngineParamValidators,
): Promise<WorkspacePacks> {
  const base = join(workspaceRoot, ".frontsmith", "packs");
  let names: string[];
  try {
    names = (await readdir(base, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { packs: [], diagnostics: [] };
  }
  const packs: PackDef[] = [];
  const diagnostics: PackDiagnostic[] = [];
  for (const name of names) {
    if (!isPackId(name)) {
      diagnostics.push({
        code: "PCK-001",
        pack: name,
        where: "",
        message: "pack directory name is not a valid pack id",
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = await readPack(join(base, name, "pack.json"));
    } catch (error) {
      diagnostics.push({
        code: "PCK-001",
        pack: name,
        where: "pack.json",
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const result = validatePack(raw, { scope: "workspace", validators });
    if (!result.ok) diagnostics.push(...result.diagnostics);
    else if (result.pack.packId !== name)
      diagnostics.push({
        code: "PCK-001",
        pack: name,
        where: "/packId",
        message: `packId ${result.pack.packId} differs from its directory`,
      });
    else packs.push(result.pack);
  }
  return { packs, diagnostics };
}

/** Pack access for the rules service: shipped packs are cached, workspace packs are re-read. */
export class FsPackStore {
  private cache: Promise<PackDef[]> | undefined;

  constructor(
    private readonly validators: EngineParamValidators,
    private readonly root = packageRoot(),
  ) {}

  shipped(): Promise<PackDef[]> {
    this.cache ??= loadShippedPacks(this.validators, this.root);
    return this.cache;
  }

  workspace(workspaceRoot: string): Promise<WorkspacePacks> {
    return loadWorkspacePacks(workspaceRoot, this.validators);
  }
}
