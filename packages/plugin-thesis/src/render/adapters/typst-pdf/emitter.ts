import type { Finding } from "../../../types.js";
import { validateLatex } from "../../math.js";
import type { Block, Figure, Inline, Section, TableBlock, ThesisDocument } from "../../model.js";
import { type FloatKind, Numberer } from "../../numbering.js";
import { escapeText, typstLabel, typstString } from "./escape.js";

/** Typst package imports, pinned and vendored (spec 16.1). */
export const mitexImport = '#import "@preview/mitex:0.2.7": mitex, mi';
export const mermanImport = '#import "@preview/merman:0.3.0": mermaid';

export interface EmitResult {
  /** Contents of `main.typ`. */
  main: string;
  /** Contents of `meta.json`, read by the template with `json(...)`. */
  meta: Record<string, unknown>;
  /** Contents of `strings.json`. */
  strings: Record<string, string>;
  /** MTH-001 and CIT-001 problems found while emitting; any error blocks the build. */
  findings: Finding[];
  /** Build-relative path of the CSL file the bibliography uses. */
  bibliographyStyle: string;
  hasBibliography: boolean;
}

class Emitter {
  readonly findings: Finding[] = [];
  hasCitations = false;
  private file: string | undefined;
  private line: number | undefined;
  private readonly keys: Set<string>;
  // Static float numbering shared with the other adapters (render/numbering.ts): the emitter
  // knows the chapter order, so every float gets its number here and Typst never evaluates
  // chapter-dependent counters at the reference site.
  private readonly numbering = new Numberer();

  constructor(private readonly doc: ThesisDocument) {
    this.keys = new Set(doc.bibliography.entries.map((entry) => entry.citeKey));
  }

  /** Numbering arguments `chapter, index, sequence` for the next float of a kind. */
  private nextFloat(kind: FloatKind): string {
    const number = this.numbering.nextFloat(kind);
    const chapter =
      number.chapter === null
        ? "none"
        : /^\d+$/.test(number.chapter)
          ? number.chapter
          : typstString(number.chapter);
    return `${chapter}, ${number.index}, ${number.sequence}`;
  }

  private problem(code: string, gate: Finding["gate"], message: string, hint?: string): void {
    this.findings.push({
      code,
      gate,
      severity: "error",
      ...(this.file === undefined ? {} : { file: this.file }),
      ...(this.line === undefined ? {} : { line: this.line }),
      message,
      ...(hint ? { hint } : {}),
    });
  }

  // ---------------------------------------------------------------------------------------
  // Inline
  // ---------------------------------------------------------------------------------------

  inlines(nodes: readonly Inline[]): string {
    return nodes.map((node) => this.inline(node)).join("");
  }

  private inline(node: Inline): string {
    switch (node.kind) {
      case "text":
        return escapeText(node.text);
      // The trailing `;` ends the embedded expression, so a following `.name` or `(` stays text.
      case "emph":
        return `#emph[${this.inlines(node.children)}];`;
      case "strong":
        return `#strong[${this.inlines(node.children)}];`;
      case "code":
        return `#raw(${typstString(node.text)});`;
      case "math":
        return `#mi(${this.math(node.latex)});`;
      case "citation":
        return this.citation(node);
      case "crossref":
        return `#ref(${typstLabel(node.label)});`;
      case "link":
        return `#link(${typstString(node.href)})[${this.inlines(node.children)}];`;
      case "footnote": {
        const blocks = this.doc.footnotes[node.id];
        return `#footnote[${blocks ? this.footnoteBody(blocks) : ""}];`;
      }
      case "break":
        return "#linebreak();";
    }
  }

  private footnoteBody(blocks: readonly Block[]): string {
    return blocks
      .map((block) =>
        block.kind === "paragraph" ? this.inlines(block.children) : this.block(block),
      )
      .join(" ")
      .trim();
  }

  private math(latex: string): string {
    const invalid = validateLatex(latex);
    if (invalid) {
      this.problem(
        "MTH-001",
        "G8",
        invalid,
        "Fix or remove the formula; only math commands are allowed.",
      );
      return typstString("?");
    }
    return typstString(latex);
  }

