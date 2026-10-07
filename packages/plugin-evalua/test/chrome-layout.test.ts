import { describe, expect, it } from "vitest";
import { detectChrome, knownBrowserPaths } from "../src/chrome/detect.js";
import { buildLayoutReport, choosePreset, countPdfPages } from "../src/layout.js";

describe("detectChrome", () => {
  const none = { exists: async () => false, pathLookup: async () => undefined };

  it("prefers an environment override", async () => {
    const result = await detectChrome({
      platform: "linux",
      env: { ALISIO_EVALUA_CHROME: "/opt/chrome" },
      exists: async (path) => path === "/opt/chrome",
      pathLookup: async () => undefined,
    });
    expect(result).toMatchObject({ path: "/opt/chrome", source: "env" });
  });

  it("falls back to a known path and then PATH", async () => {
    const known = await detectChrome({
      platform: "linux",
      env: {},
      exists: async (path) => path === "/usr/bin/google-chrome",
      pathLookup: async () => undefined,
    });
    expect(known).toMatchObject({ path: "/usr/bin/google-chrome", source: "known-path" });

    const onPath = await detectChrome({
      platform: "linux",
      env: {},
      ...none,
      pathLookup: async (name) => (name === "chromium" ? "/custom/chromium" : undefined),
    });
    expect(onPath).toMatchObject({ path: "/custom/chromium", source: "path" });
  });

  it("reports none when nothing is found", async () => {
    expect(await detectChrome({ platform: "linux", env: {}, ...none })).toEqual({ source: "none" });
    expect(knownBrowserPaths("darwin")[0]).toContain("Google Chrome");
  });
});

describe("countPdfPages", () => {
  it("counts leaf pages and cross-checks the page tree", () => {
    const bytes = Buffer.from("/Type /Pages 1 0 R /Type /Page /Type /Page /Count 2");
    expect(countPdfPages(bytes)).toEqual({ leafPages: 2, maxCount: 2, agreement: true });
  });

  it("flags a disagreement between the leaf count and the page tree", () => {
    const bytes = Buffer.from("/Type /Page /Count 5");
    expect(countPdfPages(bytes)).toEqual({ leafPages: 1, maxCount: 5, agreement: false });
  });
});

describe("choosePreset", () => {
  const counts = new Map([
    ["comfortable", 5],
    ["regular", 4],
    ["compact", 3],
    ["tight", 3],
    ["minimum", 2],
  ]);

  it("picks the fewest pages for auto", () => {
    const result = choosePreset({ pageCounts: counts, maxPages: "auto" });
    expect(result.preset?.id).toBe("minimum");
    expect(result.pages).toBe(2);
  });

  it("picks the most comfortable preset within the budget", () => {
    expect(choosePreset({ pageCounts: counts, maxPages: 3 }).preset?.id).toBe("compact");
    expect(choosePreset({ pageCounts: counts, maxPages: 4 }).preset?.id).toBe("regular");
  });

  it("reports a failure with concrete options when the budget is unreachable", () => {
    const result = choosePreset({ pageCounts: counts, maxPages: 1 });
    expect(result.preset).toBeUndefined();
    expect(result.failure?.smallestReached).toBe(2);
    expect(result.failure?.options.length).toBeGreaterThan(0);
  });

  it("builds the layout report only for a chosen preset", () => {
    const chosen = choosePreset({ pageCounts: counts, maxPages: "auto" });
    const report = buildLayoutReport({
      chosen,
      pageCounts: counts,
      engineVersion: "Chrome/154",
      maxPages: "auto",
    });
    expect(report).toMatchObject({ preset: "minimum", pages: 2, engineVersion: "Chrome/154" });
    expect(
      buildLayoutReport({
        chosen: choosePreset({ pageCounts: counts, maxPages: 1 }),
        pageCounts: counts,
        engineVersion: "Chrome/154",
        maxPages: 1,
      }),
    ).toBeUndefined();
  });
});
