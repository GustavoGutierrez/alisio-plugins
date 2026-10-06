import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A throwaway workspace under the OS temp directory; `files` maps relative paths to content. */
export interface TempWorkspace {
  root: string;
  write(relative: string, content: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function tempWorkspace(files: Record<string, string> = {}): Promise<TempWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "frontsmith-test-"));
  const write = async (relative: string, content: string): Promise<string> => {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    return target;
  };
  for (const [relative, content] of Object.entries(files)) await write(relative, content);
  return { root, write, cleanup: () => rm(root, { recursive: true, force: true }) };
}
