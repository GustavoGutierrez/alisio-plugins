import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { figureSvg } from "../../src/figures/index.js";
import { LEGACY_CASES } from "./legacy-cases.js";

const frozen = JSON.parse(
  readFileSync(new URL("../fixtures/figures-legacy.json", import.meta.url), "utf8"),
) as Record<string, string>;

describe("figures that predate the component refactor", () => {
  it("covers every frozen case", () => {
    expect(Object.keys(frozen).sort()).toEqual(LEGACY_CASES.map((entry) => entry.name).sort());
  });

  it.each(LEGACY_CASES)("$name stays byte-identical", ({ name, spec, tone }) => {
    expect(figureSvg(spec, tone)).toBe(frozen[name]);
  });
});
