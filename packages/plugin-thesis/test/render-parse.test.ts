import { describe, expect, it } from "vitest";
import type { Block, Inline } from "../src/render/model.js";
import { parseChapter } from "../src/render/parse.js";

const parse = (source: string, path = "chapters/01-test.md") => parseChapter(path, source);
const blocks = (source: string): Block[] => parse(source).section.blocks;
const paragraph = (source: string): Inline[] => {
  const first = blocks(source)[0];
  if (first?.kind !== "paragraph") throw new Error(`not a paragraph: ${first?.kind}`);
  return first.children;
};
const codes = (source: string) => parse(source).findings.map((finding) => finding.code);

describe("dialect: headings, citations and references", () => {
  it("reads heading labels and levels", () => {
    const [h1, h2] = blocks("# Intro {#sec-intro}\n\n## Sub\n");
    expect(h1).toMatchObject({ kind: "heading", level: 1, label: "sec-intro", line: 1 });
    expect(h2).toMatchObject({ kind: "heading", level: 2 });
    expect(h2).not.toHaveProperty("label");
    // The attribute group is removed from the visible heading text.
    expect((h1 as { children: Inline[] }).children).toEqual([{ kind: "text", text: "Intro" }]);
  });

  it("parses bracketed, locator, grouped and narrative citations", () => {
    const nodes = paragraph(
      "A [@perez2021], B [@garcia2019, p. 17], C [@a2020; @b2021], D @rojas2020.",
    );
    const citations = nodes.filter((node) => node.kind === "citation");
    expect(citations).toEqual([
      { kind: "citation", items: [{ key: "perez2021" }], narrative: false },
      { kind: "citation", items: [{ key: "garcia2019", locator: "p. 17" }], narrative: false },
      { kind: "citation", items: [{ key: "a2020" }, { key: "b2021" }], narrative: false },
      { kind: "citation", items: [{ key: "rojas2020" }], narrative: true },
    ]);
    // The sentence period stays text, not part of the key.
    expect(nodes[nodes.length - 1]).toEqual({ kind: "text", text: "." });
  });

  it("parses cross-references for figures, tables, equations and sections", () => {
    const refs = paragraph("Ver @fig-a, @tbl-b, @eq-c y @sec-d.").filter(
      (n) => n.kind === "crossref",
    );
    expect(refs.map((ref) => (ref as { label: string }).label)).toEqual([
      "fig-a",
      "tbl-b",
      "eq-c",
      "sec-d",
    ]);
  });

  it("does not treat e-mail addresses as references and flags unknown @words", () => {
    expect(codes("Escribe a ana@example.org por favor.")).toEqual([]);
    expect(codes("Mira @Perez2021 allí.")).toEqual(["HYG-001"]);
  });
});

describe("dialect: math", () => {
  it("parses inline math but not currency", () => {
    const nodes = paragraph("Vale $x^2$ y cuesta $5 o $10 en total.");
    expect(nodes.filter((n) => n.kind === "math")).toEqual([{ kind: "math", latex: "x^2" }]);
  });

  it("parses display math with and without a label, single and multi line", () => {
    const [one, many, bare] = blocks(
      "$$ a = b $$ {#eq-uno}\n\n$$\n\\frac{1}{2}\n$$ {#eq-dos}\n\n$$ c $$\n",
    );
    expect(one).toMatchObject({ kind: "equation", latex: "a = b", label: "eq-uno" });
    expect(many).toMatchObject({ kind: "equation", latex: "\\frac{1}{2}", label: "eq-dos" });
    expect(bare).toMatchObject({ kind: "equation", latex: "c" });
    expect(bare).not.toHaveProperty("label");
  });

  it("rejects an equation label with the wrong prefix", () => {
    expect(codes("$$ a $$ {#fig-x}\n")).toEqual(["HYG-001"]);
  });
});

