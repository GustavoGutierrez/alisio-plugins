import MarkdownIt, { type Token } from "markdown-it";
import footnote from "markdown-it-footnote";
import { parse as parseYaml } from "yaml";
import type { Finding } from "../types.js";
import { labelKind, labelPattern, parseAttrs, thesisDialect } from "./dialect.js";
import type {
  Block,
  FigureAsset,
  FigureAssetKind,
  Inline,
  ParsedChapter,
  Section,
  SectionRole,
  TableBlock,
} from "./model.js";

const sectionRoles: readonly SectionRole[] = [
  "body",
  "annex",
  "abstract",
  "abstract-secondary",
  "dedication",
  "acknowledgments",
  "ai-declaration",
];
const frontKeys = ["role", "section", "lang", "keywords"];

const md = new MarkdownIt("commonmark", { html: true, linkify: false, typographer: false })
  .enable("table")
  .use(footnote)
  .use(thesisDialect);

const placeholderPattern = /\b(?:TODO|TBD|XXX|FIXME)\b|\[citation needed\]|\{\{[^}]*\}\}/;
const rawTypstPattern =
  /(?:^|\s)#(?:set|show|import|include|let|eval|read|context|page|pagebreak|box|block|raw|image|figure|table|grid|place|text|par|align|heading|bibliography|cite|ref|label|metadata|counter|state|query|script|plugin|json|yaml|csv|toml|xml)\b/;
