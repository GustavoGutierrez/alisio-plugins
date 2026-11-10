import { copyPayload, writeClipboard } from "./copy.js";
import {
  canSpawn,
  effectOf,
  findingGroups,
  formatElapsed,
  groupModels,
  jobTitle,
  lineCount,
  nextCard,
  POLL_MS,
  progressLabel,
  responseError,
  sectionActions,
  staleSections,
  stepper,
  WRITE_ACTIONS,
} from "./derive.js";
import { errorText, locale, setLocale, t, tf } from "./i18n.js";
import { icon } from "./icons.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";

const root = document.querySelector("#app");
const dialog = document.querySelector("#dialog");

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
        // Coming back: re-check the app (Alisio may have reopened it), the models and the state.
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
  // `message.error` is a host transport code; `result.error` a Thesis Studio code. For
  // not_permitted, prefer the host's `effect`; older hosts omit it: use the action's own effect.
  const error = responseError(message, effectOf(request.action));
  if (!error) return request.resolve(message.result?.value);
  const failure = new Error(error);
  // Only the HOST's not_found can mean "app gone"; a plugin not_found is an unknown job or file.
  failure.transport = !!message.error;
  failure.detail = message.error ? {} : (message.result ?? {});
  if (message.error === "not_found") hostNotFound();
  request.reject(failure);
}

// One host not_found never latches: it is confirmed with `status` after a short delay; only a
// second host not_found shows the unavailable screen, which keeps retrying.
let verifying;
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
const VERIFY_DELAY_MS = 1500;

// The host runs at most PLUGIN_APP_LIMITS.inFlight (8) requests per frame; stay below it.
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
  const mutation = WRITE_ACTIONS.has(action) || effectOf(action) === "process";
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
        toast(t("awaiting_approval"), true);
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

// ---------- State (frame conveniences only; everything else is read back from the backend) ----
let status = null;
let models = null;
let screen = "home";
let job = null;
let lastJob = null;
let blocked = null;
let pollBusy = false;
const view = {
  plansTab: "protocol",
  chapter: null,
  chapterTab: "chapter",
  evidenceTab: "library",
  evidence: { section: "", status: "", text: "" },
  findingStatus: "",
  file: null,
  interviewStep: 0,
  reviewTarget: "all",
  build: { scope: "full", section: "", pdfa: false, html: false },
  pdfWhich: "last",
  zoom: "fit",
  page: 1,
  pages: 0,
};
const cache = {
  interview: null,
  artifacts: new Map(),
  evidence: null,
  findings: null,
  report: null,
  files: null,
  file: null,
  fileFindings: null,
  fileError: null,
  packs: null,
  packCheck: null,
  explain: null,
  styles: null,
  doctor: null,
  pdf: null,
  pdfError: null,
};
const inputs = {};
let answers = {};
let fieldErrors = [];
const copySources = new Map();

const spawnOk = () => canSpawn(models);
const button = (action, label, cls = "outline", extra = "") =>
  `<button type="button" class="${cls}" data-action="${action}" ${extra}>${label}</button>`;
const announce = (text) => {
  const live = document.querySelector("#live");
  if (live) live.textContent = text;
};
const chip = (text, kind = "") => `<span class="chip ${kind}">${escapeHtml(text)}</span>`;
const date = (iso) => {
  try {
    return new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return String(iso ?? "");
  }
};
const value = (id, fallback = "") => inputs[id] ?? fallback;
const disclaimerNote = () => `<p class="disclaimer">${escapeHtml(t("disclaimer"))}</p>`;
const childAttr = () => (spawnOk() ? "" : `disabled title="${escapeHtml(t("noModel"))}"`);

function copyControls(ref, source) {
  copySources.set(ref, source);
  return `<span class="copy-controls">${button("copy-text", `${icon("copy")}<span class="sr-only">${escapeHtml(t("copyText"))}</span>`, "icon-btn ghost", `data-copy="${escapeHtml(ref)}" title="${escapeHtml(t("copyText"))}" aria-label="${escapeHtml(t("copyText"))}"`)}${button("copy-formatted", `${icon("copyRich")}<span class="sr-only">${escapeHtml(t("copyFormatted"))}</span>`, "icon-btn ghost", `data-copy="${escapeHtml(ref)}" title="${escapeHtml(t("copyFormatted"))}" aria-label="${escapeHtml(t("copyFormatted"))}"`)}</span>`;
}
/** A generated Markdown block with its copy controls. */
const generated = (ref, text) =>
  `<div class="doc copyable">${copyControls(ref, { text, markdown: true })}<div class="md">${renderMarkdown(text)}</div></div>`;
/** Coordinator text (English) as a collapsible "Details" block. */
const details = (ref, text) =>
  text
    ? `<details class="details copyable"><summary>${escapeHtml(t("details"))}</summary>${copyControls(ref, { text, markdown: false })}<pre>${escapeHtml(text)}</pre></details>`
    : "";

function showUnavailable() {
  unavailable = true;
  root.innerHTML = `<main class="unavailable"><span class="mark" aria-hidden="true"></span><h1>${escapeHtml(t("unavailableTitle"))}</h1><p>${escapeHtml(t("unavailable"))}</p>${button("retry", escapeHtml(t("retry")), "primary")}</main>`;
}

// ---------- Layout ----------
const SCREENS = [
  ["home", "home"],
  ["interview", "interview"],
  ["plans", "plans"],
  ["chapters", "chapters"],
  ["evidence", "evidence"],
  ["review", "review"],
  ["build", "build"],
  ["settings", "settings"],
];

function changeLocale(next) {
  setLocale(next);
  render();
}

function render() {
  if (unavailable) return showUnavailable();
  copySources.clear();
  const focusId = document.activeElement?.id;
  const scroll = document.querySelector("main.screen")?.scrollTop;
  const phase = status?.initialized ? status.phase : null;
  root.innerHTML = `<header class="topbar"><div class="brand"><span class="mark" aria-hidden="true"></span><div class="brand-text"><strong>${escapeHtml(t("appName"))}</strong>${status?.title ? `<span class="project">${escapeHtml(status.title)}</span>` : ""}</div></div>
    ${phase ? `<span class="phase-badge">${escapeHtml(tf(`phases.${phase}`))}</span>` : ""}</header>
    <div id="jobbar" aria-live="polite">${jobBar()}</div>
    <div class="layout"><nav class="sidenav" aria-label="${escapeHtml(t("appName"))}">${SCREENS.map(([id, glyph]) => `<button type="button" data-action="nav" data-screen="${id}" ${screen === id ? 'aria-current="page"' : ""}>${icon(glyph)}<span>${escapeHtml(tf(`nav.${id}`))}</span></button>`).join("")}</nav>
    <main class="screen" id="screen">${banners()}${screenHtml()}<p id="live" class="sr-only" aria-live="polite"></p></main></div>
    <footer class="footer">${disclaimerNote()}</footer>`;
  const main = document.querySelector("main.screen");
  if (main && typeof scroll === "number") main.scrollTop = scroll;
  const target = focusId ? document.getElementById(focusId) : undefined;
  target?.focus();
  afterRender();
}

function banners() {
  const out = [];
  if (models && !spawnOk())
    out.push(
      `<section class="banner warn" role="alert">${icon("warning")}<div><strong>${escapeHtml(t("noModel"))}</strong><p>${escapeHtml(t("noModelText"))}</p></div></section>`,
    );
  if (blocked)
    out.push(
      `<section class="banner info" role="status">${icon("warning")}<div><strong>${escapeHtml(t("blockedTitle"))}</strong>${details("blocked", blocked)}</div>${button("dismiss-blocked", icon("close"), "icon-btn ghost", `aria-label="${escapeHtml(t("close"))}"`)}</section>`,
    );
  if (lastJob) {
    const failed = lastJob.state !== "done";
    const text =
      lastJob.state === "cancelled"
        ? t("jobCancelled")
        : failed
          ? `${t("jobFailed")} ${errorText(lastJob.error ?? "operation_failed")}`
          : t("jobDone");
    out.push(
      `<section class="banner ${failed ? "warn" : "ok"}" role="status">${icon(failed ? "warning" : "check")}<div><strong>${escapeHtml(jobName(lastJob))}</strong><p>${escapeHtml(text)}</p>${lastJob.notice ? `<p class="small">${escapeHtml(tf("notice", lastJob.notice))}</p>` : ""}${details("job", lastJob.result ?? lastJob.reason ?? "")}</div>${button("dismiss-job", icon("close"), "icon-btn ghost", `aria-label="${escapeHtml(t("close"))}"`)}</section>`,
    );
  }
  const stale = staleSections(status);
  if (stale.length)
    out.push(
      `<section class="banner info" role="status">${icon("warning")}<p>${escapeHtml(tf("stale", stale.join(", ")))}</p></section>`,
    );
  return out.join("");
}

