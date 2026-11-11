import { copyText, writeClipboard } from "./copy.js";
import {
  bankSizes,
  blueprintRows,
  buildProgress,
  checkLogo,
  documentsState,
  draftToForm,
  EDITABLE_PHASES,
  emptyForm,
  examStepState,
  filterTopics,
  formCount,
  fromEditable,
  generationNotices,
  gradeList,
  jobView,
  MAX_TEMPLATES,
  missingFields,
  nextExamStep,
  offeredTypes,
  POLL_MS,
  promptsToSave,
  responseError,
  stepOfField,
  templateParts,
  templateProblem,
  toAnswers,
  toEditable,
  wizardSteps,
  wordingState,
} from "./derive.js";
import { errorText, familyLabel, locale, localName, messages, setLocale, t, tf } from "./i18n.js";
import { icon } from "./icons.js";

const root = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const WRITE_ACTIONS = new Set([
  "profile.save",
  "profile.setLogo",
  "profile.removeLogo",
  "draft.create",
  "draft.discard",
  "exam.approveA",
  "models.choose",
  "wording.draft",
  "wording.save",
  "exam.generate",
  "exam.approveB",
  "jobs.cancel",
]);
const PROCESS_ACTIONS = new Set(["build.start"]);
const effectOf = (action) =>
  PROCESS_ACTIONS.has(action) ? "process" : WRITE_ACTIONS.has(action) ? "write" : "read";

// ---------- Transport ----------
let hostPort;
let visible = true;
let unavailable = false;
const pending = new Map();
const connected = new Promise((resolve) => {
  window.addEventListener("message", (event) => {
    if (
      hostPort ||
      event.source !== window.parent ||
      event.data?.type !== "alisio.app.connect" ||
      !event.ports[0]
    )
      return;
    hostPort = event.ports[0];
    setLocale(event.data.locale);
    visible = event.data.visible !== false;
    hostPort.onmessage = (portEvent) => {
      const message = portEvent.data;
      if (message?.type === "locale") changeLocale(message.locale);
      if (message?.type === "visibility") {
        visible = message.visible !== false;
        // Coming back: re-check the app (Alisio may have reopened it) and what the chat changed.
        if (visible) void (unavailable ? verifyAvailable() : refreshOnShow());
      }
      if (message?.type === "response") settle(message);
    };
    hostPort.start();
    resolve();
  });
});

function settle(message) {
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  clearTimeout(request.approvalTimer);
  settleApprovalNotice();
  const error = responseError(message, effectOf(request.action));
  if (!error) return request.resolve(message.result?.value);
  const failure = new Error(error);
  // Only the HOST's not_found can mean "app gone"; a plugin's not_found is an unknown item.
  failure.transport = !!message.error;
  if (message.error === "not_found") hostNotFound();
  request.reject(failure);
}

// One host not_found never latches: it is confirmed with a `status` request after a short delay;
// only a second host not_found shows the unavailable screen, which keeps re-checking.
let verifying;
const VERIFY_DELAY_MS = 1500;
function hostNotFound() {
  if (unavailable || verifying) return;
  verifying = new Promise((r) => setTimeout(r, VERIFY_DELAY_MS)).then(verifyAvailable);
}
async function verifyAvailable() {
  try {
    await send("status", {});
    const wasUnavailable = unavailable;
    unavailable = false;
    if (wasUnavailable) await reloadAll();
  } catch (error) {
    if (error?.transport && error.message === "not_found") showUnavailable();
  } finally {
    verifying = undefined;
  }
}

// The host runs at most 8 requests per frame; stay below it.
const MAX_IN_FLIGHT = 6;
// Longer than the approval wait (10 min) plus the 30 s handler timeout.
const RESPONSE_GUARD_MS = 11 * 60 * 1000;
const APPROVAL_HINT_MS = 3000;
let approvalNotice = false;
let inFlight = 0;
const waiting = [];
let toastTimer;

function toast(message, sticky = false) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => (el.style.display = "none"), 7000);
}
function settleApprovalNotice() {
  if (!approvalNotice || [...pending.values()].some((r) => r.awaitingHint)) return;
  approvalNotice = false;
  document.querySelector("#toast").style.display = "none";
}

async function api(action, input = {}) {
  await connected;
  if (unavailable) throw new Error("not_found");
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await send(action, input);
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}
function send(action, input) {
  const id = crypto.randomUUID();
  const mutation = effectOf(action) !== "read";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      settleApprovalNotice();
      reject(new Error("timeout"));
    }, RESPONSE_GUARD_MS);
    const request = { resolve, reject, timer, action, awaitingHint: false };
    if (mutation)
      request.approvalTimer = setTimeout(() => {
        request.awaitingHint = true;
        approvalNotice = true;
        toast(t("awaitingApproval"), true);
      }, APPROVAL_HINT_MS);
    pending.set(id, request);
    hostPort.postMessage({
      type: "request",
      id,
      action,
      input,
      ...(mutation ? { idempotencyKey: id } : {}),
    });
  });
}

/** A state mutation: sends the revision the frame last saw and keeps the new one (spec D2). */
async function mutate(action, input = {}) {
  try {
    const value = await api(action, { ...input, expectedRevision: status?.revision ?? "-" });
    if (value?.revision && status) status.revision = value.revision;
    return value;
  } catch (error) {
    if (error?.message === "state_changed") {
      toast(t("stateChanged"));
      await reloadView();
      error.handled = true;
    }
    throw error;
  }
}

const fail = (error) => {
  if (unavailable || error?.handled) return;
  toast(errorText(error?.message ?? "operation_failed"));
};

// ---------- State ----------
let status;
let view = { name: "home" };
let catalog;
let models;
let doctor;
let kb;
let form = emptyForm();
let stepIndex = 0;
let topicQuery = "";
let fieldErrors = {};
/** Capacity shortfalls behind a `capacity` field error, by field (plain-words messages). */
let fieldCapacity = {};
/** A logo chosen before the first profile exists: uploaded right after `profile.save`. */
let pendingLogo;
let summaryOpen = false;
let wizardDirty = false;
let draftView;
let wording;
let edits = {};
let wordingDirty = false;
let items;
let showAnswers = false;
let generationResult;
let docTab = "exam";
const docInfo = {};
let buildJob;
let wordingJob;
let buildMessage;
const jobStates = new Map();
let focusTarget;

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const attr = esc;
const button = (action, label, cls = "outline", extra = "") =>
  `<button type="button" class="${cls}" data-action="${action}" ${extra}>${label}</button>`;
const iconLabel = (action, name, label, cls = "outline", extra = "") =>
  button(action, `${icon(name)}<span>${esc(label)}</span>`, cls, extra);
const announce = (text) => {
  const live = document.querySelector("#live");
  if (live) live.textContent = text;
};
const activeExam = () => status?.exams?.find((exam) => exam.id === status.activeExamId);
const gradeName = (grade) => t("gradeNames")[grade] ?? grade;
const phaseText = (phase) => t("phase")[phase] ?? phase;
const findingText = (finding) => t("findingText")[finding.id] ?? finding.message;
/** One capacity shortfall in plain words: the topic, the kind of question and how many exist. */
const capacityText = (entry) => {
  const name = localName(entry.name) || entry.topic;
  const type = t("itemTypes")[entry.type]?.[0] ?? entry.type;
  return entry.available > 0
    ? tf("capacityFew", name, type, entry.available)
    : tf("capacityNone", name, type);
};

function showUnavailable() {
  unavailable = true;
  root.innerHTML = `<main class="unavailable"><span class="mark" aria-hidden="true"></span><h1>${esc(t("unavailableTitle"))}</h1><p>${esc(t("unavailable"))}</p>${button("retry", esc(t("retry")), "primary")}</main>`;
}

// ---------- Rendering ----------
/** Follows Alisio's language without losing the answers, the edits, focus or scroll. */
function changeLocale(value) {
  const focusId = document.activeElement?.id;
  const scroll = document.querySelector("main")?.scrollTop;
  setLocale(value);
  render({ keepFocus: true });
  const main = document.querySelector("main");
  if (main && typeof scroll === "number") main.scrollTop = scroll;
  if (focusId) document.getElementById(focusId)?.focus();
}

function topbar(title) {
  const exam = view.name !== "home";
  return `<header class="topbar"><div class="brand">${exam ? `<button type="button" class="icon-btn on-bar" data-action="home" aria-label="${attr(t("home"))}" title="${attr(t("home"))}">${icon("back")}</button>` : ""}<span class="mark" aria-hidden="true"></span><strong>${esc(title ?? t("appName"))}</strong></div>
    <nav class="topbar-actions" aria-label="${attr(t("appName"))}">${iconLabel("profile", "user", t("profileButton"), "bar-btn")}${iconLabel("settings", "settings", t("settings"), "bar-btn")}</nav></header>`;
}

