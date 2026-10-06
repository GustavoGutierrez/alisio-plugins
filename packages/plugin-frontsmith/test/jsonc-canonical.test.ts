import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/domain/canonical-json.js";
import { JsoncError, parseJsonc } from "../src/domain/jsonc.js";

describe("jsonc", () => {
  it("accepts comments and trailing commas", () => {
    const text = `{
      // line comment
      "a": 1, /* block */
      "b": [1, 2, ],
      "c": { "d": "x", },
    }`;
    expect(parseJsonc(text)).toEqual({ a: 1, b: [1, 2], c: { d: "x" } });
  });

  it("keeps comment-like text inside strings", () => {
    expect(parseJsonc('{ "u": "http://x/*not*/y", "e": "a\\"//b" }')).toEqual({
      u: "http://x/*not*/y",
      e: 'a"//b',
    });
  });

  it("handles a BOM and reports a position for invalid input", () => {
    expect(parseJsonc('﻿{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJsonc('{ "a": }')).toThrow(JsoncError);
    expect(() => parseJsonc("{ /* open ")).toThrow(JsoncError);
  });
});

describe("canonical json", () => {
  it("sorts keys recursively, indents by two spaces and ends with a newline", () => {
    const text = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } });
    expect(text).toBe(
      `{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n`,
    );
  });

  it("omits undefined properties and is stable across key order", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe(canonicalJson({ b: 1 }));
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
    expect(canonicalJson([])).toBe("[]\n");
    expect(canonicalJson({})).toBe("{}\n");
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow();
  });
});
