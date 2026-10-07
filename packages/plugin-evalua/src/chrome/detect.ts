import { access, constants } from "node:fs/promises";
import { join, sep } from "node:path";

/** Chrome-family detection (spec 10.4): env overrides, known paths, then `PATH`. Nothing is downloaded. */

export interface ChromeDetection {
  path?: string;
  source: "env" | "known-path" | "path" | "none";
  detail?: string;
}

export interface ChromeDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => Promise<boolean>;
  pathLookup: (name: string) => Promise<string | undefined>;
}

export const ENV_OVERRIDES = [
  "ALISIO_EVALUA_CHROME",
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROME_PATH",
] as const;

export function knownBrowserPaths(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  if (platform === "win32") {
    return [
      "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
      "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
      "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
      "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/var/lib/flatpak/exports/bin/com.google.Chrome",
  ];
}

export function pathBrowserNames(platform: NodeJS.Platform): string[] {
  const names =
    platform === "win32"
      ? ["chrome.exe", "msedge.exe"]
      : platform === "darwin"
        ? ["google-chrome", "chromium"]
        : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  return names;
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Expands Windows `%VAR%` placeholders (e.g. `%ProgramFiles%`) so known paths resolve. */
export function expandEnv(path: string, env: NodeJS.ProcessEnv): string {
  return path.replace(/%([^%]+)%/g, (_match, name: string) => env[name] ?? "");
}

async function defaultPathLookup(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const directories = (env.PATH ?? "").split(sep === "\\" ? ";" : ":").filter(Boolean);
  for (const directory of directories) {
    const candidate = join(directory, name);
    if (await defaultExists(candidate)) return candidate;
  }
  return undefined;
}

/** Finds a Chrome-family browser without downloading one. */
export async function detectChrome(overrides: Partial<ChromeDeps> = {}): Promise<ChromeDetection> {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? process.env;
  const exists = overrides.exists ?? defaultExists;
  const pathLookup = overrides.pathLookup ?? ((name: string) => defaultPathLookup(name, env));

  for (const name of ENV_OVERRIDES) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "" && (await exists(value))) {
      return { path: value, source: "env", detail: name };
    }
  }
  for (const path of knownBrowserPaths(platform)) {
    const expanded = expandEnv(path, env);
    if (await exists(expanded)) return { path: expanded, source: "known-path", detail: expanded };
  }
  for (const name of pathBrowserNames(platform)) {
    const found = await pathLookup(name);
    if (found !== undefined) return { path: found, source: "path", detail: name };
  }
  return { source: "none" };
}
