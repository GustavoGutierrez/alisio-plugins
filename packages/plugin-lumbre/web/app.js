import { copyPayload, writeClipboard } from "./copy.js";
import {
  allItems,
  applyInput,
  fileRows,
  jobView,
  POLL_MS,
  proposalEntries,
  responseError,
  SERVER_POLL_MS,
  serverView,
} from "./derive.js";
import { hunks, lineDiff, stats } from "./diff.js";
import { errorText, locale, nested, setLocale, t, tf } from "./i18n.js";
import { icon } from "./icons.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";
import { fitThumbnail, renderThumbnail } from "./thumbnail.js";

const root = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const live = document.querySelector("#live");
const approval = document.querySelector("#approval");

/** Effect of every mutation, to name the missing permission on hosts without `effect`. */
const EFFECTS = {
  "projects.create": "write",
  "projects.update": "write",
  "projects.delete": "write",
  "chat.send": "write",
  "chat.clear": "write",
  "proposal.apply": "write",
  "proposal.discard": "write",
  "files.save": "write",
  "files.delete": "write",
  "revisions.restore": "write",
  "jobs.cancel": "write",
  "project.export": "write",
  "preview.check": "process",
  "deps.install": "process",
  "server.start": "process",
  "server.stop": "process",
  "server.open": "process",
};

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
        if (visible) void (unavailable ? verifyAvailable() : resume());
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
  settleApproval();
  const error = responseError(message, EFFECTS[request.action] ?? "read");
  if (!error) return request.resolve(message.result?.value);
  const failure = new Error(error);
  // Only the HOST's not_found can mean "app gone"; a plugin's not_found is an unknown item.
  failure.transport = !!message.error;
  if (message.error === "not_found") hostNotFound();
  request.reject(failure);
}

// One host not_found never latches: it is confirmed with a `status` request after a short delay;
// only a second host not_found shows the unavailable screen, whose "Try again" verifies again.
const VERIFY_DELAY_MS = 1500;
let verifying;
function hostNotFound() {
  if (unavailable || verifying) return;
  verifying = new Promise((r) => setTimeout(r, VERIFY_DELAY_MS)).then(verifyAvailable);
}
async function verifyAvailable() {
  try {
    status = await send("status", {});
    const was = unavailable;
    unavailable = false;
    if (was) await reloadAll();
  } catch (error) {
    if (error?.transport && error.message === "not_found") showUnavailable();
  } finally {
    verifying = undefined;
  }
}

// The host runs at most PLUGIN_APP_LIMITS.inFlight (8) requests per frame; stay below it.
const MAX_IN_FLIGHT = 6;
// Longer than the approval wait (10 min) plus the 30 s handler timeout.
const RESPONSE_GUARD_MS = 11 * 60 * 1000;
const APPROVAL_HINT_MS = 3000;
let inFlight = 0;
const waiting = [];

function settleApproval() {
  // The notice stays while ANY mutation still waits beyond the hint delay.
  if ([...pending.values()].some((r) => r.awaitingHint)) return;
  approval.hidden = true;
}

async function api(action, input = {}) {
  await connected;
  if (unavailable) throw new Error("unavailable");
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
  const mutation = Object.hasOwn(EFFECTS, action);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      settleApproval();
      reject(new Error("timeout"));
    }, RESPONSE_GUARD_MS);
    const request = { resolve, reject, timer, action, awaitingHint: false };
    if (mutation)
      request.approvalTimer = setTimeout(() => {
        request.awaitingHint = true;
        approval.textContent = t("awaitingApproval");
        approval.hidden = false;
        announce(t("awaitingApproval"));
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

// ---------- State ----------
let status = {};
let models = { models: [], active: null, available: true };
let projects = [];
let current;
let proposal;
let snapshot;
let server;
let tab = "preview";
let pane = "chat";
let showArchived = false;
let selectedFile;
let fileView;
let editing = false;
let reviewPath;
let ticked = new Set();
let detailsOpen = false;
let lastError;
const drafts = new Map();
const home = { brief: "", title: "", stack: "vanilla", tailwind: false, model: "" };
/** The job shown in the chat pane: { id, kind, view, receivedAt }. */
let job;
let creating = false;

const button = (action, label, cls = "outline", extra = "") =>
  `<button type="button" class="${cls}" data-action="${action}" ${extra}>${label}</button>`;
const iconButton = (action, name, label, extra = "") =>
  `<button type="button" class="icon-btn ghost" data-action="${action}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" ${extra}>${icon(name)}</button>`;
const announce = (text) => {
  live.textContent = "";
  // A fresh text node makes screen readers announce repeated messages too.
  setTimeout(() => (live.textContent = text), 30);
};
let toastTimer;
function toast(message, kind = "info") {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 7000);
  announce(message);
}
const fail = (error) => {
  if (unavailable) return;
  const code = error?.message ?? "operation_failed";
  if (code === "unavailable") return;
  toast(errorText(code), "error");
};

function showUnavailable() {
  unavailable = true;
  root.innerHTML = `<main class="unavailable"><span class="mark" aria-hidden="true"></span><h1>${escapeHtml(t("unavailableTitle"))}</h1><p>${escapeHtml(t("unavailable"))}</p>${button("retry", escapeHtml(t("retry")), "primary")}</main>`;
}

// ---------- Locale ----------
function changeLocale(value) {
  const focused = document.activeElement?.id;
  setLocale(value);
  render();
  if (focused) document.getElementById(focused)?.focus();
}

// ---------- Rendering ----------
const stackInfo = (id) => (status.stacks ?? []).find((s) => s.id === id);
const stackLabel = (p) => {
  const info = stackInfo(p.stack);
  const label = info?.label?.[locale] ?? info?.label?.en ?? p.stack;
  return p.stack === "vanilla" && p.tailwind ? `${label} + Tailwind` : label;
};
const dateText = (ms) =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));

function render() {
  if (unavailable) return showUnavailable();
  document.documentElement.lang = locale;
  if (current) renderStudio();
  else renderHome();
}

