import { copyPayload, copySourceFor, writeClipboard } from "./copy.js";
import {
  countKey,
  jobView,
  MAX_UPLOAD_BYTES,
  needsRebuild,
  needsRemoteNotice,
  POLL_MS,
  pickerEntries,
  placeLabel,
  responseError,
  SOURCE_EXTENSIONS,
  scopeIds,
  selectAllState,
  setupView,
  sourceStatus,
  suggestions,
} from "./derive.js";
import { errorText, locale, setLocale, t } from "./i18n.js";
import { icon } from "./icons.js";
import { escapeHtml, renderMarkdown } from "./markdown.js";

const root = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
const WRITE_ACTIONS = new Set([
  "notebooks.create",
  "notebooks.rename",
  "notebooks.delete",
  "sources.upload",
  "sources.addFromWorkspace",
  "sources.delete",
  "chat.ask",
  "chat.clear",
  "notebook.guide",
  "sources.summary",
  "index.rebuild",
  "jobs.cancel",
  "notice.ack",
  "engine.setup",
  "notebooks.setModel",
  "notebooks.setScope",
]);

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
        // Coming back: re-check the app (it may have been reopened by Alisio) and the models.
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
  // `message.error` is a host transport code; `result.error` a Notebook code. For not_permitted,
  // prefer the host's `effect`; older hosts omit it, so fall back to the action's own effect.
  const error = responseError(message, WRITE_ACTIONS.has(request.action) ? "write" : "read");
  if (!error) return request.resolve(message.result?.value);
  const failure = new Error(error);
  // Only the HOST's not_found can mean "app gone"; a plugin's not_found is an unknown item.
  failure.transport = !!message.error;
  if (message.error === "not_found") hostNotFound();
  request.reject(failure);
}

// O13: one host not_found never latches. It is confirmed with a `status` request after a short
// delay; only a second host not_found shows the unavailable screen, which keeps retrying.
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
  const mutation = WRITE_ACTIONS.has(action);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      settleApprovalNotice();
      reject(new Error("operation_failed"));
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
const fail = (error) => {
  if (!unavailable) toast(errorText(error?.message ?? "operation_failed"));
};

// ---------- State ----------
/** Configured models (O12): an empty list blocks asking, not indexing or keyword search. */
let models = { models: [], active: null, available: true };
let status = {};
let notebooks = [];
let current; // { ...notebook, sources }
let chat = [];
const checked = new Set();
let guide;
let passage;
let summary;
let setupJob;
let setupDismissed = false;
let askJob;
let guideJob;
let rebuildJob;
/** jobId -> { kind, notebookId, sourceId? } */
const jobs = new Map();
const jobState = new Map();
let panels = { sources: true, guide: true };
let tab = "chat";
let pollBusy = false;
let draft = "";

const tf = (key, ...args) => {
  const value = t(key);
  return typeof value === "function" ? value(...args) : value;
};
const button = (action, label, cls = "outline", extra = "") =>
  `<button type="button" class="${cls}" data-action="${action}" ${extra}>${label}</button>`;
const iconButton = (action, name, label, extra = "") =>
  `<button type="button" class="icon-btn ghost" data-action="${action}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}" ${extra}>${icon(name)}</button>`;
const announce = (text) => {
  const live = document.querySelector("#live");
  if (live) live.textContent = text;
};

function showUnavailable() {
  unavailable = true;
  root.innerHTML = `<main class="unavailable"><span class="mark" aria-hidden="true"></span><h1>${escapeHtml(t("unavailableTitle"))}</h1><p>${escapeHtml(t("unavailable"))}</p>${button("retry", escapeHtml(t("retry")), "primary")}</main>`;
}

// ---------- Rendering ----------
/**
 * Follows Alisio's language without losing state: the open notebook, draft, focus and selection,
 * scroll positions, an open dialog (with its typed values) and any running progress are kept.
 */
function changeLocale(value) {
  const focused = document.activeElement;
  const focusId = focused?.id;
  const selection = [focused?.selectionStart, focused?.selectionEnd];
  const scrolls = SCROLLERS.map((selector) => [
    selector,
    document.querySelector(selector)?.scrollTop,
  ]);
  setLocale(value);
  keepScroll = true;
  try {
    render();
  } finally {
    keepScroll = false;
  }
  for (const [selector, top] of scrolls) {
    const el = document.querySelector(selector);
    if (el && typeof top === "number") el.scrollTop = top;
  }
  if (dialog.open && dialogView) {
    const values = [...dialog.querySelectorAll("input,textarea")].map((el) => [el.id, el.value]);
    dialog.innerHTML = dialogView();
    for (const [id, text] of values) {
      const el = id && dialog.querySelector(`#${id}`);
      if (el) el.value = text;
    }
  }
  const target = focusId ? document.getElementById(focusId) : undefined;
  if (target) {
    target.focus();
    if (typeof selection[0] === "number" && typeof target.setSelectionRange === "function")
      target.setSelectionRange(selection[0], selection[1]);
  }
}
const SCROLLERS = ["#messages", ".panel.sources", ".panel.guide", ".home"];
let keepScroll = false;
let dialogView;

function render() {
  if (unavailable) return showUnavailable();
  if (!current) renderHome();
  else renderNotebook();
}

