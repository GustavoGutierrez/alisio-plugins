export type TemplateKind = "vue-sfc" | "svelte" | "angular" | "astro" | "html";

export interface TemplateAttribute {
  /** Name as written: `:key`, `@click.prevent`, `[(ngModel)]`, `on:click|once`, `{...rest}`. */
  name: string;
  value?: string;
  hasValue: boolean;
  quote: '"' | "'" | "{" | "";
  /** A binding, directive or expression rather than a static attribute. */
  dynamic: boolean;
  line: number;
  column: number;
}

export interface TemplateElement {
  index: number;
  tag: string;
  attrs: TemplateAttribute[];
  /** Written with `/>`. */
  selfClosing: boolean;
  /** Index of the enclosing element, or -1 at the root. */
  parent: number;
  childElements: number[];
  /** Non-blank direct text or an expression/interpolation child. */
  hasText: boolean;
  /** Direct static text, collapsed and capped at 500 characters. */
  text: string;
  line: number;
  column: number;
}

/** Template-level constructs that are not elements: Svelte blocks, Angular control flow. */
export interface TemplateBlock {
  /** `#each`, `:else`, `/each`, `@html`, `@if`, `@else`, ... */
  kind: string;
  /** Text after the kind keyword (the expression). */
  expression: string;
  line: number;
  column: number;
}

export interface TemplateComment {
  text: string;
  line: number;
  column: number;
}

export interface TemplateScan {
  elements: TemplateElement[];
  blocks: TemplateBlock[];
  comments: TemplateComment[];
  errors: string[];
}

/** Lexical HTML-like scanner port (spec 10.3). Never throws. */
export interface TemplateScanner {
  scan(source: string, kind: TemplateKind): TemplateScan;
}
