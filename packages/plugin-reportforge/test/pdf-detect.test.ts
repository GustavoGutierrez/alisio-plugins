import { describe, expect, it } from "vitest";
import {
  ENV_OVERRIDES,
  expandEnv,
  findBrowser,
  knownBrowserPaths,
  pathBrowserNames,
} from "../src/pdf/detect.js";

const only =
  (...present: string[]) =>
  async (path: string) =>
    present.includes(path);
const noPath = async () => undefined;

describe("browser discovery", () => {
  it("prefers an explicit override that exists", async () => {
    expect(ENV_OVERRIDES[0]).toBe("ALISIO_REPORTFORGE_CHROME");
    const found = await findBrowser({
      platform: "linux",
      env: { ALISIO_REPORTFORGE_CHROME: "/opt/custom/chrome", CHROME_PATH: "/other" },
      exists: only("/opt/custom/chrome", "/usr/bin/google-chrome"),
      pathLookup: noPath,
    });
    expect(found).toEqual({ path: "/opt/custom/chrome", source: "env" });
  });

  it("ignores an override that does not exist and falls back to known paths", async () => {
    const found = await findBrowser({
      platform: "linux",
      env: { CHROME_PATH: "/missing" },
      exists: only("/usr/bin/chromium"),
      pathLookup: noPath,
    });
    expect(found).toEqual({ path: "/usr/bin/chromium", source: "known-path" });
  });

  it("finds Chrome, Edge, Brave, Vivaldi and Opera on macOS", async () => {
    const paths = knownBrowserPaths("darwin");
    for (const name of [
      "Google Chrome",
      "Chromium",
      "Microsoft Edge",
      "Brave Browser",
      "Vivaldi",
      "Opera",
    ]) {
      expect(paths.some((p) => p.includes(`${name}.app`))).toBe(true);
    }
    const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    const found = await findBrowser({
      platform: "darwin",
      env: {},
      exists: only(edge),
      pathLookup: noPath,
    });
    expect(found.path).toBe(edge);
  });

  it("expands Windows placeholders and finds Edge in Program Files (x86)", async () => {
    const env = {
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramFiles: "C:\\Program Files",
    };
    const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    const found = await findBrowser({
      platform: "win32",
      env,
      exists: only(edge),
      pathLookup: noPath,
    });
    expect(found).toEqual({ path: edge, source: "known-path" });
    expect(expandEnv("%LOCALAPPDATA%\\x", {})).toBe("\\x");
  });

  it("skips Windows paths whose placeholder is not set", async () => {
    const seen: string[] = [];
    await findBrowser({
      platform: "win32",
      env: {},
      exists: async (p) => {
        seen.push(p);
        return false;
      },
      pathLookup: noPath,
    });
    expect(seen.every((p) => !p.startsWith("\\"))).toBe(true);
  });

  it("looks the browser up on PATH last", async () => {
    const looked: string[] = [];
    const found = await findBrowser({
      platform: "linux",
      env: {},
      exists: async () => false,
      pathLookup: async (name) => {
        looked.push(name);
        return name === "brave-browser" ? "/home/u/bin/brave-browser" : undefined;
      },
    });
    expect(found).toEqual({ path: "/home/u/bin/brave-browser", source: "path" });
    expect(looked[0]).toBe(pathBrowserNames("linux")[0]);
    expect(pathBrowserNames("win32")).toContain("msedge.exe");
  });

  it("reports none when no browser is installed", async () => {
    const found = await findBrowser({
      platform: "linux",
      env: {},
      exists: async () => false,
      pathLookup: noPath,
    });
    expect(found).toEqual({ source: "none" });
  });
});
