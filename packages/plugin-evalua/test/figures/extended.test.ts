import { describe, expect, it } from "vitest";
import { count, render } from "./helpers.js";

/** New params on figures that predate the refactor; without them the output is frozen (legacy). */
describe("extended figures", () => {
  it("bar-chart: labelled bars with a numbered axis every step", () => {
    const svg = render({
      kind: "bar-chart",
      label: "Votos",
      params: { labels: ["Mango", "Uva", "Piña"], values: [4, 10, 6], step: 2, axis: "Votos" },
    });
    expect(count(svg, /<rect /g)).toBe(3);
    for (const tick of ["0", "2", "4", "6", "8", "10"]) expect(svg).toContain(`>${tick}</text>`);
    expect(svg).toContain("Mango: 4; Uva: 10; Piña: 6");
  });

  it("angle: drawn to scale with a right-angle box and an optional measure", () => {
    const right = render({ kind: "angle", params: { degrees: 90 } });
    expect(right).toContain('<line x1="130" y1="140" x2="130" y2="30"/>');
    expect(right).not.toContain("°");
    const obtuse = render({ kind: "angle", params: { degrees: 135, showMeasure: true } });
    expect(obtuse).toContain("135°");
    expect(obtuse).toContain("Ángulo de 135 grados");
  });

  it("prism: labelled edges with their unit", () => {
    const svg = render({ kind: "prism", params: { length: 4, width: 3, height: 2, unit: "cm" } });
    for (const edge of ["4 cm", "3 cm", "2 cm"]) expect(svg).toContain(`>${edge}<`);
  });

  it("fraction-bar: hatched shading for monochrome printing", () => {
    const svg = render({ kind: "fraction-bar", params: { parts: 4, shaded: 1, hatch: true } });
    expect(count(svg, /stroke-width="0\.8"/g)).toBeGreaterThan(3);
    expect(svg).toContain("4 partes iguales con 1 sombreada");
  });
});

/** Params added for grades 6-9: without them each figure keeps its legacy drawing (see legacy). */
describe("secondary extensions", () => {
  it("triangle: a right triangle from its legs and a triangle from its angles", () => {
    const right = render({
      kind: "triangle",
      params: { legs: [3, 4], sideLabels: ["3 cm", "4 cm", "?"] },
    });
    for (const text of ["3 cm", "4 cm", "?"]) expect(right).toContain(`>${text}</text>`);
    expect(right).toContain("Catetos: 3 cm y 4 cm. Hipotenusa: ?.");
    const angled = render({
      kind: "triangle",
      params: { angles: [50, 70, 60], angleLabels: ["50°", "70°", "x"], exterior: true },
    });
    expect(count(angled, /<path d="M[^"]*A22 22/g)).toBe(2);
    expect(angled).toContain(">x</text>");
    expect(angled).toContain("Ángulo exterior marcado en B.");
  });

  it("polygon, circle, cylinder, cone and number line take measured params", () => {
    expect(render({ kind: "polygon", params: { sides: 6, markAngle: "x" } })).toContain(
      "Polígono regular de 6 lados",
    );
    expect(
      render({ kind: "circle", params: { show: "diameter", value: 10, unit: "cm" } }),
    ).toContain("Círculo de diámetro 10 cm");
    expect(render({ kind: "cylinder", params: { radius: 3, height: 10, unit: "cm" } })).toContain(
      "Cilindro de radio 3 cm y altura 10 cm",
    );
    expect(render({ kind: "cone", params: { radius: 4, height: 9, unit: "m" } })).toContain(
      ">9 m</text>",
    );
    const line = render({
      kind: "number-line",
      params: { min: -8, max: 8, points: [{ value: -5, name: "A" }], distances: true },
    });
    expect(line).toContain("Puntos: A = -5.");
    expect(line).toContain('stroke-dasharray="4 3"');
  });
});
