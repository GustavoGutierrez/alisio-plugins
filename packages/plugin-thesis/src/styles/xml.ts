/**
 * Minimal, non-entity-expanding XML reader for CSL files (spec 10.4.1). It exists so that no style
 * from the workspace ever reaches an XML parser that could resolve entities or external subsets:
 * any DOCTYPE or ENTITY declaration is rejected before anything is parsed, and only the five
 * predefined entities and numeric character references are accepted in text and attributes.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated direct text, trimmed. */
  text: string;
}

export class XmlError extends Error {}

const maxBytes = 2 * 1024 * 1024;
const maxDepth = 64;
const maxNodes = 200_000;
const nameStart = /[A-Za-z_:]/;
const nameChar = /[A-Za-z0-9_:.-]/;

const predefined: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[A-Za-z]+);/g, (_match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#")) {
      const code = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number(body.slice(1));
      if (
        !Number.isInteger(code) ||
        (code < 0x20 && code !== 9 && code !== 10 && code !== 13) ||
        code > 0x10ffff
      )
        throw new XmlError(`Invalid character reference &${body};`);
      return String.fromCodePoint(code);
    }
    const value = predefined[body];
    if (value === undefined) throw new XmlError(`Entity &${body}; is not allowed`);
    return value;
  });
}

/** Parse a document; throws XmlError for DOCTYPE, entities, malformed markup or oversize input. */
export function parseXml(source: string): XmlElement {
  if (Buffer.byteLength(source) > maxBytes) throw new XmlError("The XML file is larger than 2 MB");
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new XmlError(
      "A DOCTYPE or ENTITY declaration is not allowed (entity expansion is disabled)",
    );
  }
  if (source.includes("\0")) throw new XmlError("The XML file contains a NUL character");
  let pos = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nodes = 0;

  const fail = (message: string): never => {
    const line = source.slice(0, pos).split("\n").length;
    throw new XmlError(`${message} (line ${line})`);
  };
  const skipSpace = () => {
    while (pos < source.length && /\s/.test(source[pos] as string)) pos += 1;
  };
  const readName = (): string => {
    const start = pos;
    if (!nameStart.test(source[pos] ?? "")) fail("Expected a name");
    while (pos < source.length && nameChar.test(source[pos] as string)) pos += 1;
    return source.slice(start, pos);
  };
  /** Skip comments and processing instructions; true when something was skipped. */
  const skipMisc = (): boolean => {
    if (source.startsWith("<!--", pos)) {
      const end = source.indexOf("-->", pos + 4);
      if (end === -1) fail("Unterminated comment");
      pos = end + 3;
      return true;
    }
    if (source.startsWith("<?", pos)) {
      const end = source.indexOf("?>", pos + 2);
      if (end === -1) fail("Unterminated processing instruction");
      pos = end + 2;
      return true;
    }
    return false;
  };

  const element = (depth: number): XmlElement => {
    if (depth > maxDepth) fail("The XML nesting is too deep");
    nodes += 1;
    if (nodes > maxNodes) fail("The XML file has too many elements");
    pos += 1; // <
    const name = readName();
    const attrs: Record<string, string> = {};
    for (;;) {
      skipSpace();
      const current = source[pos];
      if (current === "/" || current === ">") break;
      const attribute = readName();
      skipSpace();
      if (source[pos] !== "=") fail(`Attribute ${attribute} has no value`);
      pos += 1;
      skipSpace();
      const quote = source[pos];
      if (quote !== '"' && quote !== "'") fail(`Attribute ${attribute} must be quoted`);
      const end = source.indexOf(quote as string, pos + 1);
      if (end === -1) fail("Unterminated attribute value");
      const raw = source.slice(pos + 1, end);
      if (raw.includes("<")) fail(`Attribute ${attribute} contains <`);
      if (attribute in attrs) fail(`Duplicate attribute ${attribute}`);
      attrs[attribute] = decode(raw);
      pos = end + 1;
    }
    const node: XmlElement = { name, attrs, children: [], text: "" };
    if (source[pos] === "/") {
      if (source[pos + 1] !== ">") fail("Malformed empty element");
      pos += 2;
      return node;
    }
    pos += 1; // >
    let text = "";
    for (;;) {
      const next = source.indexOf("<", pos);
      if (next === -1) fail(`Element <${name}> is not closed`);
      text += decode(source.slice(pos, next));
      pos = next;
      if (skipMisc()) continue;
      if (source.startsWith("<![CDATA[", pos)) {
        const end = source.indexOf("]]>", pos);
        if (end === -1) fail("Unterminated CDATA section");
        text += source.slice(pos + 9, end);
        pos = end + 3;
        continue;
      }
      if (source.startsWith("</", pos)) {
        pos += 2;
        const closing = readName();
        skipSpace();
        if (source[pos] !== ">") fail("Malformed closing tag");
        pos += 1;
        if (closing !== name) fail(`Closing tag </${closing}> does not match <${name}>`);
        node.text = text.trim();
        return node;
      }
      node.children.push(element(depth + 1));
    }
  };

  skipSpace();
  while (skipMisc()) skipSpace();
  if (source[pos] !== "<") fail("The document has no root element");
  const root = element(1);
  skipSpace();
  while (skipMisc()) skipSpace();
  if (pos < source.length) fail("Unexpected content after the root element");
  return root;
}

export const child = (node: XmlElement, name: string): XmlElement | undefined =>
  node.children.find((entry) => entry.name === name);
export const childrenNamed = (node: XmlElement, name: string): XmlElement[] =>
  node.children.filter((entry) => entry.name === name);

/** Depth-first visit of every element. */
export function walkXml(node: XmlElement, visit: (node: XmlElement) => void): void {
  visit(node);
  for (const entry of node.children) walkXml(entry, visit);
}
