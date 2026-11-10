// Copy an answer as text or with formatting (0.1.1, O14). The formatted HTML comes from the same
// safe renderer (model text is always escaped), with citations as plain [n] and inline styles only.

/** Plain text to copy: the answer's Markdown source, citations kept as [n]. */
export const copyText = (markdown) => String(markdown ?? "");

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

/** Rich HTML to copy: rendered Markdown without chips, buttons or classes. */
export function copyHtml(markdown, citations, render) {
  let html = render(String(markdown ?? ""), citations ?? [], { chips: false });
  for (const [pattern, replacement] of STYLES) html = html.replace(pattern, replacement);
  return `<div>${html}</div>`;
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

/**
 * What a copy control copies (one shared component for every generated block, O14):
 * `chat:<i>` an answer, `guide` the notebook summary, `questions` its suggested questions,
 * `summary` a source summary, `passage` the passage text plus a plain reference line.
 * `place` formats the passage's location ("Page 3", "Slide 2", "Sheet: Sales").
 */
export function copySourceFor(ref, state) {
  const { chat = [], guide, summary, passage, place } = state;
  if (ref === "guide")
    return guide?.summary
      ? { text: guide.summary, citations: guide.citations ?? [], markdown: true }
      : undefined;
  if (ref === "questions") {
    const questions = (guide?.questions ?? []).filter(Boolean);
    return questions.length
      ? { text: questions.map((q) => `- ${q}`).join("\n"), citations: [], markdown: true }
      : undefined;
  }
  if (ref === "summary")
    return summary?.summary
      ? { text: summary.summary, citations: summary.citations ?? [], markdown: true }
      : undefined;
  if (ref === "passage") {
    if (!passage) return undefined;
    const where = [passage.sourceName, place?.(passage)].filter(Boolean).join(", ");
    return { text: passage.text, reference: where, citations: [], markdown: false };
  }
  const message = chat[Number(String(ref).split(":")[1])];
  return message?.text
    ? { text: message.text, citations: message.citations ?? [], markdown: true }
    : undefined;
}

const escapeText = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/** Plain text and (when `formatted`) rich HTML for a copy source. */
export function copyPayload(source, render, formatted) {
  const text = source.reference
    ? `${copyText(source.text)}\n\n— ${source.reference}`
    : copyText(source.text);
  if (!formatted) return { text };
  if (source.markdown) return { text, html: copyHtml(source.text, source.citations, render) };
  // Source text is not Markdown: quote it as is, with its reference line.
  const quoted = escapeText(source.text).split(/\n/).join("<br>");
  const reference = source.reference ? `<p>— ${escapeText(source.reference)}</p>` : "";
  return {
    text,
    html: `<div><blockquote style="border-left:3px solid #999;margin:0 0 8px;padding-left:10px">${quoted}</blockquote>${reference}</div>`,
  };
}