function jobName(j) {
  const title = jobTitle(j);
  const key = `jobs.${title.key}`;
  const name = tf(key, title.target);
  return name && name !== key ? name : (j.label ?? t("jobDone"));
}

function jobBar() {
  if (!job) return "";
  const last = job.progress?.at(-1);
  const label = last ? progressLabel(last) : null;
  const line = label ? (label.key ? t(`roles.${label.key}`) : label.text) : "";
  return `<div class="jobbar"><span class="spinner" aria-hidden="true"></span><strong>${escapeHtml(jobName(job))}…</strong><span class="muted">${escapeHtml(formatElapsed(job.elapsedMs))}</span>${line ? `<span class="job-line">${escapeHtml(line)}</span>` : ""}${button("cancel-job", escapeHtml(t("cancelJob")), "outline small")}</div>`;
}

function screenHtml() {
  if (!status) return `<p class="muted">${escapeHtml(t("loading"))}</p>`;
  if (!status.initialized && screen !== "home") return startCard();
  switch (screen) {
    case "interview":
      return interviewScreen();
    case "plans":
      return plansScreen();
    case "chapters":
      return chaptersScreen();
    case "evidence":
      return evidenceScreen();
    case "review":
      return reviewScreen();
    case "build":
      return buildScreen();
    case "settings":
      return settingsScreen();
    default:
      return homeScreen();
  }
}

// ---------- Home ----------
function startCard() {
  return `<section class="card hero" aria-labelledby="start-title"><h1 id="start-title">${escapeHtml(t("startTitle"))}</h1><p class="lead">${escapeHtml(t("startText"))}</p>
    <div class="fields"><label class="field"><span>${escapeHtml(t("folderLabel"))}</span><input id="init-dir" maxlength="200" placeholder="thesis" value="${escapeHtml(value("init-dir"))}"><small>${escapeHtml(t("folderHint"))}</small></label>
    <label class="field"><span>${escapeHtml(t("languageLabel"))}</span><input id="init-lang" maxlength="35" placeholder="es-CO" value="${escapeHtml(value("init-lang"))}"><small>${escapeHtml(t("languageHint"))}</small></label></div>
    <div class="row">${button("init", `${icon("play")}<span>${escapeHtml(t("start"))}</span>`, "primary")}</div></section>`;
}

function homeScreen() {
  if (!status.initialized)
    return `<p class="tagline">${escapeHtml(t("tagline"))}</p>${startCard()}`;
  const steps = stepper(status.phase)
    .map(
      (s, i) =>
        `<li class="step ${s.state}" ${s.state === "current" ? 'aria-current="step"' : ""}><span class="dot" aria-hidden="true">${s.state === "done" ? icon("check") : i + 1}</span><span class="step-name">${escapeHtml(tf(`phases.${s.phase}`))}</span><span class="sr-only">(${escapeHtml(tf(`stepState.${s.state}`))})</span></li>`,
    )
    .join("");
  const card = nextCard(status);
  const needsModel = card.run && CHILD_RUNS.has(card.action);
  const label = `${tf(`nextLabels.${card.action}`)}${card.target && !["all", "next"].includes(card.target) ? ` · ${card.target}` : ""}`;
  const approved = status.sections.filter((s) => s.status === "approved").length;
  const gates = ["A", "B", "OUTLINE", "C"]
    .map((g) => {
      const gate = status.gates[g];
      return `<li class="gate ${gate.status}">${icon(gate.status === "approved" ? "check" : "dot")}<span>${escapeHtml(tf(`gates.${g}`))}</span>${chip(tf(`gateStatus.${gate.status}`), gate.status === "approved" ? "ok" : "")}</li>`;
    })
    .join("");
  return `<section class="card" aria-labelledby="progress-title"><h2 id="progress-title" class="sr-only">${escapeHtml(t("progressTitle"))}</h2><ol class="stepper">${steps}</ol></section>
    <section class="next-card" aria-labelledby="next-title"><h2 id="next-title">${escapeHtml(t("nextStepTitle"))}</h2><p class="lead">${escapeHtml(tf(`reasons.${card.reasonKey}`))}</p>
      <div class="row">${button("next-step", `<span>${escapeHtml(label)}</span>${icon("arrow")}`, "primary big", needsModel ? childAttr() : "")}</div>
      ${card.action === "research.run" ? `<p class="small muted">${escapeHtml(t("consequences.research"))}</p>` : ""}</section>
    <div class="grid two"><section class="card"><h2>${escapeHtml(t("gatesTitle"))}</h2><ul class="gates">${gates}</ul></section>
    <section class="card"><h2>${escapeHtml(t("progressTitle"))}</h2><ul class="facts">
      ${status.sections.length ? `<li>${escapeHtml(tf("sectionsApproved", approved, status.sections.length))}</li>` : ""}
      <li>${escapeHtml(status.lastCheck ? tf("lastCheck", status.lastCheck.errors, status.lastCheck.warnings) : t("neverChecked"))}</li>
      <li>${escapeHtml(status.lastBuild ? tf("lastBuildAt", date(status.lastBuild.at)) : t("noBuild"))}</li>
      ${status.submittedAt ? `<li>${escapeHtml(tf("submittedAt", date(status.submittedAt)))}</li>` : ""}</ul></section></div>`;
}
const CHILD_RUNS = new Set([
  "design.run",
  "outline.run",
  "research.run",
  "draft.run",
  "review.run",
  "figure.run",
  "revise",
  "next.run",
  "styles.new",
  "norms.import",
]);

// ---------- Interview ----------
function interviewScreen() {
  const data = cache.interview;
  if (!data) return `<p class="muted">${escapeHtml(t("loading"))}</p>`;
  const pendingRound = data.pending;
  if (!pendingRound) {
    return `<section class="card"><h1>${escapeHtml(t("interviewTitle"))}</h1><p class="lead">${escapeHtml(status.intake.completedRounds.length >= 3 ? t("interviewDone") : t("noInterview"))}</p>
      ${status.intake.completedRounds.length < 3 ? `<div class="row">${button("init-continue", escapeHtml(t("nextLabels.project.init")), "primary")}</div>` : ""}</section>
      ${data.presentationOpen ? `<section class="card"><h2>${escapeHtml(t("presentationTitle"))}</h2><p>${escapeHtml(t("presentationText"))}</p><div class="row">${button("presentation", escapeHtml(t("presentationStart")))}</div></section>` : ""}`;
  }
  const questions = pendingRound.questions;
  const index = Math.min(view.interviewStep, questions.length - 1);
  const q = questions[index];
  const chosen = answers[q.id];
  const option = q.options.find((o) => o.value === chosen);
  const invalid = fieldErrors.includes(q.id) || fieldErrors.includes("_form");
  const options = q.options
    .map(
      (o) =>
        `<label class="option ${o.value === chosen ? "selected" : ""}"><input type="radio" name="q-${escapeHtml(q.id)}" data-question="${escapeHtml(q.id)}" value="${escapeHtml(o.value)}" ${o.value === chosen ? "checked" : ""}><span class="option-body"><span class="option-label">${escapeHtml(o.label)}${o.recommended ? ` ${chip(t("recommended"), "gold")}` : ""}</span>${o.description ? `<span class="muted small">${escapeHtml(o.description)}</span>` : ""}</span></label>`,
    )
    .join("");
  const textId = `answer-text-${q.id}`;
  return `<section class="card wizard" aria-labelledby="q-title"><div class="wizard-head"><span class="chip">${escapeHtml(tf("round", pendingRound.round))}</span><span class="muted">${escapeHtml(tf("questionOf", index + 1, questions.length))}</span></div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${questions.length}" aria-valuenow="${index + 1}"><span style="width:${Math.round(((index + 1) / questions.length) * 100)}%"></span></div>
    <p class="eyebrow">${escapeHtml(q.header)}</p><h1 id="q-title">${escapeHtml(q.question)}</h1>
    <fieldset class="options" aria-labelledby="q-title" ${invalid ? 'aria-invalid="true"' : ""}>${options}</fieldset>
    ${invalid ? `<p class="error" role="alert">${icon("warning")}${escapeHtml(t("checkAnswer"))}</p>` : ""}
    ${option?.textInput ? `<label class="field"><span>${escapeHtml(t("freeText"))}</span><textarea id="${escapeHtml(textId)}" data-answer-text="${escapeHtml(q.id)}" rows="3" maxlength="2000" placeholder="${escapeHtml(option.textInput.placeholder ?? "")}">${escapeHtml(answers[`${q.id}:text`] ?? "")}</textarea></label>` : ""}
    <div class="row between">${button("q-back", escapeHtml(t("back")), "outline", index === 0 ? "disabled" : "")}${index < questions.length - 1 ? button("q-next", escapeHtml(t("next")), "primary", chosen ? "" : "disabled") : button("q-save", escapeHtml(t("saveAnswers")), "primary", questions.every((x) => answers[x.id]) ? "" : "disabled")}</div></section>`;
}

