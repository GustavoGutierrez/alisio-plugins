import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractDocument } from "../src/extract.js";

function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  return zipSync({
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
    ),
    "word/media/evil.bin": strToU8("ignored"),
  });
}

function xlsx(): Uint8Array {
  return zipSync({
    "xl/sharedStrings.xml": strToU8(
      "<sst><si><t>Region</t></si><si><t>North &amp; East</t></si></sst>",
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      '<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c><c><v>2024</v></c></row><row r="2"><c t="s"><v>1</v></c><c><v>42.5</v></c></row></sheetData></worksheet>',
    ),
  });
}

/** A minimal one-page PDF with a text line, with a correct cross-reference table. */
function pdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}

describe("extractDocument", () => {
  it("reads the paragraphs of a DOCX", async () => {
    const out = await extractDocument("brief.docx", "", docx(["First &amp; foremost", "Second"]));
    expect(out.text).toBe("First & foremost\nSecond");
    expect(out.mime).toContain("wordprocessingml");
  });

  it("reads the cells of an XLSX with shared strings", async () => {
    const out = await extractDocument("data.xlsx", "", xlsx());
    expect(out.text).toContain("Region\t2024");
    expect(out.text).toContain("North & East\t42.5");
  });

  it("reads the text of a PDF", async () => {
    const out = await extractDocument("report.pdf", "", pdf("Quarterly revenue grew"));
    expect(out.text).toContain("[PAGE 1]");
    expect(out.text).toContain("Quarterly revenue grew");
  });

  it("rejects broken, oversized and unsupported files with codes", async () => {
    await expect(extractDocument("x.pdf", "", strToU8("not a pdf"))).rejects.toThrow(
      "pdf_unreadable",
    );
    await expect(extractDocument("x.docx", "", zipSync({ "a.txt": strToU8("x") }))).rejects.toThrow(
      "docx_document_missing",
    );
    await expect(extractDocument("x.xlsx", "", new Uint8Array(9 * 1024 * 1024))).rejects.toThrow(
      "source_too_large",
    );
    await expect(extractDocument("x.odt", "", new Uint8Array(4))).rejects.toThrow(
      "unsupported_file_type",
    );
  });
});
