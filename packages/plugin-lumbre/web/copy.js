// Copy generated text as plain Markdown or with formatting. The formatted HTML comes from the same
// safe renderer (model text is always escaped) with inline styles only.

const STYLES = [
  [/<table>/g, '<table style="border-collapse:collapse">'],
  [/<th>/g, '<th style="border:1px solid #999;padding:4px 8px;text-align:left">'],
  [/<td>/g, '<td style="border:1px solid #999;padding:4px 8px">'],
  [/<pre>/g, '<pre style="background:#f4f4f4;padding:8px;white-space:pre-wrap">'],
  [
    /<blockquote>/g,
    '<blockquote style="border-left:3px solid #999;margin:0 0 8px;padding-left:10px">',
  ],
  [/ class="table-wrap"/g, ""],
];

/** Plain text and, when `formatted`, rich HTML for one block of generated Markdown or code. */
export function copyPayload(markdown, render, formatted) {
  const text = String(markdown ?? "");
  if (!formatted) return { text };
  let html = render(text);
  for (const [pattern, replacement] of STYLES) html = html.replace(pattern, replacement);
  return { text, html: `<div>${html}</div>` };
}

/**
 * Tries the async Clipboard API, then a `copy` event fired by `execCommand` on a hidden
 * selection (sandboxed frames often lack the clipboard permission). Returns the path that worked:
 * "clipboard", "execCommand", or "manual" when the caller must show the content to copy by hand.
 */
export async function writeClipboard({ text, html }, env = globalThis) {
  const nav = env.navigator;
  try {
    if (html && nav?.clipboard?.write && typeof env.ClipboardItem === "function") {
      await nav.clipboard.write([
        new env.ClipboardItem({
          "text/html": new env.Blob([html], { type: "text/html" }),
          "text/plain": new env.Blob([text], { type: "text/plain" }),
        }),
      ]);
      return "clipboard";
    }
    if (!html && nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return "clipboard";
    }
  } catch {
    // Permission denied in the sandbox: fall back below.
  }
  const doc = env.document;
  try {
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    doc.body.append(area);
    area.select();
    let filled = false;
    const onCopy = (event) => {
      event.clipboardData?.setData("text/plain", text);
      if (html) event.clipboardData?.setData("text/html", html);
      if (event.clipboardData) {
        event.preventDefault();
        filled = true;
      }
    };
    doc.addEventListener("copy", onCopy);
    let ok = false;
    try {
      ok = !!doc.execCommand?.("copy");
    } finally {
      doc.removeEventListener("copy", onCopy);
      area.remove();
    }
    if (ok && (filled || !html)) return "execCommand";
  } catch {
    // execCommand is unavailable: manual copy.
  }
  return "manual";
}