function render({ keepFocus = false } = {}) {
  if (unavailable) return showUnavailable();
  if (!status) {
    root.innerHTML = `${topbar()}<main class="page"><p class="muted">${esc(t("loading"))}</p></main>`;
    return;
  }
  const views = {
    home: renderHome,
    profile: renderProfile,
    wizard: renderWizard,
    review: renderReview,
    exam: renderExam,
    archive: renderArchive,
    settings: renderSettings,
  };
  root.innerHTML = (views[view.name] ?? renderHome)();
  afterRender();
  if (!keepFocus && focusTarget) {
    document.querySelector(focusTarget)?.focus();
    focusTarget = undefined;
  }
}

/** Moves focus to the heading of what the teacher just opened (spec §9). */
function go(next) {
  view = next;
  focusTarget = "#view-heading";
  render();
  document.querySelector("main")?.scrollTo?.(0, 0);
}

function heading(text, level = "h1") {
  return `<${level} id="view-heading" tabindex="-1">${esc(text)}</${level}>`;
}

function banner(kind, text, iconName = kind === "warn" ? "warning" : "info") {
  return `<div class="banner ${kind}" role="${kind === "warn" ? "alert" : "note"}">${icon(iconName)}<span>${esc(text)}</span></div>`;
}

// ---------- Home ----------
function renderHome() {
  const exams = status.exams ?? [];
  const draft = status.draft;
  const chat = status.chatInterview;
  const cards = exams
    .map((exam) => {
      const readOnly = !exam.active;
      return `<article class="exam-card"><button type="button" class="exam-open" data-action="open-exam" data-id="${attr(exam.id)}">
        <span class="exam-no">${esc(tf("examNo", exam.number))}</span>
        <span class="exam-title">${esc(exam.theme)}</span>
        <span class="muted small">${esc(gradeName(exam.grade))} · ${esc(tf("questionsN", exam.questionCount))}</span>
        <span class="phase-chip phase-${attr(exam.phase)}">${exam.phase === "approved-b" ? icon("check") : ""}${esc(phaseText(exam.phase))}</span>
        ${readOnly ? `<span class="badge">${icon("lock")}${esc(t("readOnly"))}</span>` : ""}
      </button></article>`;
    })
    .join("");
  const continueCard = draft
    ? `<button type="button" class="card-action continue" data-action="open-review">${icon("pencil", "icon big")}<span><strong>${esc(t("continueDraft"))}</strong><span class="muted">${esc(tf("continueDraftHint", draft.theme))}</span></span></button>`
    : chat
      ? `<div class="card-action info" role="note">${icon("info", "icon big")}<span><strong>${esc(t("chatInterview"))}</strong><span class="muted">${esc(t("chatInterviewHint"))}</span></span></div>`
      : "";
  return `${topbar()}<main class="page home">
    <section class="hero"><div class="hero-sheet" aria-hidden="true"><span></span><i></i><i></i><i class="gold"></i></div><div>${heading(t("appName"))}<p class="lead">${esc(t("tagline"))}</p></div></section>
    <div class="cards-row">
      <button type="button" class="card-action primary-card" data-action="new-exam" id="new-exam">${icon("plus", "icon big")}<span><strong>${esc(t("newExam"))}</strong><span>${esc(t("newExamHint"))}</span></span></button>
      ${continueCard}
    </div>
    <h2>${esc(t("yourExams"))}</h2>
    ${exams.length ? `<div class="exam-grid">${cards}</div>` : `<p class="muted">${esc(t("noExams"))}</p>`}
  </main>`;
}

// ---------- Profile ----------
function renderProfile() {
  const p = status.profile ?? {};
  // First run: no profile to attach a logo to yet, so the chosen one waits here until it is saved.
  const pending = !status.profile && pendingLogo ? pendingLogo : undefined;
  const logoSrc = status.logo ?? pending?.preview;
  const locales = status.locales ?? ["es"];
  const err = (id) =>
    fieldErrors[id] ? `<p class="field-error" id="${id}-error">${esc(t("fieldRequired"))}</p>` : "";
  const field = (id, label, value, max) =>
    `<label class="field" for="${id}"><span>${esc(label)}</span><input id="${id}" maxlength="${max}" value="${attr(value ?? "")}" ${fieldErrors[id] ? `aria-invalid="true" aria-describedby="${id}-error"` : ""}>${err(id)}</label>`;
  return `${topbar()}<main class="page narrow">${heading(t("profileTitle"))}<p class="lead">${esc(t("profileIntro"))}</p>
    <section class="panel stack">
      ${field("teacherName", t("teacherName"), view.draftProfile?.teacherName ?? p.teacherName, 100)}
      ${field("institution", t("institution"), view.draftProfile?.institution ?? p.institution, 150)}
      ${field("subject", t("subject"), view.draftProfile?.subject ?? p.subject ?? "Matemáticas", 80)}
      <fieldset class="field"><legend>${esc(t("paper"))}</legend><div class="choice-row">
        ${["letter", "a4"].map((paper) => `<label class="pill"><input type="radio" name="paper" value="${paper}" ${(view.draftProfile?.paper ?? p.paper ?? "letter") === paper ? "checked" : ""}><span>${esc(paper === "letter" ? t("paperLetter") : t("paperA4"))}</span></label>`).join("")}
      </div></fieldset>
      <label class="field" for="language"><span>${esc(t("docLanguage"))}</span><select id="language">${locales.map((code) => `<option value="${attr(code)}" ${(p.language ?? "es") === code ? "selected" : ""}>${esc(t("languageNames")[code] ?? code)}</option>`).join("")}</select><small class="muted">${esc(t("docLanguageHint"))}</small></label>
      <div class="field"><span>${esc(t("logo"))}</span>
        <div class="logo-row">${logoSrc ? `<img class="logo-preview" src="${attr(logoSrc)}" alt="${attr(t("logoPreview"))}">` : `<span class="logo-empty" aria-hidden="true">${icon("image", "icon big")}</span>`}
        <div class="stack-tight">${iconLabel("choose-logo", "image", logoSrc ? t("replaceLogo") : t("chooseLogo"))}${logoSrc ? iconLabel("remove-logo", "trash", t("removeLogo"), "ghost") : ""}<small class="muted">${esc(t("logoHint"))}</small>${pending ? `<small class="muted">${esc(t("logoPending"))}</small>` : ""}</div></div>
        <input id="logo-input" type="file" accept="image/png,image/jpeg,image/webp" hidden></div>
      <div class="row end">${button("save-profile", esc(t("saveProfile")), "primary", 'id="save-profile"')}</div>
    </section></main>`;
}

function readProfileForm() {
  const value = (id) => document.getElementById(id)?.value.trim() ?? "";
  return {
    teacherName: value("teacherName"),
    institution: value("institution"),
    subject: value("subject"),
    paper: document.querySelector('input[name="paper"]:checked')?.value ?? "letter",
    language: document.getElementById("language")?.value ?? "es",
  };
}

// ---------- Wizard ----------
function steps() {
  return wizardSteps(form);
}
const stepTitle = (step) =>
  ({
    topic: t("stepTopic"),
    questions: t("stepQuestions"),
    bank: t("stepBank"),
    format: t("stepFormat"),
  })[step];

function fieldError(field) {
  const code = fieldErrors[field];
  if (!code) return "";
  const capacity = code === "capacity" ? (fieldCapacity[field] ?? []) : [];
  const text = capacity.length
    ? capacity.map(capacityText).join(" ")
    : (t("fieldErrors")[code] ?? t("fieldErrors").invalid);
  return `<p class="field-error" id="err-${field}">${icon("warning")}${esc(text)}</p>`;
}
const describedBy = (field) =>
  fieldErrors[field] ? `aria-invalid="true" aria-describedby="err-${field}"` : "";

function radioCards(name, options, value, field = name) {
  return `<div class="choice-grid" role="radiogroup" aria-label="${attr(name)}" ${describedBy(field)}>${options
    .map(
      (option) =>
        `<label class="choice"><input type="radio" name="${name}" value="${attr(option.value)}" ${value === option.value ? "checked" : ""}><span class="choice-body"><strong>${esc(option.label)}</strong>${option.hint ? `<small>${esc(option.hint)}</small>` : ""}</span></label>`,
    )
    .join("")}</div>`;
}
function pills(name, options, value, field = name) {
  return `<div class="choice-row" role="radiogroup" ${describedBy(field)}>${options
    .map(
      (option) =>
        `<label class="pill"><input type="radio" name="${name}" value="${attr(option.value)}" ${value === option.value ? "checked" : ""}><span>${esc(option.label)}</span></label>`,
    )
    .join("")}</div>`;
}
const numberField = (id, label, value, min, max) =>
  `<label class="field inline-number" for="${id}"><span>${esc(label)}</span><input id="${id}" type="number" inputmode="numeric" min="${min}" max="${max}" value="${attr(value)}"></label>`;

