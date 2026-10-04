import { describe, expect, it } from "vitest";
import { detectChrome, knownBrowserPaths, pathBrowserNames } from "../src/chrome/detect.js";
import { formatDoctor, parseTypstVersion, runDoctor, typstVersionOk } from "../src/doctor.js";

const base = {
  nodeVersion: "22.19.0",
  detectChrome: async () => ({ browser: null, source: null }),
  listCountries: async () => ["CO"],
  exists: () => true,
};

describe("Typst version detection", () => {
  it("parses and compares versions", () => {
    expect(parseTypstVersion("typst 0.15.1 (abcdef12)")).toEqual([0, 15, 1]);
    expect(parseTypstVersion("nonsense")).toBeUndefined();
    expect(typstVersionOk([0, 15, 0])).toBe(true);
    expect(typstVersionOk([0, 15, 1])).toBe(true);
    expect(typstVersionOk([0, 16, 0])).toBe(true);
    expect(typstVersionOk([1, 0, 0])).toBe(true);
    expect(typstVersionOk([0, 14, 2])).toBe(false);
  });

  it("accepts a new enough typst on PATH and spawns it with an argv array", async () => {
    const calls: [string, string[]][] = [];
    const report = await runDoctor({
      ...base,
      env: {},
      exec: async (command, args) => {
        calls.push([command, args]);
        return "typst 0.15.1 (deadbeef)";
      },
    });
    expect(calls).toEqual([["typst", ["--version"]]]);
    expect(report.items.find((item) => item.id === "typst")).toMatchObject({ status: "ok" });
    expect(report.engineAvailable).toBe(true);
  });

  it("prefers ALISIO_THESIS_TYPST over PATH", async () => {
    const calls: string[] = [];
    await runDoctor({
      ...base,
      env: { ALISIO_THESIS_TYPST: "/opt/typst/bin/typst" },
      exec: async (command) => {
        calls.push(command);
        return "typst 0.15.0";
      },
    });
    expect(calls).toEqual(["/opt/typst/bin/typst"]);
  });

  it("warns about an old version and reports a missing binary", async () => {
    const old = await runDoctor({ ...base, env: {}, exec: async () => "typst 0.14.2" });
    expect(old.items.find((item) => item.id === "typst")).toMatchObject({ status: "warn" });
    expect(old.engineAvailable).toBe(false);
    const missing = await runDoctor({
      ...base,
      env: { ALISIO_THESIS_TYPST: "/nope" },
      exec: async () => {
        throw new Error("ENOENT");
      },
    });
    const item = missing.items.find((entry) => entry.id === "typst");
    expect(item?.status).toBe("missing");
    expect(item?.detail).toMatch(/ALISIO_THESIS_TYPST/);
  });

  it("counts a Chrome fallback as an engine and reports vendored packages", async () => {
    const report = await runDoctor({
      ...base,
      env: {},
      exec: async () => {
        throw new Error("missing");
      },
      detectChrome: async () => ({ browser: "chrome", source: "path" }),
      exists: () => false,
    });
    expect(report.engineAvailable).toBe(true);
    expect(
      report.items
        .filter((item) => item.id.startsWith("typst-package-"))
        .every((item) => item.status === "missing"),
    ).toBe(true);
    expect(report.items.find((item) => item.id === "policy-packs")?.status).toBe("missing");
    expect(formatDoctor(report)).toContain("report only");
  });

  it("flags an unsupported Node.js", async () => {
    const report = await runDoctor({
      ...base,
      nodeVersion: "20.1.0",
      env: {},
      exec: async () => "typst 0.15.1",
    });
    expect(report.items[0]).toMatchObject({ id: "node", status: "warn" });
  });
});

describe("Chrome detection", () => {
  const none = { exists: () => false, which: async () => undefined };

  it("lists platform install paths", () => {
    expect(knownBrowserPaths("linux", {}, "/h")).toContain("/usr/bin/google-chrome");
    expect(knownBrowserPaths("darwin", {}, "/h")).toContain(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(
      knownBrowserPaths("win32", { ProgramFiles: "P" }, "/h").some((path) =>
        path.endsWith("chrome.exe"),
      ),
    ).toBe(true);
    expect(pathBrowserNames("win32")).toContain("msedge");
  });

  it("honours overrides first, then known paths, then PATH", async () => {
    expect(
      await detectChrome({
        ...none,
        platform: "linux",
        env: { ALISIO_THESIS_CHROME: "/x/chrome" },
        exists: (path) => path === "/x/chrome",
      }),
    ).toEqual({ browser: "/x/chrome", source: "ALISIO_THESIS_CHROME" });
    expect(
      await detectChrome({
        ...none,
        platform: "linux",
        env: { PUPPETEER_EXECUTABLE_PATH: "/y/chrome" },
        exists: (path) => path === "/y/chrome",
      }),
    ).toEqual({ browser: "/y/chrome", source: "PUPPETEER_EXECUTABLE_PATH" });
    expect(
      await detectChrome({
        ...none,
        platform: "linux",
        env: {},
        home: "/h",
        exists: (path) => path === "/usr/bin/chromium",
      }),
    ).toEqual({ browser: "/usr/bin/chromium", source: "known-path" });
    expect(
      await detectChrome({
        ...none,
        platform: "linux",
        env: {},
        home: "/h",
        which: async (name) => (name === "brave-browser" ? "/somewhere/brave" : undefined),
      }),
    ).toEqual({ browser: "/somewhere/brave", source: "path" });
    expect(await detectChrome({ ...none, platform: "linux", env: {}, home: "/h" })).toEqual({
      browser: null,
      source: null,
    });
  });

  it("ignores an override that does not exist", async () => {
    expect(
      await detectChrome({
        ...none,
        platform: "linux",
        env: { ALISIO_THESIS_CHROME: "/gone" },
        home: "/h",
      }),
    ).toEqual({ browser: null, source: null });
  });
});
