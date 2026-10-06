import type {
  TemplateAttribute,
  TemplateBlock,
  TemplateComment,
  TemplateElement,
  TemplateKind,
  TemplateScan,
  TemplateScanner,
} from "../../application/ports/template-scanner.js";
import { positionIndex } from "./positions.js";

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const ANGULAR_BLOCKS = [
  "else if",
  "if",
  "else",
  "for",
  "switch",
  "case",
  "default",
  "defer",
  "placeholder",
  "loading",
  "error",
  "empty",
  "let",
];
const DYNAMIC_PREFIX =
  /^(?::|@|#|v-|\[|\(|\*|on:|bind:|use:|class:|style:|let:|transition:|in:|out:|animate:|\{)/;

/** Read a balanced `{...}` region starting at `start`; strings and template literals are opaque. */
function balancedBraces(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === '"' || char === "'" || char === "`") {
      index += 1;
      while (index < source.length && source[index] !== char)
        index += source[index] === "\\" ? 2 : 1;
    } else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return -1;
}

export function scanTemplate(source: string, kind: TemplateKind): TemplateScan {
  const elements: TemplateElement[] = [];
  const blocks: TemplateBlock[] = [];
  const comments: TemplateComment[] = [];
  const errors: string[] = [];
  const position = positionIndex(source);
  const where = (offset: number): string => {
    const p = position(offset);
    return `${p.line}:${p.column}`;
  };
  const braceKinds = kind === "svelte" || kind === "astro";
  const stack: number[] = [];
  const textOf = new Map<number, string[]>();
  let index = 0;

  const markText = (text: string): void => {
    const owner = stack[stack.length - 1];
    if (owner === undefined) return;
    const element = elements[owner] as TemplateElement;
    element.hasText = true;
    const parts = textOf.get(owner) ?? [];
    if (text) parts.push(text);
    textOf.set(owner, parts);
  };

  const isTagStart = (at: number): boolean => {
    const next = source[at + 1];
    return source[at] === "<" && next !== undefined && /[A-Za-z/!?]/.test(next);
  };

  const readAttributes = (): {
    attrs: TemplateAttribute[];
    selfClosing: boolean;
    closed: boolean;
  } => {
    const attrs: TemplateAttribute[] = [];
    for (;;) {
      while (index < source.length && /\s/.test(source[index] as string)) index += 1;
      if (index >= source.length) return { attrs, selfClosing: false, closed: false };
      if (source[index] === ">") {
        index += 1;
        return { attrs, selfClosing: false, closed: true };
      }
      if (source[index] === "/" && source[index + 1] === ">") {
        index += 2;
        return { attrs, selfClosing: true, closed: true };
      }
      if (source[index] === "/") {
        index += 1;
        continue;
      }
      const start = index;
      let name = "";
      if (braceKinds && source[index] === "{") {
        const end = balancedBraces(source, index);
        if (end === -1) return { attrs, selfClosing: false, closed: false };
        name = source.slice(index, end);
        index = end;
      } else {
        while (index < source.length) {
          const char = source[index] as string;
          if (
            /\s/.test(char) ||
            char === "=" ||
            char === ">" ||
            (char === "/" && source[index + 1] === ">")
          )
            break;
          index += 1;
        }
        name = source.slice(start, index);
      }
      const at = position(start);
      let probe = index;
      while (probe < source.length && /\s/.test(source[probe] as string)) probe += 1;
      const attr: TemplateAttribute = {
        name,
        hasValue: false,
        quote: "",
        dynamic: DYNAMIC_PREFIX.test(name),
        ...at,
      };
      if (source[probe] === "=") {
        probe += 1;
        while (probe < source.length && /\s/.test(source[probe] as string)) probe += 1;
        const opener = source[probe];
        if (opener === '"' || opener === "'") {
          const end = source.indexOf(opener, probe + 1);
          if (end === -1) return { attrs, selfClosing: false, closed: false };
          attr.value = source.slice(probe + 1, end);
          attr.quote = opener;
          index = end + 1;
        } else if (braceKinds && opener === "{") {
          const end = balancedBraces(source, probe);
          if (end === -1) return { attrs, selfClosing: false, closed: false };
          attr.value = source.slice(probe + 1, end - 1);
          attr.quote = "{";
          attr.dynamic = true;
          index = end;
        } else {
          let end = probe;
          while (end < source.length && !/[\s>]/.test(source[end] as string)) end += 1;
          attr.value = source.slice(probe, end);
          index = end;
        }
        attr.hasValue = true;
      }
      attrs.push(attr);
    }
  };

  while (index < source.length) {
    const char = source[index] as string;
    if (char === "<" && source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      const stop = end === -1 ? source.length : end;
      if (end === -1) errors.push(`Unterminated comment at ${where(index)}`);
      comments.push({ text: source.slice(index + 4, stop), ...position(index) });
      index = end === -1 ? source.length : end + 3;
    } else if (char === "<" && (source[index + 1] === "!" || source[index + 1] === "?")) {
      const end = source.indexOf(">", index);
      index = end === -1 ? source.length : end + 1;
    } else if (
      char === "<" &&
      source[index + 1] === "/" &&
      /[A-Za-z]/.test(source[index + 2] ?? "")
    ) {
      const end = source.indexOf(">", index);
      const name = source.slice(index + 2, end === -1 ? source.length : end).trim();
      let depth = stack.length - 1;
      while (
        depth >= 0 &&
        (elements[stack[depth] as number] as TemplateElement).tag.toLowerCase() !==
          name.toLowerCase()
      )
        depth -= 1;
      if (depth < 0) errors.push(`Unmatched closing tag </${name}> at ${where(index)}`);
      else stack.length = depth;
      index = end === -1 ? source.length : end + 1;
    } else if (char === "<" && /[A-Za-z]/.test(source[index + 1] ?? "")) {
      const start = index;
      index += 1;
      let tag = "";
      while (index < source.length && !/[\s/>]/.test(source[index] as string)) {
        tag += source[index];
        index += 1;
      }
      const { attrs, selfClosing, closed } = readAttributes();
      if (!closed) {
        errors.push(`Unterminated tag <${tag} at ${where(start)}`);
        break;
      }
      const parent = stack[stack.length - 1] ?? -1;
      const element: TemplateElement = {
        index: elements.length,
        tag,
        attrs,
        selfClosing,
        parent,
        childElements: [],
        hasText: false,
        text: "",
        ...position(start),
      };
      elements.push(element);
      if (parent >= 0) (elements[parent] as TemplateElement).childElements.push(element.index);
      const lower = tag.toLowerCase();
      if (!selfClosing && RAW_TEXT.has(lower) && kind !== "angular") {
        const close = new RegExp(`</${lower}\\s*>`, "i").exec(source.slice(index));
        if (!close) {
          errors.push(`Unterminated <${tag}> at ${where(start)}`);
          index = source.length;
        } else {
          const raw = source.slice(index, index + close.index);
          if (lower === "textarea" || lower === "title") {
            element.hasText = raw.trim().length > 0;
            element.text = raw.trim().replace(/\s+/g, " ").slice(0, 500);
          }
          index += close.index + close[0].length;
        }
      } else if (!selfClosing && !VOID.has(lower)) stack.push(element.index);
    } else if (braceKinds && char === "{") {
      const end = balancedBraces(source, index);
      if (end === -1) {
        errors.push(`Unterminated { at ${where(index)}`);
        index = source.length;
        continue;
      }
      const inner = source.slice(index + 1, end - 1);
      if (kind === "svelte") {
        const block = /^([#:/@])\s*([\w]+(?: if)?)\s*([\s\S]*)$/.exec(inner.trim());
        if (block) {
          const blockKind = `${block[1]}${block[2]}`;
          blocks.push({
            kind: blockKind,
            expression: (block[3] as string).trim(),
            ...position(index),
          });
          if (blockKind === "@html") markText("");
        } else markText(inner.trim());
      } else markText("");
      index = end;
    } else if (
      (kind === "vue-sfc" || kind === "angular") &&
      char === "{" &&
      source[index + 1] === "{"
    ) {
      const end = source.indexOf("}}", index + 2);
      markText("");
      index = end === -1 ? source.length : end + 2;
    } else if (
      kind === "angular" &&
      char === "@" &&
      (index === 0 || /[\s}]/.test(source[index - 1] as string))
    ) {
      const keyword = ANGULAR_BLOCKS.find((word) =>
        new RegExp(`^@${word}(?![\\w-])`).test(source.slice(index, index + 20)),
      );
      if (keyword) {
        const start = index;
        index += 1 + keyword.length;
        let probe = index;
        while (probe < source.length && /\s/.test(source[probe] as string)) probe += 1;
        let expression = "";
        if (source[probe] === "(") {
          let depth = 0;
          let end = probe;
          while (end < source.length) {
            if (source[end] === "(") depth += 1;
            else if (source[end] === ")") {
              depth -= 1;
              if (depth === 0) break;
            }
            end += 1;
          }
          expression = source.slice(probe + 1, end);
          index = end + 1;
        } else if (keyword === "let") {
          const end = source.indexOf(";", index);
          expression = source.slice(index, end === -1 ? source.length : end).trim();
          index = end === -1 ? source.length : end + 1;
        }
        blocks.push({ kind: `@${keyword}`, expression: expression.trim(), ...position(start) });
      } else {
        markText("@");
        index += 1;
      }
    } else {
      let end = index + 1;
      while (end < source.length) {
        const next = source[end] as string;
        if (next === "<" && isTagStart(end)) break;
        if (braceKinds && next === "{") break;
        if (next === "{" && source[end + 1] === "{" && (kind === "vue-sfc" || kind === "angular"))
          break;
        if (kind === "angular" && next === "@" && /[\s}]/.test(source[end - 1] as string)) break;
        end += 1;
      }
      const text = source.slice(index, end);
      if (text.trim()) markText(text.trim().replace(/\s+/g, " "));
      index = end;
    }
  }
  for (const [owner, parts] of textOf)
    (elements[owner] as TemplateElement).text = parts.join(" ").slice(0, 500);
  if (stack.length > 0 && errors.length === 0)
    for (const open of stack) errors.push(`Unclosed <${(elements[open] as TemplateElement).tag}>`);
  return { elements, blocks, comments, errors };
}

export const lexicalTemplateScanner: TemplateScanner = { scan: scanTemplate };