function setupCard() {
  const view = setupView(status, setupJob);
  if (!status.semanticApi && status.minHost)
    return `<section class="banner info" role="note">${icon("warning")}<span>${escapeHtml(tf("hostTooOld", status.minHost))}</span></section>`;
  if (view.state === "hidden" || (view.state === "offer" && setupDismissed)) return "";
  if (view.state === "offer")
    return `<section class="setup card-block" aria-labelledby="setup-title">
      <div class="setup-head">${icon("download", "icon big")}<div><h2 id="setup-title">${escapeHtml(t("setupTitle"))}</h2>
      <p class="lead">${escapeHtml(tf("setupNotice", view.totalMb))}</p><p class="muted">${escapeHtml(t("setupWhy"))}</p></div></div>
      <div class="row">${button("setup-start", escapeHtml(t("setupStart")), "primary")}${button("setup-later", escapeHtml(t("setupLater")))}<span class="muted small">${escapeHtml(t("setupLaterNote"))}</span></div>
    </section>`;
  if (view.state === "downloading")
    return `<section class="setup card-block" aria-labelledby="setup-title">
      <div class="setup-head">${icon("download", "icon big")}<div><h2 id="setup-title">${escapeHtml(t("setupDownloading"))}</h2>
      <p class="muted">${escapeHtml(tf("setupNotice", view.totalMb))}</p></div></div>
      <div class="progress-label"><strong>${view.percent}%</strong><span>${escapeHtml(tf("setupOverall", view.doneMb, view.totalMb))}</span></div>
      <div class="bar" role="progressbar" aria-label="${escapeHtml(t("setupDownloading"))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${view.percent}"><span style="width:${view.percent}%"></span></div>
      <div class="progress-label small"><span>${escapeHtml(tf("setupFile", view.fileIndex, view.fileCount))} · ${escapeHtml(view.file)}</span><span>${view.filePercent}%</span></div>
      <div class="bar thin" role="progressbar" aria-label="${escapeHtml(tf("setupFile", view.fileIndex, view.fileCount))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${view.filePercent}"><span style="width:${view.filePercent}%"></span></div>
      <div class="row">${button("setup-cancel", escapeHtml(t("setupCancel")))}</div>
    </section>`;
  if (view.state === "done")
    return `<section class="setup card-block done" role="status">${icon("check", "icon big")}<div><p class="lead">${escapeHtml(t("setupDone"))}</p><p class="muted">${escapeHtml(t("activation")[view.activation] ?? "")}</p></div>${iconButton("setup-dismiss", "close", t("close"))}</section>`;
  return `<section class="setup card-block failed" role="alert">${icon("warning", "icon big")}<div><p class="lead">${escapeHtml(view.state === "cancelled" ? t("setupCancelled") : t("setupFailed"))}</p>${view.state === "failed" ? `<p class="muted">${escapeHtml(errorText(view.error))}</p>` : ""}</div>${button("setup-start", escapeHtml(t("setupRetry")))}</section>`;
}

function renderHome() {
  const cards = notebooks
    .map(
      (n) => `<article class="nb-card">
        <button type="button" class="nb-open" data-action="open" data-id="${n.id}">
          <span class="nb-glyph" aria-hidden="true">${icon("book")}</span>
          <span class="nb-title">${escapeHtml(n.title)}</span>
          <span class="muted small">${n.sourceCount} ${escapeHtml(t(countKey(n.sourceCount, "source")))} · ${escapeHtml(t("updated"))} ${escapeHtml(new Date(n.updatedAt).toLocaleDateString(locale))}</span>
        </button>
        <div class="nb-actions">${iconButton("rename", "edit", t("rename"), `data-id="${n.id}"`)}${iconButton("delete-notebook", "trash", t("delete"), `data-id="${n.id}"`)}</div>
      </article>`,
    )
    .join("");
  root.innerHTML = `<header class="topbar"><div class="brand"><span class="mark" aria-hidden="true"></span><strong>${escapeHtml(t("appName"))}</strong></div>
    <div class="topbar-actions">${keywordBadge()}${button("new", `${icon("plus")}<span>${escapeHtml(t("newNotebook"))}</span>`, "primary", 'id="new-notebook"')}</div></header>
    <main class="home"><p class="tagline">${escapeHtml(t("tagline"))}</p><div id="setup">${setupCard()}</div>
    <div class="cards">${button("new", `<span class="nb-glyph" aria-hidden="true">${icon("plus")}</span><span>${escapeHtml(t("newNotebook"))}</span>`, "nb-card new")}${cards}</div>
    ${notebooks.length === 0 ? `<p class="muted center">${escapeHtml(t("emptyHome"))}</p>` : ""}
    <p id="live" class="sr-only" aria-live="polite"></p></main>`;
}

function keywordBadge() {
  return status.keywordOnly
    ? `<span class="badge" title="${escapeHtml(t("keywordOnlyHint"))}">${escapeHtml(t("keywordOnly"))}</span>`
    : "";
}

