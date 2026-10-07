import { describe, expect, it } from "vitest";
import { figureKinds, figureSvg } from "../src/figures/index.js";
import { parseMarkup } from "../src/markup.js";

/** The palette the figures draw from; kept in the test so a silent palette change fails loudly. */
const PASTEL_TONES = ["#FFDA64", "#A3D084", "#F4B281", "#E3E3E3", "#8FA9DA"];

describe("deterministic figures", () => {
  it("renders every kind as a self-contained, print-safe SVG", () => {
    for (const kind of figureKinds) {
      const svg = figureSvg({ kind, label: kind });
      expect(svg, kind).toContain("<svg");
      expect(svg, kind).toContain("</svg>");
      expect(svg, kind).toContain('stroke="#000"');
      expect(svg, kind).not.toContain("href=");
      expect(svg, kind).not.toContain("<image");
    }
  });

  it("fills every figure with one of the pastel tones", () => {
    for (const kind of figureKinds) {
      const svg = figureSvg({ kind, label: kind });
      const fill = /<g fill="(#[0-9A-F]{6})"/.exec(svg)?.[1];
      expect(PASTEL_TONES, kind).toContain(fill);
    }
  });

  it("keeps one colour per spec and spreads them across specs", () => {
    const spec = { kind: "triangle" as const, params: { variant: "equilateral" } };
    expect(figureSvg(spec)).toBe(figureSvg(spec));
    const tones = new Set(
      ["triangle", "square", "circle", "prism", "angle", "rectangle"].map(
        (kind) => /<g fill="(#[0-9A-F]{6})"/.exec(figureSvg({ kind: kind as never }))?.[1],
      ),
    );
    expect(tones.size).toBeGreaterThan(1);
  });

  it("walks the palette when the renderer hands out a running tone", () => {
    const spec = { kind: "square" as const };
    // Two identical figures in one document must not come out the same colour.
    expect(figureSvg(spec, 0)).toContain('fill="#FFDA64"');
    expect(figureSvg(spec, 1)).toContain('fill="#A3D084"');
    expect(figureSvg(spec, 2)).toContain('fill="#F4B281"');
    expect(figureSvg(spec, PASTEL_TONES.length)).toBe(figureSvg(spec, 0));
  });

  it("gives the Venn circles their own tones and keeps the fraction bar white", () => {
    const venn = figureSvg({ kind: "venn", params: { sets: 2 } });
    expect(venn).toContain('fill="#FFDA64"');
    expect(venn).toContain('fill="#A3D084"');
    expect(venn).toContain('fill-opacity="0.55"');
    const bar = figureSvg({ kind: "fraction-bar", params: { parts: 4, shaded: 2 } });
    expect(bar).toContain('fill="#ffffff"');
  });

  it("scales a measured circle radius into the drawing instead of reading it as pixels", () => {
    const radiusOf = (svg: string) =>
      Number(/<circle cx="100" cy="90" r="(\d+)"/.exec(svg)?.[1] ?? 0);
    expect(radiusOf(figureSvg({ kind: "circle", params: { radius: 4 } }))).toBeGreaterThanOrEqual(
      30,
    );
    expect(radiusOf(figureSvg({ kind: "circle", params: { radius: 1 } }))).toBeGreaterThanOrEqual(
      30,
    );
    expect(figureSvg({ kind: "circle", params: { radius: 60 } })).toContain('r="60"');
  });

  it("draws the cone as one closed silhouette so its fill reads as a solid", () => {
    expect(figureSvg({ kind: "cone" })).toContain(
      '<path d="M40 150 L110 30 L180 150 A70 20 0 0 1 40 150 Z"/>',
    );
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
