import {
  assetKind,
  base64Bytes,
  changedSections,
  formatBytes,
  formatModified,
  jobStages,
  listStatus,
  matchesFilter,
  pdfVersion,
  sectionsOf,
  stepZoom,
  summaryLines,
  texStats,
  ZOOM_STEPS,
} from "./derive.js";
import { locale, setLocale, t } from "./i18n.js";
import { disciplineIcon, icon, paperGlyph } from "./icons.js";

const root = document.querySelector("#app");
const dialog = document.querySelector("#dialog");
let hostPort;
let visible = true;
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
    hostPort.onmessage = (event) => {
      const message = event.data;
      if (message?.type === "locale") {
        changeHostLocale(message.locale);
      }
      if (message?.type === "visibility") {
        visible = message.visible !== false;
        if (visible) void poll();
      }
      if (message?.type === "response") {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        clearTimeout(request.timer);
        clearTimeout(request.approvalTimer);
        settleApprovalNotice();
        // `message.error` is a host transport code; `result.error` is a Scribe action code.
        const result = message.result;
        let error = message.error || result?.error;
        if (message.error === "not_found") showUnavailable();
        // Name the missing permission. Newer hosts send the denied `effect`; older ones do not, so
        // fall back to the action: compiling runs a process, everything else that can be denied writes.
        if (message.error === "not_permitted") {
          const effect =
            message.effect === "process" || message.effect === "write"
              ? message.effect
              : request.action === "pdf.compile"
                ? "process"
                : "write";
          error = `not_permitted_${effect}`;
        }
        error ? request.reject(new Error(error)) : request.resolve(result?.value);
      }
    };
    hostPort.start();
    resolve();
  });
});
let docs = [],
  models = [],
  jobs = [],
  doc,
  context = {},
  filter = "all",
  search = "";
let view = "preview",
  mobile = "assistant",
  navTab = "structure",
  prompt = "",
  brief = "",
  scope = "",
  dirty = false;
let draftTex = "",
  draftBib = "",
  pdfBlob,
  pdfStale = false,
  unavailable = false;
let pollBusy = false,
  pollSignature = "",
  toastTimer,
  pdfRequest = 0;
let newLanguage,
  newModel = "",
  newDiscipline = "physics";
/** Files picked on the home screen; attached to the new document right after it is created. */
let pendingSources = [];
/** PDF preview: zoom is a scale or "fit"; the fitted scale and page count come from the viewer. */
let zoom = "fit",
  fitScale = 1,
  pageCount = 0,
  page = 1;
/** The last request sent per document in this frame (jobs do not carry their prompt). */
const lastRequest = new Map();
const ASSET_ACCEPT = ".png,.jpg,.jpeg,.pdf,.csv,.json,.bib,.txt";
const ASSET_MAX = 25 * 1024 * 1024;
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const latest = () => doc.revisions.at(-1);
const button = (id, label, primary = false) =>
  `<button id="${id}" class="${primary ? "primary" : "outline"}">${escapeHtml(t(label))}</button>`;
/** A button with a leading icon and a visible label. */
const iconLabel = (id, name, label, cls = "outline") =>
  `<button id="${id}" class="${cls}" aria-label="${escapeHtml(t(label))}">${icon(name)}<span class="label">${escapeHtml(t(label))}</span></button>`;
/** An icon-only button; its accessible name is the (translated) label. */
const iconButton = (id, name, label, cls = "") =>
  `<button id="${id}" class="icon-btn ${cls}" aria-label="${escapeHtml(t(label))}" title="${escapeHtml(t(label))}">${icon(name)}</button>`;
/** A native select styled as a pill with a leading icon. */
const pill = (id, name, label, options, cls = "") =>
  `<label class="pill ${cls}">${icon(name)}<select id="${id}" aria-label="${escapeHtml(t(label))}">${options}</select>${icon("chevronDown", "icon caret")}</label>`;
