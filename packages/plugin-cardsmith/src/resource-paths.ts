import { fileURLToPath } from "node:url";

/**
 * Absolute path of the package root. Modules under `src/` and `dist/` sit exactly one level below
 * it, so `../` resolves to the same directory in the source tree, in `dist` and in a packed tarball.
 */
export function packageRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

/** Absolute path of a file or directory shipped inside the package. */
export function packagePath(...segments: string[]): string {
  return fileURLToPath(new URL(`../${segments.join("/")}`, import.meta.url));
}
