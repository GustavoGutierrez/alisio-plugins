// .pptx and .xlsx text (owner O10). Reads only XML parts reached through the package's own
// relationships; never formulas (cached values only), macros, external links or embedded objects.
import { SemanticPluginError } from "../errors.js";
import type { Segment } from "./chunk.js";
import {
  attributes,
  decodeXml,
  OFFICE_LIMITS,
  relationships,
  resolvePart,
  ZipArchive,
} from "./zip.js";

/** Same rule as any source (§7.2): more extracted text than this is `limit_exceeded`. */
const MAX_CHARS = 2_000_000;
const MAX_CELLS = 2_000_000;

const bad = (): never => {
  throw new SemanticPluginError("zip_invalid");
};
const folderOf = (part: string) => part.slice(0, part.lastIndexOf("/") + 1);
const relsOf = (part: string) =>
  `${folderOf(part)}_rels/${part.slice(part.lastIndexOf("/") + 1)}.rels`;

function budget() {
  let used = 0;
  return (text: string) => {
    used += text.length;
    if (used > MAX_CHARS) throw new SemanticPluginError("limit_exceeded");
    return text;
  };
}

/** Text of `<a:p>` paragraphs (`<a:t>` runs, `<a:br/>` breaks); slide-number fields are skipped. */
function drawingParagraphs(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/g)) {
    const body = match[0].replace(/<a:fld\b[^>]*type="slidenum"[\s\S]*?<\/a:fld>/g, "");
    let text = "";
    for (const token of body.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>/g))
      text += token[1] !== undefined ? decodeXml(token[1]) : "\n";
    if (text.trim()) out.push(text.trim());
  }
  return out;
}

/** One segment per slide, in presentation order; notes follow the slide text after a blank line. */
export function pptxSegments(bytes: Buffer): Segment[] {
  const zip = new ZipArchive(bytes, OFFICE_LIMITS);
  const presentation = zip.xml("ppt/presentation.xml");
  const rels = relationships(zip.xml("ppt/_rels/presentation.xml.rels"));
  const take = budget();
  const segments: Segment[] = [];
  for (const match of presentation.matchAll(/<p:sldId\b([^>]*)\/?>/g)) {
    const id = attributes(match[1] as string)["r:id"];
    const rel = id ? rels.get(id) : undefined;
    if (!rel || !/\/slide$/.test(rel.type)) continue;
    const part = resolvePart("ppt/", rel.target);
    if (!part.startsWith("ppt/")) bad();
    const slideXml = zip.xml(part);
    const blocks = [drawingParagraphs(slideXml).join("\n")];
    const slideRels = zip.has(relsOf(part)) ? relationships(zip.xml(relsOf(part))) : new Map();
    for (const r of slideRels.values())
      if (/\/notesSlide$/.test(r.type)) {
        const notesPart = resolvePart(folderOf(part), r.target);
        if (zip.has(notesPart)) blocks.push(drawingParagraphs(zip.xml(notesPart)).join("\n"));
      }
    segments.push({ text: take(blocks.filter(Boolean).join("\n\n")), page: segments.length + 1 });
  }
  if (segments.length === 0) bad();
  return segments;
}

const columnIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "";
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};

/** Text of every `<t>` in a string item, without phonetic runs. */
const itemText = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)]
    .map((m) => decodeXml(m[1] as string))
    .join("");

/** One segment per sheet, in workbook order: "Sheet: <name>" then tab-separated rows. */
export function xlsxSegments(bytes: Buffer): Segment[] {
  const zip = new ZipArchive(bytes, OFFICE_LIMITS);
  const workbook = zip.xml("xl/workbook.xml");
  const rels = relationships(zip.xml("xl/_rels/workbook.xml.rels"));
  const shared = zip.has("xl/sharedStrings.xml")
    ? [...zip.xml("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
        itemText(m[1] as string),
      )
    : [];
  const take = budget();
  let cells = 0;
  const segments: Segment[] = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = attributes(match[1] as string);
    const rel = attrs["r:id"] ? rels.get(attrs["r:id"]) : undefined;
    if (!rel || !/\/worksheet$/.test(rel.type)) continue;
    const part = resolvePart("xl/", rel.target);
    if (!part.startsWith("xl/")) bad();
    const lines = [take(`Sheet: ${attrs.name ?? ""}`)];
    for (const row of zip.xml(part).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const values: string[] = [];
      for (const cell of (row[1] as string).matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        if (++cells > MAX_CELLS) throw new SemanticPluginError("limit_exceeded");
        const a = attributes(cell[1] as string);
        const body = cell[2] ?? "";
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: string | undefined;
        if (a.t === "inlineStr") value = itemText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
        else if (raw === undefined) value = undefined;
        else if (a.t === "s") value = shared[Number(raw)] ?? "";
        else if (a.t === "b") value = raw.trim() === "1" ? "TRUE" : "FALSE";
        else value = decodeXml(raw); // numbers as written, cached formula results, errors
        if (value === undefined || value === "") continue;
        const col = a.r ? columnIndex(a.r) : values.length;
        while (values.length < col) values.push("");
        values[col] = value.replace(/[\t\r\n]+/g, " ");
      }
      if (values.some((v) => v)) lines.push(take(values.join("\t")));
    }
    segments.push({ text: lines.join("\n"), page: segments.length + 1 });
  }
  if (segments.length === 0) bad();
  return segments;
}
