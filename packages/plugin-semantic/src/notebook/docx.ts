// .docx text (§7.3): `word/document.xml`, `<w:p>` per paragraph, `<w:t>` runs, tabs and breaks.
import { DOCX_LIMITS, decodeXml, ZipArchive } from "./zip.js";

export { decodeXml } from "./zip.js";

export function docxText(bytes: Buffer): string {
  const xml = new ZipArchive(bytes, DOCX_LIMITS).xml("word/document.xml");
  const paragraphs: string[] = [];
  for (const match of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    let text = "";
    for (const token of match[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g))
      text += token[1] !== undefined ? decodeXml(token[1]) : token[0] === "<w:tab/>" ? "\t" : "\n";
    if (text.trim()) paragraphs.push(text);
  }
  return paragraphs.join("\n\n");
}
