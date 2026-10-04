import { describe, expect, it } from "vitest";
import { chromeArgs } from "../src/render/adapters/chrome-pdf/cdp.js";
import { isRequestAllowed } from "../src/render/adapters/chrome-pdf/network.js";
import { emitTypst } from "../src/render/adapters/typst-pdf/emitter.js";
import { diagramThemeFor } from "../src/render/diagram-theme.js";
import { generateCss } from "../src/render/html/css.js";
import { emitHtml } from "../src/render/html/emitter.js";
import { escapeHtml, jsonForScript, safeHref } from "../src/render/html/escape.js";
import { renderMath } from "../src/render/html/katex.js";
import type { FigureAsset, Section, ThesisDocument } from "../src/render/model.js";
import { formatNumbering } from "../src/render/numbering.js";
import { parseChapter } from "../src/render/parse.js";
import { resolveCitationStyle } from "../src/styles/discovery.js";
import { loadShippedProfile, type PresentationProfile } from "../src/styles/profile.js";
import type { EvidenceRecord } from "../src/types.js";

const record = (citeKey: string, extra: Partial<EvidenceRecord> = {}): EvidenceRecord =>
  ({
    citeKey,
    id: "EVD-00001",
    status: "VERIFIED_PEER_REVIEWED",
    type: "journal_article",
    title: `Title of ${citeKey}`,
    authors: [{ family: "Pérez", given: "Ana" }],
    year: 2021,
    containerTitle: "Journal",
    ...extra,
  }) as EvidenceRecord;

function sectionOf(path: string, markdown: string, role: Section["role"] = "body") {
  const parsed = parseChapter(path, markdown);
  for (const block of parsed.section.blocks) {
    if (block.kind === "figure") {
      (block.asset as FigureAsset).resolved = {
        file: `figures/abc.${block.asset.kind === "mermaid" ? "mmd" : "svg"}`,
        sha256: "abc",
        bytes: 1,
        ...(block.asset.kind === "mermaid" ? { text: "graph TD; A-->B" } : {}),
      };
    }
  }
  return { section: { ...parsed.section, role }, footnotes: parsed.footnotes };
}

function documentOf(
  chapters: string[],
  options: { annex?: string; style?: string; profile?: string } = {},
): ThesisDocument {
  const bodies = chapters.map((text, index) => sectionOf(`chapters/0${index + 1}-c.md`, text));
  const annex = options.annex
    ? sectionOf("chapters/annexes/A.md", options.annex, "annex")
    : undefined;
  const style = resolveCitationStyle(options.style ?? "apa-7", []).style as NonNullable<
    ReturnType<typeof resolveCitationStyle>["style"]
  >;
  return {
    meta: {
      language: "es-CO",
      languageCode: "es",
      region: "co",
      title: "T <b>",
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
      citationStyle: options.style ?? "apa-7",
      aiDeclarationRequired: false,
      ruleIds: [],
    },
    presentation: loadShippedProfile(options.profile ?? "generic") as PresentationProfile,
    diagramTheme: diagramThemeFor({
      palette: "okabe-ito",
      diagramTheme: "neutral",
      fontProfile: "serif",
      bodyFont: null,
    }),
    frontMatter: [],
    body: bodies.map((entry) => entry.section),
    annexes: annex ? [annex.section] : [],
    footnotes: Object.assign({}, ...bodies.map((entry) => entry.footnotes), annex?.footnotes ?? {}),
    figures: new Map(),
    bibliography: {
      entries: [
        record("perez2021"),
        record("garcia2019", { authors: [{ family: "García" }], year: 2019 }),
      ],
      styleId: options.style ?? "apa-7",
      csl: style,
      bibtex: "",
    },
    strings: {
      figure: "Figura",
      table: "Tabla",
      equation: "Ecuación",
      section: "Sección",
      annex: "Anexo",
      references: "Referencias",
      contents: "Contenido",
      page_abbr: "p.",
    },
  };
}

