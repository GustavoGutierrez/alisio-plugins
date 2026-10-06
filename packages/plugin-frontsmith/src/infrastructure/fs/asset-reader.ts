import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { AssetReader } from "../../application/ports/asset-reader.js";
import { atomicWriteBytes, resolveContained } from "./storage.js";

const MAX_FILES = 20_000;

export class FsAssetReader implements AssetReader {
  async list(root: string, directory: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
      try {
        entries = await readdir(join(root, relative), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= MAX_FILES) return;
        const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") await walk(child);
        } else if (entry.isFile()) out.push(child);
      }
    };
    await walk(directory);
    return out;
  }

  async read(root: string, relative: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(await resolveContained(root, relative));
    } catch {
      return undefined;
    }
  }

  async write(root: string, relative: string, bytes: Uint8Array): Promise<void> {
    await atomicWriteBytes(await resolveContained(root, relative), bytes);
  }

  gzipSize(bytes: Uint8Array): number {
    return gzipSync(bytes, { level: 9 }).length;
  }
}
