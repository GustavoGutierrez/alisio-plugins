import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ModelsRuntimeStore,
  RuntimeRead,
} from "../../application/ports/models-runtime-store.js";
import { canonicalJson } from "../../domain/canonical-json.js";
import { atomicWrite, readText } from "./storage.js";

const file = (root: string): string => join(root, ".alisio", "frontsmith", "models.runtime.json");

export class FsModelsRuntimeStore implements ModelsRuntimeStore {
  async read(root: string): Promise<RuntimeRead> {
    const text = await readText(file(root));
    if (text === undefined) return { state: "absent" };
    try {
      return { state: "ok", value: JSON.parse(text) };
    } catch (error) {
      return { state: "invalid", message: error instanceof Error ? error.message : String(error) };
    }
  }

  async write(
    root: string,
    value: { tiers: Record<string, string>; agents: Record<string, string> },
  ): Promise<void> {
    await atomicWrite(file(root), canonicalJson(value));
  }

  async remove(root: string): Promise<boolean> {
    const existed = (await readText(file(root))) !== undefined;
    await rm(file(root), { force: true });
    return existed;
  }
}
