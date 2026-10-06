"use strict";
// Review dashboard: vanilla JavaScript, no framework, no CDN. Everything is rendered with
// textContent, never innerHTML, and the page runs under a strict Content-Security-Policy.
(() => {
  const token = document.querySelector('meta[name="frontsmith-token"]')?.content ?? "";
  const $ = (id) => document.getElementById(id);
  const MARKS = { PASS: "✓", FAIL: "✗", REVIEW: "?", BLOCKED: "■", SKIPPED: "-" };
  let selected = decodeURIComponent(location.hash.slice(1));

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
  }

  const badge = (verdict) =>
    el("span", { class: `badge ${String(verdict).toLowerCase()}` }, `${MARKS[verdict] ?? ""} ${verdict}`);

  function notice(text) {
    $("notice").textContent = text;
  }

  async function api(path, body) {
    const init = body === undefined
      ? { headers: { "x-frontsmith-token": token } }
      : {
          method: "POST",
          headers: { "x-frontsmith-token": token, "content-type": "application/json" },
          body: JSON.stringify(body),
        };
    const response = await fetch(`/api/${path}`, init);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  }

  function table(headers, rows) {
    const head = el("tr", {}, ...headers.map((h) => el("th", { scope: "col" }, h)));
    const body = rows.map((cells) =>
      el("tr", {}, ...cells.map((c) => el("td", {}, c instanceof Node ? c : String(c)))),
    );
    return el("table", {}, el("thead", {}, head), el("tbody", {}, ...body));
  }

  function confirmDialog(title, text, withComments) {
    const dialog = $("confirm");
    $("confirm-title").textContent = title;
    $("confirm-text").textContent = text;
    $("comments").hidden = !withComments;
    $("comments-label").hidden = !withComments;
    $("comments").value = "";
    return new Promise((resolve) => {
      dialog.addEventListener(
        "close",
        () => resolve(dialog.returnValue === "ok" ? { comments: $("comments").value } : undefined),
        { once: true },
      );
      dialog.showModal();
    });
  }

  async function act(label, path, body) {
    try {
      const result = await api(path, body);
      notice(`${label}: ${result.message ?? "done"}${result.next ? ` Next: ${result.next.command}` : ""}`);
    } catch (error) {
      notice(`${label} failed: ${error.message}`);
    }
    await refresh();
  }

  async function renderFeatures() {
    const { features } = await api("state");
    $("features").replaceChildren(
      features.length === 0
        ? el("p", { class: "muted" }, "No features yet. Create one with /frontsmith:new.")
        : table(
            ["Feature", "Level", "Phase", "Gates", ""],
            features.map((f) => [
              f.feature,
              f.level,
              f.blocked ? `${f.phase} (blocked: ${f.blocked})` : f.running ? `${f.phase} (running)` : f.phase,
              el("span", {}, ...Object.entries(f.gates).flatMap(([id, v]) => [`${id} `, badge(v), " "])),
              el("button", { type: "button", onclick: () => select(f.feature) }, "Open"),
            ]),
          ),
    );
  }

  async function renderFeature() {
    const target = $("feature");
    if (!selected) return target.replaceChildren();
    let view;
    try {
      view = await api(`features/${encodeURIComponent(selected)}`);
    } catch (error) {
      target.replaceChildren(el("p", {}, `Cannot show ${selected}: ${error.message}`));
      return;
    }
    const { state } = view;
    const parts = [
      el("h3", {}, `${state.feature} (${state.level}, ${state.mode})`),
      el("p", {}, `Phase: ${state.phase}. Next command: `, el("code", {}, view.next.command)),
    ];
    const pending = /^\/frontsmith:approve \S+ (spec|ui-contract|plan|acceptance|review-signoff)$/.exec(view.next.command);
    if (pending && !view.readOnly) {
      const what = pending[1];
      const rejectable = what !== "review-signoff";
      parts.push(
        el(
          "div",
          { class: "row" },
          el("button", {
            type: "button",
            class: "primary",
            onclick: async () => {
              const ok = await confirmDialog(`Approve ${what}`, `Approve ${what} of ${state.feature}?`, false);
              if (ok) await act(`Approve ${what}`, `features/${state.feature}/approve`, { what });
            },
          }, `Approve ${what}`),
          ...(rejectable
            ? [el("button", {
                type: "button",
                onclick: async () => {
                  const ok = await confirmDialog(`Reject ${what}`, "Say what has to change.", true);
                  if (ok && ok.comments.trim() !== "")
                    await act(`Reject ${what}`, `features/${state.feature}/reject`, { what, comments: ok.comments });
                  else if (ok) notice("A rejection needs comments.");
                },
              }, `Reject ${what}`)]
            : []),
        ),
      );
    }
    const gates = Object.entries(state.gates);
    parts.push(
      el("h4", {}, "Gates"),
      gates.length === 0
        ? el("p", { class: "muted" }, "No gate has run yet.")
        : table(
            ["Gate", "Verdict", "Report"],
            gates.map(([id, gate]) => [
              id,
              badge(gate.verdict),
              view.reports.includes(id)
                ? el("button", { type: "button", onclick: () => showReport(id) }, "Show report")
                : "-",
            ]),
          ),
      el("div", { id: "report" }),
      el("h4", {}, "Tasks"),
      state.tasks.length === 0
        ? el("p", { class: "muted" }, "No tasks yet.")
        : table(["Task", "Layer", "Status", "Bounces"], state.tasks.map((t) => [t.id, t.layer, t.status, t.bounces])),
    );
    target.replaceChildren(...parts);
    renderFidelity(view);
  }

  async function showReport(gate) {
    try {
      const report = await api(`features/${encodeURIComponent(selected)}/reports/${gate}`);
      $("report").replaceChildren(el("pre", {}, JSON.stringify(report, null, 2)));
    } catch (error) {
      notice(`Cannot show ${gate}: ${error.message}`);
    }
  }

  function renderFidelity(view) {
    const body = $("fidelity-body");
    if (!view) return body.replaceChildren(el("p", { class: "muted" }, "Open a feature first."));
    const parts = [el("h3", {}, view.state.feature)];
    if (!view.evidence) parts.push(el("p", { class: "muted" }, "No fidelity run yet. Run /frontsmith:fidelity run."));
    else {
      parts.push(
        el("p", {}, `Run ${view.evidence.runId}: reference, actual and diff are drawn side by side in each composite.`),
        el(
          "div",
          { class: "images" },
          ...view.evidence.files.map((file) =>
            el("figure", {}, el("img", {
              src: `/api/features/${encodeURIComponent(view.state.feature)}/evidence/${view.evidence.runId}/${file}`,
              alt: `Fidelity evidence ${file}`,
            }), el("figcaption", {}, file)),
          ),
        ),
      );
    }
    const baselines = Object.entries(view.baselines);
    parts.push(
      el("h4", {}, "Baselines"),
      baselines.length === 0
        ? el("p", { class: "muted" }, "No baseline approved.")
        : table(["Case", "Browser", "OS", "Approved"], baselines.map(([id, b]) => [id, `${b.browser} ${b.browserVersion}`, b.os, b.approvedAt])),
    );
    if (view.evidence && !view.readOnly)
      parts.push(
        el("button", {
          type: "button",
          onclick: async () => {
            const ok = await confirmDialog("Approve baselines", "Copy the captures of the latest run as the approved baselines?", false);
            if (ok) await act("Approve baselines", `features/${view.state.feature}/baseline`, {});
          },
        }, "Approve baselines of the latest run"),
      );
    body.replaceChildren(...parts);
  }

  async function renderRules() {
    const { rules } = await api("rules");
    $("rules-body").replaceChildren(
      table(["Id", "Severity", "Kind", "Engine", "Pack", "Title"], rules.map((r) => [r.id, r.severity, r.kind, r.engine, r.pack, r.title])),
    );
  }

  async function refresh() {
    try {
      await renderFeatures();
      await renderFeature();
    } catch (error) {
      notice(`Cannot load the dashboard: ${error.message}`);
    }
  }

  function select(feature) {
    selected = feature;
    history.replaceState(null, "", `#${encodeURIComponent(feature)}`);
    refresh();
  }

  for (const button of document.querySelectorAll("nav button")) {
    button.addEventListener("click", () => {
      for (const other of document.querySelectorAll("nav button")) {
        other.setAttribute("aria-pressed", String(other === button));
        $(other.dataset.tab).hidden = other !== button;
      }
      if (button.dataset.tab === "rules") renderRules().catch((e) => notice(e.message));
    });
  }

  $("theme").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme === "dark" || (!root.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    root.dataset.theme = dark ? "light" : "dark";
  });

  refresh();
})();
