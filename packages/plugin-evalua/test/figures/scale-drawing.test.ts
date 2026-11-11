import { describe, expect, it } from "vitest";
import { render } from "./helpers.js";

describe("scale-drawing figure", () => {
  it("draws a map route of the given length with its scale legend", () => {
    const svg = render({
      kind: "scale-drawing",
      params: { length: 4.5, scale: "1:1.000", from: "la casa", to: "el colegio" },
    });
    expect(svg).toContain(">4,5 cm</text>");
    expect(svg).toContain(">Escala 1:1.000</text>");
    expect(svg).toContain("En el mapa, de la casa a el colegio hay 4,5 cm.");
  });

  it("hides the length behind a question mark and draws a labelled floor plan", () => {
    expect(render({ kind: "scale-drawing", params: { length: 3, shown: "?" } })).toContain(
      ">?</text>",
    );
    const plan = render({
      kind: "scale-drawing",
      params: { shape: "plan", width: 6, height: 4, scale: "1:100" },
    });
    expect(plan).toContain(">6 cm</text>");
    expect(plan).toContain(">4 cm</text>");
  });
});