function topicStep() {
  const topics = catalog?.topics ?? [];
  const grades = gradeList(topics);
  const visible = filterTopics(topics, { grade: form.grade, query: topicQuery });
  const levelOptions = Object.entries(t("levels")).map(([value, [label, hint]]) => ({
    value,
    label,
    hint,
  }));
  const list = visible
    .map((topic) => {
      const others = topic.grades.filter((grade) => grade !== form.grade).map(gradeName);
      const packName = localName(catalog.packs.find((pack) => pack.id === topic.pack)?.name);
      return `<label class="topic"><input type="radio" name="topic" value="${attr(topic.id)}" ${form.topic === topic.id ? "checked" : ""}><span class="topic-body"><strong>${esc(localName(topic.name))}</strong><small>${esc(packName)}${others.length ? ` · ${esc(tf("alsoFor", others.join(", ")))}` : ""}</small></span></label>`;
    })
    .join("");
  return `<fieldset class="q"><legend>${esc(t("grade"))}</legend><p class="muted small">${esc(t("gradeHint"))}</p>
      ${pills(
        "grade",
        grades.map((grade) => ({ value: grade, label: gradeName(grade) })),
        form.grade,
      )}${fieldError("grade")}</fieldset>
    <fieldset class="q"><legend>${esc(t("topic"))}</legend>
      <label class="search"><span class="sr-only">${esc(t("searchTopics"))}</span>${icon("book")}<input id="topic-search" type="search" placeholder="${attr(t("searchTopics"))}" value="${attr(topicQuery)}" maxlength="80"></label>
      <p class="muted small" aria-live="polite">${esc(tf("topicCount", visible.length))}</p>
      <div class="topic-list" role="radiogroup" aria-label="${attr(t("topic"))}" ${describedBy("topic")}>${list || `<p class="muted">${esc(t("noTopics"))}</p>`}</div>${fieldError("topic")}</fieldset>
    <fieldset class="q"><legend>${esc(t("level"))}</legend>${radioCards("level", levelOptions, form.level)}${fieldError("level")}</fieldset>`;
}

function questionsStep() {
  // Only the kinds of question the chosen topic can produce (the chat's round 2 offers the same).
  const offered = offeredTypes(catalog?.topics, form.topic);
  form.types = form.types.filter((type) => offered.includes(type));
  const types = offered.map((type) => [type, t("itemTypes")[type]]);
  return `<fieldset class="q"><legend>${esc(t("types"))}</legend><p class="muted small">${esc(t("typesHint"))}</p>
      <div class="choice-grid" ${describedBy("types")}>${types
        .map(
          ([value, [label, hint]]) =>
            `<label class="choice"><input type="checkbox" name="types" value="${value}" ${form.types.includes(value) ? "checked" : ""}><span class="choice-body"><strong>${esc(label)}</strong><small>${esc(hint)}</small></span></label>`,
        )
        .join("")}</div>${fieldError("types")}</fieldset>
    <fieldset class="q"><legend>${esc(t("count"))}</legend>${pills(
      "count",
      [
        ...["10", "15", "20"].map((n) => ({ value: n, label: n })),
        { value: "other", label: t("other") },
      ],
      form.count,
    )}${form.count === "other" ? numberField("count-text", t("otherNumber"), form.countText, 1, 100) : ""}${fieldError("count")}</fieldset>
    ${
      formCount(form) === 1
        ? ""
        : `<fieldset class="q"><legend>${esc(t("distribution"))}</legend>${radioCards(
            "distribution",
            [
              { value: "same", label: t("distributionSame")[0], hint: t("distributionSame")[1] },
              { value: "bank", label: t("distributionBank")[0], hint: t("distributionBank")[1] },
            ],
            form.distribution,
          )}${fieldError("distribution")}</fieldset>`
    }
    <fieldset class="q"><legend>${esc(t("columns"))}</legend>${pills(
      "columns",
      [
        { value: "1", label: t("columnsOne") },
        { value: "2", label: t("columnsTwo") },
      ],
      form.columns,
    )}</fieldset>`;
}

function bankStep() {
  const sizes = bankSizes(formCount(form) ?? 10);
  const options = [
    { value: "default", label: tf("bankDefault", sizes.standard) },
    ...(sizes.double !== undefined && sizes.double !== sizes.standard
      ? [{ value: "double", label: tf("bankDouble", sizes.double) }]
      : []),
    { value: "other", label: t("other") },
  ];
  return `<fieldset class="q"><legend>${esc(t("bankSize"))}</legend>${pills("bankSize", options, form.bankSize, "bank_size")}${
    form.bankSize === "other"
      ? numberField("bank-text", tf("bankOther", sizes.min), form.bankText, sizes.min, 400)
      : ""
  }${fieldError("bank_size")}</fieldset>
    <fieldset class="q"><legend>${esc(t("variants"))}</legend>${pills(
      "variants",
      [
        { value: "2", label: tf("variantsN", 2) },
        { value: "3", label: tf("variantsN", 3) },
        { value: "other", label: t("other") },
      ],
      form.variants,
    )}${form.variants === "other" ? numberField("variants-text", t("variantsOther"), form.variantsText, 1, 8) : ""}${fieldError("variants")}</fieldset>`;
}

function formatStep() {
  return `<fieldset class="q"><legend>${esc(t("pages"))}</legend>${pills(
    "pages",
    [
      { value: "auto", label: t("pagesAuto") },
      { value: "1", label: tf("pagesN", 1) },
      { value: "2", label: tf("pagesN", 2) },
      { value: "other", label: t("other") },
    ],
    form.pages,
  )}${form.pages === "other" ? numberField("pages-text", t("pagesOther"), form.pagesText, 1, 20) : ""}${fieldError("pages")}</fieldset>
    <fieldset class="q"><legend>${esc(t("time"))}</legend>${pills(
      "time",
      [
        ...Object.entries(t("times")).map(([value, label]) => ({ value, label })),
        { value: "other", label: t("timeOther") },
      ],
      form.time,
    )}${
      form.time === "other"
        ? `<div class="sub-fields">${numberField("minutes", t("minutes"), form.minutes, 5, 480)}
          <fieldset class="field"><legend>${esc(t("instrument"))}</legend>${pills(
            "instrument",
            Object.entries(t("instruments")).map(([value, label]) => ({ value, label })),
            form.instrument,
          )}</fieldset>
          <label class="check"><input type="checkbox" id="calculator" ${form.calculator ? "checked" : ""}><span>${esc(t("calculator"))}</span></label></div>`
        : ""
    }${fieldError("time")}</fieldset>
    <fieldset class="q"><legend>${esc(t("closing"))}</legend>${pills(
      "closing",
      Object.entries(t("closings")).map(([value, label]) => ({ value, label })),
      form.closing,
    )}</fieldset>
    <fieldset class="q"><legend>${esc(t("numbering"))}</legend>${radioCards(
      "numbering",
      Object.entries(t("numberings")).map(([value, label]) => ({ value, label })),
      form.numbering,
    )}</fieldset>`;
}

/** The live summary of the wizard: what the teacher chose so far, in plain words. */
function summaryLines() {
  const lines = [];
  const topic = catalog?.topics?.find((entry) => entry.id === form.topic);
  if (form.grade) lines.push([t("sheet").grade, gradeName(form.grade)]);
  if (topic) lines.push([t("sheet").theme, localName(topic.name)]);
  if (form.level) lines.push([t("sheet").level, t("levels")[form.level]?.[0] ?? form.level]);
  if (form.types.length)
    lines.push([t("types"), form.types.map((type) => t("itemTypes")[type][0]).join(", ")]);
  const count = formCount(form);
  if (count) lines.push([t("sheet").questions, String(count)]);
  if (count !== 1)
    lines.push([
      t("sheet").distribution,
      form.distribution === "bank" ? t("distributionBank")[0] : t("distributionSame")[0],
    ]);
  lines.push([t("columns"), form.columns === "2" ? t("columnsTwo") : t("columnsOne")]);
  lines.push([
    t("sheet").pages,
    form.pages === "auto"
      ? t("pagesAuto")
      : form.pages === "other"
        ? form.pagesText
        : tf("pagesN", Number(form.pages)),
  ]);
  lines.push([
    t("sheet").time,
    form.time === "other"
      ? `${tf("minutesN", form.minutes || "?")}, ${t("instruments")[form.instrument]}`
      : t("times")[form.time],
  ]);
  lines.push([t("sheet").closing, t("closings")[form.closing]]);
  return lines;
}

