import { describe, expect, it } from "vitest";
import { count, render } from "./helpers.js";

describe("similar-triangles figure", () => {
  it("draws ABC and its scaled copy DEF with every side labelled", () => {
    const svg = render({
      kind: "similar-triangles",
      params: {
        ratio: 2,
        sides: [4, 3, 5],
        labels: ["4", "3", "5"],
        imageLabels: ["8", "x", "10"],
      },
    });
    expect(count(svg, /<polygon /g)).toBe(2);
    for (const text of ["4", "3", "5", "8", "x", "10", "D", "F"]) {
      expect(svg).toContain(`>${text}</text>`);
    }
    expect(svg).toContain("Lados de DEF: 8, x, 10.");
  });

  it("draws the Thales configuration with DE parallel to BC", () => {
    const svg = render({
      kind: "similar-triangles",
      params: { mode: "nested", cut: 0.4, labels: ["4", "6", "5", "x"] },
    });
    expect(svg).toContain("AD = 4, DB = 6, AE = 5, EC = x.");
    // Two parallel marks, one on DE and one on BC.
    expect(count(svg, /<path d="M/g)).toBe(2);
  });
});