  private citation(node: Extract<Inline, { kind: "citation" }>): string {
    this.hasCitations = true;
    const parts: string[] = [];
    for (const item of node.items) {
      if (!this.keys.has(item.key)) {
        this.problem(
          "CIT-001",
          "G5",
          `Citation key ${item.key} is not in the evidence library`,
          "Add the source with /thesis:research or fix the key.",
        );
        parts.push(escapeText(`[@${item.key}]`));
        continue;
      }
      const args = [`<${item.key}>`];
      if (item.locator) args.push(`supplement: [${escapeText(item.locator)}]`);
      // Note styles print the whole note for a prose cite; keep those as ordinary note citations.
      if (node.narrative && this.doc.bibliography.csl.citationFormat !== "note")
        args.push('form: "prose"');
      parts.push(`#cite(${args.join(", ")})`);
    }
    // Adjacent `#cite` calls are grouped by Typst; the final `;` closes the last expression.
    return `${parts.join("")}${parts.length > 0 ? ";" : ""}`;
  }

  // ---------------------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------------------

  blocks(blocks: readonly Block[], front = false): string {
    return blocks.map((block) => this.block(block, front)).join("");
  }

  block(block: Block, front = false): string {
    this.line = block.line;
    switch (block.kind) {
      case "paragraph":
        return `${this.inlines(block.children)}\n\n`;
      case "heading": {
        this.numbering.enterHeading(block.level, front);
        const label = block.label ? ` ${typstLabel(block.label)}` : "";
        const flags = front ? ", numbering: none" : "";
        return `#heading(level: ${block.level}${flags})[${this.inlines(block.children)}]${label}\n\n`;
      }
      case "list": {
        const items = block.items.map((item) => `[${this.blocks(item, front)}]`).join(", ");
        return `#${block.ordered ? "enum" : "list"}(${items})\n\n`;
      }
      case "quote":
        return `#quote(block: true)[${this.blocks(block.children, front)}]\n\n`;
      case "codeblock": {
        const lang = block.lang ? `, lang: ${typstString(block.lang)}` : "";
        return `#raw(${typstString(block.text)}, block: true${lang})\n\n`;
      }
      case "equation": {
        if (!block.label) return `#mitex(${this.math(block.latex)}, numbering: none)\n\n`;
        return `#mitex(${this.math(block.latex)}, numbering: num-eq(${this.nextFloat("equation")})) ${typstLabel(block.label)}\n\n`;
      }
      case "table":
        return this.table(block);
      case "figure":
        return this.figure(block);
    }
  }

  private table(block: TableBlock): string {
    const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
    const align = Array.from({ length: columns }, (_, index) => block.align[index] ?? "auto").join(
      ", ",
    );
    const cell = (inlines: Inline[]) => `[${this.inlines(inlines)}]`;
    const cells: string[] = [];
    if (block.header.length > 0) cells.push(`table.header(${block.header.map(cell).join(", ")})`);
    for (const row of block.rows) {
      for (let index = 0; index < columns; index += 1) cells.push(cell(row[index] ?? []));
    }
    const table = `table(columns: ${columns}, align: (${align},), ${cells.join(", ")})`;
    if (!block.caption) return `#${table}\n\n`;
    const source = block.source ? `[${this.inlines(block.source)}]` : "none";
    const label = block.label ? ` ${typstLabel(block.label)}` : "";
    return `#t-table(${table}, caption: [${this.inlines(block.caption)}], source: ${source}, number: (${this.nextFloat("table")}))${label}\n\n`;
  }

  private figure(block: Figure): string {
    const resolved = block.asset.resolved;
    if (!resolved) {
      this.problem("BLD-002", "G8", `Figure ${block.asset.path} was not resolved before rendering`);
      return "";
    }
    const body = this.figureBody(block, resolved);
    const source = block.source ? `[${this.inlines(block.source)}]` : "none";
    const label = block.label ? ` ${typstLabel(block.label)}` : "";
    return `#t-figure(${body}, caption: [${this.inlines(block.caption)}], source: ${source}, number: (${this.nextFloat("figure")}))${label}\n\n`;
  }