function renderWizard() {
  const list = steps();
  stepIndex = Math.min(stepIndex, list.length - 1);
  const step = list[stepIndex];
  const body = { topic: topicStep, questions: questionsStep, bank: bankStep, format: formatStep }[
    step
  ]();
  const last = stepIndex === list.length - 1;
  const lines = summaryLines();
  return `${topbar(t("newExam"))}<main class="page wizard">
    <div class="wizard-main"><p class="muted small">${esc(tf("stepOf", stepIndex + 1, list.length))}</p>
      <ol class="stepper" aria-label="${attr(t("newExam"))}">${list.map((name, i) => `<li class="${i === stepIndex ? "current" : i < stepIndex ? "done" : ""}" ${i === stepIndex ? 'aria-current="step"' : ""}>${esc(stepTitle(name))}</li>`).join("")}</ol>
      ${heading(stepTitle(step), "h1")}
      <div class="stack">${body}</div>
      <div class="row between nav-row">${button(stepIndex === 0 ? "home" : "wizard-back", `${icon("back")}<span>${esc(t("back"))}</span>`, "outline")}${
        last
          ? button(
              "wizard-review",
              `<span>${esc(t("review"))}</span>${icon("next")}`,
              "primary",
              'id="wizard-review"',
            )
          : button(
              "wizard-next",
              `<span>${esc(t("next"))}</span>${icon("next")}`,
              "primary",
              'id="wizard-next"',
            )
      }</div></div>
    <aside class="summary ${summaryOpen ? "open" : ""}" aria-label="${attr(t("summary"))}">
      <button type="button" class="summary-toggle ghost" data-action="toggle-summary" aria-expanded="${summaryOpen}">${esc(summaryOpen ? t("summaryHide") : t("summaryShow"))}</button>
      <div class="summary-sheet"><h2>${esc(t("summary"))}</h2>${
        lines.length
          ? `<dl>${lines.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`
          : `<p class="muted">${esc(t("summaryEmpty"))}</p>`
      }</div></aside></main>`;
}

/** Reads the visible step's inputs into the form (the form survives locale switches). */
function readStep() {
  const radio = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
  const value = (id) => document.getElementById(id)?.value;
  for (const name of [
    "grade",
    "topic",
    "level",
    "count",
    "distribution",
    "columns",
    "variants",
    "pages",
    "time",
    "instrument",
    "closing",
    "numbering",
  ]) {
    const chosen = radio(name);
    if (chosen !== undefined) form[name] = chosen;
  }
  const bank = radio("bankSize");
  if (bank !== undefined) form.bankSize = bank;
  if (document.querySelector('input[name="types"]'))
    form.types = [...document.querySelectorAll('input[name="types"]:checked')].map(
      (el) => el.value,
    );
  if (value("count-text") !== undefined) form.countText = value("count-text");
  if (value("bank-text") !== undefined) form.bankText = value("bank-text");
  if (value("variants-text") !== undefined) form.variantsText = value("variants-text");
  if (value("pages-text") !== undefined) form.pagesText = value("pages-text");
  if (value("minutes") !== undefined) form.minutes = value("minutes");
  const calculator = document.getElementById("calculator");
  if (calculator) form.calculator = calculator.checked;
}

async function submitWizard(replace = false) {
  const result = await mutate("draft.create", { answers: toAnswers(form), replace });
  if (result?.errors) {
    fieldErrors = Object.fromEntries(result.errors.map((error) => [error.field, error.code]));
    fieldCapacity = Object.fromEntries(
      result.errors
        .filter((error) => error.code === "capacity")
        .map((error) => [error.field, error.capacity ?? []]),
    );
    const step = stepOfField(result.errors[0]?.field);
    stepIndex = Math.max(0, steps().indexOf(step));
    focusTarget = "#view-heading";
    return render();
  }
  if (result?.confirm === "replace") {
    const ok = await confirmDialog(
      t("replaceTitle"),
      result.chatInterview ? t("replaceChat") : t("replaceDraft"),
      t("replaceOk"),
    );
    if (ok) return submitWizard(true);
    return;
  }
  wizardDirty = false;
  await loadStatus();
  await openReview();
}

// ---------- Review and Gate A ----------
async function openReview() {
  draftView = await api("draft.get");
  if (!draftView) return go({ name: "home" });
  go({ name: "review" });
}

function sheetRows(draft) {
  const s = t("sheet");
  const types = Object.entries(draft.itemTypes)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `${t("itemTypes")[type]?.[0] ?? type} ${n}`)
    .join(", ");
  return [
    [s.title, draft.title],
    [s.theme, draft.theme],
    [s.grade, gradeName(draft.grade)],
    [s.level, t("levels")[draft.level]?.[0] ?? draft.level],
    [s.questions, `${draft.questionCount} (${types})`],
    [
      s.distribution,
      draft.distribution === "bank"
        ? `${t("distributionBank")[0]} (${tf("bankLine", draft.bank?.size, draft.bank?.variants)})`
        : t("distributionSame")[0],
    ],
    [s.layout, draft.columns === 2 ? t("columnsTwo") : t("columnsOne")],
    [s.pages, draft.maxPages === "auto" ? t("pagesAuto") : tf("pagesN", draft.maxPages)],
    [
      s.time,
      `${tf("minutesN", draft.durationMinutes)}, ${t("instruments")[draft.instrument] ?? draft.instrument}, ${draft.calculator ? t("withCalculator") : t("withoutCalculator")}`,
    ],
    [s.closing, t("closings")[draft.closing?.kind] ?? draft.closing?.kind],
    [s.numbering, t("numberings")[draft.numbering] ?? draft.numbering],
    [s.schoolYear, String(draft.schoolYear)],
  ];
}

function renderReview() {
  const draft = draftView?.draft;
  if (!draft) return renderHome();
  const rows = sheetRows(draft);
  const blueprint = blueprintRows(draftView.blueprint);
  return `${topbar(t("reviewTitle"))}<main class="page narrow">${heading(t("reviewTitle"))}<p class="lead">${esc(t("reviewIntro"))}</p>
    <section class="paper copyable"><div class="paper-head"><span>${esc(draft.title)}</span>${copyButton("review")}</div>
      <dl class="sheet-rows">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>
      ${
        blueprint.length
          ? `<h3>${esc(t("blueprint"))}</h3><table class="grid"><thead><tr><th>${esc(t("blueprintType"))}</th><th>${esc(t("blueprintThinking"))}</th><th>${esc(t("blueprintCount"))}</th></tr></thead><tbody>${blueprint
              .map(
                (row) =>
                  `<tr><td>${esc(t("itemTypes")[row.type]?.[0] ?? row.type)}</td><td>${esc(t("cognitive")[row.cognitive] ?? row.cognitive)}</td><td>${row.count}</td></tr>`,
              )
              .join("")}</tbody></table>`
          : ""
      }
      <p class="note">${icon("file")}<span>${esc(tf("willBe", draftView.folderNumber))}</span></p></section>
    <div class="row between">${iconLabel("change-answers", "pencil", t("changeAnswers"))}${iconLabel("discard-draft", "trash", t("discard"), "ghost danger")}${button("approve-a", `${icon("check")}<span>${esc(t("approveA"))}</span>`, "primary", 'id="approve-a"')}</div></main>`;
}

// ---------- Exam ----------
function examSteps(exam) {
  const state = examStepState(exam.phase);
  return `<nav class="exam-steps" role="tablist" aria-label="${attr(tf("examNo", exam.number))}">${[
    "wording",
    "questions",
    "documents",
    "approve",
  ]
    .map(
      (name, i) =>
        `<button type="button" role="tab" data-action="exam-tab" data-tab="${name}" aria-selected="${view.tab === name}" ${state[name] ? "" : "disabled"}><span class="step-n">${i + 1}</span>${esc(t("examSteps")[name])}</button>`,
    )
    .join("")}</nav>`;
}

function renderExam() {
  const exam = activeExam();
  if (!exam) return renderHome();
  const panel = {
    wording: wordingPanel,
    questions: questionsPanel,
    documents: documentsPanel,
    approve: approvePanel,
  }[view.tab]?.(exam);
  return `${topbar(tf("examNo", exam.number))}<main class="page">
    <div class="exam-head"><div><p class="muted small">${esc(tf("examNo", exam.number))} · ${esc(gradeName(exam.grade))}</p>${heading(exam.theme)}</div><span class="phase-chip phase-${attr(exam.phase)}">${esc(phaseText(exam.phase))}</span></div>
    ${examSteps(exam)}<section class="exam-panel" role="tabpanel">${panel ?? ""}</section></main>`;
}

const copyButton = (ref) =>
  `<button type="button" class="icon-btn ghost" data-action="copy" data-copy="${attr(ref)}" aria-label="${attr(t("copyText"))}" title="${attr(t("copyText"))}">${icon("copy")}</button>`;

function templatePreview(template) {
  return templateParts(template)
    .map((part) =>
      part.math ? `<span class="chip math">${esc(t("mathChip"))}</span>` : esc(part.text),
    )
    .join("");
}
const markers = () => [messages.en.mathChip, messages.es.mathChip];

