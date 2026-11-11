/**
 * One JSON file per report (sources included), written atomically (temporary file + rename) with
 * private modes. Deleting renames the file out of the listing first, so a crash never leaves a
 * half-deleted report visible; leftovers are swept on the next start.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Report } from "./types.js";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Our own leftovers: a deletion or a write interrupted by a crash. */
const LEFTOVER = new RegExp(`^${UUID}\\.json\\.[0-9a-f]{12}\\.(deleted|tmp)$`);

export interface ReportSummary {
  id: string;
  name: string;
  type: string;
  updatedAt: string;
  revision: number;
}

export class Store {
  constructor(readonly root: string) {}

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root)) {
      if (LEFTOVER.test(name)) await rm(join(this.root, name), { force: true }).catch(() => {});
    }
  }

  /** Throws `invalid_id` unless `id` is a report id. */
  check(id: string): void {
    this.file(id);
  }

  private file(id: string): string {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("invalid_id");
    return join(this.root, `${id}.json`);
  }

  async list(): Promise<ReportSummary[]> {
    const files = (await readdir(this.root)).filter((name) => ID.test(name.replace(/\.json$/, "")));
    const out: ReportSummary[] = [];
    for (const name of files) {
      try {
        const r = JSON.parse(await readFile(join(this.root, name), "utf8")) as Report;
        out.push({
          id: r.id,
          name: r.name,
          type: r.type,
          updatedAt: r.updatedAt,
          revision: r.revision,
        });
      } catch {
        // A damaged file never hides the other reports.
      }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async get(id: string): Promise<Report> {
    try {
      return JSON.parse(await readFile(this.file(id), "utf8")) as Report;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("report_not_found");
      throw error;
    }
  }

  async put(r: Report): Promise<Report> {
    r.updatedAt = new Date().toISOString();
    const dest = this.file(r.id);
    const temp = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(r, null, 2), { mode: 0o600 });
      await rename(temp, dest);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    return r;
  }

  /**
   * Deletes a report (its sources live in the same file). Only entries of this directory named by
   * a valid id are touched, and a symbolic link is removed itself, never followed.
   */
  async remove(id: string): Promise<void> {
    const dest = this.file(id);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("report_not_found");
      throw error;
    }
    if (info.isDirectory()) throw new Error("invalid_report");
    const grave = `${dest}.${randomBytes(6).toString("hex")}.deleted`;
    await rename(dest, grave);
    await rm(grave, { force: true });
  }
}