// ---------- Plans ----------
function gateCard(name, consequenceKey, canApprove) {
  const gate = status.gates[name];
  return `<div class="gate-card ${gate.status}"><div class="gate-head"><strong>${escapeHtml(tf(`gates.${name}`))}</strong>${chip(tf(`gateStatus.${gate.status}`), gate.status === "approved" ? "ok" : "")}</div>
    ${gate.status === "pending" ? `<p class="small muted">${escapeHtml(t(consequenceKey))}</p><div class="row">${button("approve-gate", escapeHtml(t("approve")), "primary", `data-target="${name}" ${canApprove ? "" : "disabled"}`)}${button("revise-gate", escapeHtml(t("requestChanges")), "outline", `data-target="${name}" ${childAttr()}`)}</div>` : ""}</div>`;
}

function plansScreen() {
  const tab = view.plansTab;
  const data = cache.artifacts.get(tab);
  const tabs = `<nav class="tabs" role="tablist">${["protocol", "outline"].map((k) => `<button type="button" role="tab" data-action="plans-tab" data-tab="${k}" aria-selected="${tab === k}">${escapeHtml(t(`${k}Tab`))}</button>`).join("")}</nav>`;
  if (!data) return `${tabs}<p class="muted">${escapeHtml(t("loading"))}</p>`;
  if (data.text === null) {
    const run = tab === "protocol" ? "design.run" : "outline.run";
    const available = tab === "protocol" ? status.phase === "design" : status.phase === "outline";
    return `${tabs}<section class="card empty"><p class="lead">${escapeHtml(t(tab === "protocol" ? "noProtocol" : "noOutline"))}</p><div class="row">${button("run", escapeHtml(t("createDraft")), "primary", `data-run="${run}" ${available && spawnOk() ? "" : "disabled"}`)}</div></section>`;
  }
  const findings = data.findings.length
    ? `<ul class="findings">${data.findings.map((f) => `<li class="${f.severity}">${chip(tf(`checkSeverity.${f.severity}`), f.severity === "error" ? "danger" : "")}<span>${escapeHtml(f.message)}</span></li>`).join("")}</ul>`
    : `<p class="muted small">${escapeHtml(t("noFindings"))}</p>`;
  const gates =
    tab === "protocol"
      ? `${gateCard("A", "consequenceA", status.phase === "design")}${gateCard("B", "consequenceB", status.phase === "design" && status.gates.A.status === "approved")}`
      : gateCard("OUTLINE", "consequenceOutline", status.phase === "outline");
  const tree = (nodes) =>
    nodes?.length
      ? `<ul>${nodes.map((n) => `<li><span class="mono">${escapeHtml(n.id)}</span> ${escapeHtml(n.title)}${tree(n.children)}</li>`).join("")}</ul>`
      : "";
  return `${tabs}<div class="split"><div class="split-main">${generated(`artifact:${tab}`, data.text)}</div>
    <aside class="split-side">${gates}<section class="card"><h3>${escapeHtml(t("findingsTitle"))}</h3>${findings}</section>
    ${tab === "outline" && data.tree?.length ? `<section class="card"><h3>${escapeHtml(t("outlineTree"))}</h3><div class="tree">${tree(data.tree)}</div></section>` : ""}</aside></div>`;
}

// ---------- Chapters ----------
function sectionTitle(s) {
  return `${s.id}${s.title ? ` · ${s.title}` : ""}`;
}
function actionButtons(section) {
  return sectionActions(section, spawnOk())
    .map((a) =>
      button(
        `chapter-${a.key}`,
        escapeHtml(t(`actions.${a.key}`)),
        a.primary ? "primary" : "outline",
        `data-section="${escapeHtml(section.id)}" ${a.disabled ? "disabled" : ""}`,
      ),
    )
    .join("");
}

function chaptersScreen() {
  if (!status.sections.length)
    return `<section class="card empty"><h1>${escapeHtml(t("chaptersTitle"))}</h1><p class="lead">${escapeHtml(t("noChapters"))}</p></section>`;
  const open = view.chapter && status.sections.find((s) => s.id === view.chapter);
  if (open) {
    const key = `${view.chapterTab}:${open.id}`;
    const data = cache.artifacts.get(key);
    const tabs = `<nav class="tabs" role="tablist">${["chapter", "dossier"].map((k) => `<button type="button" role="tab" data-action="chapter-tab" data-tab="${k}" aria-selected="${view.chapterTab === k}">${escapeHtml(t(`${k}Tab`))}</button>`).join("")}</nav>`;
    const body = !data
      ? `<p class="muted">${escapeHtml(t("loading"))}</p>`
      : data.text === null
        ? `<p class="muted">${escapeHtml(t(view.chapterTab === "chapter" ? "noChapter" : "noDossier"))}</p>`
        : generated(`artifact:${key}`, data.text);
    const claims = data?.claims?.length
      ? `<section class="card"><h3>${escapeHtml(t("claimsTitle"))}</h3><ul class="claims">${data.claims.map((c) => `<li><span class="mono">${escapeHtml(c.id)}</span> ${escapeHtml(c.text)} ${c.evidence.map((e) => chip(e)).join("")}</li>`).join("")}</ul></section>`
      : "";
    const consequence =
      open.status === "draft_review"
        ? t("consequences.approve")
        : open.status === "research_review"
          ? t("consequences.approveResearch")
          : ["planned", "researching"].includes(open.status)
            ? t("consequences.research")
            : "";
    return `<div class="row">${button("chapter-close", `${icon("left")}<span>${escapeHtml(t("chaptersTitle"))}</span>`, "ghost")}</div>
      <section class="card"><div class="gate-head"><h1>${escapeHtml(sectionTitle(open))}</h1>${chip(t(`statuses.${open.status}`), statusKind(open.status))}</div>
      ${open.next?.action === "wait" && open.next.waitsFor?.length ? `<p class="muted">${escapeHtml(tf("waitsFor", open.next.waitsFor.join(", ")))}</p>` : ""}
      <div class="row wrap">${actionButtons(open)}</div>${consequence ? `<p class="small muted">${escapeHtml(consequence)}</p>` : ""}</section>
      ${tabs}${body}${claims}`;
  }
  const cards = status.sections
    .map(
      (
        s,
      ) => `<article class="chapter-card ${s.status}"><button type="button" class="chapter-open" data-action="chapter-open" data-section="${escapeHtml(s.id)}"><span class="mono">${escapeHtml(s.id)}</span><span class="chapter-title">${escapeHtml(s.title ?? "")}</span></button>
      <div class="chapter-meta">${chip(t(`statuses.${s.status}`), statusKind(s.status))}${s.next?.action === "wait" && s.next.waitsFor?.length ? `<span class="muted small">${escapeHtml(tf("waitsFor", s.next.waitsFor.join(", ")))}</span>` : ""}</div>
      <div class="row wrap">${actionButtons(s)}</div></article>`,
    )
    .join("");
  return `<h1>${escapeHtml(t("chaptersTitle"))}</h1><p class="muted">${escapeHtml(tf("sectionsApproved", status.sections.filter((s) => s.status === "approved").length, status.sections.length))}</p><div class="chapter-grid">${cards}</div>`;
}
const statusKind = (s) =>
  s === "approved" ? "ok" : s === "draft_review" || s === "research_review" ? "gold" : "";

