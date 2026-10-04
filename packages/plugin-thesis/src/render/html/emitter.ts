import type { Finding } from "../../types.js";
import { validateLatex } from "../math.js";
import type { Block, Figure, Inline, Section, TableBlock, ThesisDocument } from "../model.js";
import {
  type FloatNumber,
  floatLabel,
  HeadingCounter,
  Numberer,
  type Numberer as NumbererType,
} from "../numbering.js";
import { CitationFormatter } from "./citations.js";
import { generateCss, staticCss } from "./css.js";
import { escapeHtml, jsonForScript, safeHref } from "./escape.js";
import { renderMath } from "./katex.js";

/** Folder inside the build directory that holds the vendored scripts, fonts and runtime. */
export const htmlAssetDir = "_html";

export interface HtmlEmitOptions {
  /** Contents of `katex.min.css`; the adapter reads the vendored file. Empty for tests. */
  katexCss?: string;
}

export interface HtmlEmitResult {
  /** The standalone document. */
  html: string;
  /** MTH-001, CIT-001, BLD-002 problems (errors block) and the BLD-004 approximation note. */
  findings: Finding[];
  hasMermaid: boolean;
  hasMath: boolean;
  hasBibliography: boolean;
}

interface Numbered {
  heading?: string;
  float?: FloatNumber;
  id: string;
}

interface TocEntry {
  id: string;
  level: number;
  number: string | null;
  html: string;
  area: "front" | "body" | "annex";
}

interface ListEntry {
  id: string;
  kind: "figure" | "table";
  label: string;
  html: string;
}

const widthPattern = /^\d{1,3}(?:\.\d{1,2})?%$/;
const idPattern = /[^A-Za-z0-9_-]/g;
const filePattern = /^[A-Za-z0-9._/-]+$/;

class HtmlEmitter {
  readonly findings: Finding[] = [];
  hasMermaid = false;
  hasMath = false;
  private file: string | undefined;
  private line: number | undefined;
  private readonly formatter: CitationFormatter;
  private readonly numbers = new WeakMap<object, Numbered>();
  /** Crossref text and anchor by label. */
  private readonly targets = new Map<string, { text: string; id: string }>();
  private readonly toc: TocEntry[] = [];
  private readonly lists: ListEntry[] = [];
  private autoId = 0;
  private area: "front" | "body" | "annex" = "front";
  private mermaidCount = 0;
  private footnoteDepth = 0;
  private readonly perChapter: boolean;

  constructor(private readonly doc: ThesisDocument) {
    this.formatter = new CitationFormatter(
      doc.bibliography.entries,
      doc.bibliography.csl.citationFormat,
      doc.meta.languageCode,
      doc.strings,
    );
    this.perChapter = doc.presentation.captions.numbering === "chapter";
    this.prepass();
  }

