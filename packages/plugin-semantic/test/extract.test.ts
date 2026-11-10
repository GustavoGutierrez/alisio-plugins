import { describe, expect, it } from "vitest";
import { extractBytes, extractPdfPages, formatOf } from "../src/notebook/extract.js";
import { docx, makeZip, pptx, xlsx } from "./zip-fixture.js";

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe("text extraction (§7.3, SEM-AC-11)", () => {
  it("decodes UTF-8 text and strips the BOM", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Hola, año\n")]);
    expect(await extractBytes("notes.txt", bytes)).toEqual([{ text: "Hola, año\n", page: null }]);
    expect((await extractBytes("data.csv", Buffer.from("a,b\n1,2")))[0]?.text).toBe("a,b\n1,2");
  });

  it("rejects invalid UTF-8 with invalid_encoding", async () => {
    expect(await code(extractBytes("bad.md", Buffer.from([0x61, 0xff, 0xfe, 0x62])))).toBe(
      "invalid_encoding",
    );
  });

  it("drops script and style from HTML and decodes entities", async () => {
    const html =
      "<html><head><style>p{color:red}</style><script>alert('x')</script></head><body><h1>Title</h1><p>Caf&eacute; &amp; t&#233; &lt;3</p></body></html>";
    const [segment] = await extractBytes("page.html", Buffer.from(html));
    expect(segment?.text).not.toMatch(/alert|color/);
    expect(segment?.text).toContain("Title");
    expect(segment?.text).toContain("Café & té <3");
  });

  it("reads .docx paragraphs from word/document.xml", async () => {
    const [segment] = await extractBytes("doc.docx", docx(["First &amp; one", "Second"]));
    expect(segment?.text).toBe("First & one\n\nSecond");
  });

  it("rejects zip bombs and broken archives with zip_invalid", async () => {
    const many = makeZip(
      Array.from({ length: 1001 }, (_, i) => ({ name: `f${i}.xml`, data: Buffer.from("x") })),
    );
    expect(await code(extractBytes("many.docx", many))).toBe("zip_invalid");
    const huge = makeZip([{ name: "word/document.xml", data: Buffer.alloc(51 * 1024 * 1024, 32) }]);
    expect(await code(extractBytes("huge.docx", huge))).toBe("zip_invalid");
    const lying = makeZip([
      { name: "word/document.xml", data: Buffer.alloc(51 * 1024 * 1024, 32), declaredSize: 10 },
    ]);
    expect(await code(extractBytes("lying.docx", lying))).toBe("zip_invalid");
    expect(await code(extractBytes("x.docx", Buffer.from("not a zip")))).toBe("zip_invalid");
    expect(
      await code(extractBytes("x.docx", makeZip([{ name: "a.xml", data: Buffer.from("a") }]))),
    ).toBe("zip_invalid");
  });

  it("rejects unknown formats and PDF bytes on the backend", async () => {
    expect(await code(extractBytes("photo.png", Buffer.from("x")))).toBe("unsupported_format");
    expect(await code(extractBytes("paper.pdf", Buffer.from("%PDF")))).toBe("unsupported_format");
    expect(formatOf("A.MD")).toBe("text");
    expect(formatOf("paper.pdf")).toBe("pdf");
  });
});

describe("presentations and workbooks (O10)", () => {
  it("reads slides in presentation order, with their notes, one page per slide", async () => {
    const segments = await extractBytes("deck.pptx", pptx());
    expect(segments).toEqual([
      {
        text: "Quarterly results\nRevenue grew 12% & costs fell\n\nMention the new market.",
        page: 1,
      },
      { text: "Next steps\nHire two engineers", page: 2 },
    ]);
  });

  it("reads each sheet as a page: name, then tab-separated rows of cell values", async () => {
    const segments = await extractBytes("book.xlsx", xlsx());
    expect(segments).toEqual([
      { text: "Sheet: Sales & costs\nRegion\t\tTotal\nNorth\t\t1250.5\tTRUE", page: 1 },
      { text: "Sheet: Notes\n\tCheck the north office\tcalc text", page: 2 },
    ]);
  });

  it("rejects broken or bomb-like presentations and workbooks, and macro-enabled files", async () => {
    expect(await code(extractBytes("x.pptx", Buffer.from("PK nope")))).toBe("zip_invalid");
    expect(
      await code(
        extractBytes(
          "x.xlsx",
          makeZip([{ name: "xl/workbook.xml", data: Buffer.from("<workbook/>") }]),
        ),
      ),
    ).toBe("zip_invalid");
    const bomb = makeZip([
      { name: "ppt/presentation.xml", data: Buffer.alloc(40 * 1024 * 1024, 32) },
      { name: "ppt/_rels/presentation.xml.rels", data: Buffer.from("<Relationships/>") },
    ]);
    expect(await code(extractBytes("bomb.pptx", bomb))).toBe("zip_invalid");
    const dtd = makeZip([
      {
        name: "xl/workbook.xml",
        data: Buffer.from('<!DOCTYPE x [<!ENTITY a "aaaa">]><workbook/>'),
      },
      { name: "xl/_rels/workbook.xml.rels", data: Buffer.from("<Relationships/>") },
    ]);
    expect(await code(extractBytes("dtd.xlsx", dtd))).toBe("zip_invalid");
    const escaping = makeZip([
      {
        name: "ppt/presentation.xml",
        data: Buffer.from('<p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst>'),
      },
      {
        name: "ppt/_rels/presentation.xml.rels",
        data: Buffer.from(
          '<Relationships><Relationship Id="rId1" Type="x/slide" Target="../../../etc/passwd"/></Relationships>',
        ),
      },
    ]);
    expect(await code(extractBytes("escape.pptx", escaping))).toBe("zip_invalid");
    expect(await code(extractBytes("macro.xlsm", xlsx()))).toBe("unsupported_format");
    expect(await code(extractBytes("macro.pptm", pptx()))).toBe("unsupported_format");
  });
});

describe("PDF pages from the frame (SEM-AC-12)", () => {
  it("rejects pages averaging under 20 characters as no_text", () => {
    expect(() => extractPdfPages(["abcde", "fghij", "", "klmno"])).toThrow(
      expect.objectContaining({ code: "no_text" }),
    );
  });

  it("keeps one segment per page with its number", () => {
    const pages = ["Page one has enough text to count.", "Page two has enough text as well."];
    expect(extractPdfPages(pages)).toEqual([
      { text: pages[0], page: 1 },
      { text: pages[1], page: 2 },
    ]);
  });
});
