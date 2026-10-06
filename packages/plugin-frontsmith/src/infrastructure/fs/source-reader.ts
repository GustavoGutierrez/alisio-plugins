import { readFile, stat } from "node:fs/promises";
import type { SourceRead, SourceReader } from "../../application/ports/source-reader.js";
import { resolveContained } from "./storage.js";

/** Contained read of one regular file: symlink escapes, directories and oversize files are named. */
export class FsSourceReader implements SourceReader {
  async read(root: string, relative: string, maxBytes: number): Promise<SourceRead> {
    let absolute: string;
    try {
      absolute = await resolveContained(root, relative);
    } catch (error) {
      return { kind: "escape", message: error instanceof Error ? error.message : String(error) };
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
      throw error;
    }
    if (!info.isFile()) return { kind: "not-file" };
    if (info.size > maxBytes) return { kind: "too-large", size: info.size };
    const bytes = new Uint8Array(await readFile(absolute));
    if (bytes.byteLength > maxBytes) return { kind: "too-large", size: bytes.byteLength };
    return { kind: "ok", bytes };
  }
}
