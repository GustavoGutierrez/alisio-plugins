import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type StackAdapter, validateAdapter } from "../../domain/stack/adapter.js";

/** Package root: `src/infrastructure/packs` and `dist/infrastructure/packs` are equally deep. */
export const packageRoot = (): string => fileURLToPath(new URL("../../../", import.meta.url));

/** Load and validate every shipped `adapters/*.json`; an invalid file is a packaging bug. */
export async function loadShippedAdapters(root = packageRoot()): Promise<StackAdapter[]> {
  const directory = join(root, "adapters");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const adapters: StackAdapter[] = [];
  for (const name of names) {
    const parsed: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
    const result = validateAdapter(parsed);
    if (!result.ok)
      throw new Error(
        `Shipped adapter ${name} is invalid: ${result.errors.map((e) => `${e.pointer} ${e.message}`).join("; ")}`,
      );
    if (result.adapter.id !== basename(name, ".json"))
      throw new Error(`Shipped adapter ${name} declares id ${result.adapter.id}`);
    adapters.push(result.adapter);
  }
  return adapters;
}