  private s(key: string, fallback: string): string {
    return this.doc.strings[key] ?? fallback;
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
  // Numbering pre-pass: forward references need every number before the first one is printed.
  // ---------------------------------------------------------------------------------------

  private prepass(): void {
    const numberer: NumbererType = new Numberer();
    const headings = new HeadingCounter(
      this.doc.presentation.headings.map((heading) => heading.numbering),
      this.doc.presentation.annexNumbering,
    );
    const doc = this.doc;
    const strings = doc.strings;
    let annex = false;

    const visit = (blocks: readonly Block[], front: boolean): void => {
      for (const block of blocks) {
        switch (block.kind) {
          case "heading": {
            numberer.enterHeading(block.level, front);
            const id = this.idFor(block.label);
            const number = front ? undefined : headings.next(block.level);
            this.numbers.set(block, { id, ...(number ? { heading: number } : {}) });
            if (block.label) {
              const supplement = annex ? this.s("annex", "Annex") : this.s("section", "Section");
              this.targets.set(block.label, {
                id,
                text: number ? `${supplement} ${number}` : "",
              });
            }
            break;
          }
          case "figure": {
            const float = numberer.nextFloat("figure");
            const id = this.idFor(block.label);
            this.numbers.set(block, { id, float });
            if (block.label)
              this.targets.set(block.label, {
                id,
                text: `${strings.figure ?? "Figure"} ${floatLabel(float, this.perChapter)}`,
              });
            break;
          }
          case "table": {
            if (!block.caption) break;
            const float = numberer.nextFloat("table");
            const id = this.idFor(block.label);
            this.numbers.set(block, { id, float });
            if (block.label)
              this.targets.set(block.label, {
                id,
                text: `${strings.table ?? "Table"} ${floatLabel(float, this.perChapter)}`,
              });
            break;
          }
          case "equation": {
            if (!block.label) break;
            const float = numberer.nextFloat("equation");
            const id = this.idFor(block.label);
            this.numbers.set(block, { id, float });
            this.targets.set(block.label, {
              id,
              text: `${strings.equation ?? "Equation"} (${floatLabel(float, this.perChapter)})`,
            });
            break;
          }
          case "list":
            for (const item of block.items) visit(item, front);
            break;
          case "quote":
            visit(block.children, front);
            break;
          default:
            break;
        }
      }
    };

    for (const section of doc.frontMatter) {
      numberer.enterSection(section, true);
      visit(section.blocks, true);
    }
    for (const section of doc.body) {
      numberer.enterSection(section, false);
      visit(section.blocks, false);
    }
    for (const section of doc.annexes) {
      if (!annex) {
        annex = true;
        headings.startAnnex();
      }
      numberer.enterSection(section, false);
      visit(section.blocks, false);
    }
  }

  private idFor(label: string | undefined): string {
    if (label) return label.replace(idPattern, "-");
    this.autoId += 1;
    return `auto-${this.autoId}`;
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
        return escapeHtml(node.text);
      case "emph":
        return `<em>${this.inlines(node.children)}</em>`;
      case "strong":
        return `<strong>${this.inlines(node.children)}</strong>`;
      case "code":
        return `<code>${escapeHtml(node.text)}</code>`;
      case "math":
        return this.math(node.latex, false);
      case "citation":
        return this.citation(node);
      case "crossref": {
        const target = this.targets.get(node.label);
        if (!target) return `<span class="unresolved">?</span>`;
        return `<a class="xref" href="#${escapeHtml(target.id)}">${escapeHtml(target.text)}</a>`;
      }
      case "link": {
        const href = safeHref(node.href);
        const children = this.inlines(node.children);
        return href ? `<a href="${escapeHtml(href)}">${children}</a>` : children;
      }
      case "footnote": {
        const blocks = this.doc.footnotes[node.id];
        if (!blocks || this.footnoteDepth > 0) return "";
        this.footnoteDepth += 1;
        const body = this.footnoteBody(blocks);
        this.footnoteDepth -= 1;
        return `<span class="fn">${body}</span>`;
      }
      case "break":
        return "<br>";
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

  private math(latex: string, display: boolean): string {
    const invalid = validateLatex(latex);
    if (invalid) {
      this.problem(
        "MTH-001",
        "G8",
        invalid,
        "Fix or remove the formula; only math commands are allowed.",
      );
      return "?";
    }
    this.hasMath = true;
    const result = renderMath(latex, display);
    if (result.error) {
      this.problem(
        "MTH-001",
        "G8",
        `KaTeX cannot typeset the formula: ${result.error}`,
        "Fix or remove the formula.",
      );
    }
    return result.html;
  }

  private citation(node: Extract<Inline, { kind: "citation" }>): string {
    const known = node.items.filter((item) => {
      if (this.formatter.has(item.key)) return true;
      this.problem(
        "CIT-001",
        "G5",
        `Citation key ${item.key} is not in the evidence library`,
        "Add the source with /thesis:research or fix the key.",
      );
      return false;
    });
    if (known.length === 0) return escapeHtml(node.items.map((item) => `[@${item.key}]`).join(" "));
    const output = this.formatter.cite(known, node.narrative);
    return output.note
      ? `<span class="fn">${output.html}</span>`
      : `<span class="cite">${output.html}</span>`;
  }

  // ---------------------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------------------

  blocks(blocks: readonly Block[]): string {
    const out: string[] = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index] as Block;
      const next = blocks[index + 1];
      if (block.kind === "heading" && this.runIn(block) && next?.kind === "paragraph") {
        this.line = next.line;
        out.push(this.runInParagraph(block, next));
        index += 1;
        continue;
      }
      const after = blocks[index - 1]?.kind === "heading";
      out.push(this.block(block, after));
    }
    return out.join("\n");
  }

