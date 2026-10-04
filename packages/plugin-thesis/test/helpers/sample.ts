import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtures = join(import.meta.dirname, "..", "fixtures");
const dirs: string[] = [];

/** A scratch copy of the Spanish sample thesis (it is built into, so tests never touch the fixture). */
export async function sampleThesis(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thesis-sample-"));
  dirs.push(dir);
  await cp(join(fixtures, "sample-es"), dir, { recursive: true });
  return dir;
}

export async function cleanSamples(): Promise<void> {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