function wordingPanel(exam) {
  if (!wording) return `<p class="muted">${esc(t("loading"))}</p>`;
  const families = wording.families ?? [];
  const state = wordingState({ models, phase: exam.phase, job: wordingJob, families });
  const pendingDraft = wording.draft;
  const notices = [
    banner("warn", t("disclaimer"), "warning"),
    state.noModel ? banner("info", t("noModel")) : "",
    state.locked ? banner("info", t("wordingLocked"), "lock") : "",
    state.nothingToDraft ? banner("info", t("nothingToDraft")) : "",
    pendingDraft
      ? banner(
          "info",
          `${pendingDraft.model ? tf("modelUsed", modelName(pendingDraft.model)) : t("modelDefaultUsed")} ${pendingDraft.fallback ? t("fallbackNotice") : ""} ${pendingDraft.dropped ? tf("droppedNotice", pendingDraft.dropped) : ""}`,
          "sparkle",
        )
      : "",
  ].join("");
  const blocks = families
    .map((family) => {
      const editing = edits[family.id];
      const saved = family.templates ?? [];
      const editor = editing
        ? `<div class="sentences">${editing
            .map((template, index) => {
              const problem = templateProblem(template);
              const id = `tpl-${family.id}-${index}`;
              return `<div class="sentence"><label for="${id}" class="sr-only">${esc(tf("sentence", index + 1))}</label>
                <textarea id="${id}" data-family="${attr(family.id)}" data-index="${index}" rows="2" maxlength="260" ${problem ? `aria-invalid="true" aria-describedby="${id}-err"` : ""}>${esc(toEditable(template, t("mathChip")))}</textarea>
                <div class="sentence-tools">${button("insert-math", `${icon("plus")}<span>${esc(t("insertMath"))}</span>`, "ghost small", `data-family="${attr(family.id)}" data-index="${index}"`)}${button("remove-sentence", esc(t("removeSentence")), "ghost small", `data-family="${attr(family.id)}" data-index="${index}"`)}</div>
                <p class="preview">${templatePreview(template)}</p>
                ${problem ? `<p class="field-error" id="${id}-err">${icon("warning")}${esc(problem === "needsMath" ? t("needsMath") : t("fieldErrors").invalid)}</p>` : ""}</div>`;
            })
            .join(
              "",
            )}${editing.length < MAX_TEMPLATES ? button("add-sentence", `${icon("plus")}<span>${esc(t("addSentence"))}</span>`, "ghost", `data-family="${attr(family.id)}"`) : ""}<p class="muted small">${esc(t("mathHint"))}</p></div>`
        : saved.length
          ? `<ul class="saved">${saved.map((template) => `<li>${templatePreview(template)}</li>`).join("")}</ul>`
          : `<p class="muted">${esc(t("defaultWording"))}</p>`;
      return `<article class="family copyable"><header><h3>${esc(familyLabel(family.id))}</h3>${copyButton(`family:${family.id}`)}</header>
        <div class="sample"><span class="muted small">${esc(t("sample"))}</span><div class="math-sample">${family.sampleHtml}</div></div>
        <div>${editing ? "" : `<span class="muted small">${esc(t("current"))}</span>`}${editor}</div>
        ${
          state.locked
            ? ""
            : `<div class="row">${editing ? "" : iconLabel("write-myself", "pencil", t("writeMyself"), "outline small", `data-family="${attr(family.id)}"`)}${saved.length || editing ? button("use-default", esc(t("useDefault")), "ghost small", `data-family="${attr(family.id)}"`) : ""}</div>`
        }</article>`;
    })
    .join("");
  const actions = state.locked
    ? ""
    : `<div class="row between sticky-actions">${
        state.drafting
          ? `<span class="muted">${icon("sparkle")}${esc(t("drafting"))}</span>`
          : iconLabel(
              "draft-ai",
              "sparkle",
              t("draftWithAi"),
              "outline",
              state.canDraft ? 'id="draft-ai"' : 'id="draft-ai" disabled',
            )
      }${button("save-wording", `${icon("check")}<span>${esc(t("saveWording"))}</span>`, "primary", 'id="save-wording"')}</div>`;
  return `<h2>${esc(t("wordingTitle"))}</h2><p class="muted">${esc(t("wordingIntro"))}</p>${notices}<div class="families">${blocks}</div>${actions}`;
}
const modelName = (reference) =>
  models?.models?.find((m) => m.reference === reference)?.label ?? reference;

function questionsPanel(exam) {
  const editable = EDITABLE_PHASES.includes(exam.phase);
  const list = items?.items ?? [];
  const notices = generationNotices(generationResult);
  const blocked = notices.technical.length
    ? `<div class="banner warn" role="alert">${icon("warning")}<div><strong>${esc(t("generationBlocked"))}</strong><ul>${[
        ...notices.capacity.map((entry) => `<li class="capacity">${esc(capacityText(entry))}</li>`),
        ...notices.others.map(
          (finding) =>
            `<li>${esc(finding.message)} <small class="muted">${esc(finding.id)}</small></li>`,
        ),
      ].join("")}</ul>${
        notices.capacity.length
          ? `<details class="technical"><summary class="small">${esc(t("technicalDetails"))}</summary><ul class="small muted">${notices.technical.map((finding) => `<li>${esc(finding.message)} <code>${esc(finding.id)}</code></li>`).join("")}</ul></details>`
          : ""
      }</div></div>`
    : "";
  const cards = list
    .map(
      (
        item,
      ) => `<li class="item"><div class="item-head"><span class="item-n">${esc(tf("questionN", item.n))}</span><span class="badge">${esc(t("itemTypes")[item.type]?.[0] ?? item.type)}</span></div>
        <div class="stem math-sample">${item.stemHtml}</div>
        ${item.options.length ? `<ol class="options">${item.options.map((option) => `<li class="${showAnswers && option.correct ? "correct" : ""}"><span class="key">${esc(option.key)}</span><span>${option.html}</span>${showAnswers && option.correct ? icon("check") : ""}</li>`).join("")}</ol>` : ""}
        ${showAnswers ? `<p class="answer"><strong>${esc(t("answer"))}:</strong> <span class="math-sample">${item.answerHtml}</span></p>` : ""}</li>`,
    )
    .join("");
  return `<div class="row between"><h2>${esc(t("questionsTitle"))}</h2>${list.length ? `<label class="check"><input type="checkbox" id="show-answers" ${showAnswers ? "checked" : ""}><span>${esc(t("showAnswers"))}</span></label>` : ""}</div>
    ${blocked}
    ${editable ? `<div class="row">${button("generate", `${icon("sparkle")}<span>${esc(list.length ? t("generateAgain") : t("generate"))}</span>`, list.length ? "outline" : "primary", 'id="generate"')}</div>` : ""}
    ${list.length ? `<ol class="items">${cards}</ol>${items.total > list.length ? button("more-items", esc(t("moreItems")), "ghost") : ""}` : `<p class="muted">${esc(t("questionsEmpty"))}</p>`}`;
}

function buildStatus() {
  if (!buildJob)
    return buildMessage ? `<p class="muted" role="status">${esc(buildMessage)}</p>` : "";
  const job = jobStates.get(buildJob);
  const progress = buildProgress(job);
  return `<div class="progress-box"><div class="progress-label"><strong>${esc(tf(progress.key, ...progress.args))}</strong><span>${progress.percent}%</span></div>
    <div class="bar" role="progressbar" aria-label="${attr(t("createDocs"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress.percent}"><span style="width:${progress.percent}%"></span></div>
    <div class="row end">${button("cancel-build", esc(t("cancelBuild")), "outline small")}</div></div>`;
}

function docTabs() {
  return `<div class="doc-tabs" role="tablist">${Object.entries(t("docs"))
    .map(
      ([doc, label]) =>
        `<button type="button" role="tab" data-action="doc-tab" data-doc="${doc}" aria-selected="${docTab === doc}">${esc(label)}</button>`,
    )
    .join("")}</div>`;
}

function viewerBlock(exam, state) {
  if (!state.hasHtml && !state.hasPdf) return `<p class="muted">${esc(t("noDocsYet"))}</p>`;
  const info = docInfo[`${exam.id}:${docTab}`];
  return `${docTabs()}<div class="row doc-actions">${state.hasPdf ? iconLabel("download-doc", "download", t("downloadPdf"), "outline small", 'data-format="pdf"') : ""}${state.hasHtml ? iconLabel("download-doc", "download", t("downloadHtml"), "outline small", 'data-format="html"') : ""}${info?.pages ? `<span class="muted small">${esc(tf("pagesN", info.pages))}</span>` : ""}</div>
    <div class="viewer" id="viewer" data-exam="${attr(exam.id)}" data-doc="${attr(docTab)}" data-format="${state.hasPdf ? "pdf" : "html"}" aria-live="polite"><p class="muted">${esc(t("loading"))}</p></div>`;
}

function findingsBlock(state) {
  if (!state.findings.length) return "";
  return `<section class="findings copyable"><header><h3>${esc(t("findingsTitle"))}</h3>${copyButton("findings")}</header><ul>${state.findings
    .map(
      (finding) =>
        `<li class="${finding.severity}">${icon(finding.severity === "error" ? "warning" : "info")}<span>${esc(findingText(finding))} <small class="muted">${esc(finding.id)}</small></span></li>`,
    )
    .join("")}</ul></section>`;
}

function documentsPanel(exam) {
  const state = documentsState({ exam, lastBuild: status.lastBuild, doctor, job: buildJob });
  return `<div class="row between"><h2>${esc(t("documentsTitle"))}</h2>${state.canBuild ? button("build", `${icon("print")}<span>${esc(state.hasHtml ? t("rebuild") : t("createDocs"))}</span>`, state.hasHtml ? "outline" : "primary", 'id="build"') : ""}</div>
    ${state.noBrowser ? banner("info", t("noBrowser"), "print") : ""}
    <div id="build-status">${buildStatus()}</div>
    ${findingsBlock(state)}
    ${viewerBlock(exam, state)}`;
}

