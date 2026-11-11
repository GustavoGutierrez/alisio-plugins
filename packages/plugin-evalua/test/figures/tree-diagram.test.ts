import { describe, expect, it } from "vitest";
import { count, render } from "./helpers.js";

describe("tree-diagram figure", () => {
  it("branches every node into every outcome of the next stage", () => {
    const svg = render({
      kind: "tree-diagram",
      params: {
        stages: [
          ["C", "S"],
          ["1", "2", "3"],
        ],
        leafLabels: true,
      },
    });
    // 2 first-stage branches + 2 x 3 second-stage branches.
    expect(count(svg, /<line /g)).toBe(8);
    expect(svg).toContain(">(S, 3)</text>");
    expect(svg).toContain("Etapa 1: C, S. Etapa 2: 1, 2, 3. 6 resultados.");
  });

  it("writes branch probabilities in breadth-first order", () => {
    const svg = render({
      kind: "tree-diagram",
      params: {
        stages: [
          ["R", "A"],
          ["R", "A"],
        ],
        edgeLabels: ["3/5", "2/5", "2/4", "2/4", "3/4", "1/4"],
      },
    });
    for (const text of ["3/5", "2/5", "3/4", "1/4"]) expect(svg).toContain(`>${text}</text>`);
  });

  it("stops adding stages beyond sixteen leaves", () => {
    const svg = render({
      kind: "tree-diagram",
      params: {
        stages: [
          ["1", "2", "3", "4", "5", "6"],
          ["1", "2", "3", "4", "5", "6"],
        ],
      },
    });
    expect(svg).toContain("6 resultados.");
  });
});
