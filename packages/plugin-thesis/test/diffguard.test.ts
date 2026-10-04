import { describe, expect, it } from "vitest";
import { diffProtected, protectedItems } from "../src/diffguard.js";

const base = `<!-- claim:c1 -->
La tasa subió 12,5 % entre 2019 y 2021 [@perez2021, p. 17]; véase @fig-tasa y @garcia2019.

<!-- claim:c2 -->
La media es $\\bar{x} = 3.5$ y se define en @eq-media.

$$
y = \\frac{1}{n}
$$ {#eq-media}

![Tasa anual. Fuente: propia.](figures/charts/tasa.vl.json){#fig-tasa width=80%}

Consulte [la guía](https://ejemplo.org/guia) y la nota[^1].

[^1]: Texto de la nota.
`;

describe("editor diff guard", () => {
  it("accepts a pure wording change", () => {
    const edited = base
      .replace("La tasa subió", "La tasa aumentó")
      .replace("véase", "puede verse")
      .replace("Consulte", "Revise");
    expect(diffProtected(base, edited)).toEqual([]);
  });

  it("accepts moving a sentence inside a paragraph when its citation moves with it", () => {
    const edited = base.replace(
      "La tasa subió 12,5 % entre 2019 y 2021 [@perez2021, p. 17]; véase @fig-tasa y @garcia2019.",
      "Véase @fig-tasa y @garcia2019: la tasa subió 12,5 % entre 2019 y 2021 [@perez2021, p. 17].",
    );
    expect(diffProtected(base, edited)).toEqual([]);
  });

  it.each([
    [
      "a citation key",
      base.replace("[@perez2021, p. 17]", "[@garcia2019, p. 17]"),
      /citations or cross-references/,
    ],
    ["a locator", base.replace("p. 17", "p. 18"), /citations or cross-references/],
    [
      "a removed narrative citation",
      base.replace(" y @garcia2019", ""),
      /citations or cross-references/,
    ],
    ["a cross-reference", base.replace("@fig-tasa", "@fig-otra"), /citations or cross-references/],
    ["a number", base.replace("12,5 %", "15 %"), /changed numbers/],
    ["a year", base.replace("2019", "2018"), /changed numbers/],
    ["an anchor", base.replace("claim:c2", "claim:c9"), /claim anchors/],
    [
      "a moved anchor",
      base.replace("<!-- claim:c1 -->\n", "").replace("La media", "<!-- claim:c1 -->\nLa media"),
      /claim anchors/,
    ],
    ["inline math", base.replace("3.5", "3.6"), /changed math/],
    ["display math", base.replace("\\frac{1}{n}", "\\frac{2}{n}"), /changed math/],
    ["a label", base.replace("{#fig-tasa width=80%}", "{#fig-tasa width=60%}"), /changed labels/],
    ["an image target", base.replace("tasa.vl.json", "otra.vl.json"), /link or image targets/],
    [
      "a link target",
      base.replace("https://ejemplo.org/guia", "https://otro.org"),
      /link or image targets/,
    ],
    ["a footnote mark", base.replace("nota[^1]", "nota"), /footnote marks/],
  ])("rejects a change to %s", (_name, edited, message) => {
    const violations = diffProtected(base, edited);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join("\n")).toMatch(message);
  });

  it("extracts each kind of protected item", () => {
    const items = protectedItems(base);
    expect(items.anchors).toEqual(["c1", "c2"]);
    expect(items.citations).toEqual(
      expect.arrayContaining(["[@perez2021, p. 17]", "@fig-tasa", "@garcia2019", "@eq-media"]),
    );
    expect(items.math).toHaveLength(2);
    expect(items.labels).toEqual(["{#eq-media}", "{#fig-tasa width=80%}"]);
    expect(items.targets).toEqual(["figures/charts/tasa.vl.json", "https://ejemplo.org/guia"]);
    expect(items.numbers).toEqual(expect.arrayContaining(["12,5", "2019", "2021"]));
  });

  it("does not take an email address for a citation", () => {
    expect(protectedItems("Escriba a autora@ejemplo.org por favor.").citations).toEqual([]);
  });
});
