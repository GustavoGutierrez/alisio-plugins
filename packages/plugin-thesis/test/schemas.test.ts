import { describe, expect, it } from "vitest";
import { parseChildJson, stripControl, validateIntakeDraft } from "../src/schemas.js";

describe("child JSON parsing", () => {
  it("accepts strict JSON and a single fenced block", () => {
    expect(parseChildJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseChildJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it("rejects prose, multiple blocks, empties and malformed JSON", () => {
    expect(() => parseChildJson("")).toThrow(/no output/);
    expect(() => parseChildJson('Here you go:\n```json\n{"a":1}\n```')).toThrow(/extra prose/);
    expect(() => parseChildJson('```json\n{"a":1}\n```\n```json\n{"b":2}\n```')).toThrow(
      /more than one/,
    );
    expect(() => parseChildJson("{nope")).toThrow(/not valid JSON/);
  });

  it("strips control characters", () => {
    expect(stripControl("a\u0000b\u001bc\nd\te")).toBe("abc\nd\te");
  });
});

describe("IntakeDraft", () => {
  it("validates titles, domain, approach and notes", () => {
    const ok = validateIntakeDraft({
      titles: ["A", " B\u0000 "],
      domain: "computer_science",
      approach: "mixed",
      notes: "x",
    });
    expect(ok.errors).toEqual([]);
    expect(ok.value).toEqual({
      titles: ["A", "B"],
      domain: "computer_science",
      approach: "mixed",
      notes: "x",
    });
  });

  it("rejects unknown fields, bad enums and oversize values", () => {
    expect(validateIntakeDraft([]).errors).toHaveLength(1);
    const bad = validateIntakeDraft({
      titles: [],
      domain: "Bad Domain",
      approach: "magic",
      extra: 1,
      notes: "n".repeat(1001),
    });
    expect(bad.value).toBeUndefined();
    expect(bad.errors.length).toBe(5);
    expect(validateIntakeDraft({ titles: ["a", "b", "c", "d"] }).errors).toHaveLength(1);
    expect(validateIntakeDraft({ titles: ["x".repeat(201)] }).errors).toHaveLength(1);
  });
});
