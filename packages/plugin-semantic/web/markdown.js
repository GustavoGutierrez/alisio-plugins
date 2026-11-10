// Small, safe Markdown renderer for answers (0.1.1). Every piece of model text is HTML-escaped
// before any formatting is applied, so the only tags in the output are the ones built here.
// Supports paragraphs, line breaks, # to ### headings, bold, italic, inline code, fenced code,
// nested ordered/unordered lists, blockquotes, simple GFM tables and horizontal rules. Links are
// shown as plain text (the frame cannot navigate). `[n]` citations that match `citations` become
// chips; other numbers stay text.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

function chip(citation) {
  const label = `${citation.n}: ${citation.sourceName ?? ""}`;
  return `<button type="button" class="cite" data-action="cite" data-source="${escapeHtml(citation.sourceId)}" data-ordinal="${escapeHtml(citation.ordinal)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(citation.sourceName ?? "")}">${escapeHtml(citation.n)}</button>`;
}

/**
 * Inline formatting of one line of raw text. `options.chips === false` keeps citations as plain
 * `[n]` text (copied HTML must not contain buttons).
 */
export function renderInline(raw, citations = [], options = {}) {
  const byNumber = new Map(citations.map((c) => [Number(c.n), c]));
  const slots = [];
  const hold = (html) => `\uE000${slots.push(html) - 1}\uE000`;
  let s = escapeHtml(String(raw ?? "").replace(/\uE000/g, ""));
  // Code spans first: nothing inside them is formatted.
  s = s.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${code}</code>`));
  // Links become their text plus the address, as plain text.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) =>
    text === url ? text : `${text} (${url})`,
  );
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?![\w])/g, "$1<em>$2</em>");
  s = s.replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g, (match, list) => {
    const numbers = list.split(",").map((n) => Number(n.trim()));
    if (!numbers.every((n) => byNumber.has(n))) return match;
    if (options.chips === false) return `[${numbers.join(", ")}]`;
    return numbers.map((n) => hold(chip(byNumber.get(n)))).join("");
  });
  return s.replace(/\uE000(\d+)\uE000/g, (_, i) => slots[Number(i)]);
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,3})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const isTableRow = (line) => line.includes("|");
const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
const indentOf = (s) => s.replace(/\t/g, "    ").length;

function renderList(lines, citations, options) {
  // Builds nested lists from indentation: deeper markers open a child list in the last item.
  const root = { indent: -1, items: [] };
  const stack = [];
  for (const line of lines) {
    const m = LIST.exec(line);
    if (!m) {
      const top = stack.at(-1);
      const item = top?.list.items.at(-1);
      if (item) item.text += `\n${line.trim()}`;
      continue;
    }
    const indent = indentOf(m[1]);
    const ordered = /\d/.test(m[2]);
    while (stack.length && indent < stack.at(-1).indent) stack.pop();
    let top = stack.at(-1);
    if (!top || indent > top.indent) {
      const parentItem = top?.list.items.at(-1);
      const list = { ordered, items: [] };
      if (parentItem) parentItem.children.push(list);
      else root.items.push(list);
      top = { indent, list };
      stack.push(top);
    }
    top.list.items.push({ text: m[3], children: [] });
  }
  const html = (list) =>
    `<${list.ordered ? "ol" : "ul"}>${list.items
      .map(
        (item) =>
          `<li>${item.text
            .split("\n")
            .map((t) => renderInline(t, citations, options))
            .join("<br>")}${item.children.map(html).join("")}</li>`,
      )
      .join("")}</${list.ordered ? "ol" : "ul"}>`;
  return root.items.map(html).join("");
}

function renderTable(rows, citations, options) {
  const [head, , ...body] = rows.map(cells);
  const th = (head ?? []).map((c) => `<th>${renderInline(c, citations, options)}</th>`).join("");
  const tr = body
    .map(
      (r) => `<tr>${r.map((c) => `<td>${renderInline(c, citations, options)}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
}

/** Block-level rendering; returns HTML built only from escaped text and fixed tags. */
export function renderMarkdown(text, citations = [], options = {}) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length + 2; // # -> h3: answers live inside the chat
      out.push(`<h${level}>${renderInline(heading[2], citations, options)}</h${level}>`);
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])[1]);
      out.push(`<blockquote>${renderMarkdown(inner.join("\n"), citations, options)}</blockquote>`);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && lines[i].trim() && isTableRow(lines[i])) rows.push(lines[i++]);
      out.push(renderTable(rows, citations, options));
      continue;
    }
    if (LIST.test(line)) {
      const block = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        (LIST.test(lines[i]) || /^\s+\S/.test(lines[i]))
      )
        block.push(lines[i++]);
      out.push(renderList(block, citations, options));
      continue;
    }
    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !FENCE.test(lines[i]) &&
      !HEADING.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !LIST.test(lines[i]) &&
      !RULE.test(lines[i])
    )
      paragraph.push(lines[i++]);
    out.push(`<p>${paragraph.map((l) => renderInline(l, citations, options)).join("<br>")}</p>`);
  }
  return out.join("");
}