/** "1 figure" / "3 figures" with translated singular and plural keys. */
const count = (n, key) => `${n} ${t(n === 1 ? key : `${key}s`)}`;
const spinner = '<span class="spinner" aria-hidden="true"></span>';
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.style.display = "none"), 7000);
}
// The host runs at most PLUGIN_APP_LIMITS.inFlight (8) requests per frame; stay below it.
const MAX_IN_FLIGHT = 6;
const RESPONSE_GUARD_MS = 11 * 60 * 1000;
// A write or process action can wait on Alisio's approval prompt; say so if it takes a moment.
const APPROVAL_HINT_MS = 3000;
let approvalNotice = false;
function settleApprovalNotice() {
  if (!approvalNotice || [...pending.values()].some((r) => r.awaitingHint)) return;
  approvalNotice = false;
  document.querySelector("#toast").style.display = "none";
}
let inFlight = 0;
const waiting = [];
async function api(action, input = {}, mutation = false) {
  await connected;
  if (unavailable) throw new Error("not_found");
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((resolve) => waiting.push(resolve));
  inFlight++;
  try {
    return await send(action, input, mutation);
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}
function send(action, input, mutation) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    // Last-resort guard for a lost response only: the host answers every request itself (30 s per
    // handler), but it may first wait for the user's approval prompt (capped at 10 minutes).
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
        toast(t("awaiting_approval"));
        clearTimeout(toastTimer); // stays visible until the request settles
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
function confirmPrompt(message) {
  return new Promise((resolve) => {
    const box = document.createElement("dialog");
    box.className = "confirm";
    const p = document.createElement("p");
    p.textContent = message;
    const actions = document.createElement("div");
    actions.className = "row end";
    const cancel = document.createElement("button");
    cancel.className = "outline";
    cancel.textContent = locale === "es" ? "Cancelar" : "Cancel";
    const ok = document.createElement("button");
    ok.className = "primary";
    ok.textContent = locale === "es" ? "Continuar" : "Continue";
    const finish = (value) => {
      box.close();
      box.remove();
      resolve(value);
    };
    cancel.onclick = () => finish(false);
    ok.onclick = () => finish(true);
    box.oncancel = (e) => {
      e.preventDefault();
      finish(false);
    };
    actions.append(cancel, ok);
    box.append(p, actions);
    document.body.append(box);
    box.showModal();
    cancel.focus();
  });
}
let refreshDialog;
function changeHostLocale(value) {
  const focused = document.activeElement;
  const id = focused?.id;
  const start = focused?.selectionStart;
  const end = focused?.selectionEnd;
  const values = dialog.open
    ? [...dialog.querySelectorAll("input,textarea,select")].map((el) => [el.id, el.value])
    : [];
  setLocale(value);
  render();
  if (dialog.open && refreshDialog) {
    refreshDialog();
    for (const [id, value] of values) {
      const el = document.getElementById(id);
      if (el) el.value = value;
    }
  }
  const target = id ? document.getElementById(id) : null;
  target?.focus();
  if (target && typeof start === "number") target.setSelectionRange?.(start, end);
}
function on(id, fn, event = "click") {
  const el = document.getElementById(id);
  if (el)
    el.addEventListener(event, async (e) => {
      try {
        await fn(e);
      } catch (error) {
        toast(t(error.message));
      }
    });
}
function modelOptions(selected = "") {
  return (
    `<option value="">${t("hostModel")}</option>` +
    models
      .map((m) => {
        const id = m.reference || (typeof m.provider === "string" ? `${m.provider}/${m.id}` : m.id);
        return `<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(m.model?.name || m.name || id)}</option>`;
      })
      .join("")
  );
}
/** The app or its plugin is gone (disabled, removed or updated): stop and say so. */
function showUnavailable() {
  if (unavailable) return;
  unavailable = true;
  dirty = false;
  closeMenu();
  if (dialog.open) dialog.close();
  root.innerHTML = `<main class="shell"><div class="empty"><h1>${escapeHtml(t("unavailableTitle"))}</h1><p>${escapeHtml(t("unavailable"))}</p></div></main>`;
}

/* ---------- Popover menus (card and file "⋯" actions) ---------- */
let menuEl;
function closeMenu() {
  if (!menuEl) return;
  menuEl.anchor.setAttribute("aria-expanded", "false");
  menuEl.remove();
  menuEl = undefined;
}
function showMenu(anchor, items) {
  const same = menuEl?.anchor === anchor;
  closeMenu();
  if (same) return;
  const el = document.createElement("div");
  el.className = "menu";
  el.setAttribute("role", "menu");
  for (const item of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    if (item.danger) b.className = "danger";
    b.innerHTML = `${icon(item.icon)}<span>${escapeHtml(item.label)}</span>`;
    b.onclick = async () => {
      closeMenu();
      anchor.focus();
      try {
        await item.run();
      } catch (e) {
        toast(t(e.message));
      }
    };
    el.append(b);
  }
  el.anchor = anchor;
  el.addEventListener("keydown", (e) => {
    const buttons = [...el.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement);
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      closeMenu();
      anchor.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    }
  });
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const width = el.offsetWidth || 220;
  el.style.top = `${Math.min(r.bottom + 6, window.innerHeight - (el.offsetHeight || 0) - 8)}px`;
  el.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
  anchor.setAttribute("aria-expanded", "true");
  menuEl = el;
  el.querySelector("button")?.focus();
}
document.addEventListener("click", (e) => {
  if (!menuEl || menuEl.contains(e.target) || menuEl.anchor.contains(e.target)) return;
  closeMenu();
});
window.addEventListener("resize", closeMenu);

/* ---------- Shared chrome ---------- */
function saveStateInner(isDirty) {
  return `${icon(isDirty ? "alert" : "checkCircle")}<span id="save-status">${escapeHtml(t(isDirty ? "unsaved" : "saved"))}</span>`;
}
function brand(middle, right) {
  return `<header class="topbar"><div class="brand"><span class="mark" aria-hidden="true"></span><strong>Scribe</strong><span class="vdivider" aria-hidden="true"></span>${middle}</div><div class="topbar-actions">${right}</div></header>${context.demo ? `<div class="warning banner">${t("demo")}</div>` : ""}`;
}
function bindCommon() {
  on("back", async () => {
    if (dirty && !(await confirmPrompt(t("dirtyLeave")))) return;
    doc = undefined;
    dirty = false;
    await refreshList();
    render();
  });
}
async function refreshList() {
  docs = await api("documents.list");
}
async function openDocument(id) {
  doc = await api("documents.get", { documentId: id });
  pdfBlob = undefined;
  pdfStale = false;
  draftTex = latest().tex;
  draftBib = latest().bib;
  dirty = false;
  prompt = "";
  scope = "";
  view = "preview";
  mobile = "assistant";
  navTab = "structure";
  zoom = "fit";
  page = 1;
  pageCount = 0;
  render();
  await loadPdf();
}
function render() {
  if (unavailable) return;
  closeMenu();
  if (!doc) {
    newLanguage = document.querySelector("#doc-language")?.value ?? newLanguage;
    newModel = document.querySelector("#new-model")?.value ?? newModel;
    newDiscipline = document.querySelector("#discipline")?.value ?? newDiscipline;
  }
  document.title = doc ? `${doc.title} · Scribe` : "Scribe";
  doc ? renderEditor() : renderLibrary();
  bindCommon();
}
function readBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function downloadProject(id) {
  return api("projects.export", { documentId: id }).then((project) =>
    downloadBlob(
      new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }),
      "document.scribe.json",
    ),
  );
}
function downloadSources(id) {
  return api("sources.export", { documentId: id }).then((zip) =>
    downloadBlob(blobFromBase64(zip.base64, "application/zip"), "latex-project.zip"),
  );
}