function renderNotebook() {
  const focusedId = document.activeElement?.id;
  root.innerHTML = `<header class="topbar"><div class="brand">${iconButton("home", "back", t("back"))}<span class="mark" aria-hidden="true"></span><strong class="nb-name">${escapeHtml(current.title)}</strong>${iconButton("rename", "edit", t("rename"), `data-id="${current.id}"`)}</div>
    <div class="topbar-actions">${keywordBadge()}${iconButton("toggle-sources", "panelLeft", panels.sources ? t("hideSources") : t("showSources"), `aria-pressed="${panels.sources}"`)}${iconButton("toggle-guide", "panelRight", panels.guide ? t("hideGuide") : t("showGuide"), `aria-pressed="${panels.guide}"`)}</div></header>
    <div id="setup" class="setup-slot">${setupCard()}</div>
    <nav class="tabs" role="tablist">${["sources", "chat", "guide"].map((name) => `<button type="button" role="tab" data-action="tab" data-tab="${name}" aria-selected="${tab === name}">${escapeHtml(t(`${name}Panel`))}</button>`).join("")}</nav>
    <main class="workspace ${panels.sources ? "" : "no-sources"} ${panels.guide ? "" : "no-guide"}" data-tab="${tab}">
      <aside class="panel sources" aria-label="${escapeHtml(t("sourcesPanel"))}"><h2>${escapeHtml(t("sourcesPanel"))}</h2>
        <div class="stack">${button("add-computer", `${icon("upload")}<span>${escapeHtml(t("addComputer"))}</span>`, "full")}${button("add-workspace", `${icon("folder")}<span>${escapeHtml(t("addWorkspace"))}</span>`, "full outline")}</div>
        <input id="file-input" type="file" multiple hidden accept="${SOURCE_EXTENSIONS.join(",")}">
        <div id="sources-list"></div></aside>
      <section class="panel chat" aria-label="${escapeHtml(t("chatPanel"))}"><div id="chat-head" class="chat-head"></div><div id="banner"></div><div id="messages" class="messages"></div>
        <div class="composer"><div class="composer-box"><label class="sr-only" for="question">${escapeHtml(t("placeholder"))}</label><textarea id="question" rows="1" maxlength="4000" placeholder="${escapeHtml(t("placeholder"))}" aria-describedby="composer-hint">${escapeHtml(draft)}</textarea><div id="composer-actions" class="composer-actions"></div></div><p id="composer-hint" class="composer-hint">${escapeHtml(t("composerHint"))}</p><p class="disclaimer">${escapeHtml(t("disclaimer"))}</p></div>
        <p id="live" class="sr-only" aria-live="polite"></p></section>
      <aside class="panel guide" aria-label="${escapeHtml(t("guidePanel"))}" id="guide"></aside>
    </main>`;
  renderSources();
  renderChatHead();
  renderMessages();
  renderGuide();
  renderComposer();
  renderBanner();
  if (focusedId) document.getElementById(focusedId)?.focus();
}

function renderSources() {
  const el = document.querySelector("#sources-list");
  if (!el || !current) return;
  const sources = current.sources;
  if (sources.length === 0) {
    el.innerHTML = `<p class="muted small">${escapeHtml(t("noSources"))}</p>`;
    return;
  }
  const all = selectAllState(sources, checked);
  el.innerHTML = `<label class="check select-all"><input type="checkbox" id="select-all" ${all === "all" ? "checked" : ""}><span>${escapeHtml(t("selectAll"))}</span></label>
    <ul class="source-list">${sources
      .map((s) => {
        const job = [...jobs.entries()].find(([, j]) => j.sourceId === s.id)?.[0];
        const view = sourceStatus(s, job ? jobState.get(job) : undefined);
        const usable = view.key === "ready" || view.key === "keyword";
        const label =
          view.key === "indexing"
            ? tf("status_indexing", view.percent)
            : view.key === "failed"
              ? `${t("status_failed")}: ${errorText(view.error)}`
              : t(`status_${view.key}`);
        return `<li class="source ${view.key}"><label class="check"><input type="checkbox" data-source="${s.id}" ${checked.has(s.id) ? "checked" : ""} ${usable ? "" : "disabled"} aria-label="${escapeHtml(tf("includeSource", s.name))}"></label>
          <span class="source-main">${icon("file")}<span class="source-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span><span class="source-state small">${escapeHtml(label)}</span></span>
          <span class="source-actions">${usable ? iconButton("summarize", "sparkle", t("summarize"), `data-id="${s.id}" ${canAsk() || s.summary ? "" : "disabled"}`) : ""}${iconButton("delete-source", "trash", t("removeSource"), `data-id="${s.id}"`)}</span></li>`;
      })
      .join("")}</ul>`;
  const selectAll = document.querySelector("#select-all");
  if (selectAll) selectAll.indeterminate = all === "mixed";
}

const canAsk = () => models.available !== false;

/** Copy controls for an answer, the guide or a summary (O14). */
const copyControls = (ref) =>
  `<span class="copy-controls">${iconButton("copy-text", "copy", t("copyText"), `data-copy="${ref}"`)}${iconButton("copy-formatted", "copyRich", t("copyFormatted"), `data-copy="${ref}"`)}</span>`;

