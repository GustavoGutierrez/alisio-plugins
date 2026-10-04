import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitTypst } from "../src/render/adapters/typst-pdf/emitter.js";
import { escapeText, typstLabel, typstString } from "../src/render/adapters/typst-pdf/escape.js";
import { diagramThemeFor } from "../src/render/diagram-theme.js";
import { validateLatex } from "../src/render/math.js";
import type { FigureAsset, ThesisDocument } from "../src/render/model.js";
import { parseChapter } from "../src/render/parse.js";
import { resolveCitationStyle } from "../src/styles/discovery.js";
import { loadShippedProfile, type PresentationProfile } from "../src/styles/profile.js";
import type { EvidenceRecord } from "../src/types.js";

const style = (id: string) =>
  resolveCitationStyle(id, []).style as NonNullable<
    ReturnType<typeof resolveCitationStyle>["style"]
  >;

const record = (citeKey: string): EvidenceRecord =>
  ({ citeKey, id: "EVD-00001", status: "VERIFIED_PEER_REVIEWED" }) as EvidenceRecord;

function documentOf(markdown: string, extra: Partial<ThesisDocument> = {}): ThesisDocument {
  const parsed = parseChapter("chapters/01-test.md", markdown);
  const resolve = (asset: FigureAsset) => {
    asset.resolved = {
      file: `figures/abc.${asset.kind === "mermaid" ? "mmd" : asset.kind === "svg" ? "svg" : "png"}`,
      sha256: "abc",
      bytes: 1,
    };
  };
  for (const block of parsed.section.blocks) if (block.kind === "figure") resolve(block.asset);
  return {
    meta: {
      language: "es-CO",
      languageCode: "es",
      region: "co",
      title: "T",
      subtitle: null,
      authors: ["A"],
      advisors: [],
      institution: { name: null, faculty: null, program: null, city: null, country: "CO" },
      year: 2026,
      workType: "undergraduate_thesis",
      secondaryAbstractLanguage: null,
      paper: "letter",
      fontProfile: "serif",
      bodyFont: null,
      palette: "okabe-ito",
      diagramTheme: "neutral",
      lineSpacing: null,
      presentationStandard: "generic",
      citationStyle: "apa-7",
      aiDeclarationRequired: false,
      ruleIds: [],
    },
    presentation: loadShippedProfile("generic") as PresentationProfile,
    diagramTheme: diagramThemeFor({
      palette: "okabe-ito",
      diagramTheme: "neutral",
      fontProfile: "serif",
      bodyFont: null,
    }),
    frontMatter: [],
    body: [parsed.section],
    annexes: [],
    footnotes: parsed.footnotes,
    figures: new Map(),
    bibliography: {
      entries: ["perez2021", "garcia2019", "a2020", "b2021"].map(record),
      styleId: "apa-7",
      csl: style("apa-7"),
      bibtex: "",
    },
    strings: { abstract: "Resumen", keywords: "Palabras clave" },
    ...extra,
  };
}

/** The Typst emitted for the body only (what follows the body-mode show rule). */
function body(markdown: string): string {
  const emitted = emitTypst(documentOf(markdown)).main;
  const start = emitted.indexOf("#show: body-mode\n") + "#show: body-mode\n".length;
  const end = emitted.indexOf("#references(");
  return emitted.slice(start, end === -1 ? undefined : end);
}

