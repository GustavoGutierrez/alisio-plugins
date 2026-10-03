import { describe, expect, it } from "vitest";
import {
  allowPatterns,
  checkpointBytes,
  digestsEnv,
  MANIFEST,
  type ModelName,
  modelsToInstall,
} from "../src/runtime/manifest.js";

describe("manifest", () => {
  it("pins an exact laya version and a full commit SHA", () => {
    expect(MANIFEST.laya.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(MANIFEST.laya.requirement).toBe(`laya[serve]==${MANIFEST.laya.version}`);
    expect(MANIFEST.hub.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(MANIFEST.hub.repo).toBe("convaiinnovations/laya");
  });

  it("describes every checkpoint file with size and sha256", () => {
    for (const name of Object.keys(MANIFEST.models) as ModelName[]) {
      const files = MANIFEST.models[name].files;
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((f) => f.path === "model.safetensors")).toBe(true);
      for (const file of files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(Number.isInteger(file.size) && file.size > 0).toBe(true);
        expect(file.path.startsWith("/") || file.path.includes("..")).toBe(false);
      }
    }
  });

  it("selects the checkpoints a config needs", () => {
    expect(modelsToInstall("multilingual")).toEqual(["multilingual"]);
    expect(modelsToInstall("english")).toEqual(["english"]);
    expect(modelsToInstall("typed-decisions")).toEqual(["typed-decisions"]);
    expect(modelsToInstall("auto")).toEqual(["english", "multilingual"]);
  });

  it("builds repo-relative allow patterns, including the subfolder", () => {
    const multi = allowPatterns("multilingual");
    expect(multi).toContain("multilingual/model.safetensors");
    expect(multi.every((p) => p.startsWith("multilingual/"))).toBe(true);
    const english = allowPatterns("english");
    expect(english).toContain("model.safetensors");
    expect(english.some((p) => p.startsWith("multilingual/"))).toBe(false);
  });

  it("exposes the multilingual checkpoint size as about 0.67 GB", () => {
    const bytes = checkpointBytes("multilingual");
    expect(bytes).toBeGreaterThan(640_000_000);
    expect(bytes).toBeLessThan(700_000_000);
  });

  it("builds the nested LAYA_SHA256_DIGESTS map keyed by checkpoint name", () => {
    const parsed = JSON.parse(digestsEnv(["multilingual", "english"])) as Record<
      string,
      Record<string, string>
    >;
    expect(Object.keys(parsed).sort()).toEqual(["english", "multilingual"]);
    expect(parsed.multilingual?.["model.safetensors"]).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.multilingual).not.toHaveProperty("multilingual/model.safetensors");
  });

  it("lists the hosts a setup contacts", () => {
    expect(MANIFEST.hosts).toContain("pypi.org");
    expect(MANIFEST.hosts).toContain("huggingface.co");
  });
});