/** Model selector and the no-model state above the chat (O12). */
function renderChatHead() {
  const el = document.querySelector("#chat-head");
  if (!el || !current) return;
  if (!canAsk()) {
    el.innerHTML = `<div class="banner block-state" role="alert">${icon("warning")}<span><strong>${escapeHtml(t("noModelTitle"))}</strong> ${escapeHtml(t("noModel"))}</span></div>${clearChatButton()}`;
    return;
  }
  const chosen = current.model ?? "";
  const groups = new Map();
  for (const m of models.models) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }
  const options = [...groups.entries()]
    .map(
      ([provider, list]) =>
        `<optgroup label="${escapeHtml(provider)}">${list.map((m) => `<option value="${escapeHtml(m.reference)}" ${m.reference === chosen ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}</optgroup>`,
    )
    .join("");
  el.innerHTML = `<label class="model-picker"><span>${escapeHtml(t("model"))}</span><select id="model-select"><option value="" ${chosen ? "" : "selected"}>${escapeHtml(tf("modelDefault", models.active ?? ""))}</option>${options}</select></label>${clearChatButton()}`;
}
const clearChatButton = () =>
  chat.length && !askJob ? iconButton("clear-chat", "trash", t("clearChat")) : "";

function messageHtml(m, index) {
  if (m.role === "user")
    return `<div class="msg user"><span class="who">${escapeHtml(t("you"))}</span><p>${escapeHtml(m.text)}</p></div>`;
  const body = renderMarkdown(m.text, m.citations);
  const warnings = [
    m.modelFallback
      ? `<p class="warn small">${icon("warning")}${escapeHtml(t("modelFallback"))}</p>`
      : "",
    !m.grounded && !m.notFound
      ? `<p class="warn small">${icon("warning")}${escapeHtml(t("notGrounded"))}</p>`
      : "",
    m.keywordOnly ? `<span class="badge small">${escapeHtml(t("keywordAnswer"))}</span>` : "",
  ].join("");
  return `<div class="msg assistant copyable"><span class="who">${escapeHtml(t("assistant"))}${m.notFound ? "" : copyControls(`chat:${index}`)}</span><div class="md">${body}</div>${warnings}</div>`;
}

function renderMessages() {
  const el = document.querySelector("#messages");
  if (!el) return;
  if (chat.length === 0 && !askJob) {
    const questions = suggestions(guide);
    el.innerHTML = `<div class="empty-chat">${icon("quote", "icon big")}<h2>${escapeHtml(t("emptyChatTitle"))}</h2><p class="muted">${escapeHtml(t("emptyChatText"))}</p>
      ${guide?.summary ? `<div class="guide-summary md">${renderMarkdown(guide.summary, guide.citations)}</div>` : ""}
      ${questions.length ? `<div class="chips">${questions.map((q, i) => button("suggest", escapeHtml(q), "chip", `data-index="${i}" ${canAsk() ? "" : "disabled"}`)).join("")}</div>` : current?.sources.length ? button("guide", `${icon("sparkle")}<span>${escapeHtml(guideJob ? t("guideWorking") : t("makeGuide"))}</span>`, "outline", guideJob || !canAsk() ? "disabled" : "") : ""}
    </div>`;
    return;
  }
  el.innerHTML =
    chat.map((m, i) => messageHtml(m, i)).join("") +
    (askJob
      ? `<div class="msg assistant pending"><span class="spinner" aria-hidden="true"></span>${escapeHtml(t("thinking"))}</div>`
      : "");
  if (!keepScroll) el.scrollTop = el.scrollHeight;
}

function renderComposer() {
  const el = document.querySelector("#composer-actions");
  if (!el) return;
  // One compact round button inside the composer: Send, or Stop while an answer is running.
  const empty = !draft.trim();
  el.innerHTML = askJob
    ? `<button type="button" class="send-btn stop" data-action="stop" aria-label="${escapeHtml(t("stop"))}" title="${escapeHtml(t("stop"))}">${icon("stop")}</button>`
    : `<button type="button" class="send-btn" data-action="send" aria-label="${escapeHtml(t("send"))}" title="${escapeHtml(t("send"))}" ${canAsk() && !empty ? "" : "disabled"}>${icon("arrowUp")}</button>`;
  const box = document.querySelector("#question");
  if (box) {
    box.disabled = !canAsk();
    autoGrow(box);
  }
}
/** 1 line minimum, about 6 lines maximum, then the textarea scrolls. */
function autoGrow(box) {
  box.style.height = "auto";
  const max = 6 * 22 + 16;
  box.style.height = `${Math.min(box.scrollHeight || 0, max) || ""}px`;
  box.style.overflowY = box.scrollHeight > max ? "auto" : "hidden";
}

function renderBanner() {
  const el = document.querySelector("#banner");
  if (!el || !current) return;
  el.innerHTML =
    needsRebuild(current.sources) && status.available
      ? `<div class="banner warn" role="note">${icon("warning")}<span><strong>${escapeHtml(t("rebuildTitle"))}</strong> ${escapeHtml(t("rebuildText"))}</span>${button("rebuild", escapeHtml(rebuildJob ? t("rebuilding") : t("rebuild")), "small", rebuildJob ? "disabled" : "")}</div>`
      : "";
}

function renderGuide() {
  const el = document.querySelector("#guide");
  if (!el) return;
  const questions = suggestions(guide);
  el.innerHTML = `<h2>${escapeHtml(t("guidePanel"))}</h2>
    <section class="block copyable"><h3>${escapeHtml(t("summaryTitle"))}${guide?.summary ? copyControls("guide") : ""}</h3>${
      guide?.summary
        ? `${guide.outdated ? `<p class="warn small">${icon("warning")}${escapeHtml(t("outdated"))} ${button("guide", escapeHtml(guideJob ? t("guideWorking") : t("regenerate")), "small", guideJob || !canAsk() ? "disabled" : "")}</p>` : ""}<div class="md">${renderMarkdown(guide.summary, guide.citations)}</div>`
        : `<p class="muted small">${escapeHtml(t("noGuide"))}</p>${current?.sources.length ? button("guide", `${icon("sparkle")}<span>${escapeHtml(guideJob ? t("guideWorking") : t("makeGuide"))}</span>`, "small", guideJob || !canAsk() ? "disabled" : "") : ""}`
    }</section>
    ${questions.length ? `<section class="block copyable"><h3>${escapeHtml(t("questionsTitle"))}${copyControls("questions")}</h3><div class="chips column">${questions.map((q, i) => button("suggest", escapeHtml(q), "chip", `data-index="${i}" ${canAsk() ? "" : "disabled"}`)).join("")}</div></section>` : ""}
    ${summary ? `<section class="block copyable"><h3>${escapeHtml(summary.name)}${copyControls("summary")}</h3><div class="md">${renderMarkdown(summary.summary, summary.citations)}</div><p>${button("summarize-again", escapeHtml(t("regenerate")), "small", `data-id="${summary.sourceId}" ${canAsk() ? "" : "disabled"}`)}</p></section>` : ""}
    <section class="block passage copyable" aria-live="polite"><h3>${escapeHtml(t("passageTitle"))}${passage ? copyControls("passage") : ""}</h3>${
      passage
        ? `<p class="muted small">${escapeHtml(passage.sourceName)}${placeLabel(passage) ? ` · ${escapeHtml(tf(...placeLabel(passage)))}` : ""}</p><blockquote>${escapeHtml(passage.text)}</blockquote>`
        : `<p class="muted small">${escapeHtml(t("passageEmpty"))}</p>`
    }</section>`;
}

// ---------- Data ----------
async function loadStatus() {
  status = (await api("status")) ?? {};
  if (status.setupJob) setupJob = status.setupJob;
}
async function loadHome() {
  notebooks = (await api("notebooks.list")) ?? [];
}
async function refreshNotebook() {
  if (!current) return;
  const fresh = await api("notebooks.get", { id: current.id });
  for (const s of fresh.sources)
    if (
      (s.status === "ready" || s.status === "ready_keyword") &&
      !current.sources.some((o) => o.id === s.id && o.status === s.status)
    )
      checked.add(s.id);
  current = fresh;
}
async function loadModels() {
  try {
    models = (await api("models.list")) ?? models;
  } catch {
    // Keep the last known list; a transport problem is handled by the not_found check.
  }
}
async function openNotebook(id) {
  current = await api("notebooks.get", { id });
  // The ticked scope, the guide and the chat persist in the notebook (O15).
  checked.clear();
  const excluded = new Set(current.excluded ?? []);
  for (const s of current.sources)
    if (s.status !== "failed" && !excluded.has(s.id)) checked.add(s.id);
  chat = await api("chat.history", { notebookId: id });
  guide = current.guide ?? undefined;
  passage = undefined;
  summary = undefined;
  tab = "chat";
  await loadModels();
  render();
}
/** Visible again: refresh what may have changed while hidden (models, notebook, status). */
async function refreshOnShow() {
  try {
    await loadStatus();
    if (current) {
      await loadModels();
      await refreshNotebook();
      render();
    } else {
      await loadHome();
      render();
    }
  } catch (error) {
    fail(error);
  }
  void poll();
}
/** After the app comes back from the unavailable state. */
async function reloadAll() {
  await loadStatus();
  await loadHome();
  if (current) {
    try {
      await openNotebook(current.id);
      return;
    } catch {
      current = undefined;
    }
  }
  render();
}
function saveScope() {
  if (!current) return;
  const usable = current.sources.filter(
    (s) => s.status === "ready" || s.status === "ready_keyword",
  );
  const excluded = usable.filter((s) => !checked.has(s.id)).map((s) => s.id);
  current.excluded = excluded;
  api("notebooks.setScope", { id: current.id, excluded }).catch(fail);
}

function track(jobId, info) {
  if (!jobId) return;
  jobs.set(jobId, info);
  jobState.set(jobId, { state: "queued", progress: 0 });
}

async function poll() {
  if (!visible || pollBusy || unavailable) return;
  pollBusy = true;
  try {
    if (setupJob && jobView(setupJob).running) {
      try {
        setupJob = await api("jobs.get", { jobId: setupJob.id });
      } catch (error) {
        // The backend no longer knows this job (e.g. it was restarted): stop polling it.
        if (error?.message !== "not_found" || error.transport) throw error;
        setupJob = undefined;
        await loadStatus();
      }
      if (!setupJob) {
        render();
        return;
      }
      const slot = document.querySelector("#setup");
      if (slot) slot.innerHTML = setupCard();
      if (!jobView(setupJob).running) {
        announce(setupJob.state === "done" ? t("setupDone") : t("setupFailed"));
        await loadStatus();
        render();
      }
    }
    let changed = false;
    for (const [jobId, info] of jobs) {
      let job;
      try {
        job = await api("jobs.get", { jobId });
      } catch (error) {
        if (error?.message !== "not_found" || error.transport) throw error;
        job = { state: "failed", error: "not_found" };
      }
      jobState.set(jobId, job);
      if (jobView(job).running) {
        if (info.kind === "index") renderSources();
        continue;
      }
      jobs.delete(jobId);
      changed = true;
      await finished(info, job);
    }
    if (
      current &&
      !changed &&
      current.sources.some((s) => s.status === "indexing") &&
      jobs.size === 0
    ) {
      await refreshNotebook();
      renderSources();
    }
  } catch (error) {
    fail(error);
  } finally {
    pollBusy = false;
  }
}

async function finished(info, job) {
  const view = jobView(job);
  if (view.failed && info.kind !== "index" && view.error !== "not_found")
    fail(new Error(view.error));
  if (!current || info.notebookId !== current.id) return;
  if (info.kind === "index" || info.kind === "rebuild") {
    if (info.kind === "rebuild") rebuildJob = undefined;
    await refreshNotebook();
    renderSources();
    renderBanner();
    renderMessages();
  } else if (info.kind === "ask") {
    askJob = undefined;
    chat = await api("chat.history", { notebookId: current.id });
    renderMessages();
    renderComposer();
    renderChatHead();
    announce(chat.at(-1)?.text ?? "");
  } else if (info.kind === "guide") {
    guideJob = undefined;
    if (view.done) guide = job.result;
    renderGuide();
    renderMessages();
  } else if (info.kind === "summary") {
    if (view.done) {
      const source = current.sources.find((s) => s.id === info.sourceId);
      summary = { name: source?.name ?? "", ...job.result };
      await refreshNotebook();
    }
    renderGuide();
  }
  if (view.failed && view.error === "not_found") {
    // A job the backend no longer knows: just refresh what it was about.
    if (info.kind === "ask") askJob = undefined;
    if (info.kind === "guide") guideJob = undefined;
    if (info.kind === "rebuild") rebuildJob = undefined;
    await refreshNotebook();
    render();
  }
}

// ---------- Actions ----------
function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function addFile(name, bytes) {
  if (bytes.length > MAX_UPLOAD_BYTES) return toast(tf("fileTooLarge", name));
  let input;
  if (/\.pdf$/i.test(name)) {
    announce(tf("readingPdf", name));
    try {
      input = { notebookId: current.id, name, pages: await globalThis.semanticPdfPages(bytes) };
    } catch {
      return toast(errorText("no_text"));
    }
  } else
    input = {
      notebookId: current.id,
      name,
      mime: "application/octet-stream",
      base64: bytesToBase64(bytes),
    };
  const result = await api("sources.upload", input);
  track(result.jobId, { kind: "index", notebookId: current.id, sourceId: result.sourceId });
  await refreshNotebook();
  renderSources();
  renderMessages();
  renderGuide();
}

/** `view` returns the dialog's HTML; it is called again when the host language changes. */
function openDialog(view, onOpen) {
  dialogView = view;
  dialog.innerHTML = view();
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  onOpen?.();
}
function closeDialog() {
  if (typeof dialog.close === "function") dialog.close();
  dialog.removeAttribute("open");
  dialog.innerHTML = "";
  dialogView = undefined;
}
/** Keys, not texts, so an open dialog can be re-rendered in a new language. */
function confirmDialog(messageKey, okKey = "continue", titleKey = "") {
  return new Promise((resolve) => {
    openDialog(
      () =>
        `<div class="dialog-body">${titleKey ? `<h2>${escapeHtml(t(titleKey))}</h2>` : ""}<p>${escapeHtml(t(messageKey))}</p><div class="row end">${button("dialog-cancel", escapeHtml(t("cancel")))}${button("dialog-ok", escapeHtml(t(okKey)), "primary")}</div></div>`,
      () => dialog.querySelector('[data-action="dialog-cancel"]')?.focus(),
    );
    dialog.onclick = (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action !== "dialog-ok" && action !== "dialog-cancel") return;
      closeDialog();
      resolve(action === "dialog-ok");
    };
    dialog.oncancel = (event) => {
      event.preventDefault();
      closeDialog();
      resolve(false);
    };
  });
}
function promptDialog(labelKey, value = "") {
  return new Promise((resolve) => {
    openDialog(
      () =>
        `<div class="dialog-body"><label class="field"><span>${escapeHtml(t(labelKey))}</span><input id="dialog-input" maxlength="200" value="${escapeHtml(value)}"></label><div class="row end">${button("dialog-cancel", escapeHtml(t("cancel")))}${button("dialog-ok", escapeHtml(t("save")), "primary")}</div></div>`,
      () => dialog.querySelector("#dialog-input")?.focus(),
    );
    const finish = (ok) => {
      const text = dialog.querySelector("#dialog-input")?.value.trim();
      closeDialog();
      resolve(ok ? text || null : null);
    };
    dialog.onclick = (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "dialog-ok") finish(true);
      if (action === "dialog-cancel") finish(false);
    };
    dialog.onkeydown = (event) => {
      if (event.key === "Enter" && event.target.id === "dialog-input") {
        event.preventDefault();
        finish(true);
      }
    };
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(false);
    };
  });
}

async function workspaceBrowser(dir = "") {
  const entries = pickerEntries(await api("workspace.list", dir ? { dir } : {}));
  const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  openDialog(
    () => `<div class="dialog-body wide"><h2>${escapeHtml(t("workspaceTitle"))}</h2><p class="muted small">${escapeHtml(t("workspaceRoot"))}${dir ? ` / ${escapeHtml(dir)}` : ""}</p>
    <ul class="browser">${dir ? `<li>${button("ws-open", `${icon("up")}<span>${escapeHtml(t("workspaceUp"))}</span>`, "row-btn", `data-path="${escapeHtml(parent)}"`)}</li>` : ""}
    ${entries.map((e) => `<li>${button(e.kind === "dir" ? "ws-open" : "ws-add", `${icon(e.kind === "dir" ? "folder" : "file")}<span>${escapeHtml(e.name)}</span>`, "row-btn", `data-path="${escapeHtml(e.path)}"`)}</li>`).join("") || `<li class="muted small">${escapeHtml(t("workspaceEmpty"))}</li>`}</ul>
    <div class="row end">${button("dialog-cancel", escapeHtml(t("close")))}</div></div>`,
  );
  dialog.onclick = async (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    try {
      if (action === "dialog-cancel") closeDialog();
      if (action === "ws-open") await workspaceBrowser(target.dataset.path);
      if (action === "ws-add") {
        const path = target.dataset.path;
        closeDialog();
        if (/\.pdf$/i.test(path)) {
          const { base64 } = await api("sources.read", { path });
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          await addFile(path.split("/").pop(), bytes);
        } else {
          const result = await api("sources.addFromWorkspace", { notebookId: current.id, path });
          track(result.jobId, { kind: "index", notebookId: current.id, sourceId: result.sourceId });
          await refreshNotebook();
          renderSources();
          renderMessages();
          renderGuide();
        }
      }
    } catch (error) {
      fail(error);
    }
  };
  dialog.oncancel = (event) => {
    event.preventDefault();
    closeDialog();
  };
}

async function ask(question) {
  const text = question.trim();
  if (!text || askJob || !current || !canAsk()) return;
  if (needsRemoteNotice(current)) {
    const ok = await confirmDialog("noticeText", "noticeOk", "noticeTitle");
    if (!ok) return;
    await api("notice.ack", { notebookId: current.id });
    current.remoteNoticeAck = true;
  }
  const scope = scopeIds(current.sources, checked);
  const { jobId } = await api("chat.ask", {
    notebookId: current.id,
    question: text,
    ...(scope ? { sourceIds: scope } : {}),
    locale,
  });
  askJob = jobId;
  track(jobId, { kind: "ask", notebookId: current.id });
  chat = [...chat, { role: "user", text }];
  draft = "";
  const box = document.querySelector("#question");
  if (box) box.value = "";
  renderMessages();
  renderComposer();
  announce(t("thinking"));
}

async function handle(action, target) {
  switch (action) {
    case "setup-start": {
      setupDismissed = false;
      const { jobId } = await api("engine.setup");
      setupJob = { id: jobId, state: "running", progress: 0 };
      document.querySelector("#setup").innerHTML = setupCard();
      return;
    }
    case "setup-cancel":
      if (setupJob) await api("jobs.cancel", { jobId: setupJob.id });
      return;
    case "setup-later":
    case "setup-dismiss":
      setupDismissed = true;
      setupJob = undefined;
      document.querySelector("#setup").innerHTML = setupCard();
      return;
    case "new": {
      const title = await promptDialog("notebookTitle", t("untitled"));
      if (!title) return;
      const { id } = await api("notebooks.create", { title });
      await loadHome();
      return openNotebook(id);
    }
    case "open":
      return openNotebook(target.dataset.id);
    case "home":
      current = undefined;
      await loadHome();
      return render();
    case "rename": {
      const nb =
        current?.id === target.dataset.id
          ? current
          : notebooks.find((n) => n.id === target.dataset.id);
      const title = await promptDialog("notebookTitle", nb?.title ?? "");
      if (!title || !nb) return;
      await api("notebooks.rename", { id: nb.id, title });
      if (current) current.title = title;
      await loadHome();
      return render();
    }
    case "delete-notebook":
      if (!(await confirmDialog("deleteNotebook", "delete"))) return;
      await api("notebooks.delete", { id: target.dataset.id });
      await loadHome();
      return render();
    case "add-computer":
      return document.querySelector("#file-input")?.click();
    case "add-workspace":
      return workspaceBrowser("");
    case "delete-source":
      if (!(await confirmDialog("deleteSource", "removeSource"))) return;
      await api("sources.delete", { sourceId: target.dataset.id });
      checked.delete(target.dataset.id);
      await refreshNotebook();
      return renderSources();
    case "summarize": {
      // A stored summary is shown as is; it is regenerated only on request (O15).
      const source = current.sources.find((s) => s.id === target.dataset.id);
      if (source?.summary) {
        summary = { name: source.name, sourceId: source.id, ...source.summary };
        if (!panels.guide) panels.guide = true;
        tab = "guide";
        return renderNotebook();
      }
      return handle("summarize-again", target);
    }
    case "summarize-again": {
      const { jobId } = await api("sources.summary", { sourceId: target.dataset.id, locale });
      track(jobId, { kind: "summary", notebookId: current.id, sourceId: target.dataset.id });
      return;
    }
    case "guide": {
      const { jobId } = await api("notebook.guide", { notebookId: current.id, locale });
      guideJob = jobId;
      track(jobId, { kind: "guide", notebookId: current.id });
      renderGuide();
      return renderMessages();
    }
    case "retry":
      root.querySelector('[data-action="retry"]')?.setAttribute("disabled", "");
      return verifyAvailable();
    case "copy-text":
    case "copy-formatted": {
      const source = copySource(target.dataset.copy);
      if (!source) return;
      const { text, html } = copyPayload(source, renderMarkdown, action === "copy-formatted");
      const path = await writeClipboard({ text, ...(html ? { html } : {}) });
      lastCopyPath = path;
      if (path === "manual") return manualCopy(text, html);
      toast(t("copied"));
      return announce(t("copied"));
    }
    case "suggest":
      return ask(suggestions(guide)[Number(target.dataset.index)] ?? "");
    case "send":
      return ask(document.querySelector("#question")?.value ?? "");
    case "stop":
      if (askJob) await api("jobs.cancel", { jobId: askJob });
      return;
    case "clear-chat":
      if (!(await confirmDialog("clearChatConfirm", "clearChat"))) return;
      await api("chat.clear", { notebookId: current.id });
      chat = [];
      renderMessages();
      return renderComposer();
    case "cite":
      passage = await api("sources.passage", {
        sourceId: target.dataset.source,
        ordinal: Number(target.dataset.ordinal),
      });
      if (!panels.guide) panels.guide = true;
      tab = "guide";
      return renderNotebook();
    case "rebuild": {
      const { jobId } = await api("index.rebuild", { notebookId: current.id });
      rebuildJob = jobId;
      track(jobId, { kind: "rebuild", notebookId: current.id });
      return renderBanner();
    }
    case "toggle-sources":
      panels = { ...panels, sources: !panels.sources };
      return renderNotebook();
    case "toggle-guide":
      panels = { ...panels, guide: !panels.guide };
      return renderNotebook();
    case "tab":
      tab = target.dataset.tab;
      return renderNotebook();
  }
}

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  handle(target.dataset.action, target).catch(fail);
});
root.addEventListener("change", (event) => {
  const target = event.target;
  if (target.id === "file-input") {
    const files = [...target.files];
    target.value = "";
    (async () => {
      for (const file of files) await addFile(file.name, new Uint8Array(await file.arrayBuffer()));
    })().catch(fail);
  } else if (target.id === "select-all") {
    for (const s of current.sources)
      if (s.status === "ready" || s.status === "ready_keyword")
        target.checked ? checked.add(s.id) : checked.delete(s.id);
    renderSources();
    saveScope();
  } else if (target.dataset.source) {
    target.checked ? checked.add(target.dataset.source) : checked.delete(target.dataset.source);
    renderSources();
    saveScope();
  } else if (target.id === "model-select") {
    const model = target.value || null;
    api("notebooks.setModel", { id: current.id, model })
      .then(() => {
        current.model = model;
      })
      .catch((error) => {
        fail(error);
        renderChatHead();
      });
  }
});
root.addEventListener("input", (event) => {
  if (event.target.id === "question") {
    const wasEmpty = !draft.trim();
    draft = event.target.value;
    autoGrow(event.target);
    if (wasEmpty !== !draft.trim()) renderComposer();
  }
});
root.addEventListener("keydown", (event) => {
  if (
    event.target.id === "question" &&
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    ask(event.target.value).catch(fail);
  }
});

/** Text and citations behind a copy button (one shared component for every generated block). */
const copySource = (ref) =>
  copySourceFor(ref, {
    chat,
    guide,
    summary,
    passage,
    place: (p) => (placeLabel(p) ? tf(...placeLabel(p)) : ""),
  });

/** Last resort when the frame may not write the clipboard: show the content preselected. */
function manualCopy(text, html) {
  openDialog(
    () =>
      `<div class="dialog-body wide"><p class="lead">${escapeHtml(t("copyManual"))}</p>${
        html
          ? `<div id="copy-area" class="copy-area md" contenteditable="true">${html}</div>`
          : `<textarea id="copy-area" class="copy-area" readonly rows="10">${escapeHtml(text)}</textarea>`
      }<div class="row end">${button("dialog-cancel", escapeHtml(t("close")))}</div></div>`,
    () => {
      const area = dialog.querySelector("#copy-area");
      if (!area) return;
      if (area.select) area.select();
      else {
        const range = document.createRange();
        range.selectNodeContents(area);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      area.focus();
    },
  );
  dialog.onclick = (event) => {
    if (event.target.closest("[data-action]")?.dataset.action === "dialog-cancel") closeDialog();
  };
}
/** Which copy path worked last ("clipboard", "execCommand", "manual"); read by the visual check. */
let lastCopyPath;
globalThis.semanticLastCopyPath = () => lastCopyPath;

// ---------- Start ----------
await connected;
try {
  await loadStatus();
  await loadHome();
  render();
} catch (error) {
  fail(error);
}
setInterval(() => void poll(), POLL_MS);
