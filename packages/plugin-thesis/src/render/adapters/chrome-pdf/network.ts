import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Network policy of the Chrome fallback (spec 10.7, 12). The page loads nothing from the network:
 * every request Chrome is about to make is checked here and only `file://` URLs inside the build
 * directory (plus inline `data:`, `blob:` and `about:` URLs) are allowed.
 */
export function isRequestAllowed(url: string, buildDir: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:" || parsed.protocol === "about:") {
    return true;
  }
  if (parsed.protocol !== "file:") return false;
  if (parsed.hostname !== "") return false;
  let path: string;
  try {
    path = resolve(fileURLToPath(parsed));
  } catch {
    return false;
  }
  const inside = relative(resolve(buildDir), path);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}
