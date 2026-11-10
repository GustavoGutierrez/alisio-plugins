import { deflateRawSync } from "node:zlib";

/** Builds a minimal ZIP (deflate) in memory: enough for .docx and zip-bomb fixtures. */
export function makeZip(
  entries: Array<{ name: string; data: Buffer; declaredSize?: number }>,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const compressed = deflateRawSync(entry.data);
    const size = entry.declaredSize ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function docx(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((p) => `<w:p><w:pPr/><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`)
    .join("");
  const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`;
  return makeZip([
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
    { name: "word/document.xml", data: Buffer.from(xml) },
  ]);
}

const rels = (items: Array<[string, string, string]>) =>
  `<?xml version="1.0"?><Relationships xmlns="r">${items
    .map(
      ([id, type, target]) =>
        `<Relationship Id="${id}" Type="http://x/${type}" Target="${target}"/>`,
    )
    .join("")}</Relationships>`;
const file = (name: string, text: string) => ({ name, data: Buffer.from(text) });

/** A 2-slide deck (listed out of file order) whose first slide has speaker notes. */
export function pptx(): Buffer {
  const slide = (paragraphs: string[]) =>
    `<p:sld><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs
      .map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`)
      .join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  return makeZip([
    file(
      "ppt/presentation.xml",
      `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId7"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
    ),
    file(
      "ppt/_rels/presentation.xml.rels",
      rels([
        ["rId3", "slide", "slides/slide1.xml"],
        ["rId7", "slide", "slides/slide2.xml"],
        ["rId1", "theme", "theme/theme1.xml"],
      ]),
    ),
    file(
      "ppt/slides/slide2.xml",
      slide(["Quarterly results", "Revenue grew 12% &amp; costs fell"]),
    ),
    file(
      "ppt/slides/_rels/slide2.xml.rels",
      rels([["rId2", "notesSlide", "../notesSlides/notesSlide1.xml"]]),
    ),
    file(
      "ppt/notesSlides/notesSlide1.xml",
      `<p:notes><a:p><a:fld type="slidenum"><a:t>1</a:t></a:fld></a:p><a:p><a:r><a:t>Mention the new market.</a:t></a:r></a:p></p:notes>`,
    ),
    file("ppt/slides/slide1.xml", slide(["Next steps", "Hire two engineers"])),
  ]);
}

/** A workbook with two sheets: shared strings (one rich text), numbers, a formula, empty cells. */
export function xlsx(): Buffer {
  return makeZip([
    file(
      "xl/workbook.xml",
      `<workbook><sheets><sheet name="Sales &amp; costs" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    ),
    file(
      "xl/_rels/workbook.xml.rels",
      rels([
        ["rId1", "worksheet", "worksheets/sheet1.xml"],
        ["rId2", "worksheet", "/xl/worksheets/sheet2.xml"],
      ]),
    ),
    file(
      "xl/sharedStrings.xml",
      `<sst><si><t>Region</t></si><si><t>Total</t></si><si><r><t>No</t></r><r><t>rth</t></r><rPh><t>ignored</t></rPh></si></sst>`,
    ),
    file(
      "xl/worksheets/sheet1.xml",
      `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
        <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"/><c r="C2"><f>SUM(D2:E2)</f><v>1250.5</v></c><c r="D2" t="b"><v>1</v></c></row>
        <row r="3"></row>
      </sheetData></worksheet>`,
    ),
    file(
      "xl/worksheets/sheet2.xml",
      `<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>Check the north office</t></is></c><c r="C1" t="str"><f>A1&amp;"x"</f><v>calc text</v></c></row></sheetData></worksheet>`,
    ),
  ]);
}
