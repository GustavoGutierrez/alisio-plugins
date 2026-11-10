import { describe, expect, it } from "vitest";
import { ftsQuery, reciprocalRankFusion } from "../src/notebook/retrieve.js";

describe("reciprocal rank fusion (D9, SEM-AC-09)", () => {
  it("fuses two ranked lists into the expected order", () => {
    const vector = ["a", "b", "c", "d"];
    const keyword = ["c", "a", "e"];
    // a: 1/61 + 1/62, c: 1/63 + 1/61, b: 1/62, e: 1/63, d: 1/64
    expect(reciprocalRankFusion([vector, keyword], { k: 60, top: 8 })).toEqual([
      "a",
      "c",
      "b",
      "e",
      "d",
    ]);
  });

  it("keeps ties stable in first-seen order and honors the cut", () => {
    expect(
      reciprocalRankFusion(
        [
          ["x", "y"],
          ["y", "x"],
        ],
        { k: 60, top: 8 },
      ),
    ).toEqual(["x", "y"]);
    expect(reciprocalRankFusion([["p"], ["q"]], { k: 60, top: 8 })).toEqual(["p", "q"]);
    const many = Array.from({ length: 20 }, (_, i) => `id${i}`);
    expect(reciprocalRankFusion([many, []], { k: 60, top: 8 })).toEqual(many.slice(0, 8));
  });

  it("counts an id once per list", () => {
    expect(reciprocalRankFusion([["a", "a", "b"], ["b"]], { k: 60, top: 8 })).toEqual(["b", "a"]);
  });
});

describe("FTS5 query building", () => {
  it("quotes every word and drops operators and punctuation", () => {
    expect(ftsQuery('ID-42 "quote" OR NEAR(x) ñandú')).toBe(
      '"ID" OR "42" OR "quote" OR "OR" OR "NEAR" OR "x" OR "ñandú"',
    );
    expect(ftsQuery("!!! ???")).toBe("");
  });
});
