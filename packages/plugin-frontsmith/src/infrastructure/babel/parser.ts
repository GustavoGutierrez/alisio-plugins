import { parse } from "@babel/parser";
import {
  languageForPath,
  type ParseDiagnostic,
  type ParseOptions,
  type ParseResult,
  type SourceLanguage,
  type SourceParser,
} from "../../application/ports/source-parser.js";
import { buildSourceView, type Node } from "./ast-view.js";

const pluginsFor = (
  language: SourceLanguage,
): Array<"typescript" | "jsx" | "decorators-legacy"> => {
  // `decorators-legacy` rescues Angular-style files that throw without a decorators plugin and
  // accepts parameter decorators with no recoverable error (spike S-R2).
  if (language === "ts") return ["typescript", "decorators-legacy"];
  if (language === "tsx") return ["typescript", "jsx", "decorators-legacy"];
  return ["jsx", "decorators-legacy"];
};

interface BabelError {
  message?: string;
  loc?: { line: number; column: number };
}

const shift = (
  line: number,
  column: number,
  origin: { line: number; column: number },
): { line: number; column: number } => ({
  line: origin.line + line - 1,
  column: line === 1 ? origin.column + column : column + 1,
});

const describe = (error: BabelError, origin: { line: number; column: number }): ParseDiagnostic => {
  const at = error.loc ? shift(error.loc.line, error.loc.column, origin) : origin;
  return { message: (error.message ?? "Parse error").replace(/\s*\(\d+:\d+\)\s*$/, ""), ...at };
};

export class BabelSourceParser implements SourceParser {
  parse(source: string, options: ParseOptions): ParseResult {
    const language = options.language ?? languageForPath(options.path);
    const origin = options.origin ?? { line: 1, column: 1 };
    let file: {
      program: Node;
      errors?: BabelError[];
      comments?: Array<{ value: string; loc?: { start: { line: number; column: number } } }>;
    };
    try {
      file = parse(source, {
        sourceType: "unambiguous",
        errorRecovery: true,
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        plugins: pluginsFor(language),
      }) as unknown as typeof file;
    } catch (error) {
      return { ok: false, recoverable: [], error: describe(error as BabelError, origin) };
    }
    try {
      const view = buildSourceView(file.program, source, { path: options.path, language, origin });
      view.comments = (file.comments ?? []).map((comment) => ({
        text: comment.value,
        ...(comment.loc ? shift(comment.loc.start.line, comment.loc.start.column, origin) : origin),
      }));
      return {
        ok: true,
        recoverable: (file.errors ?? []).map((error) => describe(error, origin)),
        view,
      };
    } catch (error) {
      return {
        ok: false,
        recoverable: [],
        error: { message: `Analysis failed: ${(error as Error).message}`, ...origin },
      };
    }
  }
}

export const babelSourceParser = new BabelSourceParser();
