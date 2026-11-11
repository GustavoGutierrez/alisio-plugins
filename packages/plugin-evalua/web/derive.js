// Pure view logic of the Evalua frame (no DOM), unit-tested in test/ui.test.ts.

export const POLL_MS = 750;
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const MAX_TEMPLATE_CHARS = 200;
export const MAX_TEMPLATES = 5;
/** Phases in which wording, questions and documents can still change (spec D9). */
export const EDITABLE_PHASES = ["approved-a", "generated", "built"];

/**
 * `message.error` is the host transport code, `message.result.error` the plugin's. For
 * not_permitted, prefer the host's `effect`; older hosts omit it, so use the action's own.
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

/** The frame's own logo check before uploading (the backend checks the bytes again). */
export function checkLogo(file) {
  if (!file) return "bad_image";
  if (!LOGO_TYPES.includes(file.type)) return "bad_image";
  if (file.size > MAX_LOGO_BYTES) return "file_too_large";
  return null;
}

/** Grades in school order; unknown grades keep their order after the known ones. */
const GRADE_ORDER = [
  "Primero",
  "Segundo",
  "Tercero",
  "Cuarto",
  "Quinto",
  "Sexto",
  "Séptimo",
  "Octavo",
  "Noveno",
  "Décimo",
  "Undécimo",
];
/** The chat interview's own grade values; any other grade travels as `grade:text`. */
const GRADE_VALUES = { Sexto: "sexto", Séptimo: "septimo", Octavo: "octavo" };

export function gradeList(topics) {
  const all = new Set();
  for (const topic of topics ?? []) for (const grade of topic.grades ?? []) all.add(grade);
  const rank = (grade) => {
    const index = GRADE_ORDER.indexOf(grade);
    return index < 0 ? GRADE_ORDER.length : index;
  };
  return [...all].sort((a, b) => rank(a) - rank(b));
}

/** The wizard's grade label as interview answers. */
export function gradeAnswer(label) {
  const value = GRADE_VALUES[label];
  return value ? { grade: value } : { grade: "other", "grade:text": label };
}

const fold = (text) =>
  String(text ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

/** Catalog topics for a grade whose name (any language) or pack contains every query word. */
export function filterTopics(topics, { grade, query } = {}) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  return (topics ?? []).filter((topic) => {
    if (grade && !(topic.grades ?? []).includes(grade)) return false;
    const haystack = fold(
      [...Object.values(topic.name ?? {}), topic.pack, ...(topic.grades ?? [])].join(" "),
    );
    return words.every((word) => haystack.includes(word));
  });
}

/** Bank sizes like the chat: 3 x count by default, never below count + 5. */
export function bankSizes(count) {
  const min = count + 5;
  const double = 2 * count;
  return { standard: Math.max(3 * count, min), double: double >= min ? double : undefined, min };
}

export const emptyForm = () => ({
  grade: "",
  topic: "",
  level: "",
  types: [],
  count: "10",
  countText: "",
  distribution: "same",
  columns: "1",
  bankSize: "default",
  bankText: "",
  variants: "2",
  variantsText: "",
  pages: "auto",
  pagesText: "",
  time: "120-pencil",
  minutes: "",
  instrument: "pencil",
  calculator: false,
  closing: "none",
  numbering: "letters",
});

