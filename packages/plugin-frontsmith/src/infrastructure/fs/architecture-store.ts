import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArchitectureStore } from "../../application/ports/architecture-store.js";
import {
  type ArchitectureConfig,
  parseArchitectureConfig,
} from "../../domain/architecture/config.js";
import type { PresetId } from "../../domain/architecture/presets.js";
import { canonicalJson } from "../../domain/canonical-json.js";
import { packageRoot } from "../packs/adapter-loader.js";
import { atomicWrite, readText } from "./storage.js";

export class FsArchitectureStore implements ArchitectureStore {
  constructor(private readonly root: string = packageRoot()) {}

  async preset(id: PresetId): Promise<ArchitectureConfig> {
    const raw = await readFile(join(this.root, "presets", "architecture", `${id}.json`), "utf8");
    const parsed = parseArchitectureConfig(JSON.parse(raw));
    if (!parsed.ok)
      throw new Error(
        `Shipped preset ${id} is invalid: ${parsed.errors.map((e) => `${e.pointer} ${e.message}`).join("; ")}`,
      );
    return parsed.config;
  }

  async create(root: string, config: ArchitectureConfig): Promise<{ created: boolean }> {
    const target = join(root, ".frontsmith", "architecture.json");
    if ((await readText(target)) !== undefined) return { created: false };
    await atomicWrite(target, canonicalJson(config));
    return { created: true };
  }
}
