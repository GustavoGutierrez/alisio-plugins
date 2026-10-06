import type { CssScan, CssSyntax } from "./css-scanner.js";
import type { SourceView } from "./source-parser.js";
import type { TemplateKind, TemplateScan } from "./template-scanner.js";

export type FileKind = "script" | "style" | "sfc" | "html" | "other";

export interface ScriptPiece {
  /** Which part of the file the script came from. */
  block: "file" | "script" | "module" | "setup" | "frontmatter" | "inline";
  view: SourceView;
}

export interface StylePiece {
  scan: CssScan;
  syntax: CssSyntax;
  origin: "file" | "block";
}

export interface TemplatePiece {
  scan: TemplateScan;
  kind: TemplateKind;
  origin: "file" | "block" | "angular-inline";
  className?: string;
}

/** A piece of a file that could not be read; becomes `FS-SRC-001` REVIEW, never a crash. */
export interface AnalysisDiagnostic {
  code: "FS-SRC-001";
  message: string;
  line: number;
  column: number;
}

export interface FileComment {
  text: string;
  line: number;
  column: number;
}

/** Everything the rule engines and the import graph need to know about one file. */
export interface FileAnalysis {
  path: string;
  kind: FileKind;
  lineCount: number;
  scripts: ScriptPiece[];
  styles: StylePiece[];
  templates: TemplatePiece[];
  diagnostics: AnalysisDiagnostic[];
  /** Comments from every piece, for inline suppressions. */
  comments: FileComment[];
  /** Soft problems reported by the scanners (unterminated blocks and the like). */
  scanErrors: string[];
}

/** Turns one file's text into a `FileAnalysis`; deterministic, never throws. */
export interface FileAnalyzer {
  analyze(path: string, text: string): FileAnalysis;
}
