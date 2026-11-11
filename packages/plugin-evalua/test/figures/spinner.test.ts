import { describe, expect, it } from "vitest";
import { count, render } from "./helpers.js";

describe("spinner figure", () => {
  it("draws one equal sector per entry with its name", () => {
    const svg = render({ kind: "spinner", params: { sectors: ["1", "2", "3", "4", "5"] } });
    expect(count(svg, /<path d="M[^"]*Z" fill="#ffffff"\/>/g)).toBe(5);
    expect(svg).toContain("Ruleta dividida en 5 partes iguales");
    expect(svg).toContain("Partes: 1, 2, 3, 4, 5.");
  });

  it("caps the sectors at twelve", () => {
    const sectors = Array.from({ length: 20 }, (_, index) => String(index));
    expect(count(render({ kind: "spinner", params: { sectors } }), /<path /g)).toBe(12);
  });
});
