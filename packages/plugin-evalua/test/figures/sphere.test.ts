import { describe, expect, it } from "vitest";
import { render } from "./helpers.js";

describe("sphere figure", () => {
  it("labels the radius with its unit and dashes the hidden half of the equator", () => {
    const svg = render({ kind: "sphere", params: { radius: 5, unit: "cm" } });
    expect(svg).toContain(">5 cm</text>");
    expect(svg).toContain('stroke-dasharray="4 3"');
    expect(svg).toContain("<title>Esfera de radio 5 cm</title>");
  });

  it("draws a hemisphere with its diameter", () => {
    const svg = render({
      kind: "sphere",
      params: { radius: 8, unit: "m", half: true, diameter: true },
    });
    expect(svg).toContain("Semiesfera de diámetro 8 m");
  });
});