// ---------- Evidence ----------
function evidenceScreen() {
  const data = cache.evidence;
  const tab = view.evidenceTab;
  const tabs = `<nav class="tabs" role="tablist">${["library", "rejected", "log"].map((k) => `<button type="button" role="tab" data-action="evidence-tab" data-tab="${k}" aria-selected="${tab === k}">${escapeHtml(t(`${k}Tab`))}</button>`).join("")}</nav>`;
  const filters =
    tab === "library"
      ? `<div class="filters"><label class="field"><span>${escapeHtml(t("filterSection"))}</span><select id="ev-section" data-filter="section"><option value="">${escapeHtml(t("all"))}</option>${status.sections.map((s) => `<option value="${escapeHtml(s.id)}" ${view.evidence.section === s.id ? "selected" : ""}>${escapeHtml(sectionTitle(s))}</option>`).join("")}</select></label>
      <label class="field"><span>${escapeHtml(t("filterStatus"))}</span><select id="ev-status" data-filter="status"><option value="">${escapeHtml(t("all"))}</option>${Object.keys(
        t("evidenceStatuses"),
      )
        .map(
          (k) =>
            `<option value="${k}" ${view.evidence.status === k ? "selected" : ""}>${escapeHtml(t(`evidenceStatuses.${k}`))}</option>`,
        )
        .join("")}</select></label>
      <label class="field grow"><span>${escapeHtml(t("filterText"))}</span><input id="ev-text" data-filter="text" maxlength="200" value="${escapeHtml(view.evidence.text)}"></label>${button("evidence-search", escapeHtml(t("filterText")), "outline")}</div>`
      : "";
  if (!data)
    return `<h1>${escapeHtml(t("evidenceTitle"))}</h1>${tabs}<p class="muted">${escapeHtml(t("loading"))}</p>`;
  let table = `<p class="muted">${escapeHtml(t("noRecords"))}</p>`;
  if (data.records.length && tab === "library")
    table = `<p class="muted small">${escapeHtml(tf("recordsCount", data.filtered, data.total))}</p><div class="table-wrap"><table><thead><tr><th>${escapeHtml(t("colTitle"))}</th><th>${escapeHtml(t("colAuthors"))}</th><th>${escapeHtml(t("colYear"))}</th><th>${escapeHtml(t("colStatus"))}</th><th>${escapeHtml(t("colChapters"))}</th></tr></thead><tbody>${data.records
      .map(
        (r, i) =>
          `<tr><td><button type="button" class="link" data-action="evidence-open" data-index="${i}">${escapeHtml(r.title)}</button>${r.verification?.retracted ? ` ${chip(t("retracted"), "danger")}` : ""}</td><td>${escapeHtml(r.authors.slice(0, 3).join(", "))}${r.authors.length > 3 ? "…" : ""}</td><td>${escapeHtml(r.year)}</td><td>${chip(t(`evidenceStatuses.${r.status}`), r.status.startsWith("VERIFIED") ? "ok" : r.status === "REJECTED" ? "danger" : "")}</td><td class="mono small">${escapeHtml(r.sections.join(", "))}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  else if (data.records.length && tab === "rejected")
    table = `<div class="table-wrap"><table><thead><tr><th>${escapeHtml(t("colTitle"))}</th><th>${escapeHtml(t("colChapters"))}</th><th>${escapeHtml(t("colReason"))}</th></tr></thead><tbody>${data.records.map((r) => `<tr><td>${escapeHtml(r.title ?? r.identifier)}</td><td class="mono small">${escapeHtml(r.sectionId)}</td><td>${escapeHtml(r.reason)}</td></tr>`).join("")}</tbody></table></div>`;
  else if (data.records.length)
    table = `<div class="table-wrap"><table><thead><tr><th>${escapeHtml(t("colQuery"))}</th><th>${escapeHtml(t("colChapters"))}</th><th>${escapeHtml(t("colHits"))}</th></tr></thead><tbody>${data.records.map((r) => `<tr><td>${escapeHtml(r.query)} <span class="muted small">(${escapeHtml(r.source)})</span></td><td class="mono small">${escapeHtml(r.sectionId)}</td><td>${escapeHtml(r.hits)}</td></tr>`).join("")}</tbody></table></div>`;
  return `<h1>${escapeHtml(t("evidenceTitle"))}</h1>${tabs}${filters}${table}`;
}

function evidenceDrawer(r) {
  const ids = [r.doi ? `DOI ${r.doi}` : "", r.url ?? ""].filter(Boolean);
  copySources.set("evidence-ids", { text: ids.join("\n"), markdown: false });
  return `<div class="dialog-body wide"><h2>${escapeHtml(r.title)}</h2><p class="muted">${escapeHtml(r.authors.join(", "))} · ${escapeHtml(r.year)}${r.containerTitle ? ` · ${escapeHtml(r.containerTitle)}` : ""}</p>
    <p>${chip(t(`evidenceStatuses.${r.status}`), r.status.startsWith("VERIFIED") ? "ok" : "")} ${chip(r.verification?.retracted ? t("retracted") : t("notRetracted"), r.verification?.retracted ? "danger" : "")}</p>
    <h3>${escapeHtml(t("verification"))}</h3><p class="mono small">${escapeHtml(r.verification?.method ?? "")} · ${escapeHtml(Math.round((r.verification?.metadataMatch ?? 0) * 100))}%</p>
    ${r.appraisal ? `<h3>${escapeHtml(t("appraisal"))}</h3><p>${escapeHtml(t("relevance"))}: ${escapeHtml(r.appraisal.relevance)} · ${escapeHtml(r.appraisal.evidenceType ?? "")}</p>${r.appraisal.limitations?.length ? `<p class="small">${escapeHtml(t("limitations"))}: ${escapeHtml(r.appraisal.limitations.join("; "))}</p>` : ""}` : ""}
    ${ids.length ? `<h3>${escapeHtml(t("identifiers"))}</h3><div class="copy-line"><code>${ids.map(escapeHtml).join("<br>")}</code>${button("copy-text", `${icon("copy")}<span>${escapeHtml(t("copyValue"))}</span>`, "outline small", 'data-copy="evidence-ids"')}</div>` : ""}
    <div class="row end">${button("dialog-cancel", escapeHtml(t("close")))}</div></div>`;
}

// ---------- Review ----------
function reviewScreen() {
  const data = cache.findings;
  const controls = `<div class="row wrap"><label class="field inline"><span>${escapeHtml(t("reviewTarget"))}</span><select id="review-target"><option value="all">${escapeHtml(t("wholeThesis"))}</option>${status.sections.map((s) => `<option value="${escapeHtml(s.id)}" ${view.reviewTarget === s.id ? "selected" : ""}>${escapeHtml(sectionTitle(s))}</option>`).join("")}</select></label>${button("review-run", escapeHtml(t("runReview")), "primary", childAttr())}
    <label class="field inline"><span>${escapeHtml(t("filterStatus"))}</span><select id="finding-status"><option value="">${escapeHtml(t("all"))}</option>${["open", "resolved", "dismissed", "superseded"].map((k) => `<option value="${k}" ${view.findingStatus === k ? "selected" : ""}>${escapeHtml(t(`findingStatus.${k}`))}</option>`).join("")}</select></label></div>`;
  if (!data)
    return `<h1>${escapeHtml(t("reviewTitle"))}</h1>${controls}<p class="muted">${escapeHtml(t("loading"))}</p>`;
  const { groups } = findingGroups(data.findings);
  const body = data.findings.length
    ? groups
        .filter((g) => g.items.length)
        .map(
          (g) =>
            `<section class="card"><h2>${escapeHtml(t(`severities.${g.severity}`))} <span class="muted">(${g.items.length})</span></h2>${g.items
              .map(
                (f) =>
                  `<article class="finding ${f.severity}"><div class="gate-head"><span class="mono">${escapeHtml(f.id)} · ${escapeHtml(f.target)}</span>${chip(t(`findingStatus.${f.status}`), f.status === "open" ? (f.severity === "minor" ? "" : "danger") : "ok")}</div><p>${escapeHtml(f.description)}</p><blockquote>${escapeHtml(f.evidence)}</blockquote>
                  ${f.status === "open" ? `<div class="row">${button("finding-fix", escapeHtml(t("fix")), "primary", `data-id="${escapeHtml(f.id)}" ${childAttr()}`)}${button("finding-dismiss", escapeHtml(t("dismiss")), "outline", `data-id="${escapeHtml(f.id)}"`)}</div>` : f.notes ? `<p class="small muted">${escapeHtml(f.notes)}</p>` : ""}</article>`,
              )
              .join("")}</section>`,
        )
        .join("")
    : `<p class="muted">${escapeHtml(t("noReviewFindings"))}</p>`;
  return `<h1>${escapeHtml(t("reviewTitle"))}</h1><p class="lead">${escapeHtml(tf("blockingCount", data.blocking))}</p>${controls}${body}`;
}

