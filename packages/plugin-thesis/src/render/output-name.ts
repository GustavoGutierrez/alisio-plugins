import type { RenderOptions } from "./port.js";

/** Output file name for a build scope, inside the build directory: `thesis.pdf`, `thesis-SEC-02.html`. */
export function outputName(
  options: Pick<RenderOptions, "scope" | "section">,
  extension: string,
): string {
  if (options.scope === "approved") return `thesis-approved.${extension}`;
  if (options.scope === "section") {
    const id = (options.section ?? "section").replace(/[^A-Za-z0-9.-]/g, "");
    return `thesis-${id || "section"}.${extension}`;
  }
  return `thesis.${extension}`;
}