function approvePanel(exam) {
  if (exam.phase === "approved-b")
    return `<div class="done-box">${icon("check", "icon big")}<div><h2>${esc(t("approvedTitle"))}</h2><p>${esc(t("approvedText"))}</p></div></div>`;
  if (exam.phase !== "built") return `<p class="muted">${esc(t("notBuiltYet"))}</p>`;
  const state = documentsState({ exam, lastBuild: status.lastBuild, doctor });
  return `<h2>${esc(t("approveTitle"))}</h2><p class="muted">${esc(t("approveIntro"))}</p>${findingsBlock(state)}
    <div class="row end">${button("approve-b", `${icon("check")}<span>${esc(t("approveB"))}</span>`, "primary", 'id="approve-b"')}</div>`;
}

// ---------- Archive (older exams: read only, Q3) ----------
function renderArchive() {
  const exam = status.exams.find((entry) => entry.id === view.examId);
  if (!exam) return renderHome();
  const state = documentsState({ exam, lastBuild: null, doctor: null });
  return `${topbar(tf("examNo", exam.number))}<main class="page">
    <div class="exam-head"><div><p class="muted small">${esc(tf("examNo", exam.number))} · ${esc(gradeName(exam.grade))}</p>${heading(exam.theme)}</div><span class="phase-chip phase-${attr(exam.phase)}">${esc(phaseText(exam.phase))}</span></div>
    ${banner("info", t("readOnlyHint"), "lock")}${viewerBlock(exam, state)}</main>`;
}

