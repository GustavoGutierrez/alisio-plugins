import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./packs/adapter-loader.js";

/** The package version, for reports written by the CLI (the plugin entry passes its own constant). */
export function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}
