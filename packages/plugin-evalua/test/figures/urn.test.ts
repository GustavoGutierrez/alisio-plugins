import { describe, expect, it } from "vitest";
import { count, render } from "./helpers.js";

describe("urn figure", () => {
  it("draws one lettered ball per count, with a key from letter to colour", () => {
    const svg = render({
      kind: "urn",
      params: { marks: ["R", "A"], names: ["rojas", "azules"], counts: [3, 2] },
    });
    expect(count(svg, /<circle [^>]*r="12"\/>/g)).toBe(5);
    expect(count(svg, />R</g)).toBe(3);
    expect(svg).toContain("R = rojas");
    expect(svg).toContain("3 rojas, 2 azules.");
  });

  it("caps the bag at thirty balls", () => {
    const svg = render({ kind: "urn", params: { marks: ["N"], names: ["negras"], counts: [99] } });
    expect(count(svg, /<circle [^>]*r="12"\/>/g)).toBe(30);
  });
});