/** The number of questions the form asks for, or undefined while it is not a whole number. */
export function formCount(form) {
  const raw = form.count === "other" ? form.countText : form.count;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** The wizard's steps: the bank step only for a bank of more than one question. */
export function wizardSteps(form) {
  const bank = form.distribution === "bank" && formCount(form) !== 1;
  return bank ? ["topic", "questions", "bank", "format"] : ["topic", "questions", "format"];
}

/** The fields each step shows, for errors and for "required" checks. */
export const STEP_FIELDS = {
  topic: ["grade", "topic", "level"],
  questions: ["types", "count", "distribution", "columns"],
  bank: ["bank_size", "variants"],
  format: ["pages", "time", "closing", "numbering"],
};

/** The step a backend field error belongs to. */
export function stepOfField(field) {
  for (const [step, fields] of Object.entries(STEP_FIELDS)) if (fields.includes(field)) return step;
  return "topic";
}

/** Fields of a step that still need an answer (the frame checks before moving on). */
export function missingFields(form, step) {
  const missing = [];
  const empty = (value) => String(value ?? "").trim() === "";
  if (step === "topic") {
    if (empty(form.grade)) missing.push("grade");
    if (empty(form.topic)) missing.push("topic");
    if (empty(form.level)) missing.push("level");
  } else if (step === "questions") {
    if (!form.types?.length) missing.push("types");
    if (form.count === "other" && empty(form.countText)) missing.push("count");
  } else if (step === "bank") {
    if (form.bankSize === "other" && empty(form.bankText)) missing.push("bank_size");
    if (form.variants === "other" && empty(form.variantsText)) missing.push("variants");
  } else if (step === "format") {
    if (form.pages === "other" && empty(form.pagesText)) missing.push("pages");
    if (form.time === "other" && empty(form.minutes)) missing.push("time");
  }
  return missing;
}

/** The free text of a custom time, in words the chat's time parser understands. */
export function timeText(form) {
  const instrument =
    form.instrument === "pen" ? " pen" : form.instrument === "pencil" ? " pencil" : "";
  return `${String(form.minutes).trim()}${instrument} ${form.calculator ? "calculator" : "no calculator"}`;
}

/** The form as `draft.create` answers: "other" options carry their number as `<id>:text`. */
export function toAnswers(form) {
  const answers = {
    topic: form.topic,
    ...gradeAnswer(form.grade),
    level: form.level,
    types: [...form.types],
    count: form.count,
    distribution: form.distribution,
    columns: form.columns,
    pages: form.pages,
    time: form.time,
    closing: form.closing,
    numbering: form.numbering,
  };
  if (form.count === "other") answers["count:text"] = String(form.countText).trim();
  if (wizardSteps(form).includes("bank")) {
    answers.bank_size = form.bankSize;
    if (form.bankSize === "other") answers["bank_size:text"] = String(form.bankText).trim();
    answers.variants = form.variants;
    if (form.variants === "other") answers["variants:text"] = String(form.variantsText).trim();
  }
  if (form.pages === "other") answers["pages:text"] = String(form.pagesText).trim();
  if (form.time === "other") answers["time:text"] = timeText(form);
  if (formCount(form) === 1) delete answers.distribution;
  return answers;
}

const TIME_PRESETS = {
  "120-pencil": [120, "pencil", false],
  "90-pencil": [90, "pencil", false],
  "60-pen": [60, "pen", false],
};

/** A draft back into wizard answers ("Change answers", or a draft made in the chat). */
export function draftToForm(draft, gradeLabel) {
  const form = emptyForm();
  form.grade = gradeLabel ?? draft.grade ?? "";
  form.topic = draft.topics?.[0] ?? "";
  form.level = draft.level ?? "";
  form.types = Object.entries(draft.itemTypes ?? {})
    .filter(([, count]) => count > 0)
    .map(([type]) => type);
  const count = draft.questionCount;
  if ([10, 15, 20].includes(count)) form.count = String(count);
  else {
    form.count = "other";
    form.countText = String(count ?? "");
  }
  form.distribution = draft.distribution === "bank" ? "bank" : "same";
  form.columns = draft.columns === 2 ? "2" : "1";
  if (draft.bank) {
    const sizes = bankSizes(count);
    if (draft.bank.size === sizes.standard) form.bankSize = "default";
    else if (draft.bank.size === sizes.double) form.bankSize = "double";
    else {
      form.bankSize = "other";
      form.bankText = String(draft.bank.size);
    }
    if ([2, 3].includes(draft.bank.variants)) form.variants = String(draft.bank.variants);
    else {
      form.variants = "other";
      form.variantsText = String(draft.bank.variants);
    }
  }
  if (draft.maxPages === "auto" || draft.maxPages === undefined) form.pages = "auto";
  else if (draft.maxPages === 1 || draft.maxPages === 2) form.pages = String(draft.maxPages);
  else {
    form.pages = "other";
    form.pagesText = String(draft.maxPages);
  }
  const preset = Object.entries(TIME_PRESETS).find(
    ([, [minutes, instrument, calculator]]) =>
      minutes === draft.durationMinutes &&
      instrument === draft.instrument &&
      calculator === draft.calculator,
  );
  if (preset) form.time = preset[0];
  else {
    form.time = "other";
    form.minutes = String(draft.durationMinutes ?? "");
    form.instrument = draft.instrument ?? "any";
    form.calculator = draft.calculator === true;
  }
  form.closing = draft.closing?.kind ?? "none";
  form.numbering = draft.numbering ?? "letters";
  return form;
}

/** The next step of an exam from its phase (spec §6): wording, questions, documents, approval. */
export function nextExamStep(phase) {
  if (phase === "approved-a") return "wording";
  if (phase === "generated") return "documents";
  if (phase === "built") return "approve";
  if (phase === "approved-b") return "documents";
  return "wording";
}

/** Which exam steps can be opened in a phase (the backend guards them again). */
export function examStepState(phase) {
  const editable = EDITABLE_PHASES.includes(phase);
  return {
    wording: editable,
    questions: editable || phase === "approved-b",
    documents: ["generated", "built", "approved-b"].includes(phase),
    approve: phase === "built" || phase === "approved-b",
  };
}

/**
 * The wording step: drafting needs a model and at least one family to word (an exam made only of
 * bank questions has none); an approved exam is read only. `families` unknown means "not loaded".
 */
export function wordingState({ models, phase, job, families }) {
  const available = !!models?.available;
  const editable = EDITABLE_PHASES.includes(phase);
  const nothingToDraft = editable && Array.isArray(families) && families.length === 0;
  return {
    canDraft: available && editable && !job && !nothingToDraft,
    noModel: !available,
    drafting: !!job,
    locked: !editable,
    nothingToDraft,
  };
}

/** The documents step: what can be built, shown and downloaded. */
export function documentsState({ exam, lastBuild, doctor, job }) {
  const docs = exam?.docs ?? { html: false, pdf: false };
  return {
    canBuild: !job && (exam?.phase === "generated" || exam?.phase === "built"),
    building: !!job,
    hasPdf: !!docs.pdf,
    hasHtml: !!docs.html,
    noBrowser: doctor?.browser === "missing" || (lastBuild ? lastBuild.pdf === false : false),
    findings: lastBuild?.findings ?? [],
    errors: (lastBuild?.findings ?? []).filter((finding) => finding.severity === "error"),
  };
}

/** Progress text of a build job: [i18n key, ...arguments] and a percentage. */
export function buildProgress(job) {
  const total = job?.total || 0;
  const step = job?.step || 0;
  const percent = total > 0 ? Math.round((Math.min(step, total) / total) * 100) : 0;
  if (!job || total === 0) return { key: "starting", args: [], percent };
  if (job.phase === "fit")
    return { key: "fitting", args: [Math.min(step + 1, total - 4), total - 4], percent };
  if (job.phase === "print") {
    const printed = step - (total - 4);
    return { key: "printing", args: [Math.min(printed + 1, 4), 4], percent };
  }
  return { key: "writingHtml", args: [], percent };
}

/** What a polled job means for the UI. */
/** The fixed reasons a failed job may carry (src/app/errors.ts APP_ERROR_DETAILS). */
const JOB_DETAILS = ["model_error", "unreadable", "rejected"];

export function jobView(job) {
  const state = job?.state ?? "running";
  return {
    running: state === "running",
    done: state === "done",
    failed: state === "failed",
    cancelled: state === "cancelled",
    error: state === "failed" ? job?.error || "operation_failed" : null,
    detail: state === "failed" && JOB_DETAILS.includes(job?.detail) ? job.detail : null,
  };
}

/** A template with the marker the teacher sees instead of `{expr}`. */
export const toEditable = (template, marker) =>
  String(template ?? "").replaceAll("{expr}", `[${marker}]`);

/** The teacher's text back to a template: any language's marker becomes `{expr}`. */
export function fromEditable(text, markers) {
  let out = String(text ?? "");
  for (const marker of markers) out = out.replaceAll(`[${marker}]`, "{expr}");
  return out;
}

/** Why a sentence would be refused (the backend applies the same rules, spec D7). */
export function templateProblem(template) {
  const text = String(template ?? "").trim();
  if (text === "") return null;
  if (!text.includes("{expr}")) return "needsMath";
  if (/[$<>]/.test(text) || text.length > MAX_TEMPLATE_CHARS) return "invalid";
  return null;
}

/** A template split into text and math chips, for a safe preview. */
export function templateParts(template) {
  const parts = [];
  const pieces = String(template ?? "").split("{expr}");
  pieces.forEach((piece, index) => {
    if (piece) parts.push({ text: piece });
    if (index < pieces.length - 1) parts.push({ math: true });
  });
  return parts;
}

/** The prompts `wording.save` sends: edited families, else what is saved. Empty means default. */
export function promptsToSave(families, edits) {
  const prompts = {};
  for (const family of families ?? []) {
    const list = (edits[family.id] ?? family.templates ?? [])
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .slice(0, MAX_TEMPLATES);
    if (list.length > 0) prompts[family.id] = list;
  }
  return prompts;
}

/** Blueprint cells grouped by kind of question and thinking level, for the review table. */
export function blueprintRows(blueprint) {
  const rows = new Map();
  for (const cell of blueprint?.cells ?? []) {
    if (!cell.count) continue;
    const key = `${cell.type}|${cell.cognitive}`;
    rows.set(key, (rows.get(key) ?? 0) + cell.count);
  }
  return [...rows.entries()].map(([key, count]) => {
    const [type, cognitive] = key.split("|");
    return { type, cognitive, count };
  });
}

/** Every item type, in the order the wizard lists them. */
export const ITEM_TYPES = ["single_choice", "multiple_choice", "open", "practice"];

/**
 * The item types the wizard offers for a topic: its `supports` flags, like the chat's round 2.
 * Without the topic, what any listed topic supports; without catalog data, every type.
 */
export function offeredTypes(topics, topicId) {
  const topic = (topics ?? []).find((entry) => entry.id === topicId);
  const own = ITEM_TYPES.filter((type) => topic?.supports?.[type]);
  if (own.length) return own;
  const any = ITEM_TYPES.filter((type) => (topics ?? []).some((entry) => entry.supports?.[type]));
  return any.length ? any : [...ITEM_TYPES];
}

/**
 * A blocked generation in the teacher's terms: each capacity shortfall as one notice (topic,
 * type and how many distinct questions exist), plus the raw findings for a technical detail.
 * The slot/count findings a shortfall explains are not repeated as separate problems.
 */
export function generationNotices(result) {
  const findings = result?.findings ?? [];
  const capacity = (result?.capacity ?? []).map((entry) => ({
    topic: entry.topic,
    name: entry.name,
    type: entry.type,
    requested: entry.requested,
    available: entry.available,
    kind: entry.available > 0 ? "few" : "none",
  }));
  const explained = capacity.length ? ["EVL-ITM-009", "EVL-EXM-002"] : [];
  return {
    capacity,
    others: findings.filter((finding) => !explained.includes(finding.id)),
    technical: findings,
  };
}
