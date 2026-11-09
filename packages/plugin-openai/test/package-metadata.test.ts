import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("package metadata", () => {
  it("PO-AC-13: SDK peer range spans the sign-in contract and the build uses 0.11", () => {
    expect(pkg.peerDependencies["@alisio/sdk"]).toBe(">=0.9.0 <0.12.0");
    expect(pkg.devDependencies["@alisio/sdk"]).toMatch(/^0\.11\.\d+$/);
    expect(VERSION).toBe(pkg.version);
  });
});
