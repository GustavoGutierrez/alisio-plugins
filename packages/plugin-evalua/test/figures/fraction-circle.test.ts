import { describe, expect, it } from "vitest";
import { count, render } from "./helpers.js";

describe("fraction circle figure", () => {
  it("draws one sector per part and fills exactly the shaded ones", () => {
    const svg = render({ kind: "fraction-circle", params: { parts: 8, shaded: 3 } });
    expect(count(svg, /<path d="M[^"]*Z" fill="#FFDA64"\/>/g)).toBe(3);
    expect(count(svg, /<path d="M[^"]*Z" fill="#ffffff"\/>/g)).toBe(5);
    expect(svg).toContain("8 partes iguales con 3 sombreadas");
  });

  it("handles a single part and clamps the shading", () => {
    const svg = render({ kind: "fraction-circle", params: { parts: 1, shaded: 5 } });
    expect(count(svg, /fill="#FFDA64"\/>/g)).toBe(1);
  });
});
