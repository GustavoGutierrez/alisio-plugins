import type {
  AtRuleContext,
  CssAtRule,
  CssComment,
  CssDeclaration,
  CssRule,
  CssScan,
  CssScanner,
  CssSyntax,
} from "../../application/ports/css-scanner.js";

interface Frame {
  kind: "root" | "rule" | "at";
  blockId: number;
  selectors: string[];
  chain: string[];
  rule?: CssRule;
  atRule?: CssAtRule;
  context: AtRuleContext[];
}

const MAX_SELECTORS = 64;
const IMPORTANT = /\s*!\s*important\s*$/i;

/** Lexical CSS scanner: tokenises by hand, no dependencies, never throws. */
export function scanCss(source: string, syntax: CssSyntax): CssScan {
  const scan: CssScan = {
    declarations: [],
    rules: [],
    atRules: [],
    comments: [],
    customProperties: [],
    varRefs: [],
    errors: [],
  };
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") lineStarts.push(i + 1);
  const position = (offset: number): { line: number; column: number } => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((lineStarts[mid] as number) <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - (lineStarts[low] as number) + 1 };
  };

  const lineComments = syntax !== "css";
  let index = 0;
  let nextBlock = 1;
  const stack: Frame[] = [{ kind: "root", blockId: 0, selectors: [], chain: [], context: [] }];
  const top = (): Frame => stack[stack.length - 1] as Frame;

  /** Skip whitespace and comments, recording them. */
  const skipTrivia = (): void => {
    for (;;) {
      const char = source[index];
      if (char === undefined) return;
      if (/\s/.test(char)) {
        index += 1;
      } else if (char === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        const stop = end === -1 ? source.length : end;
        if (end === -1) scan.errors.push(`Unterminated comment at ${fmt(index)}`);
        scan.comments.push({ text: source.slice(index + 2, stop), ...position(index) });
        index = end === -1 ? source.length : end + 2;
      } else if (lineComments && char === "/" && source[index + 1] === "/") {
        const end = source.indexOf("\n", index);
        const stop = end === -1 ? source.length : end;
        scan.comments.push({ text: source.slice(index + 2, stop), ...position(index) });
        index = stop;
      } else return;
    }
  };

  const fmt = (offset: number): string => {
    const p = position(offset);
    return `${p.line}:${p.column}`;
  };

  /** Skip a quoted string starting at `index`; returns its raw text. */
  const readString = (): string => {
    const quote = source[index] as string;
    const start = index;
    index += 1;
    while (index < source.length && source[index] !== quote) {
      if (source[index] === "\\") index += 1;
      else if (source[index] === "\n") break;
      index += 1;
    }
    if (source[index] !== quote) scan.errors.push(`Unterminated string at ${fmt(start)}`);
    else index += 1;
    return source.slice(start, index);
  };

  /** Skip `#{...}` (or LESS `@{...}`) interpolation as one opaque unit. */
  const readInterpolation = (): string => {
    const start = index;
    let depth = 0;
    while (index < source.length) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          break;
        }
      }
      index += 1;
    }
    return source.slice(start, index);
  };

  /**
   * Read a statement prelude up to a top-level `{`, `;` or `}` (the terminator is not consumed).
   * Comments are dropped; strings, parentheses and interpolation are kept whole.
   */
  const readPrelude = (): { text: string; terminator: "{" | ";" | "}" | "eof" } => {
    let text = "";
    let parens = 0;
    while (index < source.length) {
      const char = source[index] as string;
      if (char === '"' || char === "'") {
        text += readString();
      } else if (char === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        const stop = end === -1 ? source.length : end;
        if (end === -1) scan.errors.push(`Unterminated comment at ${fmt(index)}`);
        scan.comments.push({ text: source.slice(index + 2, stop), ...position(index) });
        index = end === -1 ? source.length : end + 2;
      } else if (lineComments && parens === 0 && char === "/" && source[index + 1] === "/") {
        const end = source.indexOf("\n", index);
        const stop = end === -1 ? source.length : end;
        scan.comments.push({ text: source.slice(index + 2, stop), ...position(index) });
        index = stop;
      } else if (
        (syntax === "scss" && char === "#" && source[index + 1] === "{") ||
        (syntax === "less" && char === "@" && source[index + 1] === "{")
      ) {
        text += readInterpolation();
      } else if (char === "(") {
        parens += 1;
        text += char;
        index += 1;
      } else if (char === ")") {
        parens = Math.max(0, parens - 1);
        text += char;
        index += 1;
      } else if (parens === 0 && (char === "{" || char === ";" || char === "}")) {
        return { text, terminator: char };
      } else {
        text += char;
        index += 1;
      }
    }
    return { text, terminator: "eof" };
  };

  /** Value of a custom property: balanced braces allowed, ends at `;` or the enclosing `}`. */
  const readCustomValue = (): string => {
    let text = "";
    let depth = 0;
    let parens = 0;
    while (index < source.length) {
      const char = source[index] as string;
      if (char === '"' || char === "'") text += readString();
      else if (char === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        index = end === -1 ? source.length : end + 2;
      } else if (char === "(") {
        parens += 1;
        text += char;
        index += 1;
      } else if (char === ")") {
        parens = Math.max(0, parens - 1);
        text += char;
        index += 1;
      } else if (char === "{") {
        depth += 1;
        text += char;
        index += 1;
      } else if (char === "}") {
        if (depth === 0) break;
        depth -= 1;
        text += char;
        index += 1;
      } else if (char === ";" && depth === 0 && parens === 0) break;
      else {
        text += char;
        index += 1;
      }
    }
    return text.trim();
  };

  const splitSelectors = (header: string): string[] => {
    const parts: string[] = [];
    let current = "";
    let depth = 0;
    for (let i = 0; i < header.length; i += 1) {
      const char = header[i] as string;
      if (char === "(" || char === "[") depth += 1;
      else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
      if (char === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
      } else current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  };

  const resolveSelectors = (header: string, parent: string[]): string[] => {
    const own = splitSelectors(header.replace(/\s+/g, " "));
    if (parent.length === 0) return own.slice(0, MAX_SELECTORS);
    const out: string[] = [];
    for (const base of parent)
      for (const sel of own) {
        out.push(sel.includes("&") ? sel.replace(/&/g, base) : `${base} ${sel}`);
        if (out.length >= MAX_SELECTORS) return out;
      }
    return out;
  };

  const currentContext = (): AtRuleContext[] => top().context;
  const ruleFrame = (): Frame | undefined => {
    for (let i = stack.length - 1; i >= 0; i -= 1)
      if ((stack[i] as Frame).kind === "rule") return stack[i];
    return undefined;
  };
  const inheritedSelectors = (): string[] => ruleFrame()?.selectors ?? [];
  const inheritedChain = (): string[] => ruleFrame()?.chain ?? [];

  const addDeclaration = (
    property: string,
    rawValue: string,
    at: { line: number; column: number },
  ): void => {
    let value = rawValue.trim();
    let important = false;
    if (IMPORTANT.test(value)) {
      important = true;
      value = value.replace(IMPORTANT, "").trim();
    }
    const isCustom = property.startsWith("--");
    const frame = top();
    const rule = ruleFrame();
    const declaration: CssDeclaration = {
      property: /^[A-Za-z-]+$/.test(property) && !isCustom ? property.toLowerCase() : property,
      value,
      important,
      line: at.line,
      column: at.column,
      selector: (rule?.selectors ?? []).join(", "),
      chain: [...(rule?.chain ?? [])],
      atRules: [...currentContext()],
      blockId: frame.blockId,
      isCustomProperty: isCustom,
    };
    scan.declarations.push(declaration);
    if (isCustom) scan.customProperties.push({ ...declaration, name: property });
    if (frame.rule) frame.rule.declarations.push(declaration);
    else if (frame.atRule) frame.atRule.declarations.push(declaration);
    for (const match of value.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g))
      scan.varRefs.push({
        name: match[1] as string,
        hasFallback: match[2] === ",",
        line: at.line,
        column: at.column,
        property: declaration.property,
      });
  };

  const handleStatement = (text: string, start: number): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const at = position(start);
    if (trimmed.startsWith("@")) {
      const variable = /^(@[\w-]+)\s*:\s*([\s\S]*)$/.exec(trimmed);
      if (variable && syntax !== "css") {
        addDeclaration(variable[1] as string, variable[2] as string, at);
        return;
      }
      const match = /^@([\w-]+)\s*([\s\S]*)$/.exec(trimmed);
      if (match) {
        scan.atRules.push({
          name: (match[1] as string).toLowerCase(),
          prelude: (match[2] as string).trim(),
          ...at,
          hasBlock: false,
          declarations: [],
          atRules: [...currentContext()],
        });
      }
      return;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) return;
    const property = trimmed.slice(0, colon).trim();
    if (/\s/.test(property) && !property.includes("#{")) return;
    addDeclaration(property, trimmed.slice(colon + 1), at);
  };

  while (index < source.length) {
    skipTrivia();
    if (index >= source.length) break;
    const start = index;
    if (source[index] === "}") {
      index += 1;
      if (stack.length === 1) scan.errors.push(`Unmatched } at ${fmt(start)}`);
      else stack.pop();
      continue;
    }
    if (source[index] === ";") {
      index += 1;
      continue;
    }
    if (source.startsWith("--", index)) {
      const colon = source.indexOf(":", index);
      const brace = source.indexOf("{", index);
      if (colon !== -1 && (brace === -1 || colon < brace)) {
        const property = source.slice(index, colon).trim();
        if (/^--[\w-]+$/.test(property)) {
          index = colon + 1;
          const value = readCustomValue();
          addDeclaration(property, value, position(start));
          if (source[index] === ";") index += 1;
          continue;
        }
      }
    }
    const { text, terminator } = readPrelude();
    if (terminator === "{") {
      index += 1;
      const header = text.trim();
      const frame = top();
      const blockId = nextBlock;
      nextBlock += 1;
      const at = position(start);
      if (header.startsWith("@")) {
        const match = /^@([\w-]+)\s*([\s\S]*)$/.exec(header);
        const name = (match?.[1] ?? header.slice(1)).toLowerCase();
        const prelude = (match?.[2] ?? "").trim().replace(/\s+/g, " ");
        const atRule: CssAtRule = {
          name,
          prelude,
          ...at,
          hasBlock: true,
          blockId,
          declarations: [],
          atRules: [...currentContext()],
        };
        scan.atRules.push(atRule);
        stack.push({
          kind: "at",
          blockId,
          selectors: frame.selectors,
          chain: frame.chain,
          atRule,
          context: [...frame.context, { name, prelude }],
        });
      } else {
        const selectors = resolveSelectors(header, inheritedSelectors());
        const chain = [...inheritedChain(), header.replace(/\s+/g, " ")];
        const rule: CssRule = {
          selectors,
          chain,
          ...at,
          blockId,
          atRules: [...currentContext()],
          declarations: [],
        };
        scan.rules.push(rule);
        stack.push({ kind: "rule", blockId, selectors, chain, rule, context: frame.context });
      }
    } else {
      handleStatement(text, start);
      if (terminator === ";") index += 1;
      if (terminator === "eof") break;
    }
  }
  if (stack.length > 1)
    scan.errors.push(`Unterminated block: ${stack.length - 1} block(s) not closed`);
  return scan;
}

export const lexicalCssScanner: CssScanner = { scan: scanCss };

export type { CssComment };
