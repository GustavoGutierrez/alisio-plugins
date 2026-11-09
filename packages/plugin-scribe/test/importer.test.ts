import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { importProject } from "../src/importer.js";
import { LIMITS } from "../src/types.js";

const revision = { tex: "\\begin{document}x\\end{document}", bib: "", summary: "s" };
const project = (document: Record<string, unknown>) => ({
  schemaVersion: 1,
  document: { title: "T", revisions: [revision], assets: [], ...document },
});
const textAsset = (bytes: number) => {
  const id = randomUUID();
  return {
    id,
    name: "data.txt",
    path: `assets/${id}.txt`,
    base64: Buffer.alloc(bytes, 97).toString("base64"),
  };
};

describe("importProject", () => {
  it("rejects malformed envelopes", () => {
    expect(() => importProject(null)).toThrow(/invalid_input/);
    expect(() => importProject({ schemaVersion: 2, document: {} })).toThrow(/invalid_input/);
    expect(() => importProject(project({ revisions: [] }))).toThrow(/invalid_input/);
  });

  it("accepts an asset of exactly the shared per-asset limit and rejects one byte more", () => {
    expect(importProject(project({ assets: [textAsset(LIMITS.assetBytes)] })).assets).toHaveLength(
      1,
    );
    expect(() => importProject(project({ assets: [textAsset(LIMITS.assetBytes + 1)] }))).toThrow(
      /asset_limit|invalid_input/,
    );
  });

  it("accepts the full revision budget", () => {
    const revisions = Array.from({ length: LIMITS.revisions }, () => revision);
    expect(importProject(project({ revisions })).revisions).toHaveLength(LIMITS.revisions);
    expect(() => importProject(project({ revisions: [...revisions, revision] }))).toThrow(
      /invalid_input/,
    );
  });
});
