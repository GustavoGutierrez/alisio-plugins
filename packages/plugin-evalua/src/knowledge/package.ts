import { fileURLToPath } from "node:url";

/**
 * The shipped knowledge packs directory. Resolves to the same `knowledge/packs` folder from
 * both the source tree (`src/knowledge/`) and the build output (`dist/knowledge/`).
 */
export function shippedKnowledgeDir(): string {
  return fileURLToPath(new URL("../../knowledge/packs/", import.meta.url));
}

/** The shipped quotes catalogue directory (`knowledge/quotes`). */
export function shippedQuotesDir(): string {
  return fileURLToPath(new URL("../../knowledge/quotes/", import.meta.url));
}

/** The shipped document themes directory (`templates/themes`). */
export function shippedThemesDir(): string {
  return fileURLToPath(new URL("../../templates/themes/", import.meta.url));
}

/** The shipped locale directory (`knowledge/locales`). */
export function shippedLocalesDir(): string {
  return fileURLToPath(new URL("../../knowledge/locales/", import.meta.url));
}