// ---------- Build & submit ----------
function buildScreen() {
  const report = cache.report;
  const errors = report?.findings?.filter((f) => f.severity === "error") ?? [];
  const checks = `<section class="card"><div class="gate-head"><h2>${escapeHtml(t("checksTitle"))}</h2>${button("check-run", escapeHtml(t("runChecks")), "outline")}</div>
    ${
      report
        ? `<p>${chip(tf("checkSummary", report.counts.error, report.counts.warning), report.counts.error ? "danger" : "ok")} <span class="muted small">${escapeHtml(date(report.at))}</span></p>${
            errors.length
              ? `<ul class="findings">${errors
                  .slice(0, 50)
                  .map(
                    (f) =>
                      `<li class="error"><span class="mono">${escapeHtml(f.code)}</span> <span>${escapeHtml(f.message)}</span>${f.file ? ` <span class="muted small">${escapeHtml(f.file)}${f.line ? `:${f.line}` : ""}</span>` : ""}</li>`,
                  )
                  .join("")}</ul>`
              : ""
          }`
        : `<p class="muted">${escapeHtml(t("noReport"))}</p>`
    }</section>`;
  const b = view.build;
  const options = `<section class="card"><h2>${escapeHtml(t("buildOptions"))}</h2><div class="fields">
    <label class="field"><span>${escapeHtml(t("reviewTarget"))}</span><select id="build-scope">${["full", "approved", "section"].map((k) => `<option value="${k}" ${b.scope === k ? "selected" : ""}>${escapeHtml(t(`scope.${k}`))}</option>`).join("")}</select></label>
    ${b.scope === "section" ? `<label class="field"><span>${escapeHtml(t("filterSection"))}</span><select id="build-section">${status.sections.map((s) => `<option value="${escapeHtml(s.id)}" ${b.section === s.id ? "selected" : ""}>${escapeHtml(sectionTitle(s))}</option>`).join("")}</select></label>` : ""}
    <label class="check"><input type="checkbox" id="build-pdfa" ${b.pdfa ? "checked" : ""}><span>${escapeHtml(t("pdfa"))}</span></label>
    <label class="check"><input type="checkbox" id="build-html" ${b.html ? "checked" : ""}><span>${escapeHtml(t("htmlFormat"))}</span></label></div>
    <div class="row">${button("build-run", `${icon("build")}<span>${escapeHtml(t("buildButton"))}</span>`, "primary")}</div></section>`;
  const hasPdf = view.pdfWhich === "final" ? !!status.finalBuild : !!status.lastBuild;
  const preview = `<section class="card"><div class="gate-head"><h2>${escapeHtml(t("previewTitle"))}</h2>
    <div class="row">${status.finalBuild ? `<select id="pdf-which" aria-label="${escapeHtml(t("previewTitle"))}"><option value="last" ${view.pdfWhich === "last" ? "selected" : ""}>${escapeHtml(t("lastPdf"))}</option><option value="final" ${view.pdfWhich === "final" ? "selected" : ""}>${escapeHtml(t("finalPdf"))}</option></select>` : ""}</div></div>
    ${
      cache.pdfError
        ? `<p class="muted">${escapeHtml(cache.pdfError)}</p>`
        : !hasPdf
          ? `<p class="muted">${escapeHtml(t("noPdf"))}</p>`
          : `<div class="pdf-tools row wrap">${button("pdf-prev", icon("left"), "icon-btn outline", `aria-label="${escapeHtml(t("prevPage"))}" title="${escapeHtml(t("prevPage"))}"`)}<span id="pdf-page" class="muted">${view.pages ? escapeHtml(tf("pageOf", view.page, view.pages)) : ""}</span>${button("pdf-next", icon("right"), "icon-btn outline", `aria-label="${escapeHtml(t("nextPage"))}" title="${escapeHtml(t("nextPage"))}"`)}
      ${button("pdf-zoom-out", icon("minus"), "icon-btn outline", `aria-label="${escapeHtml(t("zoomOut"))}" title="${escapeHtml(t("zoomOut"))}"`)}${button("pdf-zoom-fit", icon("fit"), "icon-btn outline", `aria-label="${escapeHtml(t("zoomFit"))}" title="${escapeHtml(t("zoomFit"))}"`)}${button("pdf-zoom-in", icon("plus"), "icon-btn outline", `aria-label="${escapeHtml(t("zoomIn"))}" title="${escapeHtml(t("zoomIn"))}"`)}
      ${button("pdf-download", `${icon("download")}<span>${escapeHtml(t("download"))}</span>`, "outline", cache.pdf ? "" : "disabled")}</div><div id="pdf-holder" class="pdf-holder"></div>`
    }</section>`;
  const gateC = status.gates.C;
  const final = `<section class="card"><div class="gate-head"><h2>${escapeHtml(t("gates.C"))}</h2>${chip(t(`gateStatus.${gateC.status}`), gateC.status === "approved" ? "ok" : "")}</div>
    ${
      status.submittedAt
        ? `<p class="lead">${escapeHtml(tf("submittedAt", date(status.submittedAt)))}</p>${status.finalBuild ? `<p class="mono small">${escapeHtml(tf("finalReady", status.finalBuild.pdf))}</p>` : ""}`
        : `<p class="small muted">${escapeHtml(t("gateCText"))}</p>
    <div class="row">${gateC.status === "pending" ? button("approve-c", escapeHtml(t("approveC")), "primary", status.phase === "review" ? "" : "disabled") : ""}${button("finalize", escapeHtml(t("finalizeButton")), gateC.status === "approved" ? "primary" : "outline", status.phase === "final" || (status.phase === "review" && gateC.status === "approved") ? "" : "disabled")}</div><p class="small muted">${escapeHtml(t("finalizeConsequence"))}</p>`
    }</section>`;
  return `<h1>${escapeHtml(t("buildTitle"))}</h1><div class="grid two">${checks}${options}</div>${preview}${final}`;
}

// ---------- Settings ----------
function settingsScreen() {
  const m = models;
  const chosen = status.model?.chosen ?? "";
  const options = m
    ? groupModels(m.models)
        .map(
          ([provider, list]) =>
            `<optgroup label="${escapeHtml(provider)}">${list.map((x) => `<option value="${escapeHtml(x.reference)}" ${x.reference === chosen ? "selected" : ""}>${escapeHtml(x.name)}</option>`).join("")}</optgroup>`,
        )
        .join("")
    : "";
  const model = `<section class="card" aria-labelledby="model-title"><h2 id="model-title">${escapeHtml(t("modelTitle"))}</h2><p class="muted">${escapeHtml(t("modelHelp"))}</p>
    <div class="row wrap"><select id="model-select" aria-labelledby="model-title"><option value="" ${chosen ? "" : "selected"}>${escapeHtml(tf("modelDefault", m?.active ?? ""))}</option>${options}${chosen && m && !m.chosenAvailable ? `<option value="${escapeHtml(chosen)}" selected>${escapeHtml(chosen)}</option>` : ""}</select>${button("model-save", escapeHtml(t("save")), "primary")}</div>
    ${chosen && m && !m.chosenAvailable ? `<p class="warn small">${icon("warning")}${escapeHtml(t("modelNotAvailable"))}</p>` : ""}</section>`;
  const authoring = status.authoring?.length
    ? `<section class="card"><h3>${escapeHtml(t("pendingTitle"))}</h3>${status.authoring
        .map((a) => {
          const target = a.kind === "style" ? `style:${a.id}` : "norms";
          return `<article class="pending"><strong>${escapeHtml(a.kind === "style" ? tf("pendingStyle", a.id) : t("pendingNorms"))}</strong>${a.questions.length ? `<p class="small">${escapeHtml(t("openQuestions"))}:</p><ul>${a.questions.map((q) => `<li>${escapeHtml(q)}</li>`).join("")}</ul>` : ""}<div class="row">${button("approve-target", escapeHtml(t("approve")), "primary", `data-target="${escapeHtml(target)}"`)}${button("revise-target", escapeHtml(t("requestChanges")), "outline", `data-target="${escapeHtml(target)}" ${childAttr()}`)}</div></article>`;
        })
        .join("")}</section>`
    : "";
  const rules = `<section class="card"><h2>${escapeHtml(t("rulesTitle"))}</h2>
    <h3>${escapeHtml(t("packsList"))}</h3>${cache.packs ? details("packs", cache.packs) : ""}${cache.packCheck ? details("pack-check", cache.packCheck) : ""}
    <div class="row wrap">${button("packs-check", escapeHtml(t("packsCheck")), "outline")}</div>
    <div class="row wrap"><label class="field grow"><span>${escapeHtml(t("explainLabel"))}</span><input id="explain-query" maxlength="120" value="${escapeHtml(value("explain-query"))}"></label>${button("packs-explain", escapeHtml(t("explainButton")), "outline")}</div>${cache.explain ? details("explain", cache.explain) : ""}
    <div class="row wrap"><label class="field"><span>${escapeHtml(t("packScope"))}</span><select id="pack-scope">${["institution", "faculty", "program", "writing", "international", "country", "region"].map((k) => `<option value="${k}" ${value("pack-scope", "institution") === k ? "selected" : ""}>${k}</option>`).join("")}</select></label><label class="field"><span>${escapeHtml(t("packId"))}</span><input id="pack-id" maxlength="63" value="${escapeHtml(value("pack-id"))}"></label>${button("packs-new", escapeHtml(t("newPack")), "outline")}</div>
    <h3>${escapeHtml(t("stylesList"))}</h3>${cache.styles ? details("styles", cache.styles) : ""}
    <div class="row wrap">${button("style-new", escapeHtml(t("newStyle")), "outline", childAttr())}${button("norms-import", escapeHtml(t("importNorms")), "outline", childAttr())}</div></section>`;
  const ethics = status.ethics?.length
    ? `<section class="card"><h2>${escapeHtml(t("ethicsTitle"))}</h2>${status.ethics
        .map(
          (e) =>
            `<article class="pending"><strong class="mono">${escapeHtml(e.id)}</strong><p>${escapeHtml(e.text)}</p>${e.resolution ? `<p>${chip(t("resolved"), "ok")} ${escapeHtml(e.resolution)}</p>` : `<label class="field"><span>${escapeHtml(t("ethicsResolution"))}</span><textarea id="eth-${escapeHtml(e.id)}" rows="2" maxlength="500">${escapeHtml(value(`eth-${e.id}`))}</textarea></label><div class="row">${button("ethics-record", escapeHtml(t("recordResolution")), "outline", `data-id="${escapeHtml(e.id)}"`)}</div>`}</article>`,
        )
        .join("")}</section>`
    : "";
  return `<h1>${escapeHtml(t("settingsTitle"))}</h1>${model}${authoring}${rules}${ethics}${filesCard()}${setupCard()}`;
}

