export type CssSyntax = "css" | "scss" | "less";

export interface AtRuleContext {
  name: string;
  prelude: string;
}

export interface CssDeclaration {
  property: string;
  value: string;
  important: boolean;
  /** 1-based position of the first character of the property. */
  line: number;
  column: number;
  /** Selectors of the nearest enclosing rule joined by ", " ("" outside any rule). */
  selector: string;
  /** Raw header of each enclosing rule, outermost first. */
  chain: string[];
  atRules: AtRuleContext[];
  /** Id of the block the declaration lives in; equal ids mean "same block". */
  blockId: number;
  isCustomProperty: boolean;
}

export interface CssRule {
  /** Resolved selectors (nesting `&` applied, capped at 64). */
  selectors: string[];
  chain: string[];
  line: number;
  column: number;
  blockId: number;
  atRules: AtRuleContext[];
  declarations: CssDeclaration[];
}

export interface CssAtRule {
  name: string;
  prelude: string;
  line: number;
  column: number;
  hasBlock: boolean;
  blockId?: number;
  /** Declarations written directly inside the at-rule's own block (for example `@font-face`). */
  declarations: CssDeclaration[];
  atRules: AtRuleContext[];
}

export interface CssComment {
  text: string;
  line: number;
  column: number;
}

export interface CssVarRef {
  name: string;
  hasFallback: boolean;
  line: number;
  column: number;
  property: string;
}

export interface CssScan {
  declarations: CssDeclaration[];
  rules: CssRule[];
  atRules: CssAtRule[];
  comments: CssComment[];
  customProperties: Array<CssDeclaration & { name: string }>;
  varRefs: CssVarRef[];
  errors: string[];
}

/** Lexical CSS/SCSS/LESS scanner port (spec 10.3). Never throws. */
export interface CssScanner {
  scan(source: string, syntax: CssSyntax): CssScan;
}
