import { locale, setLocale, t } from "./i18n.js";

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
  filter = "active",
  search = "";
let view = "preview",
  mobile = "assistant",
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
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const latest = () => doc.revisions.at(-1);
const button = (id, label, primary = false) =>
  `<button id="${id}" class="${primary ? "primary" : ""}">${escapeHtml(t(label))}</button>`;
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.style.display = "none"), 7000);
}
// The host runs at most PLUGIN_APP_LIMITS.inFlight (8) requests per frame; stay below it.
const MAX_IN_FLIGHT = 6;
const RESPONSE_GUARD_MS = 6 * 60 * 1000;
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
    // handler), but it may first wait for the user's approval prompt (capped at about 5 minutes).
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("operation_failed"));
    }, RESPONSE_GUARD_MS);
    pending.set(id, { resolve, reject, timer, action });
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
    const p = document.createElement("p");
    p.textContent = message;
    const cancel = document.createElement("button");
    cancel.textContent = locale === "es" ? "Cancelar" : "Cancel";
    const ok = document.createElement("button");
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
    box.append(p, cancel, ok);
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
  if (dialog.open) dialog.close();
  root.innerHTML = `<main class="shell"><div class="empty"><h1>${escapeHtml(t("unavailableTitle"))}</h1><p>${escapeHtml(t("unavailable"))}</p></div></main>`;
}
function brand() {
  return `<header><div class="brand"><span class="mark" aria-hidden="true">▱</span><strong>Scribe</strong><span class="muted">${t("tagline")}</span></div><div class="row">${doc ? button("back", "back") : ""}</div></header>${context.demo ? `<div class="warning">${t("demo")}</div>` : ""}`;
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
  render();
  await loadPdf();
}
function render() {
  if (unavailable) return;
  if (!doc) {
    newLanguage = document.querySelector("#doc-language")?.value ?? newLanguage;
    newModel = document.querySelector("#new-model")?.value ?? newModel;
    newDiscipline = document.querySelector("#discipline")?.value ?? newDiscipline;
  }
  document.title = doc ? `${doc.title} · Scribe` : "Scribe";
  doc ? renderEditor() : renderLibrary();
  bindCommon();
}
function renderLibrary() {
  const language = newLanguage ?? locale;
  root.innerHTML =
    brand() +
    `<main class="shell"><div class="hero"><section class="panel"><h1>${t("idea")}</h1><textarea id="brief" class="brief" aria-label="${t("idea")}" placeholder="${t("placeholder")}">${escapeHtml(brief)}</textarea><div class="row spread"><div class="row"><select id="discipline" aria-label="${t("start")}">${["physics", "mathematics", "computing"].map((k) => `<option value="${k}" ${newDiscipline === k ? "selected" : ""}>${t(k)}</option>`).join("")}</select><select id="doc-language" aria-label="${t("language")}"><option value="${language}">${t(language)}</option><option value="${language === "es" ? "en" : "es"}">${t(language === "es" ? "en" : "es")}</option></select><select id="new-model" aria-label="${t("model")}">${modelOptions(newModel)}</select></div>${button("create", "newDraft", true)}</div></section><aside class="panel"><h2>${t("start")}</h2><div class="templates">${[
      ["physics", "◎", "physicsExample"],
      ["mathematics", "∑", "mathExample"],
      ["computing", "⌘", "computingExample"],
    ]
      .map(
        ([k, g, x]) =>
          `<button class="template" data-template="${x}" data-discipline="${k}"><span aria-hidden="true">${g}</span><span><strong>${t(k)}</strong><span class="muted">${t(x)}</span></span></button>`,
      )
      .join(
        "",
      )}</div></aside></div><section class="library"><div class="row spread"><h2>${t("documents")}</h2><div class="row"><input id="search" class="search" aria-label="${t("search")}" placeholder="${t("search")}" value="${escapeHtml(search)}"><select id="filter" aria-label="${t("documents")}">${["all", "active", "archived"].map((k) => `<option value="${k}" ${filter === k ? "selected" : ""}>${t(k)}</option>`).join("")}</select></div></div><div class="cards" id="cards"></div></section></main>`;
  const importButton = document.createElement("button");
  importButton.textContent = t("import");
  const importInput = document.createElement("input");
  importInput.type = "file";
  importInput.accept = ".tex,.json";
  importInput.hidden = true;
  importButton.onclick = () => importInput.click();
  importInput.onchange = async () => {
    try {
      const file = importInput.files[0];
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
    } catch (e) {
      toast(t(e.message));
    }
  };
  document.querySelector(".library .row").append(importButton, importInput);
  renderCards();
  on(
    "brief",
    (e) => {
      brief = e.target.value;
    },
    "input",
  );
  on(
    "search",
    (e) => {
      search = e.target.value;
      renderCards();
    },
    "input",
  );
  on(
    "filter",
    (e) => {
      filter = e.target.value;
      renderCards();
    },
    "change",
  );
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
      await openDocument(d.id);
      prompt = brief;
      brief = "";
      render();
    } finally {
      btn.disabled = false;
    }
  });
}
function renderCards() {
  const items = docs.filter(
    (d) =>
      (filter === "all" || (filter === "archived") === d.archived) &&
      d.title.toLowerCase().includes(search.toLowerCase()),
  );
  const cards = document.querySelector("#cards");
  if (!cards) return;
  cards.innerHTML = items.length
    ? items
        .map(
          (d) =>
            `<button class="card" data-doc="${escapeHtml(d.id)}"><div class="paper" aria-hidden="true">∫ f(x) dx</div><div><span class="badge">${escapeHtml(t(d.discipline))}</span><h3>${escapeHtml(d.title)}</h3><p class="muted">${t("modified")}: ${new Date(d.updatedAt).toLocaleDateString(locale)}<br>${d.assets} ${t("resources")} · ${d.proposals} ${t("proposals")}</p></div></button>`,
        )
        .join("")
    : `<p class="empty">${t("empty")}</p>`;
  for (const el of cards.querySelectorAll("[data-doc]"))
    el.addEventListener("click", () =>
      openDocument(el.dataset.doc).catch((e) => toast(t(e.message))),
    );
}
function sections() {
  return [...draftTex.matchAll(/\\(?:sub)?section\*?\{([^}]+)\}/g)].map((m) => m[1]);
}
function renderEditor() {
  root.innerHTML =
    brand() +
    `<div class="toolbar"><h1>${escapeHtml(doc.title)}</h1><span class="badge" id="save-status">${dirty ? t("unsaved") : t("saved")}</span>${button("settings", "settings")}${button("history", "history")}${button("compile", "compile")}${button("export-pdf", "exportPdf", true)}</div><nav class="mobile-tabs" aria-label="${t("documents")}">${[
      ["assistant", "assistant"],
      ["navigator", "files"],
      ["preview", "preview"],
    ]
      .map(([k, l]) => `<button data-mobile="${k}">${t(l)}</button>`)
      .join(
        "",
      )}</nav><main class="editor"><aside class="panel navigator ${mobile === "navigator" ? "mobile-active" : ""}"><h3>${t("structure")}</h3><div class="sections">${
      sections()
        .map(
          (s, i) =>
            `<button data-section="${i}" class="quiet ${scope === s ? "selected" : ""}">${escapeHtml(s)}</button>`,
        )
        .join("") || `<p class="muted">${t("whole")}</p>`
    }</div><hr><h3>${t("files")}</h3><button id="add-asset">+ ${t("addAsset")}</button><input id="asset-input" type="file" class="hide" accept=".png,.jpg,.jpeg,.pdf,.csv,.json,.bib,.txt"><p class="notice">${t("assetHint")}</p><div id="assets"></div></aside><section class="panel assistant ${mobile === "assistant" ? "mobile-active" : ""}"><h2>${t("assistant")}</h2><p class="muted">${t("hint")}</p><div id="jobs"></div><div id="proposals"></div><p class="notice">${t("pending")}</p><div class="promptbox"><label for="scope">${t("scope")}</label><select id="scope"><option value="">${t("whole")}</option>${sections()
      .map(
        (s) =>
          `<option value="${escapeHtml(s)}" ${scope === s ? "selected" : ""}>${escapeHtml(s)}</option>`,
      )
      .join(
        "",
      )}</select><textarea id="prompt" placeholder="${t("prompt")}" aria-label="${t("prompt")}">${escapeHtml(prompt)}</textarea><div class="row spread"><span class="muted">${escapeHtml(doc.model || t("hostModel"))}</span>${button("send", "send", true)}</div></div></section><section class="panel preview ${mobile === "preview" ? "mobile-active" : ""}"><div class="tabs" role="tablist"><button id="tab-preview" role="tab" aria-selected="${view === "preview"}">${t("preview")}</button><button id="tab-source" role="tab" aria-selected="${view === "source"}">${t("source")}</button></div><div id="pdf-status"></div>${view === "source" ? `<textarea id="source" class="source" aria-label="${t("source")}" spellcheck="false">${escapeHtml(draftTex)}</textarea><label for="bib">${t("bibliography")}</label><textarea id="bib" aria-label="${t("bibliography")}" spellcheck="false">${escapeHtml(draftBib)}</textarea>${button("save", "save", true)}` : `<div id="pdf-holder" class="preview"></div>`}</section></main>`;
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
      scope = sections()[Number(el.dataset.section)];
      render();
      document.querySelector("#prompt").focus();
    });
  on("prompt", (e) => (prompt = e.target.value), "input");
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
    document.querySelector("#save-status").textContent = t("unsaved");
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
  });
  on("export-pdf", async () => {
    const result = await api("pdf.get", { documentId: doc.id });
    if (result.stale && !(await confirmPrompt(t("exportStale")))) return;
    downloadBlob(blobFromBase64(result.base64, "application/pdf"), "document.pdf");
  });
  on("settings", showSettings);
  on("history", showHistory);
  on("add-asset", () => document.querySelector("#asset-input").click());
  on(
    "asset-input",
    async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) throw new Error("asset_limit");
      const base64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      doc = await api("assets.add", { documentId: doc.id, name: file.name, base64 }, true);
      pdfStale = true;
      render();
    },
    "change",
  );
}
function renderAssets() {
  const el = document.querySelector("#assets");
  if (!el) return;
  el.innerHTML =
    doc.assets
      .map(
        (a) =>
          `<div class="asset">${a.mime.startsWith("image/") ? `<img src="data:${escapeHtml(a.mime)};base64,${escapeHtml(a.base64)}" alt="${escapeHtml(a.name)}">` : ""}<strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.path)}</small><div class="row"><button class="small" data-download="${a.id}">${t("download")}</button><button class="small quiet" data-remove="${a.id}">${t("remove")}</button></div></div>`,
      )
      .join("") || `<p class="muted">${t("noAssets")}</p>`;
  for (const b of el.querySelectorAll("[data-download]"))
    b.onclick = () => {
      const a = doc.assets.find((a) => a.id === b.dataset.download);
      downloadBlob(blobFromBase64(a.base64, a.mime), a.name);
    };
  for (const b of el.querySelectorAll("[data-remove]"))
    b.onclick = async () => {
      if (!(await confirmPrompt(t("confirmRemove")))) return;
      try {
        doc = await api("assets.remove", { documentId: doc.id, assetId: b.dataset.remove }, true);
        pdfStale = true;
        render();
      } catch (e) {
        toast(t(e.message));
      }
    };
}
function renderJobs() {
  const el = document.querySelector("#jobs");
  if (!el) return;
  const own = jobs.filter((j) => j.documentId === doc.id).slice(-4);
  el.innerHTML = own
    .map(
      (j) =>
        `<div class="activity"><div class="row spread"><strong>${t(j.status === "running" ? j.message : j.status)}</strong>${j.status === "running" ? `<button class="small" data-stop="${j.id}">${t("stop")}</button>` : ""}</div>${j.errorCode ? `<p class="error">${escapeHtml(t(j.errorCode))}</p><details><summary>${t("jobDetails")}</summary><pre class="joblog">${escapeHtml(j.message)}</pre></details>` : ""}</div>`,
    )
    .join("");
  for (const b of el.querySelectorAll("[data-stop]"))
    b.onclick = () =>
      api("jobs.cancel", { jobId: b.dataset.stop }).catch((e) => toast(t(e.message)));
}
function renderProposals() {
  const el = document.querySelector("#proposals");
  if (!el) return;
  el.innerHTML = doc.proposals
    .map(
      (p) =>
        `<div class="proposal"><h3>${t("proposals")}</h3><p>${escapeHtml(p.summary)}</p><button data-review="${p.id}">${t("review")}</button></div>`,
    )
    .join("");
  for (const b of el.querySelectorAll("[data-review]"))
    b.onclick = () => showProposal(b.dataset.review);
}
function showDialog(html) {
  dialog.innerHTML = `<div class="row spread"><h2>Scribe</h2>${button("dialog-close", "close")}</div>${html}`;
  if (!dialog.open) dialog.showModal();
  on("dialog-close", () => dialog.close());
}
function showProposal(id) {
  refreshDialog = () => showProposal(id);
  const p = doc.proposals.find((p) => p.id === id);
  showDialog(
    `<p>${escapeHtml(p.summary)}</p><div class="compare"><div><label>${t("before")}</label><textarea readonly>${escapeHtml(latest().tex)}</textarea></div><div><label>${t("after")}</label><textarea readonly>${escapeHtml(p.tex)}</textarea></div></div><details><summary>${t("bibliography")}</summary><pre class="joblog">${escapeHtml(p.bib)}</pre></details><div class="row">${button("apply", "apply", true)}${button("discard", "discard")}</div>`,
  );
  on("apply", async () => {
    if (dirty) {
      toast(t("unsaved"));
      return;
    }
    doc = await api("proposal.apply", { documentId: doc.id, proposalId: id }, true);
    draftTex = latest().tex;
    draftBib = latest().bib;
    pdfStale = true;
    dialog.close();
    render();
  });
  on("discard", async () => {
    doc = await api("proposal.discard", { documentId: doc.id, proposalId: id }, true);
    dialog.close();
    render();
  });
}
function showHistory() {
  refreshDialog = showHistory;
  showDialog(
    doc.revisions
      .slice()
      .reverse()
      .map(
        (r) =>
          `<div class="activity row spread"><div><strong>${escapeHtml(r.summary)}</strong><p class="muted">${new Date(r.at).toLocaleString(locale)}</p></div><button data-restore="${r.id}">${t("restore")}</button></div>`,
      )
      .join(""),
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
    `<label class="field">${t("title")}<input id="setting-title" value="${escapeHtml(doc.title)}"></label><label class="field">${t("model")}<select id="setting-model">${modelOptions(doc.model)}</select></label><label class="field">${t("language")}<select id="setting-language">${["en", "es"].map((l) => `<option value="${l}" ${doc.language === l ? "selected" : ""}>${t(l)}</option>`).join("")}</select></label><div class="row">${button("settings-save", "save", true)}${button("project-export", "exportProject")}${button("archive", doc.archived ? "unarchive" : "archive")}</div>`,
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
  on("project-export", async () => {
    const project = await api("projects.export", { documentId: doc.id });
    downloadBlob(
      new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }),
      "document.scribe.json",
    );
  });
  const sourceButton = document.createElement("button");
  sourceButton.textContent = t("exportSources");
  sourceButton.onclick = async () => {
    try {
      const zip = await api("sources.export", { documentId: doc.id });
      downloadBlob(blobFromBase64(zip.base64, "application/zip"), "latex-project.zip");
    } catch (e) {
      toast(t(e.message));
    }
  };
  dialog.append(sourceButton);
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
function renderPdf() {
  const status = document.querySelector("#pdf-status");
  if (status)
    status.innerHTML = pdfBlob
      ? `<div class="${pdfStale ? "warning" : "notice"}">${t(pdfStale ? "stale" : "currentPdf")}</div>`
      : "";
  const holder = document.querySelector("#pdf-holder");
  if (!holder) return;
  if (pdfBlob) {
    if (globalThis.scribeRenderPdf) void globalThis.scribeRenderPdf(holder, pdfBlob);
    else holder.textContent = t("download");
  } else
    holder.innerHTML = `<div class="empty"><h3>${t("noPdf")}</h3><p>${t("compilerHint")}</p></div>`;
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
  if (!context.capabilities.write) toast(t("readOnly"));
  setInterval(poll, 1500);
} catch (e) {
  if (!unavailable)
    root.innerHTML = `<main class="shell"><h1>Scribe</h1><p>${escapeHtml(t(e.message))}</p><p>${t("reconnect")}</p></main>`;
}
