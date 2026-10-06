/** Reduced, parser-independent view of one JS/TS/JSX/TSX source file (spec 10.3). */

export interface Loc {
  /** 1-based. */
  line: number;
  column: number;
}

export type SourceLanguage = "js" | "jsx" | "ts" | "tsx";

export interface ImportRecord {
  specifier: string;
  kind: "static" | "dynamic" | "require" | "export-from";
  typeOnly: boolean;
  /** Imported or re-exported names; `default` for the default import, `*` for a namespace. */
  names: string[];
  loc: Loc;
}

export interface JsxAttribute {
  /** Name as written, with namespace (`xlink:href`). Spread attributes are named `...`. */
  name: string;
  spread: boolean;
  valueKind: "none" | "string" | "expression" | "template" | "literal";
  /** Static text of a string, numeric or boolean literal, or of a template literal without expressions. */
  value?: string;
  /** For `key`: the expression is the index parameter of an enclosing `.map` callback. */
  keyIsIndex?: boolean;
  loc: Loc;
}

export interface JsxElementRecord {
  index: number;
  /** `div`, `Button`, `Foo.Bar`, or `` for a fragment. */
  tag: string;
  isComponent: boolean;
  attrs: JsxAttribute[];
  selfClosing: boolean;
  parent: number;
  /** Non-blank JSX text or any expression/spread child. */
  hasTextChildren: boolean;
  childTags: string[];
  loc: Loc;
}

export interface ClassStringRecord {
  /** Static text; each interpolated expression is replaced by `\u0000`. */
  value: string;
  /** The text contains interpolation or concatenation. */
  dynamic: boolean;
  origin: "attribute" | "call";
  /** Attribute name (`className`) or callee (`clsx`). */
  name: string;
  /** Tag of the element that carries the attribute (attribute origin only). */
  tag?: string;
  loc: Loc;
}

export interface CallArg {
  kind: "string" | "template" | "other";
  value?: string;
}

export interface CallRecord {
  /** Dotted callee with `()` for intermediate calls: `page.locator().first().click`. */
  callee: string;
  args: CallArg[];
  /** Babel node types of the first four arguments (`ObjectExpression`, `ArrayExpression`, ...). */
  argTypes: string[];
  argCount: number;
  typeArgCount: number;
  loc: Loc;
}

export interface PropsInfo {
  /** The component has a first parameter. */
  declared: boolean;
  typeKind: "none" | "inline" | "reference" | "any";
  typeText?: string;
  hasAny: boolean;
  /** Names of boolean-typed props found in an inline or same-file type. */
  booleanProps: string[];
  /** Names destructured or declared. */
  names: string[];
  spreadRest: boolean;
  as: {
    present: boolean;
    typeText?: string;
    /** Constraint texts of the component's type parameters. */
    typeParamConstraints: string[];
    /** The props type mentions `ComponentProps`, `ComponentPropsWithoutRef` or similar helpers. */
    usesPropsHelper: boolean;
  };
}

export interface ComponentRecord {
  name: string;
  kind: "function" | "arrow" | "class" | "forwardRef" | "memo";
  exported: boolean;
  defaultExport: boolean;
  props: PropsInfo;
  /** Wrapped by `forwardRef`, or receives a `ref` prop (React 19 style). */
  forwardsRef: boolean;
  nestedIn?: string;
  usesHooks: string[];
  loc: Loc;
  endLine: number;
}

export interface EffectRecord {
  hook: string;
  deps: "none" | "empty" | "list";
  statementCount: number;
  setterCalls: string[];
  otherCalls: string[];
  hasReturn: boolean;
  hasAwait: boolean;
  loc: Loc;
}

export interface AngularComponentRecord {
  className: string;
  selector?: string;
  template?: { text: string; line: number; column: number; start: number; end: number };
  templateUrl?: string;
  changeDetection?: string;
  hasConstructorParams: boolean;
  usesInject: boolean;
  loc: Loc;
}

export interface TestCaseRecord {
  /** `it`, `test.only`, `it.skip`, ... */
  callee: string;
  name: string;
  /** The test has a function body (`it.todo("x")` does not). */
  hasBody: boolean;
  /** Callee text of every call inside the body. */
  calls: string[];
  loc: Loc;
}

export interface ExportedLetRecord {
  name: string;
  typed: boolean;
  loc: Loc;
}

export interface SourceView {
  path: string;
  language: SourceLanguage;
  lineCount: number;
  directives: string[];
  imports: ImportRecord[];
  exportedNames: string[];
  /** 1-based line of each exported name's declaration. */
  exportLines: Record<string, number>;
  exportedLets: ExportedLetRecord[];
  jsx: JsxElementRecord[];
  classStrings: ClassStringRecord[];
  calls: CallRecord[];
  components: ComponentRecord[];
  effects: EffectRecord[];
  testCases: TestCaseRecord[];
  /** String literals that are `data:` URIs, with their length. */
  dataUris: Array<{ length: number; loc: Loc }>;
  /** Every `--custom-property` name found inside string literals (`var(--x)`, `setProperty("--x")`). */
  customPropertyStrings: string[];
  stateSetters: string[];
  angularComponents: AngularComponentRecord[];
  /** Hooks called anywhere in the file (`useState`, `useEffect`, ...). */
  hookCalls: string[];
  /** Free references to browser globals (`window`, `document`, `localStorage`, ...). */
  browserApis: string[];
  /** Number of string literals in the file. */
  stringLiterals: number;
  /** Every comment, for inline suppression lookups. */
  comments: Array<{ text: string; line: number; column: number }>;
}

export interface ParseDiagnostic {
  message: string;
  line: number;
  column: number;
}

export interface ParseResult {
  /** `false` when the file could not be parsed at all; `view` is then absent. */
  ok: boolean;
  /** Recoverable syntax errors Babel reported while still producing an AST. */
  recoverable: ParseDiagnostic[];
  error?: ParseDiagnostic;
  view?: SourceView;
}

export interface ParseOptions {
  path: string;
  language?: SourceLanguage;
  /** Line and column of the first character, for text extracted from a larger file. */
  origin?: Loc;
}

export interface SourceParser {
  parse(source: string, options: ParseOptions): ParseResult;
}

export const languageForPath = (path: string): SourceLanguage => {
  if (/\.tsx$/i.test(path)) return "tsx";
  if (/\.(?:ts|mts|cts)$/i.test(path)) return "ts";
  if (/\.jsx$/i.test(path)) return "jsx";
  return "js";
};
