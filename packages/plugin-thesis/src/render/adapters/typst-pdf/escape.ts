/**
 * Typst escaping. Every piece of document text reaches Typst through one of these two functions,
 * so Markdown content can never become Typst code (spec 12: the emitter never emits raw Typst from
 * Markdown).
 */

// Characters that carry meaning in Typst markup anywhere in a text run. `/` is escaped everywhere
// so `//` and `/*` can never open a comment (a URL in prose would otherwise comment out the line).
const markupSpecials = /[\\#$*_`<>@[\]{}~/=]/g;

/** Escape a text node for Typst markup (content mode). */
export function escapeText(text: string): string {
  let out = stripControl(text).replace(markupSpecials, (char) => `\\${char}`);
  // A text node may start a markup line: list markers and numbered-list starts must stay literal.
  out = out.replace(/^([-+])/, "\\$1").replace(/^(\d+)\./, "$1\\.");
  return out;
}

/** A Typst string literal ("...") for arbitrary text. */
export function typstString(text: string): string {
  let out = '"';
  for (const char of stripControl(text, true)) {
    switch (char) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += char;
    }
  }
  return `${out}"`;
}

/** Remove control characters; newlines and tabs survive only when asked (string literals). */
export function stripControl(text: string, keepWhitespace = false): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    const control = code < 0x20 || code === 0x7f;
    if (!control || (keepWhitespace && (code === 0x09 || code === 0x0a))) out += char;
  }
  return out;
}

/** A Typst label reference such as `<fig-x>`; labels are already validated by the dialect. */
export function typstLabel(label: string): string {
  if (!/^[A-Za-z0-9_:.-]+$/.test(label)) throw new Error(`Invalid label: ${label}`);
  return `<${label}>`;
}