  private runIn(block: Extract<Block, { kind: "heading" }>): boolean {
    const spec = this.doc.presentation.headings[Math.min(block.level, 4) - 1];
    return Boolean(spec?.runIn) && block.level > 1;
  }

  private headingLabel(block: Extract<Block, { kind: "heading" }>): {
    id: string;
    number: string | undefined;
  } {
    const known = this.numbers.get(block);
    return { id: known?.id ?? this.idFor(block.label), number: known?.heading };
  }

  private pushToc(
    block: Extract<Block, { kind: "heading" }>,
    id: string,
    number: string | undefined,
    html: string,
  ): void {
    this.toc.push({ id, level: block.level, number: number ?? null, html, area: this.area });
  }

  private runInParagraph(
    block: Extract<Block, { kind: "heading" }>,
    paragraph: Extract<Block, { kind: "paragraph" }>,
  ): string {
    const spec = this.doc.presentation.headings[Math.min(block.level, 4) - 1];
    const { id, number } = this.headingLabel(block);
    const title = this.inlines(block.children);
    this.pushToc(block, id, number, title);
    const ends = spec ? escapeHtml(spec.endsWith) : "";
    const prefix = number ? `${escapeHtml(number)} ` : "";
    return `<p class="runin-p"><span class="runin h${block.level}" id="${escapeHtml(id)}">${prefix}${title}${ends}</span> ${this.inlines(paragraph.children)}</p>`;
  }

