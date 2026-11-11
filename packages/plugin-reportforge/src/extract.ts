import { unzipSync } from "fflate";

const MAX_TEXT = 900_000;
const xmlDecode = (x: string) =>
  x.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return (
      ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[name] || ""
    );
  });
function unzipOffice(bytes: Uint8Array): Record<string, Uint8Array> {
  const contents = unzipSync(bytes, {
    filter: (file) => {
      const name = file.name;
      // Do not unpack images, embedded documents, fonts, VBA or huge XML files.
      return (
        !name.includes("..") &&
        name.endsWith(".xml") &&
        file.originalSize < 3_000_000 &&
        (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name) ||
          /^xl\/(sharedStrings|workbook)\.xml$/.test(name) ||
          /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      );
    },
  });
  if (Object.keys(contents).length > 80) throw new Error("too_many_xml_parts");
  return contents;
}
function getXml(zip: Record<string, Uint8Array>, name: string) {
  const data = zip[name];
  return data ? new TextDecoder().decode(data) : "";
}
function allTexts(xml: string, tag: string) {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "g");
  return [...xml.matchAll(regex)].map((m) => xmlDecode(m[1]!.replace(/<[^>]+>/g, "")));
}
function docxText(zip: Record<string, Uint8Array>): string {
  const xml = getXml(zip, "word/document.xml");
  if (!xml) throw new Error("docx_document_missing");
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .slice(0, 2500)
    .map((m) => allTexts(m[1]!, "w:t").join(""));
  return paragraphs.join("\n").slice(0, MAX_TEXT);
}
function xlsxText(zip: Record<string, Uint8Array>): string {
  const sharedXml = getXml(zip, "xl/sharedStrings.xml");
  const strings = [...sharedXml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
    .slice(0, 50000)
    .map((m) => allTexts(m[1]!, "t").join(""));
  const sheets = Object.keys(zip)
    .filter((x) => /^xl\/worksheets\/sheet\d+\.xml$/.test(x))
    .sort(
      (a, b) => Number(a.match(/sheet(\d+)/)?.[1] || 0) - Number(b.match(/sheet(\d+)/)?.[1] || 0),
    )
    .slice(0, 30);
  if (!sheets.length) throw new Error("xlsx_sheets_missing");
  const output: string[] = [];
  for (const sheet of sheets) {
    output.push(`\n### ${sheet}`);
    const xml = getXml(zip, sheet);
    for (const row of [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 500)) {
      const cols: string[] = [];
      for (const cell of [...row[1]!.matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)].slice(
        0,
        60,
      )) {
        const attributes = cell[1] || "",
          body = cell[2] || "",
          typ = attributes.match(/\bt="([^"]+)"/)?.[1] || "";
        const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] || "";
        let value =
          typ === "s"
            ? (strings[Number(raw)] ?? "")
            : typ === "inlineStr"
              ? allTexts(body, "t").join("")
              : xmlDecode(raw);
        if (!value && typ === "str") value = raw;
        cols.push(value.replace(/[\r\n\t]/g, " ").slice(0, 1200));
      }
      output.push(cols.join("\t"));
      if (output.join("\n").length > MAX_TEXT) break;
    }
  }
  return output.join("\n").slice(0, MAX_TEXT);
}
async function pdfText(bytes: Uint8Array): Promise<string> {
  // Loaded only when a PDF is imported. pdf.js 6 never evaluates code from the document.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    enableXfa: false,
  });
  try {
    const doc = await task.promise;
    if (doc.numPages > 100) throw new Error("pdf_too_many_pages");
    const out: string[] = [];
    let size = 0;
    for (let pageNo = 1; pageNo <= doc.numPages && size <= MAX_TEXT; pageNo++) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ("str" in item ? String(item.str) : ""))
        .filter(Boolean)
        .join(" ");
      out.push(`[PAGE ${pageNo}]`, line);
      size += line.length + 12;
    }
    return out.join("\n").slice(0, MAX_TEXT);
  } catch (error) {
    if (error instanceof Error && /^[a-z_]+$/.test(error.message)) throw error;
    throw new Error("pdf_unreadable");
  } finally {
    await task.destroy();
  }
}
export async function extractDocument(
  name: string,
  _mime: string,
  bytes: Uint8Array,
): Promise<{ mime: string; text: string }> {
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("source_too_large");
  const lower = name.toLowerCase();
  if (lower.endsWith(".docx"))
    return {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      text: docxText(unzipOffice(bytes)),
    };
  if (lower.endsWith(".xlsx"))
    return {
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      text: xlsxText(unzipOffice(bytes)),
    };
  if (lower.endsWith(".pdf")) return { mime: "application/pdf", text: await pdfText(bytes) };
  throw new Error("unsupported_file_type");
}
