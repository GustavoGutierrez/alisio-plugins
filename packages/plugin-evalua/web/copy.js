// Copy controls for generated content (the Semantic O14 component): question wording, the exam
// summary and the build findings. Plain text only; the chain falls back from the async Clipboard
// API to a `copy` event on a hidden selection, then to a dialog the teacher copies from by hand.

/** Plain text of a copy source: an optional title line, then each line. */
export function copyText(source) {
  const lines = (source?.lines ?? [])
    .map((line) => String(line ?? ""))
    .filter((line) => line !== "");
  return [source?.title, ...lines].filter(Boolean).join("\n");
}

/**
 * Tries the async Clipboard API, then a `copy` event fired by `execCommand` on a hidden
 * selection (sandboxed frames often lack the clipboard permission). Returns the path that worked:
 * "clipboard", "execCommand", or "manual" when the caller must show the text to copy by hand.
 */
export async function writeClipboard(text, env = globalThis) {
  const nav = env.navigator;
  try {
    if (nav?.clipboard?.writeText) {
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
    const onCopy = (event) => {
      if (!event.clipboardData) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    };
    doc.addEventListener("copy", onCopy);
    let ok = false;
    try {
      ok = !!doc.execCommand?.("copy");
    } finally {
      doc.removeEventListener("copy", onCopy);
      area.remove();
    }
    if (ok) return "execCommand";
  } catch {
    // execCommand is unavailable: manual copy.
  }
  return "manual";
}