describe("escaping every text node", () => {
  const cases: [string, string, string][] = [
    ["hash", "a #set b", "a \\#set b"],
    ["dollar", "cost $5", "cost \\$5"],
    ["star", "a*b", "a\\*b"],
    ["underscore", "snake_case", "snake\\_case"],
    ["backtick", "a`b", "a\\`b"],
    ["angle brackets", "a<b>c", "a\\<b\\>c"],
    ["at sign", "a@b", "a\\@b"],
    ["square brackets", "[x]", "\\[x\\]"],
    ["backslash", "a\\b", "a\\\\b"],
    ["slash and comment openers", "a//b /* c", "a\\/\\/b \\/\\* c"],
    ["equals", "a = b", "a \\= b"],
    ["leading dash", "- item", "\\- item"],
    ["leading plus", "+ item", "\\+ item"],
    ["leading number dot", "1. item", "1\\. item"],
    ["tilde", "a~b", "a\\~b"],
    ["braces", "{x}", "\\{x\\}"],
    ["a URL in prose", "https://x.org/a", "https:\\/\\/x.org\\/a"],
    ["control characters", "a\u0000b\u0007c", "abc"],
  ];
  for (const [name, input, expected] of cases) {
    it(`escapes ${name}`, () => expect(escapeText(input)).toBe(expected));
  }

  it("quotes string literals", () => {
    expect(typstString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });

  it("rejects unsafe labels", () => {
    expect(() => typstLabel("a b")).toThrow();
    expect(typstLabel("fig-a1")).toBe("<fig-a1>");
  });

  it("never lets Markdown text become Typst code in a full paragraph", () => {
    const out = body("Texto con #let x = 1 y $5, _a_ y `@perez2021` o a@b.org.\n");
    expect(out).toContain("\\#let x \\= 1");
    expect(out).toContain("\\$5");
    expect(out).toContain("#emph[a];");
    expect(out).toContain('#raw("@perez2021");');
    expect(out).toContain("a\\@b.org");
  });
});

describe("emitter goldens", () => {
  it("paragraphs, emphasis, strong, code and links", () => {
    expect(body("Un *énfasis*, **fuerte**, `code` y [enlace](https://ejemplo.org/a).\n")).toBe(
      'Un #emph[énfasis];, #strong[fuerte];, #raw("code"); y #link("https://ejemplo.org/a")[enlace];.\n\n',
    );
  });

  it("closes inline calls so a following dot or bracket stays text", () => {
    expect(body("*a*.len y **b**[c]\n")).toBe("#emph[a];.len y #strong[b];\\[c\\]\n\n");
  });

  it("headings with and without labels", () => {
    expect(body("# Uno {#sec-uno}\n\n## Dos\n")).toBe(
      "#heading(level: 1)[Uno] <sec-uno>\n\n#heading(level: 2)[Dos]\n\n",
    );
  });

  it("citations: plain, locator, narrative and grouped", () => {
    expect(body("[@perez2021] y [@garcia2019, p. 17] y @perez2021 y [@a2020; @b2021]\n")).toBe(
      '#cite(<perez2021>); y #cite(<garcia2019>, supplement: [p. 17]); y #cite(<perez2021>, form: "prose"); y #cite(<a2020>)#cite(<b2021>);\n\n',
    );
  });

  it("cross-references", () => {
    expect(body("Ver @fig-a y @eq-b y @sec-c.\n")).toBe(
      "Ver #ref(<fig-a>); y #ref(<eq-b>); y #ref(<sec-c>);.\n\n",
    );
  });

  it("inline math goes through mi() as an escaped string", () => {
    expect(body('Sea $\\alpha^2 + "x"$ ok.\n')).toBe('Sea #mi("\\\\alpha^2 + \\"x\\""); ok.\n\n');
  });

  it("display math: labeled equations get static numbering, bare ones are unnumbered", () => {
    const out = body("# C\n\n$$ a = b $$ {#eq-uno}\n\n$$ c $$\n\n$$ d $$ {#eq-dos}\n");
    expect(out).toContain('#mitex("a = b", numbering: num-eq(1, 1, 1)) <eq-uno>');
    expect(out).toContain('#mitex("c", numbering: none)');
    expect(out).toContain('#mitex("d", numbering: num-eq(1, 2, 2)) <eq-dos>');
  });

  it("figures and tables are numbered per chapter from the emitter", () => {
    const out = body(
      "# A\n\n![Uno. Fuente: x.](figures/diagrams/a.mmd){#fig-a width=60%}\n\n# B\n\n![Dos.](figures/images/b.png){#fig-b}\n\n| H |\n|---|\n| c |\n\nTable: Tabla. {#tbl-a}\n",
    );
    expect(out).toMatch(
      /#t-figure\(mermaid\(read\("figures\/abc\.mmd"\), width: 60%, theme-name: "base", theme: \(primaryColor: "#[0-9a-f]{6}", .*\), background: "#FFFFFF", typography: \(font: \("Libertinus Serif", "New Computer Modern",\), size: "14px"\)\), caption: \[Uno\.\], source: \[Fuente: x\.\], number: \(1, 1, 1\)\) <fig-a>/,
    );
    expect(out).toContain(
      '#t-figure(image("figures/abc.png", width: auto), caption: [Dos.], source: none, number: (2, 1, 2)) <fig-b>',
    );
    expect(out).toContain("number: (2, 1, 1)) <tbl-a>");
    expect(out).toContain("#t-table(table(columns: 1, align: (auto,), table.header([H]), [c]),");
  });

  it("lists, quotes and code blocks", () => {
    expect(body("- a\n- b\n\n1. x\n\n> cita\n\n```python\nprint(1)\n```\n")).toBe(
      '#list([a\n\n], [b\n\n])\n\n#enum([x\n\n])\n\n#quote(block: true)[cita\n\n]\n\n#raw("print(1)", block: true, lang: "python")\n\n',
    );
  });

  it("footnotes become inline #footnote", () => {
    expect(body("Texto[^1].\n\n[^1]: Nota *x*.\n")).toBe("Texto#footnote[Nota #emph[x];.];.\n\n");
  });

  it("claim anchors vanish from the output", () => {
    expect(body("<!-- claim:c1 -->\nHola.\n")).toBe("Hola.\n\n");
  });

  it("the references call appears only when something is cited", () => {
    expect(emitTypst(documentOf("Sin citas.\n")).hasBibliography).toBe(false);
    const cited = emitTypst(documentOf("Con cita [@perez2021].\n"));
    expect(cited.hasBibliography).toBe(true);
    expect(cited.main).toContain('#references("/styles/apa.csl")');
    expect(
      emitTypst(
        documentOf("[@perez2021]\n", {
          bibliography: {
            entries: [record("perez2021")],
            styleId: "ieee",
            csl: style("ieee"),
            bibtex: "",
          },
        }),
      ).main,
    ).toContain('#references("/styles/ieee.csl")');
  });

  it("writes the pinned, vendored package imports and no raw network imports", () => {
    const { main } = emitTypst(documentOf("x\n"));
    expect(main).toContain('#import "@preview/mitex:0.2.7": mitex, mi');
    expect(main).toContain('#import "@preview/merman:0.3.0": mermaid');
    expect(main.match(/#import "@preview\/[^"]+"/g)).toHaveLength(2);
  });
});

describe("MTH-001 and CIT-001 while emitting", () => {
  const bad: [string, string][] = [
    ["a backtick", "a`b"],
    ["unbalanced braces", "\\frac{1}{"],
    ["a file include", "\\input{secret}"],
    ["a macro definition", "\\def\\x{1}"],
    ["a newcommand", "\\newcommand{\\x}{1}"],
    ["a write command", "\\write18{ls}"],
    ["an unbalanced left/right", "\\left( x"],
    ["a mismatched environment", "\\begin{matrix} a \\end{cases}"],
    ["a stray dollar", "a $ b"],
    ["an empty formula", "  "],
    ["a very long formula", "x".repeat(2001)],
  ];
  for (const [name, latex] of bad) {
    it(`rejects ${name}`, () => {
      expect(validateLatex(latex)).toBeTypeOf("string");
    });
  }

  it("accepts ordinary formulas", () => {
    for (const latex of [
      "\\frac{a}{b}",
      "\\left( x \\right)",
      "[0, 1)",
      "\\begin{matrix} a \\end{matrix}",
      "\\$5",
    ]) {
      expect(validateLatex(latex)).toBeUndefined();
    }
  });

  it("reports MTH-001 findings with the line and never emits the formula", () => {
    const emitted = emitTypst(documentOf("Uno.\n\n$$ \\input{x} $$ {#eq-a}\n"));
    expect(emitted.findings).toMatchObject([
      { code: "MTH-001", severity: "error", file: "chapters/01-test.md", line: 3 },
    ]);
    expect(emitted.main).not.toContain("input{x}");
  });

  it("reports CIT-001 for a key missing from the library", () => {
    const emitted = emitTypst(documentOf("Cita [@nadie1999].\n"));
    expect(emitted.findings).toMatchObject([{ code: "CIT-001", severity: "error" }]);
  });
});

describe("adapter isolation (spec 10.0)", () => {
  const adapters = join(import.meta.dirname, "..", "src", "render", "adapters");
  const sources = (directory: string): string[] =>
    readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      return statSync(path).isDirectory() ? sources(path) : name.endsWith(".ts") ? [path] : [];
    });

  it("no adapter imports another adapter", () => {
    const folders = readdirSync(adapters).filter((name) =>
      statSync(join(adapters, name)).isDirectory(),
    );
    expect(folders.sort()).toEqual(["chrome-pdf", "html-preview", "test-json", "typst-pdf"]);
    for (const folder of folders) {
      for (const file of sources(join(adapters, folder))) {
        const text = readFileSync(file, "utf8");
        for (const other of folders.filter((name) => name !== folder)) {
          expect(text, `${file} must not reference ${other}`).not.toMatch(
            new RegExp(`from\\s+["'][^"']*adapters/${other}|from\\s+["']\\.\\./${other}`),
          );
        }
      }
    }
  });

  it("the neutral modules never import an adapter", () => {
    const render = join(import.meta.dirname, "..", "src", "render");
    for (const name of [
      "model.ts",
      "parse.ts",
      "dialect.ts",
      "assemble.ts",
      "assets.ts",
      "port.ts",
      "registry.ts",
      "math.ts",
      "walk.ts",
      "numbering.ts",
      "output-name.ts",
    ]) {
      expect(readFileSync(join(render, name), "utf8"), name).not.toMatch(
        /from\s+["'][^"']*adapters\//,
      );
    }
  });
});
