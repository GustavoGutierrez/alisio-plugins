// Pure view logic of the Notebook frame (no DOM), unit-tested in test/ui.test.ts.

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const POLL_MS = 750;

/** Megabytes with one decimal under 10 MB, whole numbers above (decimal MB, like the notice). */
export function formatMb(bytes) {
  const mb = (bytes || 0) / 1_000_000;
  return mb < 10 ? mb.toFixed(1) : String(Math.round(mb));
}

/** Splits an answer into text and `[n]` citation chips; unknown numbers stay plain text. */
export function citationParts(text, citations = []) {
  const byNumber = new Map(citations.map((c) => [c.n, c]));
  const parts = [];
  let last = 0;
  for (const match of String(text ?? "").matchAll(/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g)) {
    const numbers = match[1].split(",").map((n) => Number(n.trim()));
    if (!numbers.every((n) => byNumber.has(n))) continue;
    if (match.index > last) parts.push({ type: "text", text: text.slice(last, match.index) });
    for (const n of numbers) parts.push({ type: "cite", n, citation: byNumber.get(n) });
    last = match.index + match[0].length;
  }
  if (last < String(text ?? "").length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

/** What a polled job means for the UI. */
export function jobView(job) {
  const state = job?.state ?? "queued";
  return {
    running: state === "queued" || state === "running",
    done: state === "done",
    failed: state === "failed",
    cancelled: state === "cancelled",
    percent: Math.round(Math.max(0, Math.min(1, job?.progress ?? 0)) * 100),
    error: state === "failed" || state === "cancelled" ? job?.error || "operation_failed" : null,
  };
}

/** Status line of a source row: indexing with a percentage, ready, keyword only, or failed. */
export function sourceStatus(source, job) {
  if (source.status === "indexing") return { key: "indexing", percent: jobView(job).percent };
  if (source.status === "ready") return { key: "ready" };
  if (source.status === "ready_keyword") return { key: "keyword", error: source.error ?? null };
  return { key: "failed", error: source.error || "operation_failed" };
}

/** The remote-model notice (D14) is shown once per notebook, until it is acknowledged. */
export const needsRemoteNotice = (notebook) => !!notebook && !notebook.remoteNoticeAck;

/** True when some source lost its vectors because the search model changed (D6). */
export const needsRebuild = (sources = []) => sources.some((s) => s.error === "model_mismatch");

/** Source ids to restrict a question to, or undefined when every usable source is ticked. */
export function scopeIds(sources, checked) {
  const usable = sources.filter((s) => s.status === "ready" || s.status === "ready_keyword");
  const ticked = usable.filter((s) => checked.has(s.id));
  if (ticked.length === usable.length) return undefined;
  return ticked.map((s) => s.id);
}

/** Select-all checkbox state: all, none or some ("mixed"). */
export function selectAllState(sources, checked) {
  const usable = sources.filter((s) => s.status === "ready" || s.status === "ready_keyword");
  const ticked = usable.filter((s) => checked.has(s.id)).length;
  if (usable.length === 0 || ticked === 0) return "none";
  return ticked === usable.length ? "all" : "mixed";
}

/**
 * The one-time "Prepare semantic search" step: offered only while the host has semantic search and
 * the model is not downloaded and verified yet; then the download progress; never again after.
 */
export function setupView(status, job) {
  if (job) {
    const view = jobView(job);
    const detail = job.detail ?? {};
    if (view.running)
      return {
        state: "downloading",
        percent: view.percent,
        doneMb: formatMb(detail.bytes),
        totalMb: formatMb(detail.total ?? status?.model?.bytes),
        file: detail.file ?? "",
        fileIndex: detail.fileIndex ?? 0,
        fileCount: detail.fileCount ?? 0,
        filePercent: detail.fileTotal
          ? Math.round((100 * (detail.fileBytes ?? 0)) / detail.fileTotal)
          : 0,
      };
    if (view.done)
      return {
        state: "done",
        downloaded: !!job.result?.downloaded,
        activation: job.result?.activation,
      };
    return { state: view.cancelled ? "cancelled" : "failed", error: view.error };
  }
  if (!status?.semanticApi || !status.model) return { state: "hidden" };
  if (status.model.prepared) return { state: "hidden" };
  return { state: "offer", totalMb: formatMb(status.model.bytes) };
}

/**
 * Maps a host response to an error key. `message.error` is the transport code; `result.error` the
 * plugin code. For `not_permitted`, prefer the host's `effect`, else the action's own effect.
 */
export function responseError(message, actionEffect) {
  if (message.error === "not_permitted") {
    const effect =
      message.effect === "process" || message.effect === "write"
        ? message.effect
        : actionEffect || "write";
    return `not_permitted_${effect}`;
  }
  return message.error || message.result?.error || null;
}

/** "3 sources" / "1 source" with translated singular and plural keys. */
export const countKey = (n, key) => (n === 1 ? key : `${key}s`);

/** Suggested questions from a guide result (at most three, non-empty). */
export const suggestions = (guide) =>
  (guide?.questions ?? []).filter((q) => typeof q === "string" && q.trim()).slice(0, 3);

/** File types a notebook accepts (macro-enabled Office files are not). */
export const SOURCE_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".html",
  ".htm",
  ".docx",
  ".pptx",
  ".xlsx",
  ".pdf",
];
export const isSupportedFile = (name) =>
  SOURCE_EXTENSIONS.some((ext) => String(name).toLowerCase().endsWith(ext));

/** Workspace picker: folders, then supported files only. */
export const pickerEntries = (entries) =>
  entries.filter((e) => e.kind === "dir" || isSupportedFile(e.name));

/** i18n key and argument for where a passage is: page, slide or sheet (null when not paged). */
export function placeLabel(passage) {
  if (!passage || passage.page === null || passage.page === undefined) return null;
  if (passage.pageKind === "slide") return ["slide", passage.page];
  if (passage.pageKind === "sheet") return ["sheet", passage.pageName ?? String(passage.page)];
  return ["page", passage.page];
}
