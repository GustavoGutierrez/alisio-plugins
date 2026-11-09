// Pure, client-side derivations for the studio UI. They only read data the host already returned
// (document summaries, documents, jobs), so every number the UI shows is computed, never invented.

/** Remove LaTeX comments (an unescaped `%` to the end of the line). */
function stripComments(tex) {
  return String(tex ?? "").replace(/(^|[^\\])%.*$/gm, "$1");
}

const DISPLAY_MATH = /\\begin\{(?:equation|align|gather|multline|eqnarray|flalign|alignat)\*?\}/g;
const FIGURE_BLOCK = /\\begin\{figure\*?\}[\s\S]*?\\end\{figure\*?\}/g;
const BIB_ENTRY = /@(\w+)\s*[{(]/g;

/** Count display equations, figures and bibliography entries of a LaTeX source. */
export function texStats(tex, bib) {
  const source = stripComments(tex);
  const environments = source.match(DISPLAY_MATH)?.length ?? 0;
  const brackets = source.match(/\\\[/g)?.length ?? 0;
  const dollars = Math.floor((source.match(/\$\$/g)?.length ?? 0) / 2);
  const figureBlocks = source.match(FIGURE_BLOCK) ?? [];
  const looseGraphics = source.replace(FIGURE_BLOCK, "").match(/\\includegraphics\b/g)?.length ?? 0;
  const references = [...String(bib ?? "").matchAll(BIB_ENTRY)].filter(
    (m) => !["comment", "string", "preamble"].includes(m[1].toLowerCase()),
  ).length;
  return {
    equations: environments + brackets + dollars,
    figures: figureBlocks.length + looseGraphics,
    references,
  };
}

const HEADING = /\\(?:sub)?section\*?\{([^}]+)\}/g;

/** Section and subsection headings, in source order. */
export function sectionsOf(tex) {
  return [...String(tex ?? "").matchAll(HEADING)].map((m) => m[1]);
}

/** Split a source into heading-keyed chunks; repeated headings get an occurrence suffix. */
function chunks(tex) {
  const source = String(tex ?? "");
  const result = new Map();
  const seen = new Map();
  const matches = [...source.matchAll(HEADING)];
  matches.forEach((m, i) => {
    const n = (seen.get(m[1]) ?? 0) + 1;
    seen.set(m[1], n);
    const end = matches[i + 1]?.index ?? source.length;
    const body = source
      .slice(m.index + m[0].length, end)
      .replace(/\s+/g, " ")
      .trim();
    result.set(n > 1 ? `${m[1]}#${n}` : m[1], { name: m[1], body });
  });
  return result;
}

/** Headings added, removed or rewritten between two sources (the preamble is not a section). */
export function changedSections(before, after) {
  const a = chunks(before);
  const b = chunks(after);
  const names = [];
  for (const [key, chunk] of b) if (a.get(key)?.body !== chunk.body) names.push(chunk.name);
  for (const [key, chunk] of a) if (!b.has(key)) names.push(chunk.name);
  return { count: names.length, names: [...new Set(names)] };
}

/** One-line bullets from a proposal summary (newline or bullet separated), at most `max`. */
export function summaryLines(summary, max = 6) {
  return String(summary ?? "")
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Library status of a document summary: `review` while a job runs or a proposal waits, `ready`
 * once a PDF exists, otherwise `draft`.
 */
export function listStatus(summary, jobs = []) {
  const running = jobs.some((j) => j.documentId === summary.id && j.status === "running");
  if (running || summary.proposals > 0) return "review";
  return summary.hasPdf ? "ready" : "draft";
}

/** Library filters: `all` and `progress`/`ready` hide archived documents; `archived` shows only those. */
export function matchesFilter(summary, status, filter) {
  if (filter === "archived") return summary.archived === true;
  if (summary.archived) return false;
  if (filter === "progress") return status !== "ready";
  if (filter === "ready") return status === "ready";
  return true;
}

/** "today, 11:24", "yesterday, 09:02" or a localized date, using the supplied words. */
export function formatModified(iso, locale, words, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86400000);
  if (diff === 0) return `${words.today}, ${time}`;
  if (diff === 1) return `${words.yesterday}, ${time}`;
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

/** Decoded size of a base64 payload. */
export function base64Bytes(base64) {
  const value = String(base64 ?? "");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

export function formatBytes(bytes, locale = "en") {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(locale, { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

/** Thumbnail kind of an attachment, from its name and MIME type. */
export function assetKind(asset) {
  const name = String(asset?.name ?? "").toLowerCase();
  if (String(asset?.mime ?? "").startsWith("image/")) return "image";
  if (name.endsWith(".csv")) return "table";
  if (name.endsWith(".bib") || name.endsWith(".json")) return "code";
  if (name.endsWith(".pdf")) return "pdf";
  return "text";
}

/**
 * Honest progress stages of a draft job, tied only to its real status: the request is sent, the
 * agent works while `running`, and the proposal is ready once it `succeeded`.
 */
export function jobStages(job) {
  const ended = job.status !== "running";
  const ok = job.status === "succeeded";
  return [
    { key: "stageSent", state: "done" },
    { key: "stageWriting", state: ended ? (ok ? "done" : "failed") : "active" },
    { key: "stageReady", state: ok ? "done" : "pending" },
  ];
}

/** 1-based version of the revision the current PDF was built from, or null. */
export function pdfVersion(doc) {
  if (!doc?.pdf) return null;
  const index = doc.revisions.findIndex((r) => r.id === doc.pdf.revision);
  return index < 0 ? null : index + 1;
}

/** Zoom levels of the PDF preview; `fit` scales the page to the panel width. */
export const ZOOM_STEPS = [0.5, 0.75, 0.85, 1, 1.25, 1.5, 2];

/** Next zoom step from `current` (a number, or the fitted scale when the preview fits). */
export function stepZoom(current, direction) {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS.at(-1);
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0];
}