function filesCard() {
  const files = cache.files?.files ?? [];
  const list = files
    .map(
      (f) =>
        `<li><button type="button" class="file-btn" data-action="file-open" data-path="${escapeHtml(f.path)}" ${view.file === f.path ? 'aria-current="true"' : ""}>${icon("file")}<span class="mono">${escapeHtml(f.display)}</span>${chip(t(f.editable ? "editable" : "readOnly"), f.editable ? "ok" : "")}</button></li>`,
    )
    .join("");
  const f = cache.file;
  let editor = "";
  if (f && f.path === view.file) {
    if (f.editable) {
      const text = value("file-editor", f.text);
      const gutter = Array.from({ length: lineCount(text) }, (_, i) => i + 1).join("\n");
      editor = `<div class="editor"><pre class="gutter" aria-hidden="true">${gutter}</pre><textarea id="file-editor" spellcheck="false" aria-label="${escapeHtml(f.display)}" wrap="off">${escapeHtml(text)}</textarea></div>
        ${cache.fileError ? `<p class="error" role="alert">${icon("warning")}${escapeHtml(cache.fileError)}</p>` : ""}
        <div class="row">${button("file-save", escapeHtml(t("saveFile")), "primary")}</div>
        ${cache.fileFindings ? `<h3>${escapeHtml(t("g0Findings"))}</h3>${cache.fileFindings.length ? `<ul class="findings">${cache.fileFindings.map((x) => `<li class="${x.severity}">${chip(tf(`checkSeverity.${x.severity}`), x.severity === "error" ? "danger" : "")}<span>${escapeHtml(x.message)}</span></li>`).join("")}</ul>` : `<p class="muted small">${escapeHtml(t("noFindings"))}</p>`}` : ""}`;
    } else {
      copySources.set("file-path", { text: f.display, markdown: false });
      editor = `<div class="banner info">${icon("edit")}<div><strong>${escapeHtml(t("openInEditor"))}</strong><p class="small">${escapeHtml(t("openInEditorText"))}</p><div class="copy-line"><code>${escapeHtml(f.display)}</code>${button("copy-text", `${icon("copy")}<span>${escapeHtml(t("copyValue"))}</span>`, "outline small", 'data-copy="file-path"')}</div></div></div><pre class="viewer">${escapeHtml(f.text)}</pre>`;
    }
  }
  return `<section class="card"><h2>${escapeHtml(t("filesTitle"))}</h2><div class="files"><ul class="file-list">${list}</ul><div class="file-view">${editor}</div></div></section>`;
}

function setupCard() {
  const d = cache.doctor;
  return `<section class="card"><h2>${escapeHtml(t("setupTitle"))}</h2>${d ? `<ul class="doctor">${d.items.map((i) => `<li>${chip(t(`doctorStatus.${i.status}`), i.status === "ok" ? "ok" : i.status === "missing" ? "danger" : "gold")}<strong>${escapeHtml(i.label)}</strong> <span class="muted small">${escapeHtml(i.detail)}</span></li>`).join("")}</ul>` : ""}
    <div class="row wrap">${button("doctor-run", escapeHtml(t("runDoctor")), "outline")}${button("engine-setup", escapeHtml(t("installTypst")), "outline")}</div><p class="small muted">${escapeHtml(t("installTypstText"))}</p></section>`;
}

// ---------- After render: the PDF preview ----------
function afterRender() {
  // Narrow layout: keep the current tab of the horizontal navigation in view.
  document
    .querySelector(".sidenav [aria-current]")
    ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const holder = document.querySelector("#pdf-holder");
  if (!holder || !cache.pdf || typeof globalThis.thesisRenderPdf !== "function") return;
  void globalThis.thesisRenderPdf(holder, cache.pdf.blob, {
    zoom: view.zoom,
    onInfo: ({ pages }) => {
      view.pages = pages;
      const label = document.querySelector("#pdf-page");
      if (label) label.textContent = tf("pageOf", view.page, pages);
    },
  });
}

// ---------- Loading ----------
async function loadStatus() {
  status = await api("status", {});
  if (status.job && (!job || job.id !== status.job.id)) job = status.job;
}
async function loadModels() {
  try {
    models = await api("models.list", {});
  } catch {
    models = null;
  }
}
function base64ToBlob(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "application/pdf" });
}
async function loadPdf() {
  cache.pdfError = null;
  const which = view.pdfWhich;
  const stamp = which === "final" ? status.finalBuild?.pdf : status.lastBuild?.at;
  if (!stamp) {
    cache.pdf = null;
    return;
  }
  if (cache.pdf?.which === which && cache.pdf.stamp === stamp) return;
  try {
    const pdf = await api("pdf.get", { which });
    cache.pdf = { which, stamp, blob: base64ToBlob(pdf.base64), path: pdf.path };
    view.page = 1;
  } catch (error) {
    cache.pdf = null;
    cache.pdfError =
      error?.message === "too_large"
        ? tf("tooLargePdf", error.detail?.path ?? "")
        : errorText(error?.message);
  }
}
async function loadScreen() {
  if (!status?.initialized) return;
  try {
    switch (screen) {
      case "interview":
        cache.interview = await api("interview.get", {});
        break;
      case "plans":
        cache.artifacts.set(view.plansTab, await api("artifact.get", { kind: view.plansTab }));
        break;
      case "chapters":
        if (view.chapter)
          cache.artifacts.set(
            `${view.chapterTab}:${view.chapter}`,
            await api("artifact.get", { kind: view.chapterTab, section: view.chapter }),
          );
        break;
      case "evidence": {
        const f = view.evidence;
        cache.evidence = await api("evidence.list", {
          tab: view.evidenceTab,
          limit: 200,
          ...(view.evidenceTab === "library" && f.section ? { section: f.section } : {}),
          ...(view.evidenceTab === "library" && f.status ? { status: f.status } : {}),
          ...(view.evidenceTab === "library" && f.text.trim() ? { text: f.text.trim() } : {}),
        });
        break;
      }
      case "review":
        cache.findings = await api(
          "findings.list",
          view.findingStatus ? { status: view.findingStatus } : {},
        );
        break;
      case "build":
        cache.report = (await api("check.last", {})).report;
        await loadPdf();
        break;
      case "settings": {
        const [files, packs, styles] = await Promise.all([
          api("files.list", {}),
          api("packs.list", {}).catch(() => null),
          api("styles.list", {}).catch(() => null),
        ]);
        cache.files = files;
        cache.packs = packs?.text ?? null;
        cache.styles = styles?.text ?? null;
        await loadModels();
        break;
      }
    }
  } catch (error) {
    fail(error);
  }
}
async function go(next, options = {}) {
  screen = next;
  if (options.chapter !== undefined) view.chapter = options.chapter;
  render();
  await loadScreen();
  render();
}
async function refreshAll() {
  await loadStatus();
  await loadScreen();
  render();
}
async function refreshOnShow() {
  try {
    await loadModels();
    await refreshAll();
  } catch (error) {
    fail(error);
  }
  void poll();
}
async function reloadAll() {
  try {
    await loadModels();
    await refreshAll();
  } catch (error) {
    fail(error);
  }
}

// ---------- Actions ----------
function fail(error) {
  if (unavailable) return;
  const code = error?.message ?? "operation_failed";
  if (code === "conflict") {
    toast(t("refreshed"));
    void refreshAll();
    return;
  }
  if (code === "busy") {
    toast(tf("busyBy", error.detail?.label ?? ""));
    void refreshAll();
    return;
  }
  if (code === "blocked") {
    blocked = error.detail?.reason ?? t("errors.blocked");
    render();
    return;
  }
  toast(errorText(code));
}

/** Runs one action; a `{ jobId }` result starts tracking that job. */
async function run(action, input = {}) {
  blocked = null;
  const result = await api(action, input);
  if (result?.jobId) {
    lastJob = null;
    job = {
      id: result.jobId,
      kind: action,
      target: input.section ?? input.target ?? (action === "build.run" ? undefined : input.id),
      state: "running",
      progress: [],
      elapsedMs: 0,
    };
    render();
    void poll();
  }
  return result;
}