  block(block: Block, afterHeading = false): string {
    this.line = block.line;
    switch (block.kind) {
      case "paragraph":
        return `<p${afterHeading ? ' class="np"' : ""}>${this.inlines(block.children)}</p>`;
      case "heading": {
        const { id, number } = this.headingLabel(block);
        const title = this.inlines(block.children);
        this.pushToc(block, id, number, title);
        const level = block.level;
        const chapter = level === 1 && this.area !== "front";
        const classes = [
          `h${level}`,
          chapter ? "chapter" : "",
          number === undefined ? "unnumbered" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const numberHtml = number ? `<span class="hnum">${escapeHtml(number)}</span> ` : "";
        return `<h${level} class="${classes}" id="${escapeHtml(id)}">${numberHtml}<span class="htext">${title}</span></h${level}>`;
      }
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        const items = block.items.map((item) => `<li>${this.blocks(item)}</li>`).join("\n");
        return `<${tag}>\n${items}\n</${tag}>`;
      }
      case "quote":
        return `<blockquote>${this.blocks(block.children)}</blockquote>`;
      case "codeblock": {
        const lang =
          block.lang && /^[A-Za-z0-9+#-]{1,32}$/.test(block.lang)
            ? ` class="language-${escapeHtml(block.lang)}"`
            : "";
        return `<pre><code${lang}>${escapeHtml(block.text)}</code></pre>`;
      }
      case "equation":
        return this.equation(block);
      case "table":
        return this.table(block);
      case "figure":
        return this.figure(block);
    }
  }

  private equation(block: Extract<Block, { kind: "equation" }>): string {
    const known = this.numbers.get(block);
    const body = this.math(block.latex, true);
    if (!known?.float) return `<div class="eq">${body}</div>`;
    const label = floatLabel(known.float, this.perChapter);
    return `<div class="eq numbered" id="${escapeHtml(known.id)}" data-number="${escapeHtml(label)}" data-chapter="${escapeHtml(known.float.chapter ?? "")}" data-index="${known.float.index}" data-sequence="${known.float.sequence}"><span class="eq-body">${body}</span><span class="eq-num">(${escapeHtml(label)})</span></div>`;
  }

  private floatCaption(
    kind: "figure" | "table",
    number: string,
    caption: readonly Inline[],
    source: readonly Inline[] | undefined,
  ): { html: string; plain: string } {
    const profile = this.doc.presentation.captions;
    const name = kind === "figure" ? this.s("figure", "Figure") : this.s("table", "Table");
    const text = this.inlines(caption);
    const inline =
      source && !profile.sourceBelow
        ? ` <span class="cap-source">${this.inlines(source)}</span>`
        : "";
    return {
      html: `<figcaption class="cap cap-${profile.labelStyle}"><span class="cap-label">${escapeHtml(name)} ${escapeHtml(number)}</span><span class="cap-sep">${escapeHtml(profile.separator)}</span><span class="cap-text">${text}</span>${inline}</figcaption>`,
      plain: text,
    };
  }

  private sourceBlock(source: readonly Inline[] | undefined): string {
    if (!source || !this.doc.presentation.captions.sourceBelow) return "";
    return `<div class="source">${this.inlines(source)}</div>`;
  }

  private table(block: TableBlock): string {
    const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
    const alignClass = (index: number) => {
      const align = block.align[index];
      return align ? ` class="al-${align}"` : "";
    };
    const cell = (tag: "th" | "td", inlines: Inline[] | undefined, index: number) =>
      `<${tag}${alignClass(index)}>${this.inlines(inlines ?? [])}</${tag}>`;
    const head =
      block.header.length > 0
        ? `<thead><tr>${Array.from({ length: columns }, (_, index) => cell("th", block.header[index], index)).join("")}</tr></thead>`
        : "";
    const rows = block.rows
      .map(
        (row) =>
          `<tr>${Array.from({ length: columns }, (_, index) => cell("td", row[index], index)).join("")}</tr>`,
      )
      .join("\n");
    const table = `<table>${head}<tbody>\n${rows}\n</tbody></table>`;
    const known = this.numbers.get(block);
    if (!block.caption || !known?.float) return `<div class="plain-table">${table}</div>`;
    const number = floatLabel(known.float, this.perChapter);
    const caption = this.floatCaption("table", number, block.caption, block.source);
    this.lists.push({
      id: known.id,
      kind: "table",
      label: `${this.s("table", "Table")} ${number}`,
      html: caption.plain,
    });
    const position = this.doc.presentation.captions.tablePosition;
    const body = `<div class="float-body">${table}</div>${this.sourceBlock(block.source)}`;
    return `<figure class="float table-float cap-${position}" id="${escapeHtml(known.id)}" data-number="${escapeHtml(number)}" data-chapter="${escapeHtml(known.float.chapter ?? "")}" data-index="${known.float.index}" data-sequence="${known.float.sequence}">${position === "top" ? caption.html + body : body + caption.html}</figure>`;
  }

  private figureBody(block: Figure): string {
    const resolved = block.asset.resolved;
    const alt = escapeHtml(plainText(block.caption));
    if (!resolved) {
      this.problem("BLD-002", "G8", `Figure ${block.asset.path} was not resolved before rendering`);
      return "";
    }
    const width = block.width && widthPattern.test(block.width) ? block.width : undefined;
    if (block.asset.kind === "mermaid") {
      this.hasMermaid = true;
      this.mermaidCount += 1;
      const source = resolved.text ?? "";
      return `<div class="diagram" style="width:${width ?? "80%"}"><pre class="mermaid-src" id="mmd-src-${this.mermaidCount}" hidden>${escapeHtml(source)}</pre><div class="mermaid-out" role="img" aria-label="${alt}"></div></div>`;
    }
    if (!filePattern.test(resolved.file) || resolved.file.includes("..")) {
      this.problem("BLD-002", "G8", `Figure file name ${resolved.file} is not allowed`);
      return "";
    }
    const natural =
      width === undefined && resolved.size ? `width:${resolved.size.widthPt}pt;max-width:100%` : "";
    const style = width ? `width:${width}` : natural;
    return `<img src="${escapeHtml(resolved.file)}" alt="${alt}"${style ? ` style="${style}"` : ""}>`;
  }

  private figure(block: Figure): string {
    const known = this.numbers.get(block);
    if (!known?.float) return "";
    const number = floatLabel(known.float, this.perChapter);
    const caption = this.floatCaption("figure", number, block.caption, block.source);
    this.lists.push({
      id: known.id,
      kind: "figure",
      label: `${this.s("figure", "Figure")} ${number}`,
      html: caption.plain,
    });
    const position = this.doc.presentation.captions.figurePosition;
    const body = `<div class="float-body">${this.figureBody(block)}</div>${this.sourceBlock(block.source)}`;
    return `<figure class="float figure-float cap-${position}" id="${escapeHtml(known.id)}" data-number="${escapeHtml(number)}" data-chapter="${escapeHtml(known.float.chapter ?? "")}" data-index="${known.float.index}" data-sequence="${known.float.sequence}">${position === "top" ? caption.html + body : body + caption.html}</figure>`;
  }

  // ---------------------------------------------------------------------------------------
  // Sections and front matter
  // ---------------------------------------------------------------------------------------

  section(section: Section, area: "front" | "body" | "annex"): string {
    this.area = area;
    this.file = section.path;
    this.line = undefined;
    return this.blocks(section.blocks);
  }

  private unnumbered(title: string, body: string, outlined: boolean, className: string): string {
    this.autoId += 1;
    const id = `front-${this.autoId}`;
    if (outlined)
      this.toc.push({ id, level: 1, number: null, html: escapeHtml(title), area: this.area });
    return `<section class="front-part ${className}"><h1 class="h1 unnumbered front-title" id="${id}"><span class="htext">${escapeHtml(title)}</span></h1>\n${body}\n</section>`;
  }

  private abstractHtml(section: Section): string {
    const strings = this.doc.strings;
    const lang = section.lang ?? this.doc.meta.languageCode;
    const code = lang.split("-")[0] ?? lang;
    const title =
      strings[`abstract@${lang}`] ?? strings[`abstract@${code}`] ?? strings.abstract ?? "Abstract";
    const keywordsLabel =
      strings[`keywords@${lang}`] ?? strings[`keywords@${code}`] ?? strings.keywords ?? "Keywords";
    const keywords = section.keywords ?? [];
    const body = this.section(section, "front");
    const tail =
      keywords.length > 0
        ? `<p class="keywords"><strong>${escapeHtml(keywordsLabel)}:</strong> ${escapeHtml(keywords.join(", "))}</p>`
        : "";
    return this.unnumbered(title, `${body}\n${tail}`, true, "abstract").replace(
      "<section ",
      `<section lang="${escapeHtml(code)}" `,
    );
  }

  private frontPart(name: string): string {
    const doc = this.doc;
    const of = (role: Section["role"]) =>
      doc.frontMatter.filter((section) => section.role === role);
    const content = (sections: Section[]) =>
      sections.map((section) => this.section(section, "front")).join("\n");
    switch (name) {
      case "dedication": {
        const sections = of("dedication");
        return sections.length
          ? this.unnumbered(
              this.s("dedication", "Dedication"),
              content(sections),
              false,
              "dedication",
            )
          : "";
      }
      case "acknowledgments": {
        const sections = of("acknowledgments");
        return sections.length
          ? this.unnumbered(
              this.s("acknowledgments", "Acknowledgments"),
              content(sections),
              true,
              "acknowledgments",
            )
          : "";
      }
      case "ai-declaration": {
        const sections = of("ai-declaration");
        return sections.length
          ? this.unnumbered(
              this.s("ai_declaration", "AI-use declaration"),
              content(sections),
              true,
              "ai-declaration",
            )
          : "";
      }
      case "abstract":
        return [...of("abstract"), ...of("abstract-secondary")]
          .map((section) => this.abstractHtml(section))
          .join("\n");
      default:
        return "";
    }
  }

  private cover(): string {
    const meta = this.doc.meta;
    const profile = this.doc.presentation;
    const org = meta.institution;
    const line = (className: string, text: string | null | undefined) =>
      text ? `<p class="${className}">${escapeHtml(text)}</p>` : "";
    const groups: Record<string, number> = {
      institution: 0,
      faculty: 0,
      program: 0,
      title: 1,
      subtitle: 1,
      workType: 2,
      authors: 2,
      advisors: 2,
      cityYear: 3,
    };
    const fields: Record<string, () => string> = {
      institution: () => line("cv-institution", org.name),
      faculty: () => line("cv-faculty", org.faculty),
      program: () => line("cv-program", org.program),
      title: () => `<h1 class="cv-title">${escapeHtml(meta.title)}</h1>`,
      subtitle: () => line("cv-subtitle", meta.subtitle),
      workType: () => line("cv-worktype", this.s(`work_${meta.workType}`, meta.workType)),
      authors: () => meta.authors.map((author) => line("cv-author", author)).join(""),
      advisors: () =>
        meta.advisors
          .map((advisor) => line("cv-advisor", `${this.s("advisor", "Advisor")}: ${advisor.name}`))
          .join(""),
      cityYear: () =>
        line("cv-cityyear", org.city ? `${org.city}, ${meta.year}` : String(meta.year)),
    };
    const grouped = new Map<number, string[]>();
    for (const name of profile.cover.fields) {
      const group = groups[name] ?? 0;
      grouped.set(group, [...(grouped.get(group) ?? []), fields[name]?.() ?? ""]);
    }
    const parts = [...grouped.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([, items], index) =>
          `<div class="cv-group${index > 0 ? " cv-gap" : ""}">${items.join("")}</div>`,
      )
      .join("\n");
    return `<section class="cover cover-${profile.cover.layout}">\n${parts}\n</section>`;
  }

  private tocHtml(): string {
    const profile = this.doc.presentation;
    const depth = profile.toc.depth;
    const entries = this.toc
      .filter((entry) => entry.level <= depth)
      .map((entry) => {
        const number = entry.number
          ? `<span class="toc-num">${escapeHtml(entry.number)}</span>`
          : "";
        return `<li class="toc-l${entry.level} toc-${entry.area}"><a href="#${escapeHtml(entry.id)}">${number}<span class="toc-text">${entry.html}</span><span class="toc-dots"></span></a></li>`;
      })
      .join("\n");
    const label = profile.toc.pageLabel
      ? `<p class="toc-page-label">${escapeHtml(this.s("page_abbr", "p."))}</p>`
      : "";
    const lists = (["figure", "table"] as const)
      .map((kind) => {
        const items = this.lists.filter((entry) => entry.kind === kind);
        if (items.length === 0) return "";
        const title =
          kind === "figure"
            ? this.s("list_of_figures", "List of figures")
            : this.s("list_of_tables", "List of tables");
        const rows = items
          .map(
            (entry) =>
              `<li class="toc-lf"><a href="#${escapeHtml(entry.id)}"><span class="toc-num">${escapeHtml(entry.label)}.</span><span class="toc-text">${entry.html}</span><span class="toc-dots"></span></a></li>`,
          )
          .join("\n");
        return `<section class="front-part list-of"><h1 class="h1 unnumbered front-title"><span class="htext">${escapeHtml(title)}</span></h1>\n<ol class="toc-list">\n${rows}\n</ol></section>`;
      })
      .join("\n");
    return `<section class="front-part toc"><h1 class="h1 unnumbered front-title"><span class="htext">${escapeHtml(this.s("contents", "Contents"))}</span></h1>\n${label}<ol class="toc-list">\n${entries}\n</ol></section>\n${lists}`;
  }

  referencesHtml(tocIndex: number): string {
    const entries = this.formatter.bibliography();
    const numeric = this.formatter.family === "numeric";
    const items = entries
      .map(
        (entry) =>
          `<li id="ref-${escapeHtml(entry.key)}" class="ref">${numeric ? `<span class="ref-label">${escapeHtml(entry.label ?? "")}</span> ` : ""}<span class="ref-text">${entry.html}</span></li>`,
      )
      .join("\n");
    this.autoId += 1;
    const id = `references-${this.autoId}`;
    const title = this.s("references", "References");
    this.toc.splice(tocIndex, 0, {
      id,
      level: 1,
      number: null,
      html: escapeHtml(title),
      area: "body",
    });
    return `<section class="references"><h1 class="h1 unnumbered chapter" id="${id}"><span class="htext">${escapeHtml(title)}</span></h1>\n<ol class="bibliography${numeric ? " numeric" : ""}">\n${items}\n</ol></section>`;
  }

  /** Assemble the document in reading order. */
  document(options: HtmlEmitOptions): HtmlEmitResult {
    const doc = this.doc;
    const profile = doc.presentation;

    // Emission order is document order, except the TOC whose entries need the whole body.
    const frontParts: { name: string; html: string }[] = [];
    for (const name of profile.frontMatter) {
      frontParts.push({ name, html: name === "toc" ? "" : this.frontPart(name) });
    }
    this.area = "body";
    const body = doc.body.map((section) => this.section(section, "body")).join("\n");
    const referencesAt = this.toc.length;
    const annexes = doc.annexes.map((section) => this.section(section, "annex")).join("\n");
    const bibliography = this.formatter.cited.length > 0;
    const references = bibliography ? this.referencesHtml(referencesAt) : "";
    const toc = this.tocHtml();
    const front = frontParts.map((part) => (part.name === "toc" ? toc : part.html)).join("\n");

    const meta = doc.meta;
    const config = {
      theme: {
        variables: doc.diagramTheme.variables,
        background: doc.diagramTheme.background,
        fonts: doc.diagramTheme.fonts,
      },
      language: meta.languageCode,
      pages: {
        front: profile.pageNumbers.front,
        body: profile.pageNumbers.body,
        position: profile.pageNumbers.position,
        continuous: profile.pageNumbers.continuous,
      },
    };
    const style = [
      options.katexCss
        ? `<style id="katex-css">\n${options.katexCss.replaceAll("url(fonts/", `url(${htmlAssetDir}/fonts/`)}\n</style>`
        : "",
      `<style id="thesis-base">\n${staticCss()}\n</style>`,
      `<style id="thesis-profile">\n${generateCss(profile, meta)}\n</style>`,
    ]
      .filter(Boolean)
      .join("\n");
    // Order matters: the runtime sets `PagedConfig` before the polyfill reads it.
    const scripts = [
      `<script id="thesis-config" type="application/json">${jsonForScript(config)}</script>`,
      `<script src="${htmlAssetDir}/runtime.js"></script>`,
      this.hasMermaid ? `<script src="${htmlAssetDir}/mermaid.min.js"></script>` : "",
      `<script src="${htmlAssetDir}/paged.polyfill.min.js"></script>`,
    ]
      .filter(Boolean)
      .join("\n");
    const html = `<!doctype html>
<html lang="${escapeHtml(meta.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="@alisio/plugin-thesis (HTML/Chrome output)">
<title>${escapeHtml(meta.title)}</title>
${style}
</head>
<body>
${this.cover()}
<div class="front">
${front}
</div>
<div class="body">
${body}
${references}
${annexes ? `<section class="annexes">\n${annexes}\n</section>` : ""}
</div>
${scripts}
</body>
</html>
`;
    this.findings.push({
      code: "BLD-004",
      gate: "G8",
      severity: "warning",
      message: `The HTML/Chrome output approximates the selected citation style (${doc.bibliography.csl.id}) with built-in ${this.formatter.family} formatting instead of the CSL file`,
      hint: "Use the Typst engine (/thesis:setup) for exact CSL output.",
    });
    return {
      html,
      findings: this.findings,
      hasMermaid: this.hasMermaid,
      hasMath: this.hasMath,
      hasBibliography: bibliography,
    };
  }
}

/** Plain text of inline content, for alt attributes. */
function plainText(nodes: readonly Inline[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text" || node.kind === "code") out += node.text;
    else if (node.kind === "emph" || node.kind === "strong" || node.kind === "link")
      out += plainText(node.children);
    else if (node.kind === "break") out += " ";
  }
  return out;
}

/** Model to a standalone HTML document. Pure: no file access; the adapter stages the assets. */
export function emitHtml(doc: ThesisDocument, options: HtmlEmitOptions = {}): HtmlEmitResult {
  return new HtmlEmitter(doc).document(options);
}
