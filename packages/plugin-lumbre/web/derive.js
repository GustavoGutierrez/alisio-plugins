// Pure view logic of the Lumbre frame (no DOM), unit-tested in test/ui.test.ts.

export const POLL_MS = 700;
export const SERVER_POLL_MS = 5000;
export const SLOW_HINT_MS = 20_000;

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

/** "0:07", "2:05", "1:02:03". */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** What a polled job means for the UI. */
export function jobView(job, now = Date.now(), receivedAt = now) {
  const state = job?.state ?? "running";
  const elapsed = (job?.elapsedMs ?? 0) + (state === "running" ? Math.max(0, now - receivedAt) : 0);
  return {
    running: state === "running",
    done: state === "done",
    failed: state === "failed",
    cancelled: state === "cancelled",
    stage: job?.stage ?? { key: "preparing" },
    steps: (job?.steps ?? []).slice(0, -1).slice(-4),
    percent:
      typeof job?.progress === "number"
        ? Math.round(Math.max(0, Math.min(1, job.progress)) * 100)
        : null,
    elapsed: formatElapsed(elapsed),
    slow: state === "running" && elapsed >= SLOW_HINT_MS,
    error: state === "failed" ? job?.error || "operation_failed" : null,
  };
}

/** Files of a proposal with their review status, in a stable order. */
export function proposalEntries(proposal) {
  if (!proposal) return [];
  const before = proposal.before ?? {};
  const changed = Object.keys(proposal.files ?? {}).map((path) => ({
    path,
    status: before[path] === null || before[path] === undefined ? "added" : "changed",
  }));
  const deleted = (proposal.deletes ?? []).map((path) => ({ path, status: "deleted" }));
  return [...changed, ...deleted].sort((x, y) => x.path.localeCompare(y.path));
}

/** Input for proposal.apply from the ticked review boxes. */
export function applyInput(proposal, ticked) {
  const files = Object.keys(proposal.files ?? {}).filter((p) => ticked.has(`file:${p}`));
  const deletes = (proposal.deletes ?? []).filter((p) => ticked.has(`file:${p}`));
  const dependencies = Object.keys(proposal.dependencies ?? {}).filter((n) =>
    ticked.has(`dep:${n}`),
  );
  return { projectId: proposal.projectId, proposalId: proposal.id, files, deletes, dependencies };
}

/** Every reviewable item of a proposal, ticked by default. */
export const allItems = (proposal) =>
  new Set([
    ...Object.keys(proposal?.files ?? {}).map((p) => `file:${p}`),
    ...(proposal?.deletes ?? []).map((p) => `file:${p}`),
    ...Object.keys(proposal?.dependencies ?? {}).map((n) => `dep:${n}`),
  ]);

/** Files as a sorted tree-ish list with depth for indentation. */
export function fileRows(files) {
  return [...(files ?? [])]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => ({ ...f, depth: f.path.split("/").length - 1, name: f.path.split("/").at(-1) }));
}

/** "3 files" / "1 file" key helper. */
export const countKey = (n, key) => (n === 1 ? key : `${key}s`);

/** Server badge state from a snapshot. */
export function serverView(server) {
  const state = server?.state ?? "stopped";
  return {
    state,
    running: state === "running",
    starting: state === "starting",
    url: state === "running" ? (server?.url ?? null) : null,
    idleStopped: state === "stopped" && server?.stoppedReason === "idle",
    crashed: state === "failed" || server?.stoppedReason === "crash",
  };
}
