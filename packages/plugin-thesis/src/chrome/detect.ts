import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Chrome-family detection ported from scripts/render-diagrams.mjs: explicit overrides, known
 * install locations, then a PATH lookup that never opens a shell. Nothing is ever downloaded.
 */
export interface ChromeDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
  exists(path: string): boolean;
  which(name: string): Promise<string | undefined>;
}

export interface ChromeDetection {
  browser: string | null;
  source: "ALISIO_THESIS_CHROME" | "PUPPETEER_EXECUTABLE_PATH" | "known-path" | "path" | null;
}

export function knownBrowserPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const candidates: string[] = [];
  if (platform === "win32") {
    const bases = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(
      (value): value is string => Boolean(value),
    );
    const relatives = [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
      ["Chromium", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
    ];
    for (const base of bases)
      for (const relative of relatives) candidates.push(join(base, ...relative));
  } else if (platform === "darwin") {
    const bases = ["/Applications", join(home, "Applications")];
    const relatives = [
      ["Google Chrome.app", "Contents", "MacOS", "Google Chrome"],
      ["Brave Browser.app", "Contents", "MacOS", "Brave Browser"],
      ["Chromium.app", "Contents", "MacOS", "Chromium"],
      ["Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"],
    ];
    for (const base of bases)
      for (const relative of relatives) candidates.push(join(base, ...relative));
  } else {
    const directories = [
      "/usr/bin",
      "/usr/local/bin",
      "/opt/google/chrome",
      "/snap/bin",
      "/var/lib/flatpak/exports/bin",
      join(home, ".local", "bin"),
    ];
    const names = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "brave-browser",
      "microsoft-edge",
      "microsoft-edge-stable",
      "com.brave.Browser",
      "com.google.Chrome",
      "org.chromium.Chromium",
      "chrome",
    ];
    for (const directory of directories)
      for (const name of names) candidates.push(join(directory, name));
  }
  return candidates;
}

export function pathBrowserNames(platform: NodeJS.Platform): string[] {
  if (platform === "win32") return ["chrome", "brave", "msedge", "chromium"];
  return [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "brave-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
  ];
}

async function defaultWhich(name: string): Promise<string | undefined> {
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(lookup, [name], { encoding: "utf8", timeout: 5000 });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

export async function detectChrome(overrides: Partial<ChromeDeps> = {}): Promise<ChromeDetection> {
  const deps: ChromeDeps = {
    env: process.env,
    platform: process.platform,
    home: homedir(),
    exists: existsSync,
    which: defaultWhich,
    ...overrides,
  };
  // `ALISIO_THESIS_CHROME=off` turns the Chrome fallback off (for example in tests or CI).
  if (/^(off|none|0|false)$/i.test(deps.env.ALISIO_THESIS_CHROME ?? "")) {
    return { browser: null, source: null };
  }
  for (const key of ["ALISIO_THESIS_CHROME", "PUPPETEER_EXECUTABLE_PATH"] as const) {
    const value = deps.env[key];
    if (value && deps.exists(value)) return { browser: value, source: key };
  }
  for (const candidate of new Set(knownBrowserPaths(deps.platform, deps.env, deps.home))) {
    if (deps.exists(candidate)) return { browser: candidate, source: "known-path" };
  }
  for (const name of pathBrowserNames(deps.platform)) {
    const found = await deps.which(name);
    if (found) return { browser: found, source: "path" };
  }
  return { browser: null, source: null };
}
