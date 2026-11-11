/**
 * Finds a local Chromium-family browser (Chrome, Chromium, Edge, Brave, Vivaldi, Opera) to print
 * reports to PDF: explicit environment overrides, then well-known install paths, then `PATH`.
 * Nothing is downloaded or installed.
 *
 * Adapted from plugin-evalua (`src/chrome/detect.ts`, same repository, MIT license); reimplemented
 * here because plugins stay self-contained.
 */
import { access, constants } from "node:fs/promises";
import { join } from "node:path";

export interface BrowserDetection {
  path?: string;
  source: "env" | "known-path" | "path" | "none";
}

export interface DetectDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => Promise<boolean>;
  pathLookup: (name: string) => Promise<string | undefined>;
}

export const ENV_OVERRIDES = [
  "ALISIO_REPORTFORGE_CHROME",
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROME_PATH",
] as const;

export function knownBrowserPaths(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
      "/Applications/Opera.app/Contents/MacOS/Opera",
    ];
  }
  if (platform === "win32") {
    return [
      "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe",
      "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe",
      "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe",
      "%ProgramFiles%\\Chromium\\Application\\chrome.exe",
      "%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe",
      "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe",
      "%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      "%ProgramFiles%\\Vivaldi\\Application\\vivaldi.exe",
      "%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe",
      "%ProgramFiles%\\Opera\\opera.exe",
      "%LOCALAPPDATA%\\Programs\\Opera\\opera.exe",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/var/lib/flatpak/exports/bin/com.google.Chrome",
    "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/brave-browser",
    "/usr/bin/brave",
    "/snap/bin/brave",
    "/usr/bin/vivaldi",
    "/usr/bin/vivaldi-stable",
    "/usr/bin/opera",
  ];
}

export function pathBrowserNames(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return ["chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe"];
  }
  return [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "brave-browser",
    "brave",
    "vivaldi",
    "vivaldi-stable",
    "opera",
  ];
}

/** Expands Windows `%VAR%` placeholders (e.g. `%ProgramFiles%`); unset ones become empty. */
export function expandEnv(path: string, env: NodeJS.ProcessEnv): string {
  return path.replace(/%([^%]+)%/g, (_match, name: string) => env[name] ?? "");
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function lookupOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  const directories = (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean);
  for (const directory of directories) {
    const candidate = join(directory, name);
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

/** Finds a Chromium-family browser without downloading one. */
export async function findBrowser(overrides: Partial<DetectDeps> = {}): Promise<BrowserDetection> {
  const platform = overrides.platform ?? process.platform;
  const env = overrides.env ?? process.env;
  const exists = overrides.exists ?? executable;
  const pathLookup = overrides.pathLookup ?? ((name: string) => lookupOnPath(name, env, platform));

  for (const name of ENV_OVERRIDES) {
    const value = env[name]?.trim();
    if (value && (await exists(value))) return { path: value, source: "env" };
  }
  for (const template of knownBrowserPaths(platform)) {
    // A path whose placeholder is unset would resolve relative to the drive root: skip it.
    const unresolved = (template.match(/%([^%]+)%/g) ?? []).some(
      (token) => !env[token.slice(1, -1)],
    );
    if (unresolved) continue;
    const path = expandEnv(template, env);
    if (await exists(path)) return { path, source: "known-path" };
  }
  for (const name of pathBrowserNames(platform)) {
    const found = await pathLookup(name);
    if (found !== undefined) return { path: found, source: "path" };
  }
  return { source: "none" };
}