function brand() {
  return `<div class="brand"><span class="mark" aria-hidden="true"></span><strong>Lumbre</strong><span class="tagline">${escapeHtml(t("tagline"))}</span></div>`;
}

function modelOptions(chosen) {
  const groups = new Map();
  for (const m of models.models ?? []) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  const options = [...groups.entries()]
    .map(
      ([provider, list]) =>
        `<optgroup label="${escapeHtml(provider)}">${list.map((m) => `<option value="${escapeHtml(m.reference)}" ${m.reference === chosen ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}</optgroup>`,
    )
    .join("");
  return `<option value="" ${chosen ? "" : "selected"}>${escapeHtml(tf("modelDefault", models.active ?? ""))}</option>${options}`;
}

function noModelBanner() {
  return `<div class="banner warn" role="alert">${icon("warning")}<span><strong>${escapeHtml(t("noModelTitle"))}</strong> ${escapeHtml(t("noModel"))}</span></div>`;
}

function renderHome() {
  const stacks = status.stacks ?? [];
  const visibleProjects = projects.filter((p) => p.damaged || showArchived || !p.archived);
  const cards = visibleProjects
    .map((p) =>
      p.damaged
        ? `<article class="card damaged"><p>${icon("warning")} ${escapeHtml(t("damaged"))}</p>${button("delete-project", escapeHtml(t("deleteProject")), "danger small", `data-id="${p.id}"`)}</article>`
        : `<article class="card"><button type="button" class="card-open" data-action="open-project" data-id="${p.id}"><span class="card-title">${escapeHtml(p.title)}</span><span class="card-meta">${escapeHtml(stackLabel(p))}</span><span class="card-meta">${escapeHtml(t("updated"))} ${escapeHtml(dateText(p.updatedAt))}</span>${p.running ? `<span class="badge live">${escapeHtml(t("running"))}</span>` : ""}${p.archived ? `<span class="badge">${escapeHtml(t("archived"))}</span>` : ""}</button><div class="card-actions">${iconButton("archive-project", "box", p.archived ? t("unarchive") : t("archive"), `data-id="${p.id}"`)}${iconButton("delete-project", "trash", t("deleteProject"), `data-id="${p.id}"`)}</div></article>`,
    )
    .join("");
  const stackCards = stacks
    .map(
      (s) =>
        `<label class="stack ${home.stack === s.id ? "selected" : ""}"><input type="radio" name="stack" value="${s.id}" ${home.stack === s.id ? "checked" : ""}><span class="stack-name">${escapeHtml(s.label[locale] ?? s.label.en)}${s.id === "vanilla" ? ` <span class="badge accent">${escapeHtml(t("recommended"))}</span>` : ""}</span><span class="stack-desc">${escapeHtml(s.description[locale] ?? s.description.en)}</span>${s.nodeOk ? "" : `<span class="stack-warn">${icon("warning")}${escapeHtml(tf("needsNode", s.minNode))}</span>`}</label>`,
    )
    .join("");
  root.innerHTML = `<header class="topbar">${brand()}</header>
  <main class="home">
    <section class="hero">
      <h1>${escapeHtml(t("homeTitle"))}</h1>
      <p class="lead">${escapeHtml(t("homeLead"))}</p>
      ${models.available === false ? noModelBanner() : ""}
      <label class="sr-only" for="brief">${escapeHtml(t("briefLabel"))}</label>
      <textarea id="brief" class="brief" rows="4" maxlength="8000" placeholder="${escapeHtml(t("briefPlaceholder"))}">${escapeHtml(home.brief)}</textarea>
      <fieldset class="stacks"><legend>${escapeHtml(t("stackLabel"))}</legend>${stackCards}</fieldset>
      ${home.stack === "vanilla" ? `<label class="check"><input type="checkbox" id="tailwind" ${home.tailwind ? "checked" : ""}><span>${escapeHtml(t("tailwind"))}<small>${escapeHtml(t("tailwindHint"))}</small></span></label>` : ""}
      <div class="create-row">
        <label class="field"><span>${escapeHtml(t("projectName"))}</span><input id="title" maxlength="100" value="${escapeHtml(home.title)}" placeholder="${escapeHtml(t("projectNamePlaceholder"))}"></label>
        <label class="field"><span>${escapeHtml(t("model"))}</span><select id="home-model">${modelOptions(home.model)}</select></label>
        ${button("create", creating ? `<span class="spinner" aria-hidden="true"></span>${escapeHtml(t("creating"))}` : `${icon("spark")}<span>${escapeHtml(t("create"))}</span>`, "primary big", creating || models.available === false ? "disabled" : "")}
      </div>
    </section>
    <section class="projects" aria-labelledby="projects-title">
      <div class="section-head"><h2 id="projects-title">${escapeHtml(t("yourProjects"))}</h2>${projects.some((p) => p.archived) ? `<label class="check small"><input type="checkbox" id="show-archived" ${showArchived ? "checked" : ""}><span>${escapeHtml(t("showArchived"))}</span></label>` : ""}</div>
      ${cards ? `<div class="grid">${cards}</div>` : `<p class="muted">${escapeHtml(t("noProjects"))}</p>`}
    </section>
  </main>`;
}

function renderStudio() {
  const p = current;
  const draft = drafts.get(p.id) ?? "";
  const focused = document.activeElement?.id;
  const selection = [document.activeElement?.selectionStart, document.activeElement?.selectionEnd];
  root.innerHTML = `<div class="studio" data-pane="${pane}">
    <header class="topbar studio-bar">
      ${iconButton("back", "back", t("back"))}
      <div class="title-block"><button type="button" class="project-title" data-action="rename" title="${escapeHtml(t("rename"))}">${escapeHtml(p.title)}</button><span class="badge">${escapeHtml(stackLabel(p))}</span></div>
      <div class="bar-actions">
        ${models.available === false ? "" : `<label class="model-picker"><span>${escapeHtml(t("model"))}</span><select id="project-model">${modelOptions(p.model ?? "")}</select></label>`}
        ${button("export", `${icon("download")}<span>${escapeHtml(t("export"))}</span>`, "outline small")}
      </div>
    </header>
    <nav class="pane-switch" aria-label="${escapeHtml(t("chat"))} / ${escapeHtml(t("preview"))}">
      ${button("pane-chat", `${icon("chat")}<span>${escapeHtml(t("chat"))}</span>`, pane === "chat" ? "seg active" : "seg", `aria-pressed="${pane === "chat"}"`)}
      ${button("pane-work", `${icon("eye")}<span>${escapeHtml(t("preview"))}</span>`, pane === "work" ? "seg active" : "seg", `aria-pressed="${pane === "work"}"`)}
    </nav>
    <section class="chat-pane" aria-label="${escapeHtml(t("chat"))}">
      ${models.available === false ? noModelBanner() : ""}
      <div id="messages" class="messages">${messagesHtml()}</div>
      <div id="job-slot">${jobHtml()}</div>
      <div class="composer">
        <div class="composer-box"><label class="sr-only" for="composer">${escapeHtml(t("composerLabel"))}</label><textarea id="composer" rows="1" maxlength="8000" placeholder="${escapeHtml(t("composerPlaceholder"))}" aria-describedby="composer-hint" ${models.available === false ? "disabled" : ""}>${escapeHtml(draft)}</textarea>${composerButton(draft)}</div>
        <p id="composer-hint" class="composer-hint">${escapeHtml(t("composerHint"))}</p>
        <p class="disclaimer">${escapeHtml(t("disclaimer"))}</p>
      </div>
    </section>
    <section class="work-pane">
      <div class="tabs" role="tablist">${["preview", "changes", "code", "history"].map((k) => `<button type="button" role="tab" id="tab-${k}" aria-selected="${tab === k}" class="tab ${tab === k ? "active" : ""}" data-action="tab" data-tab="${k}">${icon({ preview: "eye", changes: "diff", code: "code", history: "history" }[k])}<span>${escapeHtml(t(k))}</span>${k === "changes" && p.proposal ? '<span class="dot" aria-hidden="true"></span>' : ""}</button>`).join("")}</div>
      <div id="tab-body" class="tab-body" role="tabpanel" aria-labelledby="tab-${tab}">${tabHtml()}</div>
    </section>
  </div>`;
  afterRender();
  const box = document.querySelector("#composer");
  autoGrow(box);
  if (focused) {
    const el = document.getElementById(focused);
    el?.focus();
    if (el && typeof selection[0] === "number" && typeof el.setSelectionRange === "function")
      el.setSelectionRange(selection[0], selection[1]);
  }
  const messages = document.querySelector("#messages");
  if (messages) messages.scrollTop = messages.scrollHeight;
}

function composerButton(draft) {
  if (job?.view.running && job.kind === "generate")
    return `<button type="button" class="send-btn stop" data-action="cancel-job" aria-label="${escapeHtml(t("stop"))}" title="${escapeHtml(t("stop"))}">${icon("stop")}</button>`;
  const disabled = !draft.trim() || models.available === false || job?.view.running;
  return `<button type="button" class="send-btn" data-action="send" aria-label="${escapeHtml(t("send"))}" title="${escapeHtml(t("send"))}" ${disabled ? "disabled" : ""}>${icon("send")}</button>`;
}

function autoGrow(box) {
  if (!box) return;
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight || 40, 180)}px`;
}

const copyControls = (index) =>
  `<span class="copy-controls">${iconButton("copy-text", "copy", t("copyText"), `data-index="${index}"`)}${iconButton("copy-formatted", "copyRich", t("copyFormatted"), `data-index="${index}"`)}</span>`;

function messagesHtml() {
  const chat = current?.chat ?? [];
  if (!chat.length && !job?.view.running)
    return `<div class="empty-chat"><span class="mark big" aria-hidden="true"></span><h2>${escapeHtml(t("emptyChatTitle"))}</h2><p class="muted">${escapeHtml(t("emptyChatText"))}</p></div>`;
  const max = status.maxFixAttempts ?? 2;
  return chat
    .map((m, i) => {
      if (m.role === "user")
        return `<div class="msg user"><span class="who">${escapeHtml(t("you"))}</span><p>${escapeHtml(m.text)}</p></div>`;
      if (m.role === "notice") {
        const text =
          m.notice === "build_failed"
            ? nested("notice", "build_failed", m.fixAttempt ?? 1, max)
            : m.notice === "generation_failed"
              ? `${nested("notice", "generation_failed")} ${errorText(m.code ?? "operation_failed")}`
              : m.notice === "output_partial"
                ? nested("notice", "output_partial", m.count ?? 0)
                : nested("notice", m.notice ?? "applied");
        const warn = m.notice !== "applied";
        return `<div class="notice ${warn ? "warn" : "ok"}">${icon(warn ? "warning" : "check")}<span>${escapeHtml(text)}</span></div>`;
      }
      const review =
        m.proposalId && current.proposal?.id === m.proposalId
          ? `<p>${button("tab-changes", `${icon("diff")}<span>${escapeHtml(t("reviewTitle"))}</span>`, "primary small")}</p>`
          : "";
      return `<div class="msg assistant"><span class="who">${escapeHtml(t("assistant"))}${m.fixAttempt ? ` <span class="badge warn">${escapeHtml(tf("fixLabel", m.fixAttempt, max))}</span>` : ""}${copyControls(i)}</span><div class="md">${renderMarkdown(m.text)}</div>${m.modelFallback ? `<p class="warn small">${icon("warning")}${escapeHtml(t("modelFallback"))}</p>` : ""}${review}</div>`;
    })
    .join("");
}

function stageText(step) {
  return nested("stage", step.key, step.args ?? {});
}

function jobHtml() {
  if (!job) return lastError ? errorCard(lastError) : "";
  const v = job.view;
  if (!v.running) return lastError ? errorCard(lastError) : "";
  const bar =
    v.percent === null
      ? `<div class="progress indeterminate" role="progressbar" aria-label="${escapeHtml(stageText(v.stage))}"><span></span></div>`
      : `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v.percent}"><span style="width:${v.percent}%"></span></div>`;
  const steps = v.steps
    .filter(
      (s) =>
        s.key === "writing" ||
        s.key === "removing" ||
        s.key === "installing" ||
        s.key === "building",
    )
    .map(
      (s) =>
        `<li>${icon("check")}<span>${escapeHtml(s.key === "writing" ? tf("wrote", s.args ?? {}) : s.key === "removing" ? tf("removed", s.args ?? {}) : stageText(s))}</span></li>`,
    )
    .join("");
  return `<div class="job-card" aria-busy="true">
    <div class="job-head"><span class="spinner" aria-hidden="true"></span><strong class="job-stage">${escapeHtml(stageText(v.stage))}</strong><span class="elapsed" aria-label="${escapeHtml(tf("elapsed", v.elapsed))}">${escapeHtml(v.elapsed)}</span>${button("cancel-job", escapeHtml(t("cancel")), "ghost small")}</div>
    ${bar}
    ${steps ? `<ul class="steps">${steps}</ul>` : ""}
    ${v.slow ? `<p class="hint">${escapeHtml(t("stillWorking"))}</p>` : ""}
  </div>`;
}

/** Generation facts of a job (numbers and categories only), for the Details panel. */
function diagnosticsHtml(d) {
  if (!d) return "";
  const dt = (key) => nested("details", key);
  const source = (value) => dt(value === "provider" ? "provider" : "estimated");
  const n = (value) => new Intl.NumberFormat(locale).format(value ?? 0);
  const rows = [
    ["model", d.model ?? "—"],
    ["context", `${n(d.contextWindow)} (${source(d.contextSource)})`],
    ["output", `${n(d.outputBudget)} (${source(d.outputSource)})`],
    ["usage", `${n(d.usageInput)} / ${n(d.usageOutput)}`],
    ["batches", d.planned ? String(d.batches) : dt("no")],
    ["continuations", String(d.continuations ?? 0)],
    ...(d.retriedWithoutLimit ? [["retried", dt("yes")]] : []),
    ...(d.reason ? [["reason", nested("reasons", d.reason)]] : []),
  ];
  return `<dl class="diag">${rows.map(([k, v]) => `<dt>${escapeHtml(dt(k))}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>`;
}

function errorCard(e) {
  const reason =
    e.code === "agent_failed" && e.diagnostics?.reason
      ? ` (${nested("reasons", e.diagnostics.reason)})`
      : "";
  const text = e.warning ?? `${errorText(e.code)}${reason}`;
  const hasDetails = !!(e.log || e.diagnostics);
  const details = hasDetails
    ? `<button type="button" class="link" data-action="toggle-details" aria-expanded="${detailsOpen}">${escapeHtml(detailsOpen ? t("hideDetails") : t("showDetails"))}</button>${detailsOpen ? `${diagnosticsHtml(e.diagnostics)}${e.log ? `<pre class="log">${escapeHtml(e.log)}</pre>` : ""}` : ""}`
    : "";
  return `<div class="job-card ${e.warning ? "warning" : "error"}" role="alert">
    <div class="job-head">${icon("warning")}<strong>${escapeHtml(text)}</strong>${iconButton("dismiss-error", "close", t("close"))}</div>
    ${details}
  </div>`;
}

function tabHtml() {
  if (tab === "changes") return reviewHtml();
  if (tab === "code") return codeHtml();
  if (tab === "history") return historyHtml();
  return previewHtml();
}

function previewHtml() {
  const s = serverView(server ?? current.server);
  const stateText = s.running
    ? `${escapeHtml(t("liveRunning"))} <code class="url">${escapeHtml(s.url)}</code>${iconButton("copy-url", "copy", t("copyUrl"))}`
    : escapeHtml(s.idleStopped ? t("liveIdle") : s.crashed ? t("liveCrashed") : t("liveStopped"));
  const busy = job?.view.running;
  const controls = s.running
    ? `${button("open-browser", `${icon("external")}<span>${escapeHtml(t("openBrowser"))}</span>`, "primary")}${button("stop-server", `${icon("stop")}<span>${escapeHtml(t("stopLive"))}</span>`, "outline")}`
    : button(
        "start-server",
        `${icon("play")}<span>${escapeHtml(t("startLive"))}</span>`,
        "primary",
        busy ? "disabled" : "",
      );
  const caption = !snapshot
    ? ""
    : snapshot.kind === "script"
      ? t("thumbScript")
      : snapshot.kind === "none"
        ? t("thumbNone")
        : snapshot.stale
          ? t("thumbStale")
          : t("thumbCaption");
  const npm = current.files.some((f) => f.path === "package.json");
  return `<div class="preview">
    <div class="live-bar ${s.running ? "on" : ""}"><span class="state-dot" aria-hidden="true"></span><div class="live-text"><strong>${escapeHtml(t("livePreview"))}</strong><span class="live-state">${stateText}</span>${s.running ? `<small>${escapeHtml(t("liveHint"))}</small>` : ""}</div><div class="live-actions">${controls}</div></div>
    <figure class="thumb-wrap">
      ${snapshot && snapshot.kind === "static" ? `<div id="thumb" class="thumb-canvas" role="img" aria-label="${escapeHtml(t("thumbLabel"))}"></div>` : `<div class="thumb-empty">${icon("eye", "icon big")}</div>`}
      <figcaption class="${snapshot?.stale ? "warn" : "muted"}">${escapeHtml(caption)}</figcaption>
    </figure>
    <div class="build-row">${current.needsBuild ? button("check-build", `${icon("refresh")}<span>${escapeHtml(t("checkBuild"))}</span>`, "outline small", busy ? "disabled" : "") : ""}${npm ? button("reinstall", `${icon("box")}<span>${escapeHtml(t("reinstall"))}</span>`, "ghost small", busy ? "disabled" : "") : ""}</div>
  </div>`;
}

function reviewHtml() {
  if (!proposal) return `<p class="muted pad">${escapeHtml(t("noChanges"))}</p>`;
  const entries = proposalEntries(proposal);
  const max = status.maxFixAttempts ?? 2;
  const rows = entries
    .map((e) => {
      const ops =
        e.status === "deleted"
          ? null
          : lineDiff(proposal.before[e.path] ?? "", proposal.files[e.path]);
      const st =
        e.status === "deleted"
          ? { added: 0, removed: (proposal.before[e.path] ?? "").split("\n").length }
          : stats(ops);
      return `<li class="review-file ${reviewPath === e.path ? "active" : ""}"><label class="check"><input type="checkbox" data-item="file:${escapeHtml(e.path)}" ${ticked.has(`file:${e.path}`) ? "checked" : ""}><span class="badge ${e.status}">${escapeHtml(t(e.status))}</span></label><button type="button" class="file-link" data-action="show-diff" data-path="${escapeHtml(e.path)}">${escapeHtml(e.path)}</button><span class="counts"><span class="add">${escapeHtml(tf("linesAdded", st.added))}</span> <span class="del">${escapeHtml(tf("linesRemoved", st.removed))}</span></span></li>`;
    })
    .join("");
  const deps = Object.entries(proposal.dependencies ?? {})
    .map(
      ([name, version]) =>
        `<li><label class="check"><input type="checkbox" data-item="dep:${escapeHtml(name)}" ${ticked.has(`dep:${name}`) ? "checked" : ""}><code>${escapeHtml(name)}@${escapeHtml(version)}</code></label></li>`,
    )
    .join("");
  const ignored = (proposal.ignored ?? [])
    .map(
      (i) =>
        `<li><code>${escapeHtml(i.path ?? i.name)}</code> — ${escapeHtml(nested("ignored", i.reason))}</li>`,
    )
    .join("");
  return `<div class="review">
    <div class="review-head"><h2>${escapeHtml(t("reviewTitle"))}</h2>${proposal.fixAttempt ? `<span class="badge warn">${escapeHtml(tf("fixLabel", proposal.fixAttempt, max))}</span>` : ""}</div>
    <p class="summary">${escapeHtml(proposal.summary)}</p>
    ${proposal.partial ? `<div class="banner warn" role="note">${icon("warning")}<span>${escapeHtml(nested("notice", "output_partial", proposal.partial.received))}${proposal.partial.missing?.length ? ` ${escapeHtml(t("missing"))} ${escapeHtml(proposal.partial.missing.join(", "))}` : ""}</span></div>` : ""}
    <p class="muted small">${escapeHtml(t("reviewLead"))}</p>
    <ul class="review-files">${rows}</ul>
    ${deps ? `<h3>${escapeHtml(t("packages"))}</h3><ul class="deps">${deps}</ul><p class="muted small">${escapeHtml(t("packageHint"))}</p>` : ""}
    ${ignored ? `<div class="ignored"><strong>${escapeHtml(t("ignoredTitle"))}</strong><ul>${ignored}</ul></div>` : ""}
    <div class="review-actions">${button("apply-selected", `${icon("check")}<span>${escapeHtml(t("applySelected"))}</span>`, "primary")}${button("apply-all", escapeHtml(t("applyAll")), "outline")}${button("discard", escapeHtml(t("discard")), "ghost danger-text")}</div>
    ${reviewPath ? diffHtml(reviewPath) : ""}
  </div>`;
}

function diffHtml(path) {
  const deleted = proposal.deletes.includes(path);
  const before = proposal.before[path] ?? "";
  const after = deleted ? "" : (proposal.files[path] ?? "");
  const groups = hunks(lineDiff(before, after));
  if (!groups) return `<p class="muted pad">${escapeHtml(t("tooLarge"))}</p>`;
  const body = groups
    .map(
      (g) =>
        `<tbody class="hunk">${g.map((op) => `<tr class="${op.type}"><td class="ln">${op.a ?? ""}</td><td class="ln">${op.b ?? ""}</td><td class="sign">${op.type === "add" ? "+" : op.type === "del" ? "−" : ""}</td><td class="code"><code>${escapeHtml(op.text)}</code></td></tr>`).join("")}</tbody>`,
    )
    .join("");
  return `<div class="diff" aria-label="${escapeHtml(path)}"><div class="diff-head"><code>${escapeHtml(path)}</code></div><table>${body}</table></div>`;
}

function codeHtml() {
  const rows = fileRows(current.files)
    .map(
      (f) =>
        `<li><button type="button" class="file-link ${selectedFile === f.path ? "active" : ""}" data-action="select-file" data-path="${escapeHtml(f.path)}" style="padding-left:${8 + f.depth * 12}px">${icon(f.owned ? "lock" : "file")}<span>${escapeHtml(f.path)}</span></button></li>`,
    )
    .join("");
  let viewer = `<p class="muted pad">${escapeHtml(t("selectFile"))}</p>`;
  if (fileView) {
    const head = `<div class="viewer-head"><code class="viewer-path">${escapeHtml(fileView.path)}</code>${fileView.owned ? `<span class="badge">${icon("lock")}${escapeHtml(t("managedFile"))}</span>` : editing ? `${button("save-file", escapeHtml(t("save")), "primary small")}${button("cancel-edit", escapeHtml(t("cancel")), "ghost small")}` : `${button("edit-file", `${icon("edit")}<span>${escapeHtml(t("edit"))}</span>`, "outline small")}${iconButton("delete-file", "trash", t("deleteFile"))}`}</div>`;
    viewer =
      head +
      (editing
        ? `<label class="sr-only" for="file-editor">${escapeHtml(fileView.path)}</label><textarea id="file-editor" class="editor" spellcheck="false">${escapeHtml(fileView.draft ?? fileView.content)}</textarea>`
        : `<pre class="source"><code>${escapeHtml(fileView.content)}</code></pre>`);
  }
  return `<div class="code-view"><div class="file-list"><ul>${rows}</ul>${button("new-file", `${icon("plus")}<span>${escapeHtml(t("newFileButton"))}</span>`, "ghost small")}</div><div class="viewer">${viewer}</div></div>`;
}

function historyHtml() {
  return `<ul class="history">${current.revisions
    .map(
      (r) =>
        `<li><div><span class="badge ${r.kind}">${escapeHtml(nested("kinds", r.kind))}</span> <strong>${escapeHtml(r.summary)}</strong><br><small class="muted">${escapeHtml(dateText(r.at))}</small></div>${r.id === current.head ? `<span class="badge accent">${escapeHtml(t("current"))}</span>` : button("restore", `${icon("history")}<span>${escapeHtml(t("restore"))}</span>`, "outline small", `data-id="${r.id}"`)}</li>`,
    )
    .join("")}</ul>`;
}

let resizer;
function afterRender() {
  const thumb = document.querySelector("#thumb");
  if (thumb && snapshot) {
    renderThumbnail(thumb, snapshot);
    if (typeof ResizeObserver === "function") {
      resizer?.disconnect();
      resizer = new ResizeObserver(() => fitThumbnail(thumb));
      resizer.observe(thumb);
    }
  }
}

function refreshJobSlot() {
  const slot = document.querySelector("#job-slot");
  if (slot) slot.innerHTML = jobHtml();
  const actions = document.querySelector(".composer-box .send-btn");
  if (actions) actions.outerHTML = composerButton(drafts.get(current?.id) ?? "");
}

// ---------- Data ----------
async function reloadAll() {
  try {
    [status, projects] = await Promise.all([api("status"), api("projects.list")]);
    models = (await api("models.list").catch(() => models)) ?? models;
    if (current) await loadProject(current.id);
    render();
  } catch (error) {
    fail(error);
  }
}

async function loadProject(id) {
  current = await api("projects.get", { projectId: id });
  server = current.server;
  proposal = current.proposal
    ? await api("proposal.get", { projectId: id }).catch(() => undefined)
    : undefined;
  if (proposal) {
    proposal.projectId = id;
    if (!ticked.size || ![...ticked].every((k) => allItems(proposal).has(k)))
      ticked = allItems(proposal);
  } else ticked = new Set();
  snapshot = await api("preview.snapshot", { projectId: id }).catch(() => undefined);
  if (selectedFile && !current.files.some((f) => f.path === selectedFile)) {
    selectedFile = undefined;
    fileView = undefined;
  }
  if (current.job && (!job || job.id !== current.job)) watchJob(current.job, "resume");
}

async function resume() {
  if (current) {
    await loadProject(current.id).catch(fail);
    render();
  } else await reloadAll();
}

/** Polls a job, updating the status card, until it ends; then runs `done`. */
function watchJob(id, kind, done) {
  job = { id, kind, view: jobView({ state: "running" }), receivedAt: Date.now() };
  lastError = undefined;
  detailsOpen = false;
  let lastStage = "";
  refreshJobSlot();
  const tick = setInterval(() => {
    if (job?.id !== id) return clearInterval(tick);
    if (job.raw) job.view = jobView(job.raw, Date.now(), job.receivedAt);
    const el = document.querySelector(".job-card .elapsed");
    if (el) el.textContent = job.view.elapsed;
  }, 1000);
  const loop = async () => {
    while (job?.id === id) {
      if (!visible) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        continue;
      }
      let raw;
      try {
        raw = await api("jobs.get", { jobId: id });
      } catch (error) {
        if (error.message === "not_found" && !error.transport) break;
        await new Promise((r) => setTimeout(r, POLL_MS * 2));
        continue;
      }
      job.raw = raw;
      job.receivedAt = Date.now();
      job.view = jobView(raw, job.receivedAt, job.receivedAt);
      job.kind = raw.kind;
      if (raw.stage.key !== lastStage) {
        lastStage = raw.stage.key;
        announce(stageText(raw.stage));
      }
      if (!job.view.running) break;
      refreshJobSlot();
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    clearInterval(tick);
    const finished = job?.id === id ? job : undefined;
    if (!finished) return;
    job = undefined;
    const raw = finished.raw;
    if (raw?.state === "failed") {
      lastError = { code: raw.error, log: raw.log, diagnostics: raw.diagnostics ?? null };
      announce(errorText(raw.error));
    } else if (raw?.state === "done" && raw.result?.partial) {
      // Kept what arrived: say so where the person is looking, with the same Details.
      lastError = {
        warning: nested("notice", "output_partial", raw.result.partial.received),
        diagnostics: raw.diagnostics ?? null,
      };
      announce(lastError.warning);
    } else if (raw?.state === "cancelled") toast(t("cancelled"));
    if (current) await loadProject(current.id).catch(fail);
    try {
      await done?.(raw);
    } catch (error) {
      fail(error);
    }
    render();
  };
  void loop();
}

async function afterApply() {
  if (current.needsBuild) await runCheck();
}

async function runCheck() {
  const { jobId } = await api("preview.check", { projectId: current.id, locale });
  watchJob(jobId, "check", async (raw) => {
    if (raw?.state !== "done") return;
    if (raw.result?.ok) toast(t("buildOk"), "ok");
    else if (raw.result?.fixProposal) {
      tab = "changes";
      pane = "work";
    }
  });
}

async function sendMessage() {
  const text = (drafts.get(current.id) ?? "").trim();
  if (!text) return;
  const { jobId } = await api("chat.send", { projectId: current.id, text, locale });
  drafts.set(current.id, "");
  current.chat = [...(current.chat ?? []), { role: "user", text, at: Date.now() }];
  watchJob(jobId, "generate", async (raw) => {
    if (raw?.state === "done" && raw.result?.proposalId) {
      tab = "changes";
      reviewPath = undefined;
      if (window.matchMedia?.("(max-width: 900px)")?.matches) pane = "work";
      announce(nested("stage", "reviewReady"));
    }
  });
  render();
}

// ---------- Events ----------
async function onAction(action, target) {
  switch (action) {
    case "retry":
      return verifyAvailable();
    case "create": {
      creating = true;
      render();
      try {
        const title =
          home.title.trim() || home.brief.trim().split(/\s+/).slice(0, 5).join(" ").slice(0, 60);
        const p = await api("projects.create", {
          title,
          stack: home.stack,
          ...(home.stack === "vanilla" ? { tailwind: home.tailwind } : {}),
          model: home.model || null,
        });
        const brief = home.brief.trim();
        Object.assign(home, { brief: "", title: "" });
        tab = "preview";
        pane = "chat";
        await loadProject(p.id);
        if (brief) {
          drafts.set(p.id, brief);
          await sendMessage();
        }
      } finally {
        creating = false;
        render();
      }
      return;
    }
    case "open-project":
      tab = "preview";
      pane = "chat";
      job = undefined;
      lastError = undefined;
      await loadProject(target.dataset.id);
      return render();
    case "archive-project": {
      const p = projects.find((x) => x.id === target.dataset.id);
      await api("projects.update", { projectId: p.id, archived: !p.archived });
      projects = await api("projects.list");
      return render();
    }
    case "delete-project":
      if (!(await confirmDialog(t("confirmDelete"), t("deleteProject")))) return;
      await api("projects.delete", { projectId: target.dataset.id });
      projects = await api("projects.list");
      return render();
    case "back":
      current = undefined;
      job = undefined;
      lastError = undefined;
      projects = await api("projects.list");
      return render();
    case "rename": {
      const title = await promptDialog(t("rename"), t("projectName"), current.title, 100);
      if (!title) return;
      current = await api("projects.update", { projectId: current.id, title });
      return render();
    }
    case "pane-chat":
      pane = "chat";
      return render();
    case "pane-work":
      pane = "work";
      return render();
    case "tab":
      tab = target.dataset.tab;
      return render();
    case "tab-changes":
      tab = "changes";
      pane = "work";
      return render();
    case "send":
      return sendMessage();
    case "cancel-job":
      if (job) await api("jobs.cancel", { jobId: job.id });
      return;
    case "dismiss-error":
      lastError = undefined;
      return refreshJobSlot();
    case "toggle-details":
      detailsOpen = !detailsOpen;
      return refreshJobSlot();
    case "copy-text":
    case "copy-formatted": {
      const m = current.chat[Number(target.dataset.index)];
      if (!m) return;
      const payload = copyPayload(m.text, renderMarkdown, action === "copy-formatted");
      const how = await writeClipboard(payload);
      if (how === "manual") return manualCopy(payload.text);
      return toast(t("copied"), "ok");
    }
    case "copy-url": {
      const url = serverView(server).url;
      if (!url) return;
      const how = await writeClipboard({ text: url });
      return how === "manual" ? manualCopy(url) : toast(t("copied"), "ok");
    }
    case "start-server": {
      const { jobId } = await api("server.start", { projectId: current.id });
      watchJob(jobId, "start");
      return;
    }
    case "stop-server":
      server = await api("server.stop", { projectId: current.id });
      return render();
    case "open-browser":
      await api("server.open", { projectId: current.id });
      return;
    case "check-build":
      return runCheck();
    case "reinstall": {
      const { jobId } = await api("deps.install", { projectId: current.id });
      watchJob(jobId, "install");
      return;
    }
    case "show-diff":
      reviewPath = target.dataset.path;
      return render();
    case "apply-all":
      ticked = allItems(proposal);
      return applyTicked();
    case "apply-selected":
      return applyTicked();
    case "discard":
      await api("proposal.discard", { projectId: current.id, proposalId: proposal.id });
      await loadProject(current.id);
      tab = "preview";
      return render();
    case "select-file": {
      selectedFile = target.dataset.path;
      editing = false;
      fileView = await api("files.get", { projectId: current.id, path: selectedFile });
      return render();
    }
    case "edit-file":
      editing = true;
      fileView.draft = fileView.content;
      render();
      return document.querySelector("#file-editor")?.focus();
    case "cancel-edit":
      editing = false;
      return render();
    case "save-file": {
      const content = document.querySelector("#file-editor")?.value ?? fileView.content;
      await api("files.save", {
        projectId: current.id,
        path: fileView.path,
        content,
        baseRevision: current.head,
      });
      editing = false;
      await loadProject(current.id);
      fileView = await api("files.get", { projectId: current.id, path: fileView.path });
      toast(t("saved"), "ok");
      render();
      return afterApply();
    }
    case "delete-file":
      if (!(await confirmDialog(tf("confirmDeleteFile", fileView.path), t("deleteFile")))) return;
      await api("files.delete", {
        projectId: current.id,
        path: fileView.path,
        baseRevision: current.head,
      });
      fileView = undefined;
      selectedFile = undefined;
      await loadProject(current.id);
      return render();
    case "new-file": {
      const path = await promptDialog(t("newFileButton"), t("newFileName"), "", 200);
      if (!path) return;
      await api("files.save", {
        projectId: current.id,
        path,
        content: "",
        baseRevision: current.head,
      });
      await loadProject(current.id);
      selectedFile = path;
      fileView = await api("files.get", { projectId: current.id, path });
      editing = true;
      fileView.draft = "";
      return render();
    }
    case "restore":
      if (!(await confirmDialog(t("confirmRestore"), t("restore")))) return;
      await api("revisions.restore", { projectId: current.id, revisionId: target.dataset.id });
      await loadProject(current.id);
      render();
      return afterApply();
    case "export":
      return exportDialog();
  }
}

async function applyTicked() {
  const input = applyInput(proposal, ticked);
  if (!input.files.length && !input.deletes.length && !input.dependencies.length)
    return toast(t("noneSelected"), "error");
  await api("proposal.apply", input);
  reviewPath = undefined;
  tab = "preview";
  await loadProject(current.id);
  toast(nested("notice", "applied"), "ok");
  render();
  await afterApply();
}

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  void onAction(target.dataset.action, target).catch(fail);
});
root.addEventListener("input", (event) => {
  const el = event.target;
  if (el.id === "composer") {
    drafts.set(current.id, el.value);
    autoGrow(el);
    const btn = document.querySelector(".composer-box .send-btn");
    if (btn && btn.dataset.action === "send")
      btn.disabled = !el.value.trim() || models.available === false || !!job?.view.running;
  } else if (el.id === "brief") home.brief = el.value;
  else if (el.id === "title") home.title = el.value;
  else if (el.id === "file-editor" && fileView) fileView.draft = el.value;
});
root.addEventListener("change", (event) => {
  const el = event.target;
  if (el.name === "stack") {
    home.stack = el.value;
    render();
  } else if (el.id === "tailwind") home.tailwind = el.checked;
  else if (el.id === "home-model") home.model = el.value;
  else if (el.id === "show-archived") {
    showArchived = el.checked;
    render();
  } else if (el.dataset.item) {
    if (el.checked) ticked.add(el.dataset.item);
    else ticked.delete(el.dataset.item);
  } else if (el.id === "project-model") {
    void api("projects.update", { projectId: current.id, model: el.value || null })
      .then((p) => {
        current = p;
      })
      .catch(fail);
  }
});
root.addEventListener("keydown", (event) => {
  if (
    event.target.id === "composer" &&
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    if (!job?.view.running) void sendMessage().catch(fail);
  }
});
window.addEventListener("beforeunload", (event) => {
  if (editing) event.preventDefault();
});

// ---------- Dialogs ----------
function openDialog(html) {
  dialog.innerHTML = html;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}
function closeDialog() {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}
function confirmDialog(text, confirmLabel) {
  return new Promise((resolve) => {
    openDialog(
      `<div class="dialog-body"><p>${escapeHtml(text)}</p><div class="dialog-actions">${button("dlg-cancel", escapeHtml(t("cancel")), "ghost")}${button("dlg-ok", escapeHtml(confirmLabel), "danger")}</div></div>`,
    );
    dialog.onclick = (e) => {
      const a = e.target.closest("[data-action]")?.dataset.action;
      if (!a) return;
      closeDialog();
      resolve(a === "dlg-ok");
    };
    dialog.oncancel = () => resolve(false);
  });
}
function promptDialog(title, label, value, max) {
  return new Promise((resolve) => {
    openDialog(
      `<div class="dialog-body"><h2>${escapeHtml(title)}</h2><label class="field"><span>${escapeHtml(label)}</span><input id="dlg-input" maxlength="${max}" value="${escapeHtml(value)}"></label><div class="dialog-actions">${button("dlg-cancel", escapeHtml(t("cancel")), "ghost")}${button("dlg-ok", escapeHtml(t("ok")), "primary")}</div></div>`,
    );
    const input = dialog.querySelector("#dlg-input");
    input?.focus();
    const finish = (ok) => {
      const v = input?.value.trim() ?? "";
      closeDialog();
      resolve(ok && v ? v : undefined);
    };
    dialog.onclick = (e) => {
      const a = e.target.closest("[data-action]")?.dataset.action;
      if (a) finish(a === "dlg-ok");
    };
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      }
    });
    dialog.oncancel = () => resolve(undefined);
  });
}
function manualCopy(text) {
  openDialog(
    `<div class="dialog-body wide"><p>${escapeHtml(t("copyManual"))}</p><textarea id="copy-area" class="copy-area" readonly rows="10">${escapeHtml(text)}</textarea><div class="dialog-actions">${button("dlg-ok", escapeHtml(t("close")), "primary")}</div></div>`,
  );
  dialog.querySelector("#copy-area")?.select();
  dialog.onclick = (e) => {
    if (e.target.closest("[data-action]")) closeDialog();
  };
}
function exportDialog() {
  const slug =
    current.title
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "lumbre-site";
  openDialog(`<div class="dialog-body"><h2>${escapeHtml(t("export"))}</h2>
    <label class="field"><span>${escapeHtml(t("exportFolder"))}</span><input id="dlg-folder" maxlength="120" value="${escapeHtml(slug)}"></label>
    <div class="dialog-actions">${button("dlg-zip", `${icon("download")}<span>${escapeHtml(t("downloadZip"))}</span>`, "outline")}${button("dlg-cancel", escapeHtml(t("close")), "ghost")}${button("dlg-export", `${icon("folder")}<span>${escapeHtml(t("exportWorkspace"))}</span>`, "primary")}</div></div>`);
  dialog.onclick = async (e) => {
    const a = e.target.closest("[data-action]")?.dataset.action;
    if (!a) return;
    if (a === "dlg-cancel") return closeDialog();
    try {
      if (a === "dlg-zip") {
        const z = await api("project.zip", { projectId: current.id });
        const bytes = Uint8Array.from(atob(z.base64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = z.name;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
        closeDialog();
      } else if (a === "dlg-export") {
        const folder = dialog.querySelector("#dlg-folder")?.value.trim();
        const out = await api("project.export", { projectId: current.id, folder });
        closeDialog();
        toast(tf("exportDone", out.folder, out.files), "ok");
      }
    } catch (error) {
      fail(error);
    }
  };
}

// ---------- Server polling and boot ----------
setInterval(() => {
  if (!visible || unavailable || !current) return;
  const s = serverView(server);
  if (!s.running && !s.starting) return;
  void api("server.status", { projectId: current.id })
    .then((snap) => {
      const before = serverView(server).state;
      server = snap;
      if (
        serverView(snap).state !== before &&
        tab === "preview" &&
        !document.activeElement?.closest?.(".composer")
      )
        render();
    })
    .catch(() => {});
}, SERVER_POLL_MS);

async function boot() {
  await connected;
  root.innerHTML = `<p class="loading"><span class="spinner" aria-hidden="true"></span></p>`;
  try {
    status = await api("status");
    projects = await api("projects.list");
    models = (await api("models.list").catch(() => models)) ?? models;
    render();
  } catch (error) {
    if (!unavailable) fail(error);
  }
}
void boot();
