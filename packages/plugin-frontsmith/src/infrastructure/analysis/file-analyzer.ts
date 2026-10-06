import type { CssSyntax } from "../../application/ports/css-scanner.js";
import type {
  AnalysisDiagnostic,
  FileAnalysis,
  FileAnalyzer,
  FileComment,
  ScriptPiece,
  StylePiece,
  TemplatePiece,
} from "../../application/ports/file-analyzer.js";
import type { SourceLanguage } from "../../application/ports/source-parser.js";
import { babelSourceParser } from "../babel/parser.js";
import { scanCss } from "../scanners/css.js";
import {
  extractSfc,
  maskedRange,
  maskedSource,
  type SfcBlock,
  withoutBlocks,
} from "../scanners/sfc.js";
import { scanTemplate } from "../scanners/template.js";

const SCRIPT_EXTENSIONS = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

const styleSyntax = (lang: string | undefined): CssSyntax | undefined => {
  if (lang === undefined || lang === "css" || lang === "postcss") return "css";
  if (lang === "scss") return "scss";
  if (lang === "less") return "less";
  return undefined;
};

const scriptLanguage = (lang: string | undefined): SourceLanguage => {
  if (lang === "ts" || lang === "typescript") return "ts";
  if (lang === "tsx") return "tsx";
  if (lang === "jsx") return "jsx";
  return "js";
};

const countLines = (text: string): number =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

export class DefaultFileAnalyzer implements FileAnalyzer {
  analyze(path: string, text: string): FileAnalysis {
    const analysis: FileAnalysis = {
      path,
      kind: "other",
      lineCount: countLines(text),
      scripts: [],
      styles: [],
      templates: [],
      diagnostics: [],
      comments: [],
      scanErrors: [],
    };
    const lower = path.toLowerCase();
    if (SCRIPT_EXTENSIONS.test(lower)) {
      analysis.kind = "script";
      this.script(analysis, text, "file", undefined, text);
      return analysis;
    }
    const css = /\.(css|scss|less)$/.exec(lower);
    if (css) {
      analysis.kind = "style";
      this.style(analysis, text, css[1] as CssSyntax, "file");
      return analysis;
    }
    if (lower.endsWith(".vue") || lower.endsWith(".svelte") || lower.endsWith(".astro")) {
      analysis.kind = "sfc";
      this.sfc(
        analysis,
        text,
        lower.endsWith(".vue") ? "vue" : lower.endsWith(".svelte") ? "svelte" : "astro",
      );
      return analysis;
    }
    if (lower.endsWith(".html") || lower.endsWith(".htm")) {
      analysis.kind = "html";
      const kind = lower.endsWith(".component.html") ? "angular" : "html";
      this.template(analysis, text, kind, "file");
      const { blocks, errors } = extractSfc(text, "html");
      analysis.scanErrors.push(...errors);
      this.blocks(analysis, text, blocks);
      return analysis;
    }
    return analysis;
  }

  private script(
    analysis: FileAnalysis,
    parseText: string,
    block: ScriptPiece["block"],
    lang: string | undefined,
    originalText: string,
  ): void {
    const language = block === "file" ? undefined : scriptLanguage(lang);
    const result = babelSourceParser.parse(parseText, {
      path: analysis.path,
      ...(language ? { language } : {}),
    });
    if (!result.ok || !result.view) {
      const error = result.error;
      analysis.diagnostics.push({
        code: "FS-SRC-001",
        message: `File could not be parsed: ${error?.message ?? "unknown error"}`,
        line: error?.line ?? 1,
        column: error?.column ?? 1,
      } satisfies AnalysisDiagnostic);
      return;
    }
    analysis.scripts.push({ block, view: result.view });
    analysis.comments.push(...result.view.comments);
    for (const component of result.view.angularComponents) {
      if (!component.template) continue;
      const masked = maskedRange(originalText, component.template.start, component.template.end);
      const scan = scanTemplate(masked, "angular");
      analysis.templates.push({
        scan,
        kind: "angular",
        origin: "angular-inline",
        className: component.className,
      });
      this.collect(analysis.comments, scan.comments);
      analysis.scanErrors.push(...scan.errors);
    }
  }

  private style(
    analysis: FileAnalysis,
    text: string,
    syntax: CssSyntax,
    origin: StylePiece["origin"],
  ): void {
    const scan = scanCss(text, syntax);
    analysis.styles.push({ scan, syntax, origin });
    this.collect(analysis.comments, scan.comments);
    analysis.scanErrors.push(...scan.errors);
  }

  private template(
    analysis: FileAnalysis,
    text: string,
    kind: TemplatePiece["kind"],
    origin: TemplatePiece["origin"],
  ): void {
    const scan = scanTemplate(text, kind);
    analysis.templates.push({ scan, kind, origin });
    this.collect(analysis.comments, scan.comments);
    analysis.scanErrors.push(...scan.errors);
  }

  private collect(target: FileComment[], source: readonly FileComment[]): void {
    for (const comment of source)
      target.push({ text: comment.text, line: comment.line, column: comment.column });
  }

  /** Scripts and styles of an SFC or HTML file, parsed from position-preserving masked copies. */
  private blocks(analysis: FileAnalysis, text: string, blocks: readonly SfcBlock[]): void {
    for (const block of blocks) {
      if (block.kind === "script" || block.kind === "frontmatter") {
        const type = block.attrs.type;
        if (
          typeof type === "string" &&
          !/^(?:module|text\/javascript|application\/javascript)$/i.test(type)
        )
          continue;
        const piece: ScriptPiece["block"] =
          block.kind === "frontmatter"
            ? "frontmatter"
            : block.attrs.setup !== undefined
              ? "setup"
              : block.attrs.context === "module" || block.attrs.module !== undefined
                ? "module"
                : "script";
        this.script(analysis, maskedSource(text, [block]), piece, block.lang, text);
      } else if (block.kind === "style") {
        const syntax = styleSyntax(block.lang);
        if (syntax) this.style(analysis, maskedSource(text, [block]), syntax, "block");
      }
    }
  }

  private sfc(analysis: FileAnalysis, text: string, kind: "vue" | "svelte" | "astro"): void {
    const { blocks, errors } = extractSfc(text, kind);
    analysis.scanErrors.push(...errors);
    this.blocks(analysis, text, blocks);
    if (kind === "vue") {
      const template = blocks.find((block) => block.kind === "template");
      if (template && (template.lang === undefined || template.lang === "html")) {
        const scan = scanTemplate(maskedSource(text, [template]), "vue-sfc");
        analysis.templates.push({ scan, kind: "vue-sfc", origin: "block" });
        this.collect(analysis.comments, scan.comments);
        analysis.scanErrors.push(...scan.errors);
      }
    } else {
      const markup = withoutBlocks(text, blocks);
      this.template(analysis, markup, kind, "file");
    }
  }
}