describe("HTML emitter: escaping and structure", () => {
  it("escapes every text node and attribute", () => {
    const out = emitHtml(
      documentOf([
        '# \\<script\\>alert(1)\\</script\\> & "q"\n\nA \\<img src=x onerror=y\\> & b.\n',
      ]),
    ).html;
    expect(out.slice(out.indexOf("<body>"))).not.toContain("<script>alert");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;q&quot;");
    expect(out).toContain("A &lt;img src=x onerror=y&gt; &amp; b.");
    expect(out).toContain("<title>T &lt;b&gt;</title>");
  });

  it("drops unsafe link targets and keeps web links", () => {
    const out = emitHtml(
      documentOf(["# C\n\n[x](javascript:alert(1)) [y](https://example.org/a?b=1&c=2)\n"]),
    ).html;
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain('href="https://example.org/a?b=1&amp;c=2"');
    expect(safeHref("file:///etc/passwd")).toBeUndefined();
    expect(escapeHtml("a\u0000b")).toBe("ab");
    expect(jsonForScript({ a: "</script>" })).not.toContain("</script>");
  });

  it("typesets math on the server and rejects bad formulas", () => {
    const ok = emitHtml(documentOf(["# C\n\nSea $x^2$.\n\n$$\ny = \\frac{1}{2}\n$$ {#eq-a}\n"]));
    expect(ok.html).toContain('class="katex"');
    expect(ok.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(renderMath("\\undefinedcommand{", false).error).toBeDefined();
    const bad = emitHtml(documentOf(["# C\n\nSea $\\input{x}$.\n"]));
    expect(bad.findings.some((f) => f.code === "MTH-001" && f.severity === "error")).toBe(true);
  });

  it("structure: cover, TOC anchors, cross-references, references and annexes", () => {
    const doc = documentOf(
      ["# Uno {#sec-uno}\n\nVer @sec-dos y [@perez2021].\n\n# Dos {#sec-dos}\n"],
      { annex: "# Anexo {#sec-ax}\n\nTexto.\n" },
    );
    const out = emitHtml(doc).html;
    expect(out).toContain('class="cover cover-centered"');
    expect(out).toMatch(/<li class="toc-l1 toc-body"><a href="#sec-uno">/);
    expect(out).toContain('<a class="xref" href="#sec-dos">Sección 2</a>');
    expect(out).toContain('id="ref-perez2021"');
    expect(out).toContain('<section class="annexes">');
    expect(out).toMatch(/<span class="hnum">A<\/span>/);
    expect(out).toContain('(<a class="cite-link" href="#ref-perez2021">Pérez, 2021</a>)');
  });

  it("emits the BLD-004 approximation note and CIT-001 for unknown keys", () => {
    const result = emitHtml(documentOf(["# C\n\nVer [@nadie1999].\n"]));
    expect(result.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining(["CIT-001", "BLD-004"]),
    );
  });

  it("formats numeric and note families", () => {
    const numeric = emitHtml(
      documentOf(["# C\n\nA [@garcia2019] y [@perez2021, p. 3].\n"], { style: "ieee" }),
    ).html;
    expect(numeric).toContain("[1]");
    expect(numeric).toContain("[2, p. 3]");
    expect(numeric).toContain('<span class="ref-label">[1]</span>');
    const note = emitHtml(
      documentOf(["# C\n\nA [@perez2021].\n"], { style: "icontec-ntc1486-2022" }),
    ).html;
    expect(note).toContain('<span class="fn">PÉREZ, Ana.');
  });
});

describe("numbering parity with the Typst adapter", () => {
  for (const profile of ["generic", "icontec-ntc1486-2022"]) {
    it(`figure, table and equation numbers match the Typst static numbers (${profile})`, () => {
      const doc = documentOf(
        [
          "# Uno\n\n![A.](figures/a.svg){#fig-a}\n\n$$\na\n$$ {#eq-a}\n\n| h |\n|---|\n| 1 |\n\nTable: T1. {#tbl-a}\n",
          "# Dos\n\n![B.](figures/b.svg){#fig-b}\n\n![C.](figures/c.svg){#fig-c}\n\n$$\nb\n$$ {#eq-b}\n\n$$\nc\n$$\n",
        ],
        { annex: "# Anexo\n\n![D.](figures/d.svg){#fig-d}\n", profile },
      );
      const typst = emitTypst(doc).main;
      const typstTuples = [
        ...typst.matchAll(/(?:number: \(|num-eq\()(none|\d+|"[A-Z]"), (\d+), (\d+)\)/g),
      ].map((m) => [
        (m[1] as string).replaceAll('"', "").replace("none", ""),
        Number(m[2]),
        Number(m[3]),
      ]);
      const html = emitHtml(doc).html;
      const htmlTuples = [
        ...html.matchAll(/data-chapter="([^"]*)" data-index="(\d+)" data-sequence="(\d+)"/g),
      ].map((m) => [m[1] as string, Number(m[2]), Number(m[3])]);
      expect(typstTuples.length).toBeGreaterThanOrEqual(6);
      expect(htmlTuples).toEqual(typstTuples);
    });
  }

  it("formats Typst counting patterns", () => {
    expect(formatNumbering("1.1", [2, 3])).toBe("2.3");
    expect(formatNumbering("1.1.1", [2, 3, 4])).toBe("2.3.4");
    expect(formatNumbering("A.1.1", [1])).toBe("A");
    expect(formatNumbering("A.1.1", [2, 3])).toBe("B.3");
    expect(formatNumbering("1.1", [1, 2, 3])).toBe("1.2.3");
  });
});

describe("CSS from presentation profiles", () => {
  const meta = {
    paper: "letter",
    fontProfile: "serif",
    bodyFont: null,
    lineSpacing: null,
  } as const;
  it("generic: roman front, arabic body restarted, running header, justified text", () => {
    const css = generateCss(loadShippedProfile("generic") as PresentationProfile, meta);
    expect(css).toContain("@page { size: letter; margin: 2.5cm 2.5cm 2.5cm 3cm; }");
    expect(css).toContain("counter(page, lower-roman)");
    expect(css).toContain("string(chapter-title)");
    expect(css).toContain("counter-reset: page 1;");
    expect(css).toContain("text-align: justify");
    expect(css).toContain("line-height: 1.8");
  });
  it("icontec: continuous numbering, uppercase headings, no running header", () => {
    const css = generateCss(loadShippedProfile("icontec-ntc1486-2022") as PresentationProfile, {
      ...meta,
      paper: "a4",
    });
    expect(css).toContain("size: A4");
    expect(css).toContain("text-transform: uppercase");
    expect(css).not.toContain("counter-reset: page 1;");
  });
  it("apa: unjustified, centred level-1 headings", () => {
    const css = generateCss(loadShippedProfile("apa-7") as PresentationProfile, meta);
    expect(css).not.toContain("text-align: justify");
    expect(css).toContain("text-align: center");
  });
});

describe("network blocking and launch flags", () => {
  const dir = "/work/thesis/build";
  it("allows only file URLs inside the build directory and inline data", () => {
    expect(isRequestAllowed("file:///work/thesis/build/thesis.html", dir)).toBe(true);
    expect(isRequestAllowed("file:///work/thesis/build/_html/fonts/a.woff2", dir)).toBe(true);
    expect(isRequestAllowed("data:image/png;base64,AAAA", dir)).toBe(true);
    expect(isRequestAllowed("about:blank", dir)).toBe(true);
    expect(isRequestAllowed("file:///work/thesis/secret.txt", dir)).toBe(false);
    expect(isRequestAllowed("file:///work/thesis/build/../secret", dir)).toBe(false);
    expect(isRequestAllowed("file:///etc/passwd", dir)).toBe(false);
    expect(isRequestAllowed("file://server/share/x", dir)).toBe(false);
    expect(isRequestAllowed("https://example.org/x.js", dir)).toBe(false);
    expect(isRequestAllowed("http://127.0.0.1:9222/json", dir)).toBe(false);
    expect(isRequestAllowed("ws://example.org", dir)).toBe(false);
    expect(isRequestAllowed("not a url", dir)).toBe(false);
  });
  it("launches Chrome headless with a temp profile, pipe transport and no extensions", () => {
    expect(chromeArgs("/scratch/p", "pipe", false)).toEqual(
      expect.arrayContaining([
        "--headless=new",
        "--remote-debugging-pipe",
        "--user-data-dir=/scratch/p",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
      ]),
    );
    expect(chromeArgs("/scratch/p", "pipe", false)).not.toContain("--no-sandbox");
    expect(chromeArgs("/scratch/p", "websocket", true)).toEqual(
      expect.arrayContaining(["--remote-debugging-port=0", "--no-sandbox"]),
    );
  });
});