async function poll() {
  if (!visible || pollBusy || unavailable || !job) return;
  pollBusy = true;
  try {
    let current;
    try {
      current = await api("jobs.get", { jobId: job.id });
    } catch (error) {
      // A plugin not_found: the backend no longer knows this job; stop polling it.
      if (error?.message !== "not_found" || error.transport) throw error;
      current = { ...job, state: "failed", error: "not_found" };
    }
    if (current.state === "running") {
      job = current;
      const bar = document.querySelector("#jobbar");
      if (bar) bar.innerHTML = jobBar();
      return;
    }
    job = null;
    lastJob = current;
    if (current.error === "blocked") {
      blocked = current.reason ?? t("errors.blocked");
      lastJob = null;
    }
    announce(current.state === "done" ? t("jobDone") : t("jobFailed"));
    cache.artifacts.clear();
    await refreshAll();
  } catch (error) {
    fail(error);
  } finally {
    pollBusy = false;
  }
}

function openDialog(html, onOpen) {
  const opener = document.activeElement;
  dialog.innerHTML = html;
  dialog.onclose = () => {
    dialog.innerHTML = "";
    if (opener && typeof opener.focus === "function") opener.focus();
  };
  dialog.showModal?.();
  if (!dialog.open) dialog.setAttribute("open", "");
  onOpen?.();
  dialog.querySelector("textarea,input,select")?.focus();
}
function closeDialog() {
  if (typeof dialog.close === "function" && dialog.open) dialog.close();
  else {
    dialog.removeAttribute("open");
    dialog.innerHTML = "";
  }
}

/** A text dialog: resolves the trimmed text, or null when cancelled. */
function askText({
  title,
  label,
  hint = "",
  consequence = "",
  ok = t("send"),
  max = 4000,
  rows = 5,
  required = true,
}) {
  return new Promise((resolve) => {
    openDialog(
      `<div class="dialog-body"><h2>${escapeHtml(title)}</h2>${consequence ? `<p class="small muted">${escapeHtml(consequence)}</p>` : ""}<label class="field"><span>${escapeHtml(label)}</span><textarea id="dialog-text" rows="${rows}" maxlength="${max}" placeholder="${escapeHtml(t("feedbackPlaceholder"))}"></textarea>${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</label>${disclaimerNote()}
      <div class="row end">${button("dialog-cancel", escapeHtml(t("cancel")))}${button("dialog-ok", escapeHtml(ok), "primary")}</div></div>`,
    );
    dialog.onclick = (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "dialog-cancel") {
        closeDialog();
        resolve(null);
      } else if (action === "dialog-ok") {
        const text = dialog.querySelector("#dialog-text")?.value.trim() ?? "";
        if (required && !text) return;
        closeDialog();
        resolve(text);
      }
    };
    dialog.oncancel = () => resolve(null);
  });
}

/** Style id + guide dialog. */
function askStyle() {
  return new Promise((resolve) => {
    openDialog(
      `<div class="dialog-body"><h2>${escapeHtml(t("newStyle"))}</h2><label class="field"><span>${escapeHtml(t("styleId"))}</span><input id="dialog-id" maxlength="63" pattern="[a-z0-9][a-z0-9-]*"></label><label class="field"><span>${escapeHtml(t("guideLabel"))}</span><textarea id="dialog-text" rows="8" maxlength="50000"></textarea></label>${disclaimerNote()}
      <div class="row end">${button("dialog-cancel", escapeHtml(t("cancel")))}${button("dialog-ok", escapeHtml(t("create")), "primary")}</div></div>`,
    );
    dialog.onclick = (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "dialog-cancel") {
        closeDialog();
        resolve(null);
      } else if (action === "dialog-ok") {
        const id = dialog.querySelector("#dialog-id")?.value.trim() ?? "";
        const guide = dialog.querySelector("#dialog-text")?.value.trim() ?? "";
        if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) || !guide) return;
        closeDialog();
        resolve({ id, guide });
      }
    };
    dialog.oncancel = () => resolve(null);
  });
}

async function approve(target, notes) {
  const result = await run("approve", {
    target,
    revision: status.revision,
    ...(notes ? { notes } : {}),
  });
  toast(t("saved"));
  if (result?.buildAfter) {
    // D8: the partial build is its own `process` action (its own approval prompt).
    await loadStatus();
    await run("build.run", { scope: "approved" });
    return;
  }
  cache.artifacts.clear();
  await refreshAll();
}

async function revise(target, consequence = t("consequenceChanges")) {
  const feedback = await askText({
    title: t("requestChanges"),
    label: t("feedbackLabel"),
    consequence,
  });
  if (!feedback) return;
  await run("revise", { target, feedback, revision: status.revision });
}