const pageBreakPattern = /\\(?:newpage|pagebreak|clearpage)(?![A-Za-z])/;
const claimPattern = /^<!--\s*claim:([A-Za-z0-9_-]{1,40})\s*-->(.*)$/s;
const trailingAttrs = /\s*\{\s*((?:#|width=)[^{}]*)\}\s*$/;
const sourceMarker = /(^|(?<=[.!?])\s+)(Source|Fuente|Fonte):\s*/;
const imageKinds: [RegExp, FigureAssetKind][] = [
  [/\.vl\.json$/i, "chart"],
  [/\.mmd$/i, "mermaid"],
  [/\.svg$/i, "svg"],
  [/\.(?:png|jpe?g)$/i, "raster"],
];

interface FrontMatter {
  role: SectionRole;
  section?: string;
  lang?: string;
  keywords?: string[];
  body: string;
  /** Lines removed from the top, so reported line numbers match the file. */
  lineOffset: number;
}

const attr = (token: Token, name: string): string => String(token.attrGet(name) ?? "");
// biome-ignore lint/suspicious/noExplicitAny: markdown-it token meta is an untyped bag set by our own rules
const meta = (token: Token): Record<string, any> => (token.meta ?? {}) as Record<string, any>;

class Converter {
  readonly findings: Finding[] = [];
  readonly footnotes: Record<string, Block[]> = {};

  constructor(
    private readonly path: string,
    private readonly lineOffset: number,
    private readonly footnotePrefix: string,
  ) {}

  add(line: number | undefined, message: string, hint?: string): void {
    this.findings.push({
      code: "HYG-001",
      gate: "G7",
      severity: "error",
      file: this.path,
      ...(line === undefined ? {} : { line }),
      message,
      ...(hint ? { hint } : {}),
    });
  }

  lineOf(token: Token | undefined): number | undefined {
    const start = token?.map?.[0];
    return start === undefined ? undefined : start + 1 + this.lineOffset;
  }

  // ---------------------------------------------------------------------------------------
  // Inline
  // ---------------------------------------------------------------------------------------

  inline(children: readonly Token[], line: number | undefined): Inline[] {
    const stack: { kind: "root" | "emph" | "strong" | "link"; href?: string; nodes: Inline[] }[] = [
      { kind: "root", nodes: [] },
    ];
    const top = () => stack[stack.length - 1] as (typeof stack)[number];
    const pushText = (text: string) => {
      if (text === "") return;
      const nodes = top().nodes;
      const last = nodes[nodes.length - 1];
      if (last?.kind === "text") last.text += text;
      else nodes.push({ kind: "text", text });
    };
    for (const token of children) {
      switch (token.type) {
        case "text":
        case "text_special":
          pushText(token.content);
          break;
        case "softbreak":
          pushText(" ");
          break;
        case "hardbreak":
          top().nodes.push({ kind: "break" });
          break;
        case "code_inline":
          top().nodes.push({ kind: "code", text: token.content });
          break;
        case "em_open":
          stack.push({ kind: "emph", nodes: [] });
          break;
        case "strong_open":
          stack.push({ kind: "strong", nodes: [] });
          break;
        case "em_close":
        case "strong_close": {
          const done = stack.pop();
          if (done && done.kind !== "root" && done.kind !== "link") {
            top().nodes.push({ kind: done.kind, children: done.nodes });
          }
          break;
        }
        case "link_open": {
          const href = attr(token, "href");
          if (!/^(?:https?:\/\/|mailto:)[^\s]+$/i.test(href)) {
            this.add(
              line,
              `Unsupported link target "${href.slice(0, 60)}"`,
              "Use an absolute http(s) or mailto link; cross-references use @fig-x, @tbl-x, @eq-x and @sec-x.",
            );
            stack.push({ kind: "link", nodes: [] });
          } else stack.push({ kind: "link", href, nodes: [] });
          break;
        }
        case "link_close": {
          const done = stack.pop();
          if (done?.kind === "link") {
            if (done.href)
              top().nodes.push({ kind: "link", href: done.href, children: done.nodes });
            else top().nodes.push(...done.nodes);
          }
          break;
        }
        case "math_inline":
          top().nodes.push({ kind: "math", latex: token.content });
          break;
        case "thesis_cite":
          top().nodes.push({
            kind: "citation",
            items: meta(token).items,
            narrative: meta(token).narrative,
          });
          break;
        case "thesis_ref":
          top().nodes.push({
            kind: "crossref",
            label: meta(token).label,
            refKind: meta(token).refKind,
          });
          break;
        case "thesis_badref":
          this.add(
            line,
            `Unrecognized reference ${token.content}`,
            "Citation keys are lowercase author + year (for example @perez2021); cross-references start with fig-, tbl-, eq- or sec-.",
          );
          pushText(token.content);
          break;
        case "footnote_ref":
          top().nodes.push({
            kind: "footnote",
            id: `${this.footnotePrefix}${String(meta(token).id)}`,
          });
          break;
        case "footnote_anchor":
          break;
        case "image":
          this.add(
            line,
            "Images must stand alone in their own paragraph as a figure",
            "Write ![Caption](figures/images/x.png){#fig-x} on a line of its own.",
          );
          break;
        case "html_inline":
          this.add(line, "Raw HTML is not allowed", "Use Markdown or the thesis dialect instead.");
          break;
        default:
          this.add(line, `Unsupported inline construct (${token.type})`);
      }
    }
    while (stack.length > 1) {
      const done = stack.pop();
      if (done && done.kind !== "root") top().nodes.push(...done.nodes);
    }
    const nodes = (stack[0] as (typeof stack)[number]).nodes;
    this.scanText(nodes, line);
    return nodes;
  }

  private scanText(nodes: readonly Inline[], line: number | undefined): void {
    for (const node of nodes) {
      if (node.kind === "text") {
        if (placeholderPattern.test(node.text)) {
          this.add(line, "Placeholder text found (TODO, TBD, XXX, [citation needed] or {{...}})");
        }
        if (rawTypstPattern.test(node.text)) {
          this.add(line, "Raw Typst markup is not allowed in Markdown sources");
        }
        if (pageBreakPattern.test(node.text)) {
          this.add(
            line,
            "Page breaks cannot be requested from Markdown",
            "The template decides page breaks.",
          );
        }
      } else if (node.kind === "emph" || node.kind === "strong" || node.kind === "link") {
        this.scanText(node.children, line);
      }
    }
  }

  /** Remove a trailing `{#label width=..}` group from the last text node. */
  private takeAttrs(nodes: Inline[]): string | undefined {
    const last = nodes[nodes.length - 1];
    if (last?.kind !== "text") return undefined;
    const match = trailingAttrs.exec(last.text);
    if (!match) return undefined;
    last.text = last.text.slice(0, match.index);
    if (last.text === "") nodes.pop();
    return match[1];
  }

  private labelFrom(
    attrText: string | undefined,
    expected: "fig" | "tbl" | "eq" | "sec",
    line: number | undefined,
    allowWidth = false,
  ): { label?: string; width?: string } {
    if (attrText === undefined) return {};
    const attrs = parseAttrs(attrText);
    for (const part of attrs.unknown) {
      this.add(
        line,
        `Unknown attribute "${part.slice(0, 40)}"`,
        "Allowed: {#label} and, on figures, width=80%.",
      );
    }
    const result: { label?: string; width?: string } = {};
    if (attrs.label !== undefined) {
      if (labelKind(attrs.label) === expected) result.label = attrs.label;
      else this.add(line, `Label ${attrs.label} must start with ${expected}- here`);
    }
    if (attrs.width !== undefined) {
      if (allowWidth) result.width = attrs.width;
      else this.add(line, "width= is only valid on figures");
    }
    return result;
  }

  // ---------------------------------------------------------------------------------------
  // Blocks
  // ---------------------------------------------------------------------------------------

  private matching(tokens: readonly Token[], open: number): number {
    let depth = 0;
    for (let index = open; index < tokens.length; index += 1) {
      depth += (tokens[index] as Token).nesting;
      if (depth === 0) return index;
    }
    return tokens.length - 1;
  }

  blocks(tokens: readonly Token[]): Block[] {
    const out: Block[] = [];
    let pendingClaim: string | undefined;
    const settleClaim = (line: number | undefined) => {
      if (pendingClaim !== undefined) {
        this.add(line, `Claim anchor "${pendingClaim}" is not followed by a paragraph`);
        pendingClaim = undefined;
      }
    };
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index] as Token;
      const line = this.lineOf(token);
      switch (token.type) {
        case "heading_open": {
          settleClaim(line);
          const level = Number(token.tag.slice(1));
          const inlineToken = tokens[index + 1] as Token;
          const children = this.inline(inlineToken.children ?? [], line);
          const attrText = this.takeAttrs(children);
          const { label } = this.labelFrom(attrText, "sec", line);
          if (level > 4) this.add(line, "Headings deeper than level 4 are not supported");
          out.push({
            kind: "heading",
            level: Math.min(level, 4) as 1 | 2 | 3 | 4,
            children,
            ...(label ? { label } : {}),
            ...(line === undefined ? {} : { line }),
          });
          index = this.matching(tokens, index) + 1;
          break;
        }
        case "paragraph_open": {
          const inlineToken = tokens[index + 1] as Token;
          const produced = this.paragraph(inlineToken, line, out, pendingClaim);
          pendingClaim = undefined;
          if (produced) out.push(produced);
          index = this.matching(tokens, index) + 1;
          break;
        }
        case "html_block": {
          const claim = claimPattern.exec(token.content.trim());
          if (claim && !(claim[2] ?? "").includes("\n")) {
            settleClaim(line);
            const rest = (claim[2] ?? "").trim();
            if (rest === "") pendingClaim = claim[1];
            else {
              const [inlineToken] = md.parseInline(rest, {});
              const paragraph = this.paragraph(inlineToken as Token, line, out, claim[1]);
              if (paragraph) out.push(paragraph);
            }
          } else {
            settleClaim(line);
            this.add(
              line,
              "Raw HTML is not allowed",
              "Only <!-- claim:id --> comments are accepted.",
            );
          }
          index += 1;
          break;
        }
        case "bullet_list_open":
        case "ordered_list_open": {
          settleClaim(line);
          const end = this.matching(tokens, index);
          const items: Block[][] = [];
          let cursor = index + 1;
          while (cursor < end) {
            const itemEnd = this.matching(tokens, cursor);
            items.push(this.blocks(tokens.slice(cursor + 1, itemEnd)));
            cursor = itemEnd + 1;
          }
          out.push({
            kind: "list",
            ordered: token.type === "ordered_list_open",
            items,
            ...(line === undefined ? {} : { line }),
          });
          index = end + 1;
          break;
        }
        case "blockquote_open": {
          settleClaim(line);
          const end = this.matching(tokens, index);
          out.push({
            kind: "quote",
            children: this.blocks(tokens.slice(index + 1, end)),
            ...(line === undefined ? {} : { line }),
          });
          index = end + 1;
          break;
        }
        case "fence":
        case "code_block": {
          settleClaim(line);
          const lang = token.info.trim().split(/\s+/)[0] ?? "";
          out.push({
            kind: "codeblock",
            text: token.content.replace(/\n$/, ""),
            ...(/^[A-Za-z0-9_+#-]{1,20}$/.test(lang) ? { lang } : {}),
            ...(line === undefined ? {} : { line }),
          });
          index += 1;
          break;
        }
        case "math_block": {
          settleClaim(line);
          const attrText = meta(token).attr as string | undefined;
          const { label } = this.labelFrom(attrText?.trim(), "eq", line);
          out.push({
            kind: "equation",
            latex: token.content,
            ...(label ? { label } : {}),
            ...(line === undefined ? {} : { line }),
          });
          index += 1;
          break;
        }
        case "table_open": {
          settleClaim(line);
          const end = this.matching(tokens, index);
          out.push(this.table(tokens.slice(index, end + 1), line));
          index = end + 1;
          break;
        }
        case "footnote_block_open": {
          const end = this.matching(tokens, index);
          let cursor = index + 1;
          while (cursor < end) {
            const open = tokens[cursor] as Token;
            if (open.type === "footnote_open") {
              const itemEnd = this.matching(tokens, cursor);
              this.footnotes[`${this.footnotePrefix}${String(meta(open).id)}`] = this.blocks(
                tokens.slice(cursor + 1, itemEnd),
              );
              cursor = itemEnd + 1;
            } else cursor += 1;
          }
          index = end + 1;
          break;
        }
        case "footnote_anchor":
          index += 1;
          break;
        case "hr":
          settleClaim(line);
          this.add(line, "Thematic breaks (---) are not supported");
          index += 1;
          break;
        default:
          settleClaim(line);
          this.add(line, `Unsupported construct (${token.type})`);
          index = token.nesting === 1 ? this.matching(tokens, index) + 1 : index + 1;
      }
    }
    settleClaim(undefined);
    return out;
  }

  private paragraph(
    inlineToken: Token,
    line: number | undefined,
    out: Block[],
    claim: string | undefined,
  ): Block | undefined {
    const children = inlineToken.children ?? [];
    const meaningful = children.filter(
      (child) =>
        !(child.type === "softbreak" || (child.type === "text" && child.content.trim() === "")),
    );
    const imageAt = meaningful.findIndex((child) => child.type === "image");
    if (imageAt >= 0) {
      const figure = this.figure(meaningful, line);
      if (claim !== undefined) this.add(line, "A claim anchor cannot precede a figure");
      return figure;
    }
    const nodes = this.inline(children, line);

    // `Table: Caption {#tbl-x}` attaches to the table just before it.
    const first = nodes[0];
    const previous = out[out.length - 1];
    if (first?.kind === "text" && /^Table:\s/.test(first.text)) {
      if (previous?.kind === "table" && previous.caption === undefined) {
        first.text = first.text.replace(/^Table:\s+/, "");
        const attrText = this.takeAttrs(nodes);
        const { label } = this.labelFrom(attrText, "tbl", line);
        const { caption, source } = splitSource(nodes);
        previous.caption = caption;
        if (source) previous.source = source;
        if (label) previous.label = label;
        return undefined;
      }
      this.add(line, "A Table: caption must directly follow a table");
    }
    if (nodes.length === 0) return undefined;
    return {
      kind: "paragraph",
      children: nodes,
      ...(claim === undefined ? {} : { claim }),
      ...(line === undefined ? {} : { line }),
    };
  }

  private figure(meaningful: readonly Token[], line: number | undefined): Block | undefined {
    const image = meaningful[0] as Token;
    if (image.type !== "image") {
      this.add(line, "Images must stand alone in their own paragraph as a figure");
      return undefined;
    }
    let attrText: string | undefined;
    for (const extra of meaningful.slice(1)) {
      const match = extra.type === "text" ? /^\s*\{\s*([^{}]*)\}\s*$/.exec(extra.content) : null;
      if (match && attrText === undefined && /^(?:#|width=)/.test((match[1] ?? "").trim())) {
        attrText = (match[1] ?? "").trim();
      } else {
        this.add(line, "Unexpected text next to a figure; only {#fig-x width=80%} may follow it");
        return undefined;
      }
    }
    const { label, width } = this.labelFrom(attrText, "fig", line, true);
    const src = attr(image, "src");
    const kindEntry = imageKinds.find(([pattern]) => pattern.test(src));
    const safe =
      src.startsWith("figures/") &&
      !src.includes("\\") &&
      !src.includes("\0") &&
      src.split("/").every((part) => part !== "" && part !== "." && part !== "..");
    if (!safe) {
      this.add(
        line,
        `Unsafe or unsupported figure path "${src.slice(0, 80)}"`,
        "Figures are workspace-relative paths under figures/, for example figures/diagrams/flow.mmd.",
      );
      return undefined;
    }
    if (!kindEntry) {
      this.add(
        line,
        `Unsupported figure type "${src.slice(0, 80)}"`,
        "Use .mmd, .svg, .png, .jpg or .vl.json.",
      );
      return undefined;
    }
    const asset: FigureAsset = { kind: kindEntry[1], path: src };
    const { caption, source } = splitSource(this.inline(image.children ?? [], line));
    return {
      kind: "figure",
      asset,
      caption,
      ...(source ? { source } : {}),
      ...(label ? { label } : {}),
      ...(width ? { width } : {}),
      ...(line === undefined ? {} : { line }),
    };
  }

  private table(tokens: readonly Token[], line: number | undefined): TableBlock {
    const align: TableBlock["align"] = [];
    const header: Inline[][] = [];
    const rows: Inline[][][] = [];
    let current: Inline[][] | undefined;
    let inHead = false;
    for (const token of tokens) {
      if (token.type === "thead_open") inHead = true;
      else if (token.type === "thead_close") inHead = false;
      else if (token.type === "tr_open") current = [];
      else if (token.type === "tr_close" && current) {
        if (inHead) header.splice(0, header.length, ...current);
        else rows.push(current);
        current = undefined;
      } else if (token.type === "th_open" || token.type === "td_open") {
        if (inHead) {
          const style = attr(token, "style");
          const found = /text-align:(left|center|right)/.exec(style)?.[1] as
            | "left"
            | "center"
            | "right"
            | undefined;
          align.push(found ?? null);
        }
      } else if (token.type === "inline" && current) {
        current.push(this.inline(token.children ?? [], line));
      }
    }
    return {
      kind: "table",
      align,
      header,
      rows,
      ...(line === undefined ? {} : { line }),
    };
  }
}

/** Split a caption at its "Source: ..." sentence (also Fuente:, Fonte:). */
export function splitSource(nodes: Inline[]): { caption: Inline[]; source?: Inline[] } {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index] as Inline;
    if (node.kind !== "text") continue;
    const match = sourceMarker.exec(node.text);
    if (!match) continue;
    const before = node.text.slice(0, match.index);
    const sourceText = node.text.slice(match.index + (match[1]?.length ?? 0));
    const caption: Inline[] = [...nodes.slice(0, index)];
    if (before !== "") caption.push({ kind: "text", text: before });
    return {
      caption,
      source: [{ kind: "text", text: sourceText }, ...nodes.slice(index + 1)],
    };
  }
  return { caption: nodes };
}

function splitFrontMatter(path: string, source: string, findings: Finding[]): FrontMatter {
  const base: FrontMatter = {
    role: path.includes("/annexes/") ? "annex" : "body",
    body: source,
    lineOffset: 0,
  };
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!match) return base;
  const fail = (message: string) =>
    findings.push({ code: "HYG-001", gate: "G7", severity: "error", file: path, line: 1, message });
  let data: unknown;
  try {
    data = parseYaml(match[1] as string);
  } catch {
    fail("The YAML front matter of this chapter is not valid YAML");
    return {
      ...base,
      body: source.slice(match[0].length),
      lineOffset: match[0].split("\n").length - 1,
    };
  }
  const result: FrontMatter = {
    ...base,
    body: source.slice(match[0].length),
    lineOffset: match[0].split("\n").length - 1,
  };
  if (data === null || data === undefined) return result;
  if (typeof data !== "object" || Array.isArray(data)) {
    fail("The YAML front matter must be a mapping");
    return result;
  }
  const record = data as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!frontKeys.includes(key)) fail(`Unknown front matter key "${key}"`);
  }
  if (record.role !== undefined) {
    if (
      typeof record.role === "string" &&
      (sectionRoles as readonly string[]).includes(record.role)
    ) {
      result.role = record.role as SectionRole;
    } else fail(`role must be one of ${sectionRoles.join(", ")}`);
  }
  if (record.section !== undefined) {
    if (typeof record.section === "string" && /^SEC-\d{2}(\.\d{2}){0,2}$/.test(record.section)) {
      result.section = record.section;
    } else fail("section must be an outline id such as SEC-03");
  }
  if (record.lang !== undefined) {
    if (
      typeof record.lang === "string" &&
      /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(record.lang)
    ) {
      result.lang = record.lang;
    } else fail("lang must be a BCP-47 tag");
  }
  if (record.keywords !== undefined) {
    if (
      Array.isArray(record.keywords) &&
      record.keywords.length <= 12 &&
      record.keywords.every(
        (item) => typeof item === "string" && item.length > 0 && item.length <= 80,
      )
    ) {
      result.keywords = record.keywords as string[];
    } else fail("keywords must be a list of at most 12 short strings");
  }
  return result;
}

export interface ParseOptions {
  /** Prefix that keeps footnote ids unique across chapters (default: `<path>#`). */
  footnotePrefix?: string;
}

/** Parse one Markdown chapter into the neutral model. Pure: no file access. */
export function parseChapter(
  path: string,
  source: string,
  options: ParseOptions = {},
): ParsedChapter {
  const findings: Finding[] = [];
  const front = splitFrontMatter(path, source, findings);
  const converter = new Converter(path, front.lineOffset, options.footnotePrefix ?? `${path}#`);
  const tokens = md.parse(front.body, {});
  const blocks = converter.blocks(tokens);
  const section: Section = {
    path,
    role: front.role,
    blocks,
    ...(front.section ? { section: front.section } : {}),
    ...(front.lang ? { lang: front.lang } : {}),
    ...(front.keywords ? { keywords: front.keywords } : {}),
  };
  return {
    section,
    footnotes: converter.footnotes,
    findings: [...findings, ...converter.findings],
  };
}

export { labelPattern };
