import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type {
  ProjectConfigResult,
  ProjectStore,
  RuleCandidate,
} from "../../application/ports/project-store.js";
import {
  type ArchitectureConfig,
  type ArchitectureError,
  parseArchitectureConfig,
} from "../../domain/architecture/config.js";
import { canonicalJson } from "../../domain/canonical-json.js";
import { defaultConfig } from "../../domain/config/defaults.js";
import { validateConfig } from "../../domain/config/validate.js";
import { isPackId } from "../../domain/ids.js";
import type { PackDef, RuleDef } from "../../domain/rules/model.js";
import { validateWaivers, type Waiver, type WaiverError } from "../../domain/rules/waivers.js";
import { atomicWrite, readText, resolveContained } from "./storage.js";

const MAX_JSON_BYTES = 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readJson(
  path: string,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: string } | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  if (text.length > MAX_JSON_BYTES) return { ok: false, reason: "file is larger than 1 MiB" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export class FsProjectStore implements ProjectStore {
  async readConfig(root: string): Promise<ProjectConfigResult> {
    const read = await readJson(join(root, ".frontsmith", "config.json"));
    if (!read) return { config: defaultConfig(), present: false, diagnostics: [] };
    if (!read.ok)
      return {
        config: defaultConfig(),
        present: true,
        diagnostics: [
          {
            code: "CFG-002",
            pointer: "",
            message: `config.json is not valid JSON: ${read.reason}`,
          },
        ],
      };
    const result = validateConfig(read.value);
    return result.ok
      ? { config: result.config, present: true, diagnostics: [] }
      : { config: defaultConfig(), present: true, diagnostics: result.diagnostics };
  }

  async readArchitecture(
    root: string,
  ): Promise<{ config?: ArchitectureConfig; present: boolean; errors: ArchitectureError[] }> {
    const read = await readJson(join(root, ".frontsmith", "architecture.json"));
    if (!read) return { present: false, errors: [] };
    if (!read.ok)
      return {
        present: true,
        errors: [{ pointer: "", message: `architecture.json is not valid JSON: ${read.reason}` }],
      };
    const result = parseArchitectureConfig(read.value);
    return result.ok
      ? { config: result.config, present: true, errors: [] }
      : { present: true, errors: result.errors };
  }

  async readWaivers(root: string): Promise<{ waivers: Waiver[]; errors: WaiverError[] }> {
    const read = await readJson(join(root, ".frontsmith", "waivers.json"));
    if (!read) return { waivers: [], errors: [] };
    if (!read.ok)
      return {
        waivers: [],
        errors: [{ pointer: "", message: `waivers.json is not valid JSON: ${read.reason}` }],
      };
    const result = validateWaivers(read.value);
    return result.ok
      ? { waivers: result.waivers, errors: [] }
      : { waivers: [], errors: result.errors };
  }

  /**
   * Candidates files (spec 7.4, 8.1): one JSON per feature,
   * `{ schemaVersion: 1, feature, candidates: [{ id: "CAND-001", rule: <rule object> }] }`.
   * Files without schemaVersion 1 and entries without a `CAND-NNN` id are ignored; `rule` is
   * validated by the pack validator when a candidate is promoted.
   */
  async readCandidates(root: string): Promise<RuleCandidate[]> {
    const directory = join(root, ".frontsmith", "candidates");
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => extname(name) === ".json").sort();
    } catch {
      return [];
    }
    const out: RuleCandidate[] = [];
    for (const name of names) {
      const read = await readJson(join(directory, name));
      if (
        !read?.ok ||
        !isRecord(read.value) ||
        read.value.schemaVersion !== 1 ||
        !Array.isArray(read.value.candidates)
      )
        continue;
      const feature =
        typeof read.value.feature === "string" ? read.value.feature : name.replace(/\.json$/, "");
      for (const candidate of read.value.candidates)
        if (
          isRecord(candidate) &&
          typeof candidate.id === "string" &&
          /^CAND-\d{3}$/.test(candidate.id) &&
          isRecord(candidate.rule)
        )
          out.push({ id: candidate.id, feature, rule: candidate.rule as unknown as RuleDef });
    }
    return out;
  }

  async readPackFixture(
    root: string,
    packId: string,
    relative: string,
  ): Promise<string | undefined> {
    if (!isPackId(packId)) throw new Error(`Invalid pack id: ${packId}`);
    const base = join(root, ".frontsmith", "packs", packId);
    return readText(await resolveContained(base, relative));
  }

  async readLocalPack(root: string): Promise<PackDef | undefined> {
    const read = await readJson(join(root, ".frontsmith", "packs", "local", "pack.json"));
    return read?.ok ? (read.value as PackDef) : undefined;
  }

  async writeLocalPack(root: string, pack: PackDef): Promise<void> {
    await atomicWrite(
      join(root, ".frontsmith", "packs", "local", "pack.json"),
      canonicalJson(pack),
    );
  }
}