async function handle(action, target) {
  switch (action) {
    case "nav":
      blocked = null;
      if (target.dataset.screen === "chapters") view.chapter = null;
      return go(target.dataset.screen);
    case "retry":
      target.setAttribute("disabled", "");
      return verifyAvailable();
    case "dismiss-blocked":
      blocked = null;
      return render();
    case "dismiss-job":
      lastJob = null;
      return render();
    case "cancel-job":
      if (job) await api("jobs.cancel", { jobId: job.id });
      return poll();
    case "copy-text":
    case "copy-formatted": {
      const source = copySources.get(target.dataset.copy);
      if (!source) return;
      const { text, html } = copyPayload(source, renderMarkdown, action === "copy-formatted");
      const path = await writeClipboard({ text, ...(html ? { html } : {}) });
      lastCopyPath = path;
      if (path === "manual") return manualCopy(text);
      toast(t("copied"));
      return announce(t("copied"));
    }
    case "init": {
      const dir = (inputs["init-dir"] ?? "").trim();
      const lang = (inputs["init-lang"] ?? "").trim();
      await run("project.init", { ...(dir ? { dir } : {}), ...(lang ? { lang } : {}) });
      answers = {};
      view.interviewStep = 0;
      await loadStatus();
      return go("interview");
    }
    case "init-continue":
      await run("project.init", {});
      view.interviewStep = 0;
      await loadStatus();
      return go("interview");
    case "presentation":
      await run("project.init", { presentation: true });
      answers = {};
      view.interviewStep = 0;
      await loadStatus();
      return go("interview");
    case "next-step": {
      const card = nextCard(status);
      if (card.run) {
        await run(card.action, card.input ?? {});
        if (card.action === "project.init") {
          await loadStatus();
          return go("interview");
        }
        if (card.action === "check.run") return go("build");
        return;
      }
      return go(card.screen, card.screen === "chapters" ? { chapter: card.target ?? null } : {});
    }
    case "q-back":
      view.interviewStep = Math.max(0, view.interviewStep - 1);
      return render();
    case "q-next":
      view.interviewStep += 1;
      return render();
    case "q-save": {
      const questions = cache.interview?.pending?.questions ?? [];
      const out = {};
      for (const q of questions) {
        if (answers[q.id]) out[q.id] = answers[q.id];
        const text = answers[`${q.id}:text`];
        const option = q.options.find((o) => o.value === answers[q.id]);
        if (option?.textInput && text?.trim()) out[`${q.id}:text`] = text.trim();
      }
      try {
        await run("interview.answer", { answers: out });
      } catch (error) {
        if (error?.message === "invalid_input") {
          fieldErrors = error.detail?.fields ?? ["_form"];
          const first = questions.findIndex((q) => fieldErrors.includes(q.id));
          if (first >= 0) view.interviewStep = first;
          return render();
        }
        throw error;
      }
      fieldErrors = [];
      answers = {};
      view.interviewStep = 0;
      await loadStatus();
      cache.interview = await api("interview.get", {});
      if (!cache.interview.pending) return go("home");
      return render();
    }
    case "plans-tab":
      view.plansTab = target.dataset.tab;
      return go("plans");
    case "approve-gate":
    case "approve-target":
      return approve(target.dataset.target);
    case "revise-gate":
    case "revise-target":
      return revise(target.dataset.target);
    case "run":
      return run(target.dataset.run, {});
    case "chapter-open":
      view.chapterTab = "chapter";
      return go("chapters", { chapter: target.dataset.section });
    case "chapter-close":
      return go("chapters", { chapter: null });
    case "chapter-tab":
      view.chapterTab = target.dataset.tab;
      return go("chapters");
    case "chapter-research":
      return run("research.run", { section: target.dataset.section });
    case "chapter-searchMore": {
      const more = await askText({
        title: t("actions.searchMore"),
        label: t("searchMoreLabel"),
        consequence: t("consequences.research"),
        max: 1000,
      });
      if (more) await run("research.run", { section: target.dataset.section, more });
      return;
    }
    case "chapter-addSource": {
      const add = await askText({
        title: t("actions.addSource"),
        label: t("addSourceLabel"),
        hint: t("addSourceHint"),
        max: 1000,
        rows: 2,
      });
      if (add) await run("research.run", { section: target.dataset.section, add });
      return;
    }
    case "chapter-approveResearch":
    case "chapter-approve":
      return approve(target.dataset.section);
    case "chapter-writeDraft":
      return run("draft.run", { section: target.dataset.section });
    case "chapter-requestChanges":
      return revise(target.dataset.section);
    case "chapter-addFigure": {
      const request = await askText({
        title: t("actions.addFigure"),
        label: t("figureLabel"),
        max: 2000,
      });
      if (request) await run("figure.run", { section: target.dataset.section, request });
      return;
    }
    case "evidence-tab":
      view.evidenceTab = target.dataset.tab;
      cache.evidence = null;
      return go("evidence");
    case "evidence-search":
      return go("evidence");
    case "evidence-open": {
      const record = cache.evidence?.records[Number(target.dataset.index)];
      if (!record) return;
      openDialog(evidenceDrawer(record));
      dialog.onclick = (event) => {
        const a = event.target.closest("[data-action]");
        if (a?.dataset.action === "dialog-cancel") closeDialog();
        else if (a) handle(a.dataset.action, a).catch(fail);
      };
      return;
    }
    case "review-run":
      return run("review.run", { target: view.reviewTarget });
    case "finding-fix": {
      const feedback = await askText({ title: t("fix"), label: t("feedbackLabel") });
      if (feedback)
        await run("revise", { target: target.dataset.id, feedback, revision: status.revision });
      return;
    }
    case "finding-dismiss": {
      const reason = await askText({ title: t("dismiss"), label: t("dismissReason") });
      if (reason) await approve(target.dataset.id, reason);
      return;
    }
    case "check-run": {
      const result = await run("check.run", {});
      cache.report = result?.report ?? cache.report;
      await loadStatus();
      return render();
    }
    case "build-run": {
      const b = view.build;
      const section = b.scope === "section" ? b.section || status.sections[0]?.id : undefined;
      return run("build.run", {
        scope: b.scope,
        ...(section ? { section } : {}),
        ...(b.pdfa ? { pdfa: true } : {}),
        ...(b.html ? { format: "html" } : {}),
      });
    }
    case "pdf-prev":
    case "pdf-next": {
      view.page = Math.min(
        Math.max(1, view.page + (action === "pdf-next" ? 1 : -1)),
        view.pages || 1,
      );
      document
        .querySelector(`#pdf-holder canvas[data-page="${view.page}"]`)
        ?.scrollIntoView?.({ block: "start" });
      const label = document.querySelector("#pdf-page");
      if (label) label.textContent = tf("pageOf", view.page, view.pages);
      return;
    }
    case "pdf-zoom-in":
    case "pdf-zoom-out":
    case "pdf-zoom-fit": {
      const current = typeof view.zoom === "number" ? view.zoom : 1;
      view.zoom =
        action === "pdf-zoom-fit"
          ? "fit"
          : Math.min(3, Math.max(0.5, current + (action === "pdf-zoom-in" ? 0.25 : -0.25)));
      return render();
    }
    case "pdf-download": {
      if (!cache.pdf) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(cache.pdf.blob);
      link.download = cache.pdf.path.split("/").pop() || "thesis.pdf";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
      return;
    }
    case "approve-c":
      return approve("C");
    case "finalize":
      return run("finalize.run", {});
    case "model-save": {
      const model = document.querySelector("#model-select")?.value || null;
      const result = await run("settings.setModel", { model, revision: status.revision });
      status.model = { chosen: result?.chosen ?? null };
      toast(t("saved"));
      await loadModels();
      return refreshAll();
    }
    case "packs-check":
      cache.packCheck = (await api("packs.check", {})).text;
      return render();
    case "packs-explain": {
      const query = (inputs["explain-query"] ?? "").trim();
      if (!query) return;
      cache.explain = (await api("packs.explain", { query })).text;
      return render();
    }
    case "packs-new": {
      const id = (inputs["pack-id"] ?? "").trim();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return toast(errorText("invalid_input"));
      const result = await run("packs.new", { scope: inputs["pack-scope"] ?? "institution", id });
      lastJob = {
        kind: "packs.new",
        label: t("newPack"),
        state: "done",
        result: result?.text ?? "",
      };
      return refreshAll();
    }
    case "style-new": {
      const style = await askStyle();
      if (style) await run("styles.new", style);
      return;
    }
    case "norms-import": {
      const guide = await askText({
        title: t("importNorms"),
        label: t("guideLabel"),
        max: 50_000,
        rows: 8,
      });
      if (guide) await run("norms.import", { guide });
      return;
    }
    case "ethics-record": {
      const id = target.dataset.id;
      const text = (inputs[`eth-${id}`] ?? "").trim();
      if (!text) return;
      return approve(id, text);
    }
    case "file-open": {
      view.file = target.dataset.path;
      delete inputs["file-editor"];
      cache.fileError = null;
      cache.fileFindings = null;
      cache.file = await api("files.read", { path: view.file });
      return render();
    }
    case "file-save": {
      const f = cache.file;
      if (!f) return;
      const content = inputs["file-editor"] ?? f.text;
      try {
        const result = await run("files.write", { path: f.path, content, revision: f.revision });
        cache.file = { ...f, text: content, revision: result.revision };
        cache.fileFindings = result.findings ?? [];
        cache.fileError = null;
        toast(t("saved"));
      } catch (error) {
        if (error?.message === "invalid_input" && error.detail?.line !== undefined) {
          cache.fileError = tf("yamlError", error.detail.line);
          return render();
        }
        throw error;
      }
      await loadStatus();
      return render();
    }
    case "doctor-run":
      return run("doctor.run", {});
    case "engine-setup":
      return run("engine.setup", {});
  }
}

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  handle(target.dataset.action, target).catch(fail);
});
root.addEventListener("input", (event) => {
  const el = event.target;
  if (el.id) inputs[el.id] = el.value;
  if (el.dataset.answerText) answers[`${el.dataset.answerText}:text`] = el.value;
  if (el.id === "file-editor") {
    const gutter = el.parentElement?.querySelector(".gutter");
    if (gutter)
      gutter.textContent = Array.from({ length: lineCount(el.value) }, (_, i) => i + 1).join("\n");
  }
  if (el.dataset.filter === "text") view.evidence.text = el.value;
});
root.addEventListener(
  "scroll",
  (event) => {
    if (event.target.id === "file-editor") {
      const gutter = event.target.parentElement?.querySelector(".gutter");
      if (gutter) gutter.scrollTop = event.target.scrollTop;
    }
  },
  true,
);
root.addEventListener("change", (event) => {
  const el = event.target;
  if (el.dataset.question) {
    answers[el.dataset.question] = el.value;
    fieldErrors = fieldErrors.filter((id) => id !== el.dataset.question);
    return render();
  }
  if (el.dataset.filter === "section" || el.dataset.filter === "status") {
    view.evidence[el.dataset.filter] = el.value;
    return void go("evidence");
  }
  if (el.id === "finding-status") {
    view.findingStatus = el.value;
    return void go("review");
  }
  if (el.id === "review-target") view.reviewTarget = el.value;
  if (el.id === "build-scope") {
    view.build.scope = el.value;
    return render();
  }
  if (el.id === "build-section") view.build.section = el.value;
  if (el.id === "build-pdfa") view.build.pdfa = el.checked;
  if (el.id === "build-html") view.build.html = el.checked;
  if (el.id === "pack-scope") inputs["pack-scope"] = el.value;
  if (el.id === "pdf-which") {
    view.pdfWhich = el.value;
    void loadPdf().then(render);
  }
});
root.addEventListener("keydown", (event) => {
  if (event.target.id === "ev-text" && event.key === "Enter") {
    event.preventDefault();
    void go("evidence");
  }
});

/** Last resort when the frame may not write the clipboard: show the content preselected. */
function manualCopy(text) {
  openDialog(
    `<div class="dialog-body wide"><p class="lead">${escapeHtml(t("copyManual"))}</p><textarea id="copy-area" class="copy-area" readonly rows="10">${escapeHtml(text)}</textarea><div class="row end">${button("dialog-cancel", escapeHtml(t("close")))}</div></div>`,
    () => dialog.querySelector("#copy-area")?.select(),
  );
  dialog.onclick = (event) => {
    if (event.target.closest("[data-action]")?.dataset.action === "dialog-cancel") closeDialog();
  };
}
/** Which copy path worked last ("clipboard", "execCommand", "manual"); read by the visual check. */
let lastCopyPath;
globalThis.thesisLastCopyPath = () => lastCopyPath;

// ---------- Start ----------
await connected;
try {
  await loadModels();
  await loadStatus();
  render();
  await loadScreen();
  render();
} catch (error) {
  fail(error);
  if (!status) render();
}
setInterval(() => {
  if (job) void poll();
}, POLL_MS);