/* ---------- Home ---------- */
const IDEAS = [
  ["physics", "physicsExample"],
  ["mathematics", "mathExample"],
  ["computing", "computingExample"],
];
const FILTERS = ["all", "progress", "ready", "archived"];
function renderLibrary() {
  const language = newLanguage ?? locale;
  const other = language === "es" ? "en" : "es";
  root.innerHTML =
    brand(
      `<span class="tagline muted">${t("tagline")}</span>`,
      pill("new-model", "sparkle", "model", modelOptions(newModel), "model-pill") +
        iconButton("app-settings", "gear", "appSettings", "square"),
    ) +
    `<main class="shell home"><div class="hero"><section class="panel compose"><h1>${t("idea")}</h1><textarea id="brief" class="brief" aria-label="${t("idea")}" placeholder="${t("placeholder")}">${escapeHtml(brief)}</textarea><div id="sources" class="sources"></div><div class="compose-bar"><div class="compose-tools">${iconLabel("add-sources", "paperclip", "addSources")}<input id="sources-input" type="file" class="hide" multiple accept="${ASSET_ACCEPT}"><span class="vdivider" aria-hidden="true"></span>${pill(
      "doc-language",
      "globe",
      "language",
      `<option value="${language}">${t(language)}</option><option value="${other}">${t(other)}</option>`,
    )}${pill(
      "discipline",
      "cap",
      "discipline",
      IDEAS.map(
        ([k]) => `<option value="${k}" ${newDiscipline === k ? "selected" : ""}>${t(k)}</option>`,
      ).join(""),
    )}</div>${iconLabel("create", "pencil", "newDraft", "primary")}</div></section><aside class="panel ideas"><h2>${t("start")}</h2><p class="muted subtitle">${t("ideaSubtitle")}</p><div class="templates">${IDEAS.map(
      ([k, x]) =>
        `<button class="template" data-template="${x}" data-discipline="${k}"><span class="template-icon">${icon(disciplineIcon(k), "icon big")}</span><span class="template-text"><strong>${t(k)}</strong><span class="muted">${t(x)}</span></span>${icon("chevronRight", "icon chevron")}</button>`,
    ).join(
      "",
    )}</div></aside></div><section class="library"><div class="library-head"><h2 class="title-icon">${icon("doc")}${t("documents")}</h2><div class="library-tools"><label class="searchbox">${icon("search")}<input id="search" type="search" aria-label="${t("search")}" placeholder="${t("search")}" value="${escapeHtml(search)}"></label><div class="segmented" role="group" aria-label="${t("documents")}">${FILTERS.map(
      (k) =>
        `<button data-filter="${k}" aria-pressed="${filter === k}" class="${filter === k ? "active" : ""}">${t(k)}</button>`,
    ).join(
      "",
    )}</div>${iconLabel("import", "upload", "import")}<input id="import-input" type="file" class="hide" accept=".tex,.json"></div></div><div class="cards" id="cards"></div></section></main><div id="activity-bar"></div>`;
  renderSources();
  renderCards();
  renderActivity();
  on("import", () => document.querySelector("#import-input").click());
  on(
    "import-input",
    async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 256 * 1024 * 1024) throw new Error("asset_limit");
      const text = await file.text();
      const imported = file.name.endsWith(".tex")
        ? await api(
            "documents.create",
            { title: file.name.slice(0, -4), tex: text, language: locale },
            true,
          )
        : await api("projects.import", { project: JSON.parse(text) }, true);
      await openDocument(imported.id);
    },
    "change",
  );
  on("app-settings", showAppSettings);
  on("add-sources", () => document.querySelector("#sources-input").click());
  on(
    "sources-input",
    (e) => {
      for (const file of e.target.files) {
        if (file.size > ASSET_MAX) toast(t("asset_limit"));
        else pendingSources.push(file);
      }
      e.target.value = "";
      renderSources();
    },
    "change",
  );
  on(
    "brief",
    (e) => {
      brief = e.target.value;
    },
    "input",
  );
  on(
    "brief",
    (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        document.querySelector("#create")?.click();
      }
    },
    "keydown",
  );
  on(
    "search",
    (e) => {
      search = e.target.value;
      renderCards();
    },
    "input",
  );
  for (const el of root.querySelectorAll("[data-filter]"))
    el.addEventListener("click", () => {
      filter = el.dataset.filter;
      for (const b of root.querySelectorAll("[data-filter]")) {
        const active = b === el;
        b.classList.toggle("active", active);
        b.setAttribute("aria-pressed", String(active));
      }
      renderCards();
    });
  for (const el of root.querySelectorAll("[data-template]"))
    el.addEventListener("click", () => {
      brief = t(el.dataset.template);
      document.querySelector("#brief").value = brief;
      document.querySelector("#discipline").value = el.dataset.discipline;
      document.querySelector("#brief").focus();
    });
  on("create", async () => {
    if (!brief.trim()) {
      document.querySelector("#brief").focus();
      return;
    }
    const btn = document.querySelector("#create");
    btn.disabled = true;
    try {
      const d = await api(
        "documents.create",
        {
          title: brief.trim().slice(0, 90),
          brief,
          discipline: document.querySelector("#discipline").value,
          language: document.querySelector("#doc-language").value,
          model: document.querySelector("#new-model").value,
        },
        true,
      );
      // Attach the picked sources one by one; a rejected file is reported, the rest still upload.
      const files = pendingSources;
      pendingSources = [];
      for (const file of files) {
        try {
          await api(
            "assets.add",
            { documentId: d.id, name: file.name, base64: await readBase64(file) },
            true,
          );
        } catch (e) {
          toast(`${file.name}: ${t(e.message)}`);
        }
      }
      await openDocument(d.id);
      prompt = brief;
      brief = "";
      render();
    } finally {
      btn.disabled = false;
    }
  });
}
function renderSources() {
  const el = document.querySelector("#sources");
  if (!el) return;
  el.innerHTML = pendingSources.length
    ? `${pendingSources
        .map(
          (f, i) =>
            `<span class="source-chip">${icon("paperclip")}<span>${escapeHtml(f.name)}</span><button class="icon-btn tiny ghost" data-unsource="${i}" aria-label="${escapeHtml(`${t("remove_source")}: ${f.name}`)}">${icon("close")}</button></span>`,
        )
        .join("")}<span class="muted small">${t("sourcesHint")}</span>`
    : "";
  for (const b of el.querySelectorAll("[data-unsource]"))
    b.addEventListener("click", () => {
      pendingSources.splice(Number(b.dataset.unsource), 1);
      renderSources();
      document.querySelector("#add-sources")?.focus();
    });
}
const STATUS = {
  draft: ["statusDraft", "pencil"],
  review: ["statusReview", "refresh"],
  ready: ["statusReady", "check"],
};
function statusPill(status) {
  const [label, name] = STATUS[status];
  return `<span class="status status-${status}">${icon(name)}${t(label)}</span>`;
}
function renderCards() {
  const cards = document.querySelector("#cards");
  if (!cards) return;
  const query = search.toLowerCase();
  const items = docs
    .map((d) => ({ d, status: listStatus(d, jobs) }))
    .filter(
      ({ d, status }) => matchesFilter(d, status, filter) && d.title.toLowerCase().includes(query),
    );
  const words = { today: t("today"), yesterday: t("yesterday") };
  cards.innerHTML = items.length
    ? items
        .map(
          ({ d, status }) =>
            `<article class="card"><div class="paper" aria-hidden="true"><span class="paper-title">${t("paperTitle")}</span><span class="paper-line"></span><span class="paper-line short"></span>${paperGlyph(d.discipline)}<span class="paper-line"></span><span class="paper-line short"></span></div><div class="card-body"><div class="card-top"><span class="chip">${icon(disciplineIcon(d.discipline))}${escapeHtml(t(d.discipline))}</span><button class="icon-btn ghost" data-menu="${escapeHtml(d.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(`${t("moreActions")}: ${d.title}`)}">${icon("more")}</button></div><h3><button class="card-open" data-doc="${escapeHtml(d.id)}">${escapeHtml(d.title)}</button></h3>${statusPill(status)}${d.archived ? `<span class="chip muted-chip">${icon("archive")}${t("archived")}</span>` : ""}<p class="meta">${icon("calendar")}<span>${t("lastModified")}: ${escapeHtml(formatModified(d.updatedAt, locale, words))}</span></p><p class="meta">${icon("layers")}<span>${d.assets} ${t(d.assets === 1 ? "resource" : "resources")} · ${d.proposals} ${t(d.proposals === 1 ? "proposalShort" : "proposalsShort")}</span></p></div></article>`,
        )
        .join("")
    : `<p class="empty">${t("empty")}</p>`;
  for (const el of cards.querySelectorAll("[data-doc]"))
    el.addEventListener("click", () =>
      openDocument(el.dataset.doc).catch((e) => toast(t(e.message))),
    );
  for (const el of cards.querySelectorAll("[data-menu]"))
    el.addEventListener("click", () => {
      const d = docs.find((x) => x.id === el.dataset.menu);
      if (!d) return;
      showMenu(el, [
        { label: t("open"), icon: "doc", run: () => openDocument(d.id) },
        { label: t("exportProject"), icon: "download", run: () => downloadProject(d.id) },
        { label: t("exportSources"), icon: "code", run: () => downloadSources(d.id) },
        {
          label: t(d.archived ? "unarchive" : "archive"),
          icon: "archive",
          run: async () => {
            await api("documents.settings", { documentId: d.id, archived: !d.archived }, true);
            await refreshList();
            renderCards();
          },
        },
      ]);
    });
}
/** Sticky bar on the home screen while a draft runs; it stops the job through jobs.cancel. */
function renderActivity() {
  const el = document.querySelector("#activity-bar");
  if (!el) return;
  const running = jobs.filter((j) => j.status === "running" && j.action === "draft");
  if (!running.length) {
    el.innerHTML = "";
    el.className = "";
    return;
  }
  const job = running[0];
  const title = docs.find((d) => d.id === job.documentId)?.title ?? "";
  el.className = "activity-bar";
  el.setAttribute("role", "status");
  el.innerHTML = `${spinner}<strong class="activity-title">${t("draftingTitle")}: ${escapeHtml(title)}</strong>${running.length > 1 ? `<span class="muted">+${running.length - 1}</span>` : ""}<span class="vdivider" aria-hidden="true"></span><span class="muted activity-detail">${t("draftingDetail")}</span><button class="outline small" data-stop="${escapeHtml(job.id)}">${icon("stop")}${t("stop")}</button>`;
  el.querySelector("[data-stop]").onclick = () =>
    api("jobs.cancel", { jobId: job.id }).catch((e) => toast(t(e.message)));
}
function showAppSettings() {
  refreshDialog = showAppSettings;
  showDialog(
    `<label class="field">${t("defaultModel")}<select id="pref-model">${modelOptions(newModel)}</select></label><p class="notice">${t("compilerHint")}</p><p class="notice">${t("assetHint")}</p><p class="notice">${t("pending")}</p>`,
    t("appSettings"),
  );
  on(
    "pref-model",
    (e) => {
      newModel = e.target.value;
      const select = document.querySelector("#new-model");
      if (select) select.value = newModel;
    },
    "change",
  );
}

