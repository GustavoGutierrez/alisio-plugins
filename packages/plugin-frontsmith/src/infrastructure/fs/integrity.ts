import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { IntegrityReader } from "../../application/ports/integrity.js";

const MAX_ENTRIES = 5_000;

async function digestPath(absolute: string): Promise<string | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(absolute);
  } catch {
    return undefined;
  }
  if (info.isSymbolicLink()) return `link:${await readlink(absolute)}`;
  if (!info.isFile()) return undefined;
  const mode = (info.mode & 0o7777).toString(8).padStart(4, "0");
  const hash = createHash("sha256")
    .update(await readFile(absolute))
    .digest("hex");
  return `file:${mode}:${hash}`;
}

export class FsIntegrityReader implements IntegrityReader {
  async digestFile(root: string, relative: string): Promise<string | undefined> {
    return digestPath(join(root, relative));
  }

  async digestTree(root: string, directory: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (relative: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(join(root, relative), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (Object.keys(out).length >= MAX_ENTRIES) return;
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await walk(child);
        else {
          const digest = await digestPath(join(root, child));
          if (digest !== undefined) out[child] = digest;
        }
      }
    };
    await walk(directory);
    return out;
  }
}
