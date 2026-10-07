import { fileURLToPath } from "node:url";

/**
 * The shipped knowledge packs directory. Resolves to the same `knowledge/packs` folder from
 * both the source tree (`src/knowledge/`) and the build output (`dist/knowledge/`).
 */
export function shippedKnowledgeDir(): string {
  return fileURLToPath(new URL("../../knowledge/packs/", import.meta.url));
}
