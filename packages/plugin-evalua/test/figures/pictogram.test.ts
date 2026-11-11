import { describe, expect, it } from "vitest";
import { count, render } from "./helpers.js";

describe("pictogram figure", () => {
  it("draws the symbols of each row plus one in the key", () => {
    const svg = render({
      kind: "pictogram",
      label: "Fruta favorita",
      params: { labels: ["Mango", "Uva"], symbols: [3, 5], unit: 2 },
    });
    // Each symbol is an outlined circle plus a dot; the key adds one more symbol.
    expect(count(svg, /<circle [^>]*r="9"\/>/g)).toBe(3 + 5 + 1);
    expect(svg).toContain("= 2");
    expect(svg).toContain("Mango: 3 símbolos; Uva: 5 símbolos. Cada símbolo vale 2.");
    expect(svg).toContain('aria-label="Fruta favorita"');
  });

  it("caps rows and symbols", () => {
    const svg = render({
      kind: "pictogram",
      params: { labels: ["a", "b", "c", "d", "e", "f", "g"], symbols: [50, 1, 1, 1, 1, 1, 1] },
    });
    expect(count(svg, /<circle [^>]*r="9"\/>/g)).toBe(10 + 5 + 1);
  });
});
