import { SemanticPluginError } from "../errors.js";
import type { Segment } from "./chunk.js";
import { decodeXml, docxText } from "./docx.js";
import { pptxSegments, xlsxSegments } from "./ooxml.js";

export type SourceFormat = "text" | "html" | "docx" | "pptx" | "xlsx" | "pdf";

const FORMATS: Record<string, SourceFormat> = {
  txt: "text",
  md: "text",
  markdown: "text",
  csv: "text",
  json: "text",
  html: "html",
  htm: "html",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
  pdf: "pdf",
};

/** Format by file extension (case-insensitive), or undefined when unsupported. */
export function formatOf(name: string): SourceFormat | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext ? FORMATS[ext] : undefined;
}

function utf8(bytes: Uint8Array): string {
  try {
    // The decoder strips a leading BOM by default.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SemanticPluginError("invalid_encoding");
  }
}

const BLOCK =
  /<\/?(?:p|div|br|h[1-6]|li|ul|ol|tr|table|section|article|header|footer|blockquote|pre)\b[^>]*>/gi;

export function htmlText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(BLOCK, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeXml(decodeHtmlNamed(text))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED: Record<string, string> = {
  nbsp: " ",
  eacute: "é",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  Eacute: "É",
  Aacute: "Á",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
  uuml: "ü",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  iquest: "¿",
  iexcl: "¡",
  ccedil: "ç",
  agrave: "à",
  egrave: "è",
};
const decodeHtmlNamed = (text: string) =>
  text.replace(/&([A-Za-z]+);/g, (match, name: string) => NAMED[name] ?? match);

/** Text segments of an uploaded file (PDF text comes from the frame, see `extractPdfPages`). */
export async function extractBytes(name: string, bytes: Buffer): Promise<Segment[]> {
  const format = formatOf(name);
  switch (format) {
    case "text":
      return [{ text: utf8(bytes), page: null }];
    case "html":
      return [{ text: htmlText(utf8(bytes)), page: null }];
    case "docx":
      return [{ text: docxText(bytes), page: null }];
    case "pptx":
      return pptxSegments(bytes);
    case "xlsx":
      return xlsxSegments(bytes);
    default:
      // PDF text is extracted in the frame with PDF.js (§7.3); anything else is unsupported.
      throw new SemanticPluginError("unsupported_format");
  }
}

export const PDF_MIN_CHARS_PER_PAGE = 20;

/** One segment per PDF page; fewer than 20 characters per page on average is `no_text`. */
export function extractPdfPages(pages: string[]): Segment[] {
  const characters = pages.reduce((sum, page) => sum + page.trim().length, 0);
  if (pages.length === 0 || characters / pages.length < PDF_MIN_CHARS_PER_PAGE)
    throw new SemanticPluginError("no_text");
  return pages.map((text, index) => ({ text, page: index + 1 }));
}