  private figureBody(block: Figure, resolved: NonNullable<Figure["asset"]["resolved"]>): string {
    if (block.asset.kind === "mermaid") {
      const theme = this.doc.diagramTheme;
      const variables = Object.entries(theme.variables)
        .map(([name, value]) => `${name}: ${typstString(value)}`)
        .join(", ");
      const fonts = theme.fonts.map(typstString).join(", ");
      return `mermaid(read(${typstString(resolved.file)}), width: ${block.width ?? "80%"}, theme-name: "base", theme: (${variables}), background: ${typstString(theme.background)}, typography: (font: (${fonts},), size: "14px"))`;
    }
    // Vector images keep their natural size unless it would overflow the text block; an explicit
    // width wins.
    if (block.width === undefined && resolved.size) {
      return `t-image(${typstString(resolved.file)}, ${resolved.size.widthPt}pt)`;
    }
    return `image(${typstString(resolved.file)}, width: ${block.width ?? "auto"})`;
  }

  section(section: Section, front = false): string {
    this.numbering.enterSection(section, front);
    this.file = section.path;
    this.line = undefined;
    return this.blocks(section.blocks, front);
  }
}

function abstractCall(
  emitter: Emitter,
  section: Section,
  strings: Record<string, string>,
  main: string,
): string {
  const lang = section.lang ?? main;
  const title = strings[`abstract@${lang}`] ?? strings.abstract ?? "Abstract";
  const keywordsLabel = strings[`keywords@${lang}`] ?? strings.keywords ?? "Keywords";
  const keywords = (section.keywords ?? []).map(typstString).join(", ");
  return `(title: ${typstString(title)}, keywords-label: ${typstString(keywordsLabel)}, keywords: (${keywords}${keywords ? "," : ""}), lang: ${typstString(lang.split("-")[0] ?? "en")}, body: [${emitter.section(section, true)}])`;
}

/** Model to Typst. Pure: no file access; the adapter writes the returned files. */
export function emitTypst(doc: ThesisDocument): EmitResult {
  const emitter = new Emitter(doc);
  const main: string[] = [];
  const push = (text: string) => main.push(text);

  const frontOf = (role: Section["role"]) =>
    doc.frontMatter.filter((section) => section.role === role);
  const contentArg = (name: string, sections: Section[]) =>
    sections.length > 0
      ? `  ${name}: [${sections.map((section) => emitter.section(section, true)).join("")}],\n`
      : "";
  const abstracts = [...frontOf("abstract"), ...frontOf("abstract-secondary")].map((section) =>
    abstractCall(emitter, section, doc.strings, doc.meta.languageCode),
  );

  push("// Generated by @alisio/plugin-thesis. Do not edit: regenerate with /thesis:build.\n");
  push(`${mitexImport}\n${mermanImport}\n`);
  push('#import "_tpl/thesis.typ": make\n#import "_tpl/profile.typ": profile\n');
  push('#let meta = json("meta.json")\n#let strings = json("strings.json")\n');
  push("#let t = make(meta, profile, strings)\n");
  push(
    "#let (setup, cover, front, body-mode, annex-mode, t-figure, t-table, t-image, num-eq, references) = t\n",
  );
  push("#show: setup\n#cover()\n");
  push("#front(\n");
  push(contentArg("dedication", frontOf("dedication")));
  push(contentArg("acknowledgments", frontOf("acknowledgments")));
  push(contentArg("ai-declaration", frontOf("ai-declaration")));
  push(`  abstracts: (${abstracts.join(", ")}${abstracts.length === 1 ? "," : ""}),\n`);
  push(")\n");

  push("#show: body-mode\n");
  for (const section of doc.body) push(emitter.section(section));

  const bibliography = emitter.hasCitations;
  if (doc.annexes.length > 0) {
    push("#show: annex-mode\n");
    for (const section of doc.annexes) push(emitter.section(section));
  }

  // The adapter writes the selected CSL file to `styles/` inside the build directory.
  const style = `/styles/${doc.bibliography.csl.file}`;
  // References come after the body and before the annexes: insert the call at that position.
  if (bibliography) {
    const at = doc.annexes.length > 0 ? main.indexOf("#show: annex-mode\n") : main.length;
    main.splice(at, 0, `#references(${typstString(style)})\n`);
  }

  const meta: Record<string, unknown> = {
    ...doc.meta,
    hasBibliography: bibliography,
  };
  return {
    main: main.join(""),
    meta,
    strings: doc.strings,
    findings: emitter.findings,
    bibliographyStyle: style,
    hasBibliography: bibliography,
  };
}
