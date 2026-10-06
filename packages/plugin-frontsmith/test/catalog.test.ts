import { describe, expect, it } from "vitest";
import { loadAriaCatalog } from "../src/infrastructure/packs/catalog-loader.js";

describe("aria catalog", () => {
  it("lists sorted unique attributes and roles", async () => {
    const aria = await loadAriaCatalog();
    expect(aria.catalog).toBe("aria-1.2");
    for (const list of [aria.attributes, aria.roles]) {
      expect(new Set(list).size).toBe(list.length);
      expect([...list].sort()).toEqual(list);
    }
    expect(aria.attributes.every((a) => /^aria-[a-z]+$/.test(a))).toBe(true);
    expect(aria.attributes).toContain("aria-label");
    expect(aria.roles).toContain("button");
    expect(aria.roles).not.toContain("datepicker");
  });

  it("only requires known attributes of known roles", async () => {
    const aria = await loadAriaCatalog();
    for (const [role, required] of Object.entries(aria.requiredAttributes)) {
      expect(aria.roles).toContain(role);
      for (const attribute of required) expect(aria.attributes).toContain(attribute);
    }
    expect(aria.requiredAttributes.checkbox).toEqual(["aria-checked"]);
    for (const role of Object.keys(aria.nativeSemantics)) expect(aria.roles).toContain(role);
  });

  it("rejects a malformed catalog", async () => {
    const { parseAriaCatalog } = await import("../src/infrastructure/packs/catalog-loader.js");
    expect(() => parseAriaCatalog({ schemaVersion: 1 })).toThrow();
    expect(() =>
      parseAriaCatalog({
        schemaVersion: 1,
        catalog: "x",
        attributes: ["aria-x"],
        roles: ["a"],
        requiredAttributes: { b: [] },
        nativeSemantics: {},
      }),
    ).toThrow(/unknown role/);
  });
});
