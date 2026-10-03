import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Create a directory tree with owner-only access. */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

/**
 * Durable atomic write: temp file in the same directory, `fsync`, rename. The file is `0600`
 * and its directory `0700` when created here.
 */
export async function atomicWriteFile(path: string, data: string, mode = 0o600): Promise<void> {
  const dir = dirname(path);
  await ensurePrivateDir(dir);
  const temp = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(temp, "wx", mode);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
