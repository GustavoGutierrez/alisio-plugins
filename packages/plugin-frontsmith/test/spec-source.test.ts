import { describe, expect, it } from "vitest";
import { envelopeExamples } from "../src/application/agents/examples.js";
import {
  checkSourceJson,
  checkSourceLevel,
  checkSourcePath,
  decodeSource,
  deriveIntent,
  SOURCE_MAX_BYTES,
} from "../src/domain/spec-source.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("source spec path (SRC-001 to SRC-003)", () => {
  it("accepts a contained markdown or json path and names its format", () => {
    expect(checkSourcePath("specs/checkout.md")).toEqual({
      ok: true,
      path: "specs/checkout.md",
      format: "markdown",
    });
    expect(checkSourcePath("./docs/a.MARKDOWN")).toEqual({
      ok: true,
      path: "docs/a.MARKDOWN",
      format: "markdown",
    });
    expect(checkSourcePath("spec.json")).toMatchObject({ ok: true, format: "spec-json" });
  });

  it.each([
    ["../x.md"],
    ["a/../../x.md"],
    ["/etc/x.md"],
    ["C:/x.md"],
    ["a\\b.md"],
    ["a\u0000b.md"],
    ["a//b.md"],
    [""],
    ["   "],
  ])("refuses the unsafe path %j with SRC-001", (path) => {
    expect(checkSourcePath(path)).toMatchObject({ ok: false, code: "SRC-001" });
  });

  it("refuses machine state directories with SRC-002", () => {
    expect(checkSourcePath(".git/x.md")).toMatchObject({ ok: false, code: "SRC-002" });
    expect(checkSourcePath(".alisio/frontsmith/x.md")).toMatchObject({
      ok: false,
      code: "SRC-002",
    });
  });

  it("refuses other extensions with SRC-003", () => {
    expect(checkSourcePath("notes.txt")).toMatchObject({ ok: false, code: "SRC-003" });
    expect(checkSourcePath("noext")).toMatchObject({ ok: false, code: "SRC-003" });
  });
});

describe("source spec bytes (SRC-005, SRC-006)", () => {
  it("normalizes a BOM and CRLF", () => {
    const result = decodeSource(bytes("\uFEFF# Title\r\nline\r\n"));
    expect(result).toEqual({ ok: true, text: "# Title\nline\n", bytes: 18 });
  });

  it("refuses an empty file and one over 128 KiB with SRC-005", () => {
    expect(decodeSource(new Uint8Array())).toMatchObject({ ok: false, code: "SRC-005" });
    expect(decodeSource(new Uint8Array(SOURCE_MAX_BYTES + 1).fill(97))).toMatchObject({
      ok: false,
      code: "SRC-005",
    });
    expect(decodeSource(new Uint8Array(SOURCE_MAX_BYTES).fill(97))).toMatchObject({ ok: true });
  });

  it("refuses invalid UTF-8, NUL and blank text with SRC-006", () => {
    expect(decodeSource(new Uint8Array([0xff, 0xfe, 0x41]))).toMatchObject({
      ok: false,
      code: "SRC-006",
    });
    expect(decodeSource(bytes("a\u0000b"))).toMatchObject({ ok: false, code: "SRC-006" });
    expect(decodeSource(bytes("  \n\t\n"))).toMatchObject({ ok: false, code: "SRC-006" });
  });
});

describe("source spec json (SRC-007)", () => {
  it("accepts a valid SpecEnvelope", () => {
    const result = checkSourceJson(JSON.stringify(envelopeExamples.spec));
    expect(result.ok).toBe(true);
  });

  it("refuses text that is not one JSON value", () => {
    expect(checkSourceJson("{ nope")).toMatchObject({ ok: false, code: "SRC-007" });
    expect(checkSourceJson("```json\n{}\n```")).toMatchObject({ ok: false, code: "SRC-007" });
  });

  it("lists at most 20 pointers of an invalid envelope", () => {
    const result = checkSourceJson(JSON.stringify({ schemaVersion: 1, kind: "spec", extra: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("SRC-007");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.length).toBeLessThanOrEqual(20);
    }
  });

  it("rejects an unknown key", () => {
    const result = checkSourceJson(JSON.stringify({ ...(envelopeExamples.spec as object), x: 1 }));
    expect(result.ok).toBe(false);
  });
});

describe("source spec and level (SRC-008)", () => {
  it("refuses L0 with a source", () => {
    expect(checkSourceLevel("L0")).toMatchObject({ code: "SRC-008" });
    expect(checkSourceLevel("L1")).toBeUndefined();
  });
});

describe("intent derivation", () => {
  it("uses the first level-1 heading of a markdown file and names the path", () => {
    expect(deriveIntent("intro\n\n# Checkout flow\n\n# Second", "markdown", "specs/c.md")).toBe(
      "Checkout flow (from specs/c.md)",
    );
  });

  it("ignores headings inside code fences", () => {
    expect(deriveIntent("```\n# not this\n```\n# Real", "markdown", "a.md")).toBe(
      "Real (from a.md)",
    );
  });

  it("falls back to the first non-blank line", () => {
    expect(deriveIntent("\n\nBuild a cart page\nmore", "markdown", "a.md")).toBe(
      "Build a cart page (from a.md)",
    );
  });

  it("uses the objective of a json envelope", () => {
    expect(
      deriveIntent(
        JSON.stringify({ ...(envelopeExamples.spec as object), objective: "Pay fast" }),
        "spec-json",
        "a.json",
      ),
    ).toBe("Pay fast");
  });

  it("clips the title to 200 characters", () => {
    const intent = deriveIntent(`# ${"x".repeat(500)}`, "markdown", "a.md");
    expect(intent).toBe(`${"x".repeat(200)} (from a.md)`);
    expect(intent.length).toBeLessThan(4000);
  });
});
