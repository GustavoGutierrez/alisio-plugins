import { describe, expect, it } from "vitest";
import { figureKinds, figureSvg } from "../src/figures/index.js";
import { parseMarkup } from "../src/markup.js";

describe("deterministic figures", () => {
  it("renders every kind as a self-contained grayscale SVG", () => {
    for (const kind of figureKinds) {
      const svg = figureSvg({ kind, label: kind });
      expect(svg, kind).toContain("<svg");
      expect(svg, kind).toContain("</svg>");
      expect(svg, kind).toContain('stroke="#000"');
      expect(svg, kind).not.toContain("href=");
      expect(svg, kind).not.toContain("<image");
    }
  });

  it("is deterministic and escapes labels", () => {
    const spec = { kind: "venn" as const, label: "A < B & C", params: { sets: 3 } };
    expect(figureSvg(spec)).toBe(figureSvg(spec));
    expect(figureSvg(spec)).toContain("A &lt; B &amp; C");
  });

  it("honours parameters", () => {
    expect(figureSvg({ kind: "fraction-bar", params: { parts: 5, shaded: 3 } })).toContain(
      "3 of 5",
    );
    expect(figureSvg({ kind: "polygon", params: { sides: 6 } })).toContain("6 sides");
    expect(figureSvg({ kind: "cartesian", params: { points: [[1, 2]] } })).toContain("<circle");
  });

  it("falls back to a labelled placeholder for an unknown kind", () => {
    const svg = figureSvg({ kind: "nope" as never, label: "custom" });
    expect(svg).toContain("figure: nope");
  });
});

describe("figures in markup", () => {
  it("parses a figure block", () => {
    const blocks = parseMarkup([{ figure: { kind: "venn", params: { sets: 2 } } }]);
    expect(blocks[0]).toEqual({ kind: "figure", spec: { kind: "venn", params: { sets: 2 } } });
  });
});