/* ---------- Document ---------- */
function renderEditor() {
  const sections = sectionsOf(draftTex);
  const stats = texStats(draftTex, draftBib);
  root.innerHTML =
    brand(
      `<nav class="crumbs" aria-label="${t("breadcrumb")}"><button id="back" class="crumb-link">${t("back")}</button><span aria-hidden="true">/</span><span class="crumb-current" aria-current="page">${escapeHtml(doc.title)}</span></nav><span id="save-state" class="save-state ${dirty ? "dirty" : ""}">${saveStateInner(dirty)}</span>`,
      iconLabel("history", "history", "history") +
        iconLabel("export-pdf", "download", "exportPdf", "primary"),
    ) +
    `<div class="doc-head"><div class="doc-title"><h1>${escapeHtml(doc.title)}</h1><span class="chip">${icon(disciplineIcon(doc.discipline))}${escapeHtml(t(doc.discipline))}</span></div><div class="doc-actions">${pill("doc-model", "sparkle", "docModel", modelOptions(doc.model), "model-pill")}${iconButton("settings", "gear", "settings", "square")}</div></div><nav class="mobile-tabs" aria-label="${t("documents")}">${[
      ["navigator", "documentPanel"],
      ["assistant", "assistantTab"],
      ["preview", "preview"],
    ]
      .map(
        ([k, l]) =>
          `<button data-mobile="${k}" aria-pressed="${mobile === k}" class="${mobile === k ? "active" : ""}">${t(l)}</button>`,
      )
      .join(
        "",
      )}</nav><main class="editor"><aside class="panel navigator ${mobile === "navigator" ? "mobile-active" : ""}"><p class="eyebrow">${t("documentPanel")}</p><div class="segmented full" role="tablist" aria-label="${t("documentPanel")}"><button id="nav-structure" role="tab" aria-selected="${navTab === "structure"}" aria-controls="nav-panel" class="${navTab === "structure" ? "active" : ""}">${t("structure")}</button><button id="nav-files" role="tab" aria-selected="${navTab === "files"}" aria-controls="nav-panel" class="${navTab === "files" ? "active" : ""}">${t("files")}</button></div><div id="nav-panel" role="tabpanel" aria-labelledby="nav-${navTab}">${
      navTab === "structure"
        ? `<div class="sections">${[["", t("whole")], ...sections.map((s) => [s, s])]
            .map(
              ([value, label], i) =>
                `<button data-section="${i - 1}" class="section-item ${scope === value ? "selected" : ""}" aria-pressed="${scope === value}">${icon("doc")}<span>${escapeHtml(label)}</span></button>`,
            )
            .join(
              "",
            )}</div><p class="stats muted">${count(stats.equations, "equation")} · ${count(stats.figures, "figure")} · ${count(stats.references, "reference")}</p><p class="eyebrow">${t("docFiles")}</p>`
        : `<p class="notice">${t("assetHint")}</p><p class="notice">${t("assetsOnly")}</p>`
    }<div id="assets" class="assets"></div></div><button id="add-asset" class="outline full">${icon("plus")}${t("addAsset")}</button><input id="asset-input" type="file" class="hide" accept="${ASSET_ACCEPT}"></aside><section class="panel assistant ${mobile === "assistant" ? "mobile-active" : ""}"><h2>${t("assistant")}</h2><p class="muted helper">${t(doc.revisions.length > 1 ? "readyHint" : "hint")}</p><div class="thread" aria-live="polite"><div id="jobs"></div><div id="proposals"></div></div><p class="notice">${t("pending")}</p><div class="composer"><textarea id="prompt" placeholder="${t("prompt")}" aria-label="${t("prompt")}">${escapeHtml(prompt)}</textarea><div class="composer-bar">${pill(
      "scope",
      "doc",
      "scope",
      `<option value="">${t("whole")}</option>${sections
        .map(
          (s) =>
            `<option value="${escapeHtml(s)}" ${scope === s ? "selected" : ""}>${escapeHtml(s)}</option>`,
        )
        .join("")}`,
      "scope-pill",
    )}<div class="composer-actions"><span id="composer-stop"></span>${iconButton("attach", "paperclip", "attach", "ghost")}<button id="send" class="primary icon-btn send" title="${t("send")}">${icon("send")}<span class="sr-only">${t("send")}</span></button></div></div></div></section><section class="panel preview-panel ${mobile === "preview" ? "mobile-active" : ""}"><div class="preview-head"><div class="tabs" role="tablist" aria-label="${t("preview")}"><button id="tab-preview" role="tab" aria-selected="${view === "preview"}">${icon("doc")}${t("preview")}</button><button id="tab-source" role="tab" aria-selected="${view === "source"}">${icon("code")}${t("source")}</button></div>${iconLabel("compile", "build", "compile", "outline small")}</div>${
      view === "source"
        ? `<div class="source-pane" role="tabpanel" aria-labelledby="tab-source"><textarea id="source" class="source" aria-label="${t("source")}" spellcheck="false">${escapeHtml(draftTex)}</textarea><label for="bib">${t("bibliography")}</label><textarea id="bib" class="bib" aria-label="${t("bibliography")}" spellcheck="false">${escapeHtml(draftBib)}</textarea><div class="row end">${button("save", "save", true)}</div></div>`
        : `<div class="pdf-tools"><div class="pager">${iconButton("page-prev", "chevronLeft", "prevPage", "ghost small")}<span id="page-label" class="page-label">–</span>${iconButton("page-next", "chevronRight", "nextPage", "ghost small")}</div><div class="zoomer">${iconButton("zoom-out", "minus", "zoomOut", "ghost small")}<select id="zoom-select" aria-label="${t("zoom")}"></select>${iconButton("zoom-in", "plus", "zoomIn", "ghost small")}</div></div><div id="pdf-holder" class="pdf-holder" role="tabpanel" aria-labelledby="tab-preview" tabindex="0"></div>`
    }<div id="pdf-status" class="pdf-status" role="status"></div></section></main>`;
  renderAssets();
  renderJobs();
  renderProposals();
  renderPdf();
  for (const el of root.querySelectorAll("[data-mobile]"))
    el.addEventListener("click", () => {
      mobile = el.dataset.mobile;
      render();
    });
  for (const el of root.querySelectorAll("[data-section]"))
    el.addEventListener("click", () => {
      const index = Number(el.dataset.section);
      scope = index < 0 ? "" : (sections[index] ?? "");
      render();
      document.querySelector("#prompt").focus();
    });
  on("nav-structure", () => {
    navTab = "structure";
    render();
    document.querySelector("#nav-structure")?.focus();
  });
  on("nav-files", () => {
    navTab = "files";
    render();
    document.querySelector("#nav-files")?.focus();
  });
  on("prompt", (e) => (prompt = e.target.value), "input");
  on(
    "prompt",
    (e) => {
      // Ctrl/Cmd+Enter sends (the frame has no form element); plain Enter adds a line.
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        document.querySelector("#send")?.click();
      }
    },
    "keydown",
  );
  on("scope", (e) => (scope = e.target.value), "change");
  on("tab-preview", () => {
    view = "preview";
    render();
  });
  on("tab-source", () => {
    view = "source";
    render();
  });
  const changed = () => {
    dirty = true;
    const state = document.querySelector("#save-state");
    state.classList.add("dirty");
    state.innerHTML = saveStateInner(true);
  };
  on(
    "source",
    (e) => {
      draftTex = e.target.value;
      changed();
    },
    "input",
  );
  on(
    "bib",
    (e) => {
      draftBib = e.target.value;
      changed();
    },
    "input",
  );
  on("save", async () => {
    doc = await api(
      "revision.save",
      { documentId: doc.id, baseRevision: latest().id, tex: draftTex, bib: draftBib },
      true,
    );
    dirty = false;
    pdfStale = true;
    render();
  });
  on("send", async () => {
    if (!prompt.trim()) return;
    if (dirty) {
      toast(t("unsaved"));
      return;
    }
    const job = await api(
      "draft.generate",
      { documentId: doc.id, prompt, scope: scope || "document" },
      true,
    );
    jobs.push(job);
    lastRequest.set(doc.id, { text: prompt, scope });
    prompt = "";
    render();
  });
  on("compile", async () => {
    if (dirty) {
      toast(t("unsaved"));
      return;
    }
    const job = await api("pdf.compile", { documentId: doc.id }, true);
    jobs.push(job);
    renderJobs();
    renderPdfStatus();
  });
  on("export-pdf", async () => {
    const result = await api("pdf.get", { documentId: doc.id });
    if (result.stale && !(await confirmPrompt(t("exportStale")))) return;
    downloadBlob(blobFromBase64(result.base64, "application/pdf"), "document.pdf");
  });
  on(
    "doc-model",
    async (e) => {
      doc = await api("documents.settings", { documentId: doc.id, model: e.target.value }, true);
    },
    "change",
  );
  on("settings", showSettings);
  on("history", showHistory);
  on("add-asset", () => document.querySelector("#asset-input").click());
  on("attach", () => document.querySelector("#asset-input").click());
  on(
    "asset-input",
    async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > ASSET_MAX) throw new Error("asset_limit");
      const base64 = await readBase64(file);
      doc = await api("assets.add", { documentId: doc.id, name: file.name, base64 }, true);
      pdfStale = true;
      render();
    },
    "change",
  );
  bindPdfTools();
}
function assetThumb(asset) {
  const name = { image: "image", table: "table", code: "braces", pdf: "doc", text: "doc" }[
    assetKind(asset)
  ];
  return `<span class="thumb kind-${assetKind(asset)}">${icon(name)}</span>`;
}
function renderAssets() {
  const el = document.querySelector("#assets");
  if (!el) return;
  el.innerHTML =
    doc.assets
      .map(
        (a) =>
          `<div class="asset-row">${assetThumb(a)}<span class="asset-name"><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(formatBytes(base64Bytes(a.base64), locale))}${navTab === "files" ? ` · ${escapeHtml(a.path)}` : ""}</small></span><button class="icon-btn ghost small" data-asset-menu="${escapeHtml(a.id)}" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(`${t("moreActions")}: ${a.name}`)}">${icon("more")}</button></div>`,
      )
      .join("") || `<p class="muted small">${t("noAssets")}</p>`;
  for (const b of el.querySelectorAll("[data-asset-menu]"))
    b.addEventListener("click", () => {
      const a = doc.assets.find((x) => x.id === b.dataset.assetMenu);
      if (!a) return;
      showMenu(b, [
        {
          label: t("download"),
          icon: "download",
          run: () => downloadBlob(blobFromBase64(a.base64, a.mime), a.name),
        },
        {
          label: t("remove"),
          icon: "close",
          danger: true,
          run: async () => {
            if (!(await confirmPrompt(t("confirmRemove")))) return;
            doc = await api("assets.remove", { documentId: doc.id, assetId: a.id }, true);
            pdfStale = true;
            render();
          },
        },
      ]);
    });
}
function stageIcon(state) {
  if (state === "done") return `<span class="stage-mark done">${icon("check")}</span>`;
  if (state === "active") return spinner;
  if (state === "failed") return `<span class="stage-mark failed">${icon("close")}</span>`;
  return '<span class="stage-mark idle"></span>';
}
function jobError(j) {
  return j.errorCode
    ? `<p class="error">${escapeHtml(t(j.errorCode))}</p><details><summary>${t("jobDetails")}</summary><pre class="joblog">${escapeHtml(j.message)}</pre></details>`
    : "";
}
function renderJobs() {
  const el = document.querySelector("#jobs");
  if (!el) return;
  const own = jobs.filter((j) => j.documentId === doc.id).slice(-4);
  const request = lastRequest.get(doc.id);
  el.innerHTML =
    (request
      ? `<div class="bubble"><span class="avatar">${icon("user")}</span><div><span class="eyebrow">${t("yourRequest")}${request.scope ? ` · ${escapeHtml(request.scope)}` : ""}</span><p>${escapeHtml(request.text)}</p></div></div>`
      : "") +
    own
      .map((j) => {
        const running = j.status === "running";
        const stop = running
          ? `<button class="outline small" data-stop="${escapeHtml(j.id)}">${icon("stop")}${t("stop")}</button>`
          : "";
        if (j.action === "draft")
          return `<div class="step-card"><div class="row spread"><strong class="step-title">${running ? spinner : ""}${t(running ? "preparing" : j.status)}</strong>${stop}</div><ul class="stages">${jobStages(
            j,
          )
            .map((s) => `<li class="stage-${s.state}">${stageIcon(s.state)}${t(s.key)}</li>`)
            .join("")}</ul>${jobError(j)}</div>`;
        return `<div class="activity"><div class="row spread"><strong class="step-title">${running ? spinner : ""}${t(running ? j.message : j.status)}</strong>${stop}</div>${jobError(j)}</div>`;
      })
      .join("");
  const stopSlot = document.querySelector("#composer-stop");
  const active = own.findLast((j) => j.status === "running");
  if (stopSlot)
    stopSlot.innerHTML = active
      ? `<button class="outline small" data-stop="${escapeHtml(active.id)}">${icon("stop")}${t("stop")}</button>`
      : "";
  for (const b of [...el.querySelectorAll("[data-stop]"), ...(stopSlot?.children ?? [])])
    b.onclick = () =>
      api("jobs.cancel", { jobId: b.dataset.stop }).catch((e) => toast(t(e.message)));
}
/** Names-only warning for a proposal that needs packages or languages the engine lacks. */
function preflightNotice(report) {
  if (!report) return "";
  const rows = [
    ["preflightPackages", report.packages],
    ["preflightLanguages", report.languages],
    ["preflightProvide", report.provide],
  ]
    .filter(([, names]) => Array.isArray(names) && names.length)
    .map(([key, names]) => `<li>${t(key)}: ${escapeHtml(names.join(", "))}</li>`)
    .join("");
  return rows
    ? `<div class="preflight">${icon("alert")}<div><p>${t("latex_package_missing")}</p><ul>${rows}</ul></div></div>`
    : "";
}
function renderProposals() {
  const el = document.querySelector("#proposals");
  if (!el) return;
  el.innerHTML = doc.proposals
    .map((p) => {
      const diff = changedSections(latest().tex, p.tex);
      const lines = summaryLines(p.summary);
      return `<div class="proposal"><div class="proposal-head"><span class="proposal-icon">${icon("doc")}</span><div><strong>${t("proposals")}</strong><span class="muted small">${diff.count ? `${diff.count} ${t(diff.count === 1 ? "sectionChanged" : "sectionsChanged")}` : t("noSectionChanged")}</span></div></div>${lines.length ? `<ul class="bullets">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` : ""}${diff.names.length ? `<p class="muted small changed-names">${escapeHtml(diff.names.join(" · "))}</p>` : ""}${preflightNotice(p.preflight)}<div class="row end"><button class="outline" data-review="${escapeHtml(p.id)}">${icon("eye")}${t("reviewShort")}</button><button class="primary" data-apply="${escapeHtml(p.id)}">${icon("check")}${t("apply")}</button></div></div>`;
    })
    .join("");
  for (const b of el.querySelectorAll("[data-review]"))
    b.onclick = () => showProposal(b.dataset.review);
  for (const b of el.querySelectorAll("[data-apply]"))
    b.onclick = () => applyProposal(b.dataset.apply).catch((e) => toast(t(e.message)));
}
function showDialog(html, title = "Scribe") {
  dialog.innerHTML = `<div class="dialog-head"><h2>${escapeHtml(title)}</h2><button id="dialog-close" class="icon-btn ghost" title="${t("close")}">${icon("close")}<span class="sr-only">${t("close")}</span></button></div><div class="dialog-body">${html}</div>`;
  if (!dialog.open) dialog.showModal();
  on("dialog-close", () => dialog.close());
}
async function applyProposal(id) {
  if (dirty) {
    toast(t("unsaved"));
    return;
  }
  doc = await api("proposal.apply", { documentId: doc.id, proposalId: id }, true);
  draftTex = latest().tex;
  draftBib = latest().bib;
  pdfStale = true;
  if (dialog.open) dialog.close();
  render();
}
function showProposal(id) {
  refreshDialog = () => showProposal(id);
  const p = doc.proposals.find((p) => p.id === id);
  showDialog(
    `<p>${escapeHtml(p.summary)}</p>${preflightNotice(p.preflight)}<div class="compare"><div><label>${t("before")}</label><textarea readonly>${escapeHtml(latest().tex)}</textarea></div><div><label>${t("after")}</label><textarea readonly>${escapeHtml(p.tex)}</textarea></div></div><details><summary>${t("bibliography")}</summary><pre class="joblog">${escapeHtml(p.bib)}</pre></details><div class="row end">${button("discard", "discard")}${button("apply", "apply", true)}</div>`,
    t("review"),
  );
  on("apply", () => applyProposal(id));
  on("discard", async () => {
    doc = await api("proposal.discard", { documentId: doc.id, proposalId: id }, true);
    dialog.close();
    render();
  });
}
function showHistory() {
  refreshDialog = showHistory;
  const count = doc.revisions.length;
  showDialog(
    doc.revisions
      .slice()
      .reverse()
      .map(
        (r, i) =>
          `<div class="history-item"><span class="version-badge">v${count - i}</span><div class="history-text"><strong>${escapeHtml(r.summary)}</strong><p class="muted">${new Date(r.at).toLocaleString(locale)}</p></div><button class="outline small" data-restore="${escapeHtml(r.id)}">${icon("history")}${t("restore")}</button></div>`,
      )
      .join(""),
    t("history"),
  );
  for (const b of dialog.querySelectorAll("[data-restore]"))
    b.onclick = async () => {
      if (dirty) {
        toast(t("unsaved"));
        return;
      }
      if (!(await confirmPrompt(t("confirmRestore")))) return;
      try {
        doc = await api(
          "revision.restore",
          { documentId: doc.id, revisionId: b.dataset.restore, baseRevision: latest().id },
          true,
        );
        draftTex = latest().tex;
        draftBib = latest().bib;
        pdfStale = true;
        dialog.close();
        render();
      } catch (e) {
        toast(t(e.message));
      }
    };
}
function showSettings() {
  refreshDialog = showSettings;
  showDialog(
    `<label class="field">${t("title")}<input id="setting-title" value="${escapeHtml(doc.title)}"></label><label class="field">${t("model")}<select id="setting-model">${modelOptions(doc.model)}</select></label><label class="field">${t("language")}<select id="setting-language">${["en", "es"].map((l) => `<option value="${l}" ${doc.language === l ? "selected" : ""}>${t(l)}</option>`).join("")}</select></label><div class="row">${button("settings-save", "save", true)}${button("project-export", "exportProject")}${button("export-sources", "exportSources")}${button("archive", doc.archived ? "unarchive" : "archive")}</div>`,
    t("settings"),
  );
  on("settings-save", async () => {
    doc = await api(
      "documents.settings",
      {
        documentId: doc.id,
        title: document.querySelector("#setting-title").value,
        model: document.querySelector("#setting-model").value,
        language: document.querySelector("#setting-language").value,
      },
      true,
    );
    dialog.close();
    render();
  });
  on("project-export", () => downloadProject(doc.id));
  on("export-sources", () => downloadSources(doc.id));
  on("archive", async () => {
    doc = await api("documents.settings", { documentId: doc.id, archived: !doc.archived }, true);
    dialog.close();
    render();
  });
}
function blobFromBase64(base64, type) {
  const binary = atob(base64);
  return new Blob([Uint8Array.from(binary, (c) => c.charCodeAt(0))], { type });
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function loadPdf() {
  if (!doc) return;
  const id = doc.id;
  const request = ++pdfRequest;
  try {
    const result = await api("pdf.get", { documentId: id });
    if (doc?.id !== id || request !== pdfRequest) return;
    pdfBlob = blobFromBase64(result.base64, "application/pdf");
    pdfStale = result.stale;
    renderPdf();
  } catch (e) {
    if (doc?.id !== id || request !== pdfRequest) return;
    if (e.message !== "pdf_missing") toast(t(e.message));
    pdfBlob = undefined;
    renderPdf();
  }
}

/* ---------- PDF preview: status, pager and zoom ---------- */
const percent = (scale) => `${Math.round(scale * 100)}%`;
function renderPdfStatus() {
  const status = document.querySelector("#pdf-status");
  if (!status || !doc) return;
  const compiling = jobs.some(
    (j) => j.documentId === doc.id && j.action === "compile" && j.status === "running",
  );
  const version = pdfVersion(doc);
  status.className = `pdf-status ${compiling ? "busy" : pdfBlob ? (pdfStale ? "stale" : "fresh") : "none"}`;
  status.innerHTML = compiling
    ? `${spinner}<span>${t("compiling")}</span>`
    : pdfBlob
      ? pdfStale
        ? `${icon("alert")}<span>${t("stale")}</span>`
        : `${icon("checkCircle")}<span>${version ? `${t("currentPdf").replace(/\.$/, "")} · ${t("version")} ${version}` : t("currentPdf")}</span>`
      : `<span class="muted">${t("pdf_missing")}</span>`;
}
function renderPdfTools() {
  const select = document.querySelector("#zoom-select");
  if (!select) return;
  select.innerHTML = `<option value="fit" ${zoom === "fit" ? "selected" : ""}>${t("zoomFit")} · ${percent(fitScale)}</option>${ZOOM_STEPS.map((z) => `<option value="${z}" ${zoom === z ? "selected" : ""}>${percent(z)}</option>`).join("")}`;
  const label = document.querySelector("#page-label");
  if (label) label.textContent = pageCount ? `${page} / ${pageCount}` : "–";
  const none = !pdfBlob;
  for (const id of ["zoom-select", "zoom-in", "zoom-out"])
    document.getElementById(id).disabled = none;
  document.querySelector("#page-prev").disabled = none || page <= 1;
  document.querySelector("#page-next").disabled = none || page >= pageCount;
}
function goToPage(n) {
  const holder = document.querySelector("#pdf-holder");
  const canvas = holder?.querySelector(`[data-page="${n}"]`);
  if (!canvas) return;
  page = n;
  holder.scrollTo({ top: canvas.offsetTop - 12, behavior: "smooth" });
  renderPdfTools();
}
function setZoom(value) {
  zoom = value;
  page = 1;
  renderPdf();
}
function bindPdfTools() {
  on("page-prev", () => goToPage(Math.max(1, page - 1)));
  on("page-next", () => goToPage(Math.min(pageCount, page + 1)));
  on("zoom-in", () => setZoom(stepZoom(zoom === "fit" ? fitScale : zoom, 1)));
  on("zoom-out", () => setZoom(stepZoom(zoom === "fit" ? fitScale : zoom, -1)));
  on(
    "zoom-select",
    (e) => setZoom(e.target.value === "fit" ? "fit" : Number(e.target.value)),
    "change",
  );
  const holder = document.querySelector("#pdf-holder");
  holder?.addEventListener(
    "scroll",
    () => {
      const line = holder.scrollTop + holder.clientHeight / 3;
      let current = 1;
      for (const canvas of holder.querySelectorAll("[data-page]"))
        if (canvas.offsetTop <= line) current = Number(canvas.dataset.page);
      if (current !== page) {
        page = current;
        renderPdfTools();
      }
    },
    { passive: true },
  );
}
function renderPdf() {
  renderPdfStatus();
  const holder = document.querySelector("#pdf-holder");
  if (!holder) return;
  if (pdfBlob) {
    if (globalThis.scribeRenderPdf)
      void globalThis.scribeRenderPdf(holder, pdfBlob, {
        zoom,
        onInfo: (info) => {
          pageCount = info.pages;
          if (zoom === "fit") fitScale = info.scale;
          page = Math.min(page, pageCount) || 1;
          renderPdfTools();
        },
      });
    else holder.textContent = t("download");
  } else {
    pageCount = 0;
    holder.innerHTML = `<div class="empty"><span class="empty-icon">${icon("doc", "icon big")}</span><h3>${t("noPdf")}</h3><p>${t("compilerHint")}</p></div>`;
  }
  renderPdfTools();
}
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
async function poll() {
  if (pollBusy || unavailable || document.hidden || !visible) return;
  pollBusy = true;
  try {
    const next = await api("jobs.list");
    const signature = JSON.stringify(next.map((j) => [j.id, j.status]));
    jobs = next;
    if (signature !== pollSignature) {
      pollSignature = signature;
      if (doc) {
        const fresh = await api("documents.get", { documentId: doc.id });
        if (!dirty) {
          doc = fresh;
          draftTex = latest().tex;
          draftBib = latest().bib;
        } else {
          doc.proposals = fresh.proposals;
          doc.pdf = fresh.pdf;
        }
        renderJobs();
        renderProposals();
        await loadPdf();
      } else {
        await refreshList();
        renderCards();
        renderActivity();
      }
    }
  } catch {
    /* Keep the last valid screen while reconnecting. */
  } finally {
    pollBusy = false;
  }
}
try {
  await connected;
  context = await api("context");
  await refreshList();
  try {
    models = await api("models");
  } catch {
    toast(t("modelError"));
  }
  jobs = await api("jobs.list");
  render();
  // Only a hard read-only session is final; otherwise Alisio asks for approval when needed.
  if (context.capabilities.readOnly) toast(t("readOnly"));
  setInterval(poll, 1500);
} catch (e) {
  if (!unavailable)
    root.innerHTML = `<main class="shell"><h1>Scribe</h1><p>${escapeHtml(t(e.message))}</p><p>${t("reconnect")}</p></main>`;
}
