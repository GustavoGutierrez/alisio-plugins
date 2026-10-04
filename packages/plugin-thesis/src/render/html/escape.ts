/**
 * HTML escaping. Every piece of document text reaches the HTML through these functions, so
 * Markdown content can never become markup or script (spec 12).
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a text node or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(control, "").replace(/[&<>"']/g, (char) => entities[char] as string);
}

/** A URL that is safe in `href`: web links, mail links and in-page anchors only. */
export function safeHref(href: string): string | undefined {
  const value = href.trim();
  if (/^(https?:\/\/|mailto:|#)/i.test(value)) return value;
  return undefined;
}

/** JSON for an inline `<script type="application/json">`: `<` and line separators are escaped. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/[\u2028]/g, "\\u2028")
    .replace(/[\u2029]/g, "\\u2029");
}