describe("dialect: figures, tables, footnotes, claims", () => {
  it("builds figures for each supported asset type with attributes and the source split", () => {
    const sources: [string, string][] = [
      ["figures/diagrams/a.mmd", "mermaid"],
      ["figures/images/a.svg", "svg"],
      ["figures/images/a.png", "raster"],
      ["figures/images/a.jpg", "raster"],
      ["figures/charts/a.vl.json", "chart"],
    ];
    for (const [path, kind] of sources) {
      const [figure] = blocks(`![Caption text. Source: own work.](${path}){#fig-a width=80%}\n`);
      expect(figure).toMatchObject({
        kind: "figure",
        label: "fig-a",
        width: "80%",
        asset: { kind, path },
      });
      expect((figure as { source?: Inline[] }).source).toEqual([
        { kind: "text", text: "Source: own work." },
      ]);
      expect((figure as { caption: Inline[] }).caption).toEqual([
        { kind: "text", text: "Caption text." },
      ]);
    }
  });

  it("splits Spanish and Portuguese source lines too", () => {
    for (const label of ["Fuente", "Fonte"]) {
      const [figure] = blocks(`![Pie. ${label}: propia.](figures/images/a.png){#fig-a}\n`);
      expect((figure as { source?: Inline[] }).source?.[0]).toEqual({
        kind: "text",
        text: `${label}: propia.`,
      });
    }
  });

  it("attaches a Table: caption and label to the preceding GFM table", () => {
    const [table] = blocks(
      "| A | B |\n|:--|--:|\n| 1 | 2 |\n\nTable: Resultados. Fuente: propia. {#tbl-r}\n",
    );
    expect(table).toMatchObject({
      kind: "table",
      label: "tbl-r",
      align: ["left", "right"],
      header: [[{ kind: "text", text: "A" }], [{ kind: "text", text: "B" }]],
    });
    expect((table as { caption: Inline[] }).caption).toEqual([
      { kind: "text", text: "Resultados." },
    ]);
  });

  it("collects footnotes under file-scoped ids", () => {
    const parsed = parse("Texto[^n] aquí.\n\n[^n]: Nota al pie.\n");
    const ref = (parsed.section.blocks[0] as { children: Inline[] }).children.find(
      (n) => n.kind === "footnote",
    );
    expect(ref).toEqual({ kind: "footnote", id: "chapters/01-test.md#0" });
    expect(Object.keys(parsed.footnotes)).toEqual(["chapters/01-test.md#0"]);
  });

  it("consumes claim anchors without rendering them", () => {
    const parsed = parse(
      "<!-- claim:c3 -->\nUna afirmación.\n\n<!-- claim:c4 --> Otra afirmación.\n",
    );
    expect(parsed.findings).toEqual([]);
    expect(parsed.section.blocks).toMatchObject([
      { kind: "paragraph", claim: "c3" },
      { kind: "paragraph", claim: "c4" },
    ]);
  });

  it("reads front matter roles, keywords and the outline section", () => {
    const parsed = parse(
      "---\nrole: abstract\nlang: es\nkeywords: [a, b]\nsection: SEC-02\n---\n\nTexto.\n",
    );
    expect(parsed.section).toMatchObject({
      role: "abstract",
      lang: "es",
      keywords: ["a", "b"],
      section: "SEC-02",
    });
    expect(codes("---\nrole: nope\nbogus: 1\n---\n\nTexto.\n")).toEqual(["HYG-001", "HYG-001"]);
  });

  it("treats files under annexes/ as annexes", () => {
    expect(parse("# A\n", "chapters/annexes/a.md").section.role).toBe("annex");
  });
});

describe("HYG-001 from the dialect", () => {
  const cases: [string, string][] = [
    ["raw HTML block", "<div>hola</div>\n"],
    ["raw inline HTML", "Texto <b>negrita</b> aquí.\n"],
    ["a mid-paragraph claim comment", "Texto <!-- claim:x --> aquí.\n"],
    ["raw Typst", "#set text(red)\n"],
    ["a placeholder TODO", "Pendiente: TODO revisar.\n"],
    ["a [citation needed] marker", "Afirmación [citation needed].\n"],
    ["a {{template}} marker", "Hola {{nombre}}.\n"],
    ["a page break request", "Antes\n\n\\newpage\n"],
    ["an unknown attribute", "![Pie](figures/images/a.png){#fig-a color=red}\n"],
    ["an unsafe figure path", "![Pie](../secret.png){#fig-a}\n"],
    ["a figure outside figures/", "![Pie](data/a.png){#fig-a}\n"],
    ["an unsupported image type", "![Pie](figures/images/a.gif){#fig-a}\n"],
    ["an inline image", "Texto ![x](figures/images/a.png) más.\n"],
    ["a non-http link", "[x](ftp://example.org/a)\n"],
    ["a relative link", "[x](page.html)\n"],
    ["a thematic break", "a\n\n---\n\nb\n"],
    ["a heading deeper than level 4", "##### Profundo\n"],
    ["a Table: caption without a table", "Table: Suelta.\n"],
  ];
  for (const [name, source] of cases) {
    it(`flags ${name}`, () => {
      expect(codes(source)).toContain("HYG-001");
    });
  }

  it("reports the line of the offending block", () => {
    const finding = parse("uno\n\ndos\n\n<div>x</div>\n").findings[0];
    expect(finding).toMatchObject({
      code: "HYG-001",
      gate: "G7",
      file: "chapters/01-test.md",
      line: 5,
    });
  });

  it("reports front matter offsets in original file lines", () => {
    const finding = parse("---\nsection: SEC-01\n---\n\n<div>x</div>\n").findings[0];
    expect(finding?.line).toBe(5);
  });

  it("keeps braces in prose that are not attribute groups", () => {
    expect(codes("## Conjuntos {a, b}\n\nLa unión {x} es válida.\n")).toEqual([]);
  });
});