// ---------- Settings ----------
function renderSettings() {
  const list = models?.models ?? [];
  const groups = new Map();
  for (const m of list) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  const options = [...groups.entries()]
    .map(
      ([provider, entries]) =>
        `<optgroup label="${attr(provider)}">${entries.map((m) => `<option value="${attr(m.reference)}" ${m.reference === models.chosen ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</optgroup>`,
    )
    .join("");
  const packs = catalog?.packs ?? [];
  const kbHtml = packs
    .map((pack) => {
      const topics = (catalog.topics ?? []).filter((topic) => topic.pack === pack.id);
      return `<details class="pack"><summary><strong>${esc(localName(pack.name))}</strong> <span class="muted small">${esc(tf("topicCount", topics.length))}</span></summary><table class="grid"><thead><tr><th>${esc(t("topicsLabel"))}</th><th>${esc(t("gradesLabel"))}</th><th>${esc(t("levelsLabel"))}</th></tr></thead><tbody>${topics
        .map(
          (topic) =>
            `<tr><td>${esc(localName(topic.name))}</td><td>${esc(topic.grades.map(gradeName).join(", "))}</td><td>${esc(topic.levels.map((level) => t("levels")[level]?.[0] ?? level).join(", "))}</td></tr>`,
        )
        .join("")}</tbody></table></details>`;
    })
    .join("");
  return `${topbar(t("settingsTitle"))}<main class="page narrow">${heading(t("settingsTitle"))}
    <section class="panel"><h2>${esc(t("modelTitle"))}</h2>${
      models?.available
        ? `<label class="field" for="model-select"><span>${esc(t("modelLabel"))}</span><select id="model-select"><option value="" ${models.chosen ? "" : "selected"}>${esc(t("modelDefault"))}</option>${options}</select></label>`
        : banner("info", t("modelNone"))
    }</section>
    <section class="panel"><h2>${esc(t("doctorTitle"))}</h2>${doctor ? banner(doctor.browser === "found" ? "ok" : "info", doctor.browser === "found" ? t("browserFound") : t("browserMissing"), doctor.browser === "found" ? "check" : "print") : `<p class="muted">${esc(t("loading"))}</p>`}</section>
    <section class="panel"><div class="row between"><h2>${esc(t("kbTitle"))}</h2>${iconLabel("kb-check", "check", t("kbCheck"), "outline small", 'id="kb-check"')}</div>
      ${kb ? (kb.ok && !kb.findings.length ? banner("ok", t("kbOk"), "check") : banner("warn", tf("kbProblems", kb.findings.length))) : ""}
      <div class="packs">${kbHtml}</div></section>
    <details class="panel technical"><summary>${esc(t("technical"))}</summary><dl class="sheet-rows">
      ${doctor ? `<div><dt>browser</dt><dd>${esc(doctor.browser)} (${esc(doctor.source)})</dd></div><div><dt>kb</dt><dd>${doctor.kbOk ? "ok" : esc(doctor.kbErrors)}</dd></div>` : ""}
      ${(status.exams ?? []).map((exam) => `<div><dt>${esc(exam.id)}</dt><dd>${esc(exam.folder)} · ${esc(exam.phase)}</dd></div>`).join("")}
      ${kb?.findings?.length ? kb.findings.map((finding) => `<div><dt>${esc(finding.id)}</dt><dd>${esc(finding.subject)}: ${esc(finding.message)}</dd></div>`).join("") : ""}
    </dl></details></main>`;
}

// ---------- After render: viewers ----------
function afterRender() {
  const viewer = document.querySelector("#viewer");
  if (viewer) void showDocument(viewer);
}

const docCache = new Map();
async function fetchDoc(examId, doc, format) {
  const key = `${status.revision}:${examId}:${doc}:${format}`;
  if (!docCache.has(key)) {
    if (docCache.size > 8) docCache.delete(docCache.keys().next().value);
    docCache.set(key, api("docs.get", { examId, doc, format }));
  }
  try {
    return await docCache.get(key);
  } catch (error) {
    docCache.delete(key);
    throw error;
  }
}
function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function showDocument(holder) {
  const { exam, doc, format } = holder.dataset;
  try {
    const file = await fetchDoc(exam, doc, format);
    if (!holder.isConnected) return;
    if (format === "pdf" && typeof globalThis.evaluaRenderPdf === "function") {
      await globalThis.evaluaRenderPdf(
        holder,
        new Blob([bytesFromBase64(file.base64)], { type: "application/pdf" }),
        {
          pageLabel: (i, n) => tf("pageOf", i, n),
          onInfo: ({ pages }) => (docInfo[`${exam}:${doc}`] = { pages }),
          failed: t("previewUnavailable"),
        },
      );
      return;
    }
    renderHtmlPreview(holder, new TextDecoder().decode(bytesFromBase64(file.base64)));
  } catch (error) {
    if (holder.isConnected) holder.textContent = t("previewUnavailable");
    if (error?.transport) fail(error);
  }
}

/**
 * Shows an exam document's own markup inside a shadow root with its own styles, so the frame's
 * CSS and the document's never mix. Scripts and inline handlers are dropped.
 */
function renderHtmlPreview(holder, html) {
  try {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    for (const el of parsed.querySelectorAll("script, iframe, object, embed, link")) el.remove();
    for (const el of parsed.querySelectorAll("*"))
      for (const name of el.getAttributeNames())
        if (name.startsWith("on") || /^\s*javascript:/i.test(el.getAttribute(name) ?? ""))
          el.removeAttribute(name);
    const css = [...parsed.querySelectorAll("style")]
      .map((style) => style.textContent)
      .join("\n")
      .replace(/:root/g, ":host")
      .replace(/\bhtml\s*,\s*body\b/g, ".doc-body")
      .replace(/(^|[\s,}])body(?=[\s.{,:])/g, "$1.doc-body");
    const sheet = document.createElement("div");
    sheet.className = "html-sheet";
    holder.replaceChildren(sheet);
    const shadow = sheet.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>:host{display:block;background:#fff;color:#111}${css}</style><div class="doc-body ${attr(parsed.body.className)}">${parsed.body.innerHTML}</div>`;
  } catch {
    holder.textContent = t("previewUnavailable");
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- Data ----------
async function loadStatus() {
  status = await api("status");
}
async function loadCatalog() {
  if (!catalog) catalog = await api("catalog.list");
}
async function loadModels() {
  try {
    models = await api("models.list");
  } catch {
    // Keep the last known list; transport problems are handled by the not_found check.
  }
}
async function loadDoctor() {
  try {
    doctor = await api("doctor");
  } catch {
    doctor = undefined;
  }
}
async function loadWording() {
  wording = await api("wording.get");
  edits = {};
  for (const family of wording.families ?? [])
    if (family.draft) edits[family.id] = [...family.draft];
  wordingDirty = Object.keys(edits).length > 0;
  wordingJob = wording.job?.state === "running" ? wording.job.id : undefined;
}
async function loadItems(limit = 50) {
  items = await api("items.get", { offset: 0, limit: Math.min(50, limit) });
  if (limit > 50 && items.total > 50) {
    const more = await api("items.get", { offset: 50, limit: 50 });
    items = { total: items.total, items: [...items.items, ...more.items] };
  }
}

async function openExam(id) {
  const exam = status.exams.find((entry) => entry.id === id);
  if (!exam) return;
  if (!exam.active) return go({ name: "archive", examId: id });
  await Promise.all([loadModels(), loadDoctor()]);
  const tab = nextExamStep(exam.phase);
  await openTab(tab, exam);
}
async function openTab(tab, exam = activeExam()) {
  if (!exam) return go({ name: "home" });
  if (tab === "wording" && EDITABLE_PHASES.includes(exam.phase)) await loadWording();
  if (tab === "questions") await loadItems();
  view = { name: "exam", tab };
  focusTarget = "#view-heading";
  render();
}

/** Visible again: refresh what the chat may have changed while hidden. */
async function refreshOnShow() {
  try {
    await reloadView();
  } catch (error) {
    fail(error);
  }
  void poll();
}
/** After the app comes back from the unavailable state. */
async function reloadAll() {
  catalog = undefined;
  await reloadView();
}
/** Re-reads the status and the data of the open view (after `state_changed`, too). */
async function reloadView() {
  await loadStatus();
  if (view.name === "exam") {
    const exam = activeExam();
    if (!exam) view = { name: "home" };
    else {
      if (!examStepState(exam.phase)[view.tab]) view.tab = nextExamStep(exam.phase);
      if (view.tab === "wording" && !wordingDirty && EDITABLE_PHASES.includes(exam.phase))
        await loadWording();
      if (view.tab === "questions") await loadItems(items?.items?.length ?? 50);
    }
  }
  if (view.name === "review") {
    draftView = await api("draft.get");
    if (!draftView) view = { name: "home" };
  }
  if (view.name === "settings") await Promise.all([loadModels(), loadDoctor(), loadCatalog()]);
  render({ keepFocus: true });
}

function track(kind, jobId) {
  if (kind === "build") buildJob = jobId;
  else wordingJob = jobId;
  jobStates.set(jobId, { state: "running", step: 0, total: 0, phase: "" });
}

let pollBusy = false;
async function poll() {
  if (!visible || pollBusy || unavailable) return;
  const ids = [buildJob, wordingJob].filter(Boolean);
  if (ids.length === 0) return;
  pollBusy = true;
  try {
    for (const id of ids) {
      let job;
      try {
        job = await api("jobs.get", { jobId: id });
      } catch (error) {
        // A plugin not_found (the job is gone, e.g. Alisio restarted the plugin) only stops polling.
        if (!error.transport && error.message === "not_found") {
          if (id === buildJob) buildJob = undefined;
          if (id === wordingJob) wordingJob = undefined;
          render({ keepFocus: true });
        }
        continue;
      }
      jobStates.set(id, job);
      const state = jobView(job);
      if (id === buildJob) {
        if (state.running) {
          const el = document.querySelector("#build-status");
          if (el) el.innerHTML = buildStatus();
          const progress = buildProgress(job);
          announce(tf(progress.key, ...progress.args));
        } else await buildFinished(job);
      } else if (id === wordingJob && !state.running) await wordingFinished(job);
    }
  } finally {
    pollBusy = false;
  }
}

async function buildFinished(job) {
  buildJob = undefined;
  const state = jobView(job);
  buildMessage = state.done
    ? t("buildDone")
    : state.cancelled
      ? t("buildCancelled")
      : `${t("buildFailed")} ${errorText(state.error)}`;
  announce(buildMessage);
  docCache.clear();
  await loadStatus();
  render({ keepFocus: true });
}
async function wordingFinished(job) {
  wordingJob = undefined;
  const state = jobView(job);
  if (state.done) {
    await loadWording();
    toast(t("draftReady"));
    announce(t("draftReady"));
  } else if (!state.cancelled) toast(errorText(state.error, state.detail));
  render({ keepFocus: true });
}

// ---------- Dialogs ----------
function confirmDialog(title, message, okLabel) {
  return new Promise((resolve) => {
    dialog.innerHTML = `<div class="dialog-body"><h2>${esc(title)}</h2><p>${esc(message)}</p><div class="row end">${button("dialog-cancel", esc(t("cancel")))}${button("dialog-ok", esc(okLabel), "primary")}</div></div>`;
    const done = (value) => {
      dialog.close();
      dialog.onclick = null;
      resolve(value);
    };
    dialog.onclick = (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "dialog-ok") done(true);
      if (action === "dialog-cancel") done(false);
    };
    dialog.oncancel = () => resolve(false);
    dialog.showModal();
    dialog.querySelector('[data-action="dialog-ok"]')?.focus();
  });
}
function confirmFindings(findings) {
  return new Promise((resolve) => {
    dialog.innerHTML = `<div class="dialog-body"><h2>${esc(t("approveTitle"))}</h2><p>${esc(t("confirmProblems"))}</p><ul class="findings-list">${findings.map((finding) => `<li>${icon("warning")}<span>${esc(findingText(finding))}</span></li>`).join("")}</ul><div class="row end">${button("dialog-cancel", esc(t("cancel")))}${button("dialog-ok", esc(t("confirmProblemsOk")), "primary")}</div></div>`;
    dialog.onclick = (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "dialog-ok" || action === "dialog-cancel") {
        dialog.close();
        dialog.onclick = null;
        resolve(action === "dialog-ok");
      }
    };
    dialog.oncancel = () => resolve(false);
    dialog.showModal();
  });
}
function manualCopy(text) {
  dialog.innerHTML = `<div class="dialog-body"><p class="lead">${esc(t("copyManual"))}</p><textarea id="copy-area" class="copy-area" readonly rows="8">${esc(text)}</textarea><div class="row end">${button("dialog-cancel", esc(t("close")))}</div></div>`;
  dialog.onclick = (event) => {
    if (event.target.closest("[data-action]")?.dataset.action === "dialog-cancel") dialog.close();
  };
  dialog.showModal();
  const area = dialog.querySelector("#copy-area");
  area?.select();
  area?.focus();
}

/** What a copy button copies: the review summary, a family's wording, or the findings. */
function copySource(ref) {
  if (ref === "review" && draftView?.draft)
    return {
      title: draftView.draft.title,
      lines: sheetRows(draftView.draft).map(([label, value]) => `${label}: ${value}`),
    };
  if (ref === "findings")
    return {
      title: t("findingsTitle"),
      lines: (status.lastBuild?.findings ?? []).map(findingText),
    };
  if (ref.startsWith("family:")) {
    const id = ref.slice(7);
    const family = wording?.families?.find((entry) => entry.id === id);
    const list = edits[id] ?? family?.templates ?? [];
    return {
      title: familyLabel(id),
      lines: list.map((template) => toEditable(template, t("mathChip"))),
    };
  }
  return undefined;
}

// ---------- Actions ----------
async function handle(action, target) {
  switch (action) {
    case "retry":
      target.setAttribute("disabled", "");
      return verifyAvailable();
    case "home":
      if (view.name === "wizard") readStep();
      return go({ name: "home" });
    case "profile":
      fieldErrors = {};
      return go({ name: "profile" });
    case "settings":
      await Promise.all([loadModels(), loadDoctor(), loadCatalog()]);
      return go({ name: "settings" });
    case "new-exam":
      if (!status.profile) {
        fieldErrors = {};
        return go({ name: "profile", after: "wizard" });
      }
      await loadCatalog();
      form = emptyForm();
      stepIndex = 0;
      fieldErrors = {};
      topicQuery = "";
      wizardDirty = false;
      return go({ name: "wizard" });
    case "open-review":
      return openReview();
    case "open-exam":
      return openExam(target.dataset.id);
    case "save-profile": {
      const profile = readProfileForm();
      fieldErrors = {};
      for (const key of ["teacherName", "institution", "subject"])
        if (!profile[key]) fieldErrors[key] = "required";
      if (Object.keys(fieldErrors).length) {
        view.draftProfile = profile;
        render();
        return document.querySelector('[aria-invalid="true"]')?.focus();
      }
      view.draftProfile = profile;
      await mutate("profile.save", profile);
      view.draftProfile = undefined;
      await loadStatus();
      toast(t("profileSaved"));
      if (pendingLogo) {
        const logo = pendingLogo;
        pendingLogo = undefined;
        try {
          await mutate("profile.setLogo", { dataBase64: logo.dataBase64, mime: logo.mime });
        } catch (error) {
          // The profile is saved; the logo can be chosen again from the profile page.
          fail(error);
        }
        await loadStatus();
      }
      if (view.after === "wizard") return handle("new-exam", target);
      return render();
    }
    case "choose-logo":
      return document.querySelector("#logo-input")?.click();
    case "remove-logo":
      if (!status.profile) {
        view.draftProfile = readProfileForm();
        pendingLogo = undefined;
        return render({ keepFocus: true });
      }
      await mutate("profile.removeLogo");
      await loadStatus();
      return render();
    case "wizard-next": {
      readStep();
      const step = steps()[stepIndex];
      const missing = missingFields(form, step);
      fieldErrors = Object.fromEntries(missing.map((field) => [field, "required"]));
      if (missing.length) {
        render();
        return document
          .querySelector('[aria-invalid="true"] input, [aria-invalid="true"]')
          ?.focus();
      }
      stepIndex += 1;
      focusTarget = "#view-heading";
      return render();
    }
    case "wizard-back":
      readStep();
      fieldErrors = {};
      stepIndex = Math.max(0, stepIndex - 1);
      focusTarget = "#view-heading";
      return render();
    case "wizard-review": {
      readStep();
      const missing = missingFields(form, steps()[stepIndex]);
      fieldErrors = Object.fromEntries(missing.map((field) => [field, "required"]));
      if (missing.length) return render();
      return submitWizard(false);
    }
    case "toggle-summary":
      summaryOpen = !summaryOpen;
      readStep();
      return render({ keepFocus: true });
    case "change-answers": {
      await loadCatalog();
      const draft = draftView.draft;
      const grade = gradeList(catalog.topics).find((g) => g === draft.grade) ?? draft.grade;
      form = draftToForm(draft, grade);
      stepIndex = 0;
      fieldErrors = {};
      return go({ name: "wizard" });
    }
    case "discard-draft":
      if (!(await confirmDialog(t("discard"), t("discardConfirm"), t("discard")))) return;
      await mutate("draft.discard");
      await loadStatus();
      return go({ name: "home" });
    case "approve-a": {
      const result = await mutate("exam.approveA");
      await loadStatus();
      return openExam(result.examId);
    }
    case "exam-tab":
      return openTab(target.dataset.tab);
    case "write-myself":
      edits[target.dataset.family] = [`{expr}`];
      wordingDirty = true;
      return render({ keepFocus: true });
    case "use-default":
      edits[target.dataset.family] = [];
      wordingDirty = true;
      return render({ keepFocus: true });
    case "add-sentence": {
      const list = edits[target.dataset.family];
      if (list && list.length < MAX_TEMPLATES) list.push("{expr}");
      return render({ keepFocus: true });
    }
    case "remove-sentence":
      edits[target.dataset.family]?.splice(Number(target.dataset.index), 1);
      return render({ keepFocus: true });
    case "insert-math": {
      const id = `tpl-${target.dataset.family}-${target.dataset.index}`;
      const area = document.getElementById(id);
      if (!area) return;
      const at = area.selectionStart ?? area.value.length;
      const marker = `[${t("mathChip")}]`;
      area.value = `${area.value.slice(0, at)}${marker}${area.value.slice(area.selectionEnd ?? at)}`;
      edits[target.dataset.family][Number(target.dataset.index)] = fromEditable(
        area.value,
        markers(),
      );
      render({ keepFocus: true });
      return document.getElementById(id)?.focus();
    }
    case "draft-ai": {
      const { jobId } = await mutate("wording.draft");
      // No job: the exam has nothing to word (bank questions only).
      if (!jobId) {
        await loadWording();
        toast(t("nothingToDraft"));
        return render({ keepFocus: true });
      }
      track("wording", jobId);
      render({ keepFocus: true });
      return poll();
    }
    case "save-wording": {
      const prompts = promptsToSave(wording.families, edits);
      const result = await mutate("wording.save", { prompts });
      wordingDirty = false;
      generationResult = result.findings?.length ? result : undefined;
      await loadStatus();
      await loadWording();
      toast(
        result.regenerated
          ? t("wordingRegenerated")
          : result.blocked
            ? t("wordingSavedBlocked")
            : t("wordingSaved"),
      );
      if (result.dropped) toast(tf("droppedNotice", result.dropped));
      return render({ keepFocus: true });
    }
    case "generate": {
      const result = await mutate("exam.generate");
      generationResult = result.findings?.length ? result : undefined;
      await loadStatus();
      await loadItems();
      announce(result.count ? tf("generated", result.count) : t("generationBlocked"));
      return render({ keepFocus: true });
    }
    case "more-items":
      await loadItems(100);
      return render({ keepFocus: true });
    case "build": {
      buildMessage = undefined;
      const { jobId } = await mutate("build.start");
      track("build", jobId);
      render({ keepFocus: true });
      return poll();
    }
    case "cancel-build":
      if (buildJob) await api("jobs.cancel", { jobId: buildJob });
      return;
    case "doc-tab":
      docTab = target.dataset.doc;
      return render({ keepFocus: true });
    case "download-doc": {
      const exam = view.name === "archive" ? view.examId : status.activeExamId;
      const file = await fetchDoc(exam, docTab, target.dataset.format);
      return downloadBlob(new Blob([bytesFromBase64(file.base64)], { type: file.mime }), file.name);
    }
    case "approve-b": {
      const examId = status.activeExamId;
      let result = await mutate("exam.approveB", { examId });
      if (result?.confirm === "findings") {
        if (!(await confirmFindings(result.findings))) return;
        result = await mutate("exam.approveB", { examId, acknowledgeFindings: true });
      }
      await loadStatus();
      return render({ keepFocus: true });
    }
    case "kb-check":
      kb = await api("kb.check");
      return render({ keepFocus: true });
    case "copy": {
      const source = copySource(target.dataset.copy);
      if (!source) return;
      const text = copyText(source);
      const path = await writeClipboard(text);
      if (path === "manual") return manualCopy(text);
      toast(t("copied"));
      return announce(t("copied"));
    }
  }
}

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  handle(target.dataset.action, target).catch(fail);
});
root.addEventListener("change", (event) => {
  const target = event.target;
  if (target.id === "logo-input") {
    const file = target.files?.[0];
    target.value = "";
    if (!file) return;
    const problem = checkLogo(file);
    if (problem) return toast(errorText(problem));
    (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const dataBase64 = btoa(binary);
      if (!status.profile) {
        // Keep the unsaved form values across the re-render that shows the preview.
        view.draftProfile = readProfileForm();
        pendingLogo = {
          dataBase64,
          mime: file.type,
          preview: `data:${file.type};base64,${dataBase64}`,
        };
        return render({ keepFocus: true });
      }
      await mutate("profile.setLogo", { dataBase64, mime: file.type });
      await loadStatus();
      render();
    })().catch(fail);
    return;
  }
  if (target.id === "model-select") {
    const reference = target.value || null;
    api("models.choose", { reference })
      .then(() => {
        models.chosen = reference;
        toast(t("modelSaved"));
      })
      .catch((error) => {
        fail(error);
        render({ keepFocus: true });
      });
    return;
  }
  if (target.id === "show-answers") {
    showAnswers = target.checked;
    return render({ keepFocus: true });
  }
  if (view.name === "wizard") {
    wizardDirty = true;
    readStep();
    if (fieldErrors[target.name]) delete fieldErrors[target.name];
    // Choosing a grade, the count, the distribution or "other" changes what the step shows.
    if (
      ["grade", "count", "distribution", "bankSize", "variants", "pages", "time"].includes(
        target.name,
      ) ||
      target.name === "types"
    ) {
      if (target.name === "grade" && form.topic) {
        const topic = catalog?.topics?.find((entry) => entry.id === form.topic);
        if (topic && !topic.grades.includes(form.grade)) form.topic = "";
      }
      render({ keepFocus: true });
      document
        .querySelector(`input[name="${target.name}"][value="${CSS.escape(target.value)}"]`)
        ?.focus();
    } else {
      const aside = document.querySelector(".summary-sheet");
      if (aside) {
        const html = renderWizard();
        const fresh = new DOMParser()
          .parseFromString(html, "text/html")
          .querySelector(".summary-sheet");
        if (fresh) aside.innerHTML = fresh.innerHTML;
      }
    }
  }
});
root.addEventListener("input", (event) => {
  const target = event.target;
  if (target.id === "topic-search") {
    topicQuery = target.value;
    readStep();
    const position = target.selectionStart;
    render({ keepFocus: true });
    const search = document.getElementById("topic-search");
    search?.focus();
    search?.setSelectionRange?.(position, position);
    return;
  }
  if (target.dataset.family !== undefined && target.tagName === "TEXTAREA") {
    const list = edits[target.dataset.family];
    if (list) list[Number(target.dataset.index)] = fromEditable(target.value, markers());
    wordingDirty = true;
    const box = target.closest(".sentence");
    const preview = box?.querySelector(".preview");
    if (preview) preview.innerHTML = templatePreview(list?.[Number(target.dataset.index)]);
    return;
  }
  if (view.name === "wizard") wizardDirty = true;
});
root.addEventListener("keydown", (event) => {
  // Enter on a choice moves on, like the buttons; the frame has no form submits.
  if (
    event.key === "Enter" &&
    view.name === "wizard" &&
    event.target.matches?.("input[type=radio],input[type=number]")
  ) {
    event.preventDefault();
    document.querySelector("#wizard-next, #wizard-review")?.click();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (wizardDirty || wordingDirty) {
    event.preventDefault();
    event.returnValue = t("unsaved");
  }
});

/** Read by the visual check: the open view and the copy path. */
globalThis.evaluaView = () => ({
  view: view.name,
  tab: view.tab,
  locale,
  step: steps()[stepIndex],
  form: { ...form },
});

// ---------- Start ----------
await connected;
render();
try {
  await loadStatus();
  if (!status.profile) view = { name: "profile", after: "wizard" };
  render();
} catch (error) {
  fail(error);
}
setInterval(() => void poll(), POLL_MS);
