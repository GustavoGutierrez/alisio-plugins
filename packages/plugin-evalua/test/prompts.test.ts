import { describe, expect, it } from "vitest";
import { prompt } from "../src/families/shared.js";
import { createRng } from "../src/math/rng.js";

describe("item instruction (prompt)", () => {
  it("uses the fallback and fills {expr}", () => {
    const rng = createRng("p");
    expect(prompt(rng, undefined, "Simplifica la fracción {expr}.", "$3/4$")).toBe(
      "Simplifica la fracción $3/4$.",
    );
  });

  it("prefers an agent-authored template and still fills {expr}", () => {
    const rng = createRng("p");
    const text = prompt(
      rng,
      ["Reduce {expr} a su forma irreducible."],
      "Simplifica la fracción {expr}.",
      "$6/8$",
    );
    expect(text).toBe("Reduce $6/8$ a su forma irreducible.");
  });

  it("ignores blank templates", () => {
    const rng = createRng("p");
    expect(prompt(rng, ["  "], "Calcula: {expr}", "$1$")).toBe("Calcula: $1$");
  });
});
