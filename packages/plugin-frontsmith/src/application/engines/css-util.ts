import type { AtRuleContext, CssScan } from "../ports/css-scanner.js";
import type { FileAnalysis } from "../ports/file-analyzer.js";

export const contextText = (context: AtRuleContext): string =>
  `${context.name} ${context.prelude}`.trim();

export const scansOf = (analysis: FileAnalysis): CssScan[] =>
  analysis.styles.map((piece) => piece.scan);
