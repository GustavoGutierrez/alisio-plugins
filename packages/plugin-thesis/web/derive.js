// Pure view logic of the Thesis Studio frame (no DOM), unit-tested in test/ui.test.ts.

export const POLL_MS = 1000;

export const PHASES = ["intake", "design", "outline", "sections", "review", "final", "submitted"];

/** Effects of the backend actions (spec §6.3); the frame uses them for not_permitted fallbacks. */
export const WRITE_ACTIONS = new Set([
  "project.init",
  "interview.answer",
  "approve",
  "revise",
  "design.run",
  "outline.run",
  "research.run",
  "draft.run",
  "figure.run",
  "review.run",
  "next.run",
  "check.run",
  "packs.new",
  "styles.new",
  "norms.import",
  "files.write",
  "settings.setModel",
  "jobs.cancel",
]);
export const PROCESS_ACTIONS = new Set(["build.run", "finalize.run", "engine.setup", "doctor.run"]);
export const effectOf = (action) =>
  PROCESS_ACTIONS.has(action) ? "process" : WRITE_ACTIONS.has(action) ? "write" : "read";

/** Done / current / locked per lifecycle phase; `null` (no project yet) starts at intake. */
export function stepper(phase) {
  const current = phase ? PHASES.indexOf(phase) : 0;
  return PHASES.map((name, index) => ({
    phase: name,
    state:
      phase === "submitted" || index < current ? "done" : index === current ? "current" : "locked",
  }));
}

/** False only when Alisio has no model at all (§7.1); unknown (not loaded yet) counts as true. */
export const canSpawn = (models) =>
  !models || (Array.isArray(models.models) && models.models.length > 0) || !!models.active;

const SPAWNING = new Set([
  "research",
  "searchMore",
  "addSource",
  "writeDraft",
  "requestChanges",
  "addFigure",
]);

/**
 * Card actions of one chapter by status. `primary` marks the recommended one; `disabled` is set
 * when no model exists (child-spawning actions) or when the chapter waits for others.
 */
export function sectionActions(section, spawn = true) {
  const next = section?.next ?? null;
  const waiting = next?.action === "wait";
  const list = (() => {
    switch (section?.status) {
      case "planned":
      case "researching":
        return [next?.action === "draft.run" ? "writeDraft" : "research"];
      case "research_review":
        return ["approveResearch", "searchMore", "addSource", "requestChanges"];
      case "research_approved":
        return ["writeDraft", "searchMore", "addSource"];
      case "drafting":
      case "revising":
        return ["writeDraft"];
      case "draft_review":
        return ["approve", "requestChanges", "addFigure"];
      case "approved":
        return ["requestChanges", "addFigure"];
      default:
        return [];
    }
  })();
  return list.map((key, index) => ({
    key,
    primary: index === 0 && section?.status !== "approved",
    disabled:
      (SPAWNING.has(key) && !spawn) || (waiting && (key === "research" || key === "writeDraft")),
  }));
}

const SEVERITIES = ["critical", "major", "minor"];

/** Review findings grouped by severity, with the open critical/major (blocking) count. */
export function findingGroups(findings = []) {
  const groups = SEVERITIES.map((severity) => ({
    severity,
    items: findings.filter((f) => f.severity === severity),
  }));
  const blocking = findings.filter(
    (f) => f.status === "open" && (f.severity === "critical" || f.severity === "major"),
  ).length;
  return { groups, blocking };
}

const ROLE_LINE = /^thesis-([a-z-]+):\s*running/;

/** A job progress line as a plain label: "Librarian is searching…" instead of a role id. */
export function progressLabel(line) {
  const match = ROLE_LINE.exec(String(line ?? ""));
  if (match) return { key: `role_${match[1].replace(/-/g, "_")}` };
  return { text: String(line ?? "") };
}

/** Title key of a job ("Writing SEC-03"). */
export function jobTitle(job) {
  const kind = String(job?.kind ?? "").replace(/\.run$/, "");
  return {
    key: `job_${kind.replace(/[.-]/g, "_")}`,
    ...(job?.target ? { target: job.target } : {}),
  };
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** What the guided "Next step" card does (spec §5 Home). */
export function nextCard(status) {
  const step = status?.nextStep ?? { action: "project.init", reasonKey: "start" };
  const base = { action: step.action, target: step.target, reasonKey: step.reasonKey };
  switch (step.action) {
    case "project.init":
      return { ...base, run: step.reasonKey !== "start", input: {}, screen: "interview" };
    case "interview":
      return { ...base, screen: "interview" };
    case "check.run":
      return { ...base, run: true, input: {}, screen: "build" };
    case "approve":
      if (step.target === "A" || step.target === "B" || step.target === "OUTLINE")
        return { ...base, screen: "plans" };
      if (step.target === "C") return { ...base, screen: "build" };
      return { ...base, screen: "chapters" };
    case "finalize.run":
      if (status?.gates?.C?.status !== "approved")
        return { action: "approve", target: "C", reasonKey: "approve_gate_c", screen: "build" };
      return { ...base, run: true, input: {}, screen: "build" };
    case "design.run":
    case "outline.run":
      return { ...base, run: true, input: {}, screen: "plans" };
    case "research.run":
    case "draft.run":
      return { ...base, run: true, input: { section: step.target ?? "next" }, screen: "chapters" };
    case "review.run":
      return { ...base, run: true, input: { target: step.target ?? "all" }, screen: "review" };
    case "findings":
      return { ...base, screen: "review" };
    case "done":
      return { ...base, screen: "build" };
    default:
      return { ...base, screen: "chapters" };
  }
}

/** Chapters left mid-run (the host restarted): "the last run did not finish; run it again". */
export const staleSections = (status) =>
  status?.job
    ? []
    : (status?.sections ?? [])
        .filter((s) => s.status === "researching" || s.status === "drafting")
        .map((s) => s.id);

/**
 * `message.error` is a host transport code; `result.error` a Thesis Studio code. For
 * not_permitted, prefer the host's `effect`; older hosts omit it, so fall back to the action's.
 */
export function responseError(message, actionEffect) {
  if (message.error === "not_permitted") {
    const effect =
      message.effect === "process" || message.effect === "write"
        ? message.effect
        : actionEffect === "process"
          ? "process"
          : "write";
    return `not_permitted_${effect}`;
  }
  return message.error || message.result?.error || null;
}

/** Models grouped by provider for the picker. */
export function groupModels(models = []) {
  const groups = new Map();
  for (const model of models) {
    const list = groups.get(model.provider) ?? [];
    list.push(model);
    groups.set(model.provider, list);
  }
  return [...groups.entries()];
}

/** Lines of a text, for the editor's line-number gutter. */
export const lineCount = (text) => String(text ?? "").split("\n").length;
