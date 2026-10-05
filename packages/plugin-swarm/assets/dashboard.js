"use strict";
/* Swarm dashboard: a follow-up view of the work running in this workspace. Work is started and
   managed from the Alisio chat with /swarm:* commands; this page shows it live and offers the
   decisions that are easier with visual evidence (approve, reject, answer, retry, delete).
   Vanilla JavaScript, no framework. Agent and task text is always written with textContent. */
(function () {
  var TOKEN = (document.querySelector('meta[name="swarm-token"]') || {}).content || "";
  var POLL_MS = 2000;
  var STATUSES = ["queued", "working", "merging", "waiting_approval", "clarifying", "blocked", "rejected", "done"];
  var state = null;
  var lastStateJson = "";
  var seenAttention = null;
  var paused = false;
  var filters = { project: "", role: "", status: "" };
  var docsContext = null;
  var docsData = null;
  var sideBySide = true;
  var tailContext = null;
  var tailSession = "";
  var tailTimer = null;
  var appliedHash = null;

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, props, children) {
    var node = document.createElement(tag);
    var key;
    props = props || {};
    for (key in props) {
      if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
      var value = props[key];
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function store(key, value) {
    try {
      if (value === undefined) return window.localStorage.getItem(key);
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* storage can be blocked: the dashboard works without it */
    }
    return null;
  }

  /* ---- API ---- */

  function api(method, path, body) {
    var options = { method: method, headers: { "x-swarm-token": TOKEN }, credentials: "same-origin" };
    if (body !== undefined) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (response) {
      return response.text().then(function (text) {
        var json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (e) {
          json = null;
        }
        if (!response.ok) {
          throw new Error((json && json.error) || "Request failed (" + response.status + ")");
        }
        return json;
      });
    });
  }

  var noticeTimer = null;
  function notify(message) {
    var node = $("notice");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () {
      node.hidden = true;
    }, 6000);
  }

  function act(promise, onError) {
    return promise.then(function () { return refresh(true); }, function (error) {
      if (onError) onError(error);
      else notify(error.message);
      return refresh(true);
    });
  }

  function copy(text, label) {
    var done = function () { notify("Copied " + label + ": " + text); };
    var fallback = function () {
      var area = el("textarea", { "aria-hidden": "true", style: "position:fixed;left:-999px" });
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand("copy");
        done();
      } catch (e) {
        notify("Copy is not available here. Select this: " + text);
      }
      area.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  /* ---- formatting and commands ---- */

  function age(seconds) {
    if (seconds === undefined || seconds === null) return "";
    if (seconds < 60) return seconds + "s";
    if (seconds < 3600) return Math.round(seconds / 60) + "m";
    if (seconds < 86400) return Math.round(seconds / 3600) + "h";
    return Math.round(seconds / 86400) + "d";
  }

  function clock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toTimeString().slice(0, 8);
  }

  var KIND_LABEL = {
    approval: "Approval",
    clarification: "Clarification",
    blocked: "Blocked",
    "gate-failed": "Gate failed",
    decision: "Decision",
  };

  /* The chat command that does the same as the page, so the user can continue in Alisio. */
  function commandFor(kind, project, task, status) {
    var ref = project + "/" + task;
    if (kind === "approval" || status === "waiting_approval") return "/swarm:approve " + ref;
    if (kind === "clarification" || status === "clarifying") return "/swarm:answer " + ref + " -- ";
    if (kind === "blocked" || kind === "gate-failed" || status === "blocked" || status === "rejected") {
      return "/swarm:task " + project + " retry " + task;
    }
    if (kind === "decision") return "/swarm:budget raise ";
    return "/swarm:status " + project;
  }

  function copyButton(command, label) {
    return el("button", {
      type: "button",
      class: "btn small",
      text: label || "Copy command",
      title: "Copy: " + command,
      "aria-label": "Copy the command " + command,
      onclick: function () { copy(command, "command"); },
    });
  }

  /* ---- dialogs ---- */

  function openDialog(id) {
    var dialog = $(id);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return dialog;
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function wireDialogs() {
    Array.prototype.forEach.call(document.querySelectorAll("dialog"), function (dialog) {
      dialog.addEventListener("click", function (event) {
        var target = event.target;
        if (target === dialog) closeDialog(dialog);
        if (target && target.hasAttribute && target.hasAttribute("data-close")) closeDialog(dialog);
      });
      dialog.addEventListener("close", function () {
        if (dialog.id === "dlg-tail") stopTail();
        if (dialog.id === "dlg-docs") { docsContext = null; docsData = null; }
      });
    });
  }

  /* ---- theme: system by default, explicit light or dark on request ---- */

  var THEMES = ["system", "light", "dark"];
  function applyTheme(choice) {
    var root = document.documentElement;
    if (choice === "light" || choice === "dark") root.setAttribute("data-theme", choice);
    else root.removeAttribute("data-theme");
    var button = $("theme-btn");
    if (button) button.textContent = "Theme: " + choice;
  }

  /* ---- title, favicon, top bar ---- */

  function setBadge(count) {
    document.title = count > 0 ? "(" + count + ") Swarm" : "Swarm";
    var svg =
      count > 0
        ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#c0392b"/><text x="16" y="22" font-size="18" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">' +
          (count > 9 ? "9+" : String(count)) +
          "</text></svg>"
        : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="#2d5a3d"/></svg>';
    $("favicon").setAttribute("href", "data:image/svg+xml," + encodeURIComponent(svg));
  }

  function renderTopbar() {
    var running = ((state && state.projects) || []).filter(function (p) { return p.running; }).length;
    $("live-chip").querySelector(".dot").className = "dot " + (paused ? "idle" : running > 0 ? "live" : "idle");
    $("live-text").textContent = paused
      ? "paused"
      : "live · " + running + (running === 1 ? " project running" : " projects running");
    var needs = ((state && state.attention) || []).length;
    var chip = $("decision-chip");
    chip.hidden = needs === 0;
    chip.textContent = needs + (needs === 1 ? " needs your decision" : " need your decision");
    setBadge(needs);
    var budget = $("budget-chip");
    if (state && state.budget && state.budget.limit !== undefined && state.budget.limit !== null) {
      budget.hidden = false;
      budget.textContent =
        "tokens " + state.budget.total + " / " + state.budget.limit + (state.budget.exceeded ? " (cap reached)" : "");
    } else {
      budget.hidden = true;
    }
  }

  /* ---- filters ---- */

  function fillSelect(id, values, current) {
    var select = $(id);
    var signature = values.join("|");
    if (select.getAttribute("data-sig") !== signature) {
      select.setAttribute("data-sig", signature);
      clear(select);
      select.appendChild(el("option", { value: "", text: "All" }));
      values.forEach(function (value) { select.appendChild(el("option", { value: value, text: value.replace(/_/g, " ") })); });
    }
    select.value = values.indexOf(current) === -1 ? "" : current;
  }

  function renderFilters() {
    var projects = ((state && state.projects) || []).filter(function (p) { return p.running; });
    var roles = [];
    projects.forEach(function (p) { p.roles.forEach(function (r) { if (roles.indexOf(r) === -1) roles.push(r); }); });
    fillSelect("filter-project", projects.map(function (p) { return p.name; }), filters.project);
    fillSelect("filter-role", roles, filters.role);
    fillSelect("filter-status", STATUSES, filters.status);
    filters.project = $("filter-project").value;
    filters.role = $("filter-role").value;
    filters.status = $("filter-status").value;
  }

  function projectShown(name) {
    return !filters.project || filters.project === name;
  }

  function cardShown(card) {
    if (filters.role && card.lane !== filters.role) return false;
    if (filters.status && card.status !== filters.status) return false;
    return true;
  }

  /* ---- attention ---- */

  function attentionButtons(item) {
    var buttons = [];
    var ref = { project: item.project, task: item.task };
    var has = function (name) { return item.actions.indexOf(name) !== -1; };
    var button = function (label, handler, options) {
      options = options || {};
      return el("button", {
        type: "button",
        class: "btn small" + (options.primary ? " primary" : ""),
        text: label,
        disabled: options.disabled,
        title: options.title,
        onclick: handler,
      });
    };
    var budget = item.id.indexOf(":budget") !== -1;
    if (item.kind === "approval") {
      buttons.push(button("Documents", function () { openDocuments(ref); }));
      buttons.push(
        button("Approve", function () { act(api("POST", "/api/approvals/" + encodeURIComponent(item.id) + "/approve", {})); }, {
          primary: true,
          disabled: !has("approve"),
          title: has("approve") ? "" : "Resolve or clear the document comments first",
        }),
      );
      buttons.push(button("Reject", function () { openReject(item); }));
    } else if (item.kind === "clarification") {
      buttons.push(button("Answer", function () { openAnswer(item); }, { primary: true }));
    } else if (!budget) {
      if (has("retry")) buttons.push(button("Retry", function () { act(api("POST", "/api/tasks/retry", ref)); }, { primary: true }));
      if (has("delete")) {
        buttons.push(
          button("Delete", function () {
            if (window.confirm("Archive and delete " + item.project + "/" + item.task + "?")) {
              act(api("POST", "/api/tasks/delete", ref));
            }
          }),
        );
      }
    }
    buttons.push(copyButton(commandFor(item.kind, item.project, item.task, "")));
    return buttons;
  }

  function renderAttention() {
    var all = (state && state.attention) || [];
    var items = all.filter(function (item) { return projectShown(item.project); });
    var section = $("attention");
    var list = $("attention-list");
    clear(list);
    section.hidden = items.length === 0;
    items.forEach(function (item) {
      var budget = item.id.indexOf(":budget") !== -1;
      var children = [
        el("span", { class: "tag", "data-kind": item.kind, text: KIND_LABEL[item.kind] || item.kind }),
        budget
          ? el("strong", { text: item.project + " token budget" })
          : el("a", { class: "linkish", href: "#" + item.project + "/" + item.task, text: item.project + "/" + item.task }),
      ].concat(attentionButtons(item));
      if (item.detail) children.push(el("p", { class: "detail", text: item.detail }));
      if (budget) children.push(el("p", { class: "detail", text: "Raise the cap from the Alisio chat with /swarm:budget raise <tokens>." }));
      list.appendChild(el("li", {}, children));
    });
    var ids = all.map(function (item) { return item.id; });
    if (seenAttention !== null && $("chime").checked) {
      var fresh = ids.filter(function (id) { return seenAttention.indexOf(id) === -1; });
      if (fresh.length > 0) chime();
    }
    seenAttention = ids;
  }

  function chime() {
    try {
      var Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      var context = new Context();
      var osc = context.createOscillator();
      var gain = context.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.05;
      osc.connect(gain);
      gain.connect(context.destination);
      osc.start();
      osc.stop(context.currentTime + 0.18);
      osc.onended = function () { context.close(); };
    } catch (e) {
      /* a missing audio device must never break the dashboard */
    }
  }

  /* ---- board ---- */

  function renderCard(project, card) {
    var label = card.merging ? "Merging" : card.status.replace(/_/g, " ");
    var node = el(
      "article",
      { class: "card" + (card.merging ? " merging" : ""), "data-card": project.name + "/" + card.name, "data-status": card.status },
      [
        el("div", { class: "card-head" }, [
          el("a", { class: "card-name", href: "#" + project.name + "/" + card.name, text: card.name }),
          el("span", {
            class: "audits",
            text: "✓ " + card.auditCount,
            title: card.auditCount + " audit round(s)",
            "aria-label": card.auditCount + " audit rounds",
          }),
        ]),
        el("p", { class: "snippet", text: card.snippet }),
        el("div", { class: "card-foot" }, [
          el("span", { class: "badge", text: label }),
          copyButton(commandFor("", project.name, card.name, card.status), "Copy"),
        ]),
      ],
    );
    return node;
  }

  function emptyBoard(board) {
    board.appendChild(
      el("div", { class: "empty-state" }, [
        el("p", { text: "No project is running in this workspace yet." }),
        el("p", { text: "This page follows work live. Start it from the Alisio chat:" }),
        el("pre", { class: "plain", text: "/swarm:project new <name> -- <mission>\n/swarm:task <project> new -- <task text>" }),
        el("p", { class: "hint", text: "Closed projects are listed by /swarm:project list; open one with /swarm:project open <name>." }),
      ]),
    );
  }

  function renderBoard() {
    var board = $("board");
    var scroll = board.scrollTop;
    clear(board);
    if (!state) return;
    if (!state.initialised) {
      board.appendChild(el("p", { class: "empty-state", text: "The swarm forge is not initialised. Run /swarm:init in your Alisio session." }));
      return;
    }
    var running = state.projects.filter(function (p) { return p.running; });
    if (running.length === 0) return emptyBoard(board);
    var shown = running.filter(function (p) { return projectShown(p.name); });
    if (shown.length === 0) {
      board.appendChild(el("p", { class: "empty-state", text: "No running project matches the filter." }));
      return;
    }
    shown.forEach(function (project) {
      var columns = project.columns
        .filter(function (column) { return !filters.role || column === filters.role; })
        .map(function (column) {
          var cards = project.tasks.filter(function (task) {
            if (!cardShown(task)) return false;
            return task.status === "done" ? column === "done" : task.lane === column;
          });
          return el("section", { class: "column", "aria-label": column + " column" }, [
            el("h4", { text: column.toUpperCase() }),
            el("div", { class: "dropzone" }, cards.map(function (card) { return renderCard(project, card); })),
          ]);
        });
      board.appendChild(
        el("section", { class: "band", "aria-label": project.name, "data-band": project.name }, [
          el("div", { class: "band-head" }, [
            el("h3", {}, [
              el("a", { class: "linkish", href: "#" + project.name, text: project.name }),
              " ",
              el("span", { class: "hint", text: project.pack }),
            ]),
            el("button", { type: "button", class: "btn small", text: "Mission", onclick: function () { showMission(project.name); } }),
          ]),
          el("div", { class: "columns" }, columns),
        ]),
      );
    });
    board.scrollTop = scroll;
  }

  /* ---- work queue and activity ---- */

  function meter(value) {
    var bars = [];
    for (var i = 0; i < 6; i += 1) bars.push(el("i", { class: i < value ? "on" : "" }));
    return el("span", { class: "meter", role: "img", "aria-label": "activity " + value + " of 6" }, bars);
  }

  function renderQueue() {
    var queue = $("queue");
    var scroll = queue.scrollTop;
    clear(queue);
    var running = ((state && state.projects) || []).filter(function (p) { return p.running && projectShown(p.name); });
    if (running.length === 0) {
      queue.appendChild(el("p", { class: "empty-state", text: "Nothing is running." }));
      return;
    }
    running.forEach(function (project) {
      var rows = project.queue
        .filter(function (row) { return !filters.role || row.role === filters.role; })
        .map(function (row) {
          var side = [
            el("button", {
              type: "button",
              class: "linkish",
              text: row.role,
              title: "Show the " + row.role + " activity",
              onclick: function () { openTail(project.name, row.role); },
            }),
            el("div", {}, [meter(row.activity)]),
          ];
          if (row.sessionId) {
            side.push(
              el("div", { class: "session" }, [
                el("code", { text: row.sessionId, title: "Alisio session id" }),
                el("button", {
                  type: "button",
                  class: "btn small",
                  text: "Copy",
                  "aria-label": "Copy the Alisio session id of " + row.role,
                  onclick: function () { copy(row.sessionId, "session id"); },
                }),
              ]),
            );
          }
          return el("tr", {}, [
            el("td", {}, row.task ? [el("a", { href: "#" + project.name + "/" + row.task, text: row.task })] : []),
            el("td", {}, [
              el("div", { class: "role-cell" }, [
                el("span", { class: "dot " + row.state, title: row.state, "aria-hidden": "true" }),
                el("span", { class: "sr-only", text: row.state }),
                el("div", {}, side),
              ]),
            ]),
            el("td", { class: "age", text: age(row.ageSeconds) }),
          ]);
        });
      queue.appendChild(el("h3", { text: project.name }));
      queue.appendChild(
        el("table", {}, [
          el("thead", {}, [el("tr", {}, [el("th", { scope: "col", text: "Task" }), el("th", { scope: "col", text: "Role" }), el("th", { scope: "col", text: "Age" })])]),
          el("tbody", {}, rows),
        ]),
      );
    });
    queue.scrollTop = scroll;
  }

  function atBottom(node) {
    return node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  }

  function renderActivity() {
    var log = $("activity-log");
    var stick = atBottom(log);
    clear(log);
    var entries = ((state && state.activity) || []).filter(function (entry) {
      return projectShown(entry.project) && (!filters.role || entry.role === filters.role);
    });
    if (entries.length === 0) log.appendChild(el("li", { class: "hint", text: "No activity yet." }));
    entries.forEach(function (entry) {
      log.appendChild(
        el("li", {}, [
          el("span", { class: "time", text: clock(entry.at) }),
          el("span", { class: "kind", text: entry.kind }),
          el("a", { href: "#" + entry.project + "/" + entry.task, text: entry.project + "/" + entry.task }),
          " ",
          el("span", { class: "hint", text: entry.role }),
          el("div", { text: entry.message }),
        ]),
      );
    });
    if (stick) log.scrollTop = log.scrollHeight;
  }

  /* ---- deep links ---- */

  function applyHash(force) {
    var hash = decodeURIComponent((window.location.hash || "").slice(1));
    if (!hash || (hash === appliedHash && !force)) return;
    var node = document.querySelector('[data-card="' + hash + '"]') || document.querySelector('[data-band="' + hash + '"]');
    if (!node) return;
    appliedHash = hash;
    Array.prototype.forEach.call(document.querySelectorAll(".linked"), function (old) { old.classList.remove("linked"); });
    node.classList.add("linked");
    node.scrollIntoView({ block: "center", inline: "nearest" });
    node.setAttribute("tabindex", "-1");
    node.focus({ preventScroll: true });
  }

  /* ---- decision dialogs ---- */

  var rejectItem = null;
  function openReject(item) {
    rejectItem = item;
    $("form-reject").reset();
    $("reject-error").textContent = "";
    $("reject-target").textContent = item.project + "/" + item.task;
    openDialog("dlg-reject");
  }

  function submitReject(event) {
    event.preventDefault();
    var action = (document.querySelector('input[name="reject-action"]:checked') || {}).value;
    var body = { action: action };
    var comments = $("reject-comments").value.trim();
    if (comments) body.comments = comments;
    api("POST", "/api/approvals/" + encodeURIComponent(rejectItem.id || "approval:" + rejectItem.project + ":" + rejectItem.task) + "/reject", body).then(
      function () {
        closeDialog($("dlg-reject"));
        closeDialog($("dlg-docs"));
        return refresh(true);
      },
      function (failure) { $("reject-error").textContent = failure.message; },
    );
  }

  var promptHandler = null;
  function openAnswer(item) {
    $("dlg-prompt-title").textContent = "Answer";
    $("prompt-detail").textContent = item.detail || "The role asked for clarification.";
    $("prompt-label").textContent = "Your answer";
    $("prompt-ok").textContent = "Send answer";
    $("prompt-text").value = "";
    $("prompt-error").textContent = "";
    promptHandler = function (text) {
      return api("POST", "/api/clarifications/" + encodeURIComponent(item.id) + "/answer", { text: text });
    };
    openDialog("dlg-prompt");
    $("prompt-text").focus();
  }

  function submitPrompt(event) {
    event.preventDefault();
    var text = $("prompt-text").value.trim();
    if (!text) {
      $("prompt-error").textContent = "Enter an answer.";
      return;
    }
    promptHandler(text).then(
      function () {
        closeDialog($("dlg-prompt"));
        return refresh(true);
      },
      function (failure) { $("prompt-error").textContent = failure.message; },
    );
  }

  function showMission(project) {
    $("dlg-info-title").textContent = project + ": mission";
    $("info-text").textContent = "Loading...";
    openDialog("dlg-info");
    api("GET", "/api/mission?project=" + encodeURIComponent(project)).then(
      function (data) { $("info-text").textContent = data.mission || "(no mission recorded)"; },
      function (error) { $("info-text").textContent = error.message; },
    );
  }

  /* ---- documents and diff ---- */

  function diffRows(diff) {
    var rows = [];
    var left = [];
    var right = [];
    var flush = function () {
      var n = Math.max(left.length, right.length);
      for (var i = 0; i < n; i += 1) rows.push({ l: left[i], r: right[i] });
      left = [];
      right = [];
    };
    diff.split("\n").forEach(function (line) {
      if (/^(diff |index |--- |\+\+\+ |@@|new file|deleted file|similarity|rename)/.test(line)) {
        flush();
        rows.push({ head: line });
      } else if (line.charAt(0) === "+") right.push(line.slice(1));
      else if (line.charAt(0) === "-") left.push(line.slice(1));
      else {
        flush();
        var text = line.charAt(0) === " " ? line.slice(1) : line;
        rows.push({ c: text });
      }
    });
    flush();
    return rows;
  }

  function renderDiff(diff) {
    var host = $("docs-diff");
    clear(host);
    if (!diff) {
      host.appendChild(el("p", { class: "hint", text: "No changes between the base and the held commit." }));
      return;
    }
    if (!sideBySide) {
      var pre = el("pre", { class: "plain" });
      diff.split("\n").forEach(function (line) {
        var kind = line.charAt(0) === "+" && line.slice(0, 3) !== "+++" ? "add" : line.charAt(0) === "-" && line.slice(0, 3) !== "---" ? "del" : /^(diff|@@|\+\+\+|---)/.test(line) ? "hunk" : "";
        pre.appendChild(el("span", { class: kind, text: line + "\n" }));
      });
      host.appendChild(pre);
      return;
    }
    var rows = diffRows(diff).map(function (row) {
      if (row.head !== undefined) return el("tr", { class: "hunk-row" }, [el("td", { colspan: "2", text: row.head })]);
      if (row.c !== undefined) return el("tr", {}, [el("td", { text: row.c }), el("td", { text: row.c })]);
      return el("tr", {}, [
        el("td", { class: row.l !== undefined ? "del" : "blank", text: row.l !== undefined ? "- " + row.l : "" }),
        el("td", { class: row.r !== undefined ? "add" : "blank", text: row.r !== undefined ? "+ " + row.r : "" }),
      ]);
    });
    host.appendChild(
      el("table", { class: "sbs" }, [
        el("thead", {}, [el("tr", {}, [el("th", { scope: "col", text: "Before (base)" }), el("th", { scope: "col", text: "After (held commit)" })])]),
        el("tbody", {}, rows),
      ]),
    );
  }

  function approvalPath(ref, action) {
    return "/api/approvals/" + encodeURIComponent("approval:" + ref.project + ":" + ref.task) + "/" + action;
  }

  function renderDocs(data) {
    docsData = data;
    var ref = docsContext;
    $("docs-meta").textContent =
      data.project + "/" + data.task + " · held commit " + data.commit + " · gate role " + data.role + (data.base ? " · base " + data.base : "");
    var list = $("docs-list");
    clear(list);
    if (data.docs.length === 0) list.appendChild(el("p", { class: "hint", text: "No task documents were found in this change." }));
    data.docs.forEach(function (doc) {
      var comments = doc.comments.map(function (comment) { return el("li", { text: comment.text }); });
      var input = el("textarea", { rows: "2", maxlength: "4000", "aria-label": "Comment on " + doc.path });
      var add = el("button", {
        type: "button",
        class: "btn small",
        text: "Add comment",
        onclick: function () {
          var text = input.value.trim();
          if (!text) return;
          api("POST", approvalPath(ref, "comments"), { doc: doc.path, text: text }).then(
            function () { return reloadDocs(); },
            function (error) { $("docs-error").textContent = error.message; },
          );
        },
      });
      list.appendChild(
        el("section", { class: "doc" }, [
          el("h3", { text: doc.path + (doc.truncated ? " (truncated)" : "") }),
          el("pre", { class: "doc-text", tabindex: "0", text: doc.text }),
          comments.length ? el("ul", { class: "comments", "aria-label": "Comments on " + doc.path }, comments) : null,
          el("div", { class: "comment-form" }, [input, add]),
        ]),
      );
    });
    renderDiff(data.diff + (data.diffTruncated ? "\n(diff truncated)" : ""));
    $("docs-approve").disabled = !data.approvable;
    $("docs-approve").title = data.approvable ? "" : "Resolve or clear the comments first";
    $("docs-clear").disabled = data.comments.length === 0;
  }

  function reloadDocs() {
    var ref = docsContext;
    if (!ref) return Promise.resolve();
    return api("GET", "/api/doc?project=" + encodeURIComponent(ref.project) + "&task=" + encodeURIComponent(ref.task)).then(
      renderDocs,
      function (error) { $("docs-error").textContent = error.message; },
    );
  }

  function openDocuments(ref) {
    docsContext = ref;
    $("docs-error").textContent = "";
    $("docs-meta").textContent = "Loading...";
    clear($("docs-list"));
    clear($("docs-diff"));
    openDialog("dlg-docs");
    reloadDocs();
  }

  /* ---- agent tail ---- */

  function stopTail() {
    clearInterval(tailTimer);
    tailTimer = null;
    tailContext = null;
  }

  function loadTail() {
    var ctx = tailContext;
    if (!ctx || paused) return;
    api("GET", "/api/agents/" + encodeURIComponent(ctx.role) + "/tail?project=" + encodeURIComponent(ctx.project)).then(
      function (data) {
        tailSession = data.sessionId || "";
        $("tail-meta").textContent = "state: " + data.state + (data.sessionId ? " · session " + data.sessionId : " · no session yet");
        $("tail-copy").hidden = !data.sessionId;
        var log = $("tail-log");
        var stick = atBottom(log);
        clear(log);
        if (data.tail.length === 0) log.appendChild(el("li", { text: "No recorded activity yet." }));
        data.tail.forEach(function (entry) {
          log.appendChild(
            el("li", {}, [el("span", { class: "kind", text: entry.kind === "prompt" ? "Prompt" : "Reply" }), el("span", { class: "hint", text: entry.at }), el("div", { text: entry.text })]),
          );
        });
        if (stick) log.scrollTop = log.scrollHeight;
      },
      function (error) { $("tail-meta").textContent = error.message; },
    );
  }

  function openTail(project, role) {
    tailContext = { project: project, role: role };
    tailSession = "";
    $("dlg-tail-title").textContent = project + " / " + role + " (Alisio session)";
    $("tail-meta").textContent = "Loading...";
    $("tail-copy").hidden = true;
    clear($("tail-log"));
    openDialog("dlg-tail");
    loadTail();
    clearInterval(tailTimer);
    tailTimer = setInterval(loadTail, POLL_MS);
  }

  /* ---- splitters ---- */

  function drag(handle, onMove) {
    handle.addEventListener("pointerdown", function (event) {
      handle.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
      var move = function (e) { onMove(e); };
      var up = function () {
        handle.classList.remove("dragging");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function setRail(width) {
    var value = clamp(width, 240, Math.max(260, window.innerWidth - 320));
    document.documentElement.style.setProperty("--swarm-rail-width", value + "px");
    store("swarm.rail", String(value));
  }

  function setQueue(percent) {
    var value = clamp(percent, 15, 85);
    document.documentElement.style.setProperty("--swarm-queue-height", value + "%");
    store("swarm.queue", String(value));
  }

  function wireSplitters() {
    var savedRail = Number(store("swarm.rail"));
    var savedQueue = Number(store("swarm.queue"));
    if (savedRail) setRail(savedRail);
    if (savedQueue) setQueue(savedQueue);
    drag($("split-v"), function (event) { setRail(window.innerWidth - event.clientX); });
    drag($("split-h"), function (event) {
      var rect = $("rail").getBoundingClientRect();
      setQueue(((event.clientY - rect.top) / rect.height) * 100);
    });
    $("split-v").addEventListener("keydown", function (event) {
      var current = $("rail").getBoundingClientRect().width;
      if (event.key === "ArrowLeft") { setRail(current + 20); event.preventDefault(); }
      if (event.key === "ArrowRight") { setRail(current - 20); event.preventDefault(); }
    });
    $("split-h").addEventListener("keydown", function (event) {
      var rail = $("rail").getBoundingClientRect();
      var current = ($("queue-pane").getBoundingClientRect().height / rail.height) * 100;
      if (event.key === "ArrowUp") { setQueue(current - 4); event.preventDefault(); }
      if (event.key === "ArrowDown") { setQueue(current + 4); event.preventDefault(); }
    });
  }

  /* ---- polling ---- */

  var timer = null;
  var failures = 0;

  function render() {
    renderFilters();
    renderTopbar();
    renderAttention();
    renderBoard();
    renderQueue();
    renderActivity();
    applyHash(false);
  }

  function refresh(force) {
    if (paused && force !== true) return Promise.resolve();
    return api("GET", "/api/state").then(
      function (next) {
        failures = 0;
        var json = JSON.stringify(next);
        if (json === lastStateJson) return;
        lastStateJson = json;
        state = next;
        render();
      },
      function (error) {
        failures += 1;
        if (failures >= 2) {
          $("live-text").textContent = "offline";
          $("live-chip").querySelector(".dot").className = "dot none";
          if (failures === 2) notify("Lost contact with the dashboard server: " + error.message);
        }
      },
    );
  }

  function setPaused(value) {
    paused = value;
    $("pause-btn").setAttribute("aria-pressed", String(paused));
    $("pause-btn").textContent = paused ? "Resume refresh" : "Pause refresh";
    if (state) renderTopbar();
    if (!paused) refresh(true);
  }

  function init() {
    var theme = store("swarm.theme");
    applyTheme(THEMES.indexOf(theme) === -1 ? "system" : theme);
    $("theme-btn").addEventListener("click", function () {
      var current = store("swarm.theme");
      var next = THEMES[(Math.max(0, THEMES.indexOf(current)) + 1) % THEMES.length];
      store("swarm.theme", next);
      applyTheme(next);
    });
    wireDialogs();
    wireSplitters();
    $("chime").checked = store("swarm.chime") === "1";
    $("chime").addEventListener("change", function () { store("swarm.chime", $("chime").checked ? "1" : "0"); });
    $("pause-btn").addEventListener("click", function () { setPaused(!paused); });
    ["project", "role", "status"].forEach(function (name) {
      $("filter-" + name).addEventListener("change", function () {
        filters[name] = $("filter-" + name).value;
        if (state) render();
      });
    });
    $("filter-clear").addEventListener("click", function () {
      filters = { project: "", role: "", status: "" };
      if (state) render();
    });
    $("diff-mode").addEventListener("click", function () {
      sideBySide = !sideBySide;
      $("diff-mode").setAttribute("aria-pressed", String(sideBySide));
      $("diff-mode").textContent = sideBySide ? "Side by side" : "Unified";
      if (docsData) renderDiff(docsData.diff + (docsData.diffTruncated ? "\n(diff truncated)" : ""));
    });
    window.addEventListener("hashchange", function () { applyHash(true); });
    $("form-reject").addEventListener("submit", submitReject);
    $("form-prompt").addEventListener("submit", submitPrompt);
    $("tail-copy").addEventListener("click", function () { if (tailSession) copy(tailSession, "session id"); });
    $("docs-copy").addEventListener("click", function () {
      var ref = docsContext;
      if (ref) copy("/swarm:approve " + ref.project + "/" + ref.task, "command");
    });
    $("docs-approve").addEventListener("click", function () {
      var ref = docsContext;
      if (!ref) return;
      api("POST", approvalPath(ref, "approve"), {}).then(
        function () { closeDialog($("dlg-docs")); return refresh(true); },
        function (error) { $("docs-error").textContent = error.message; },
      );
    });
    $("docs-reject").addEventListener("click", function () {
      var ref = docsContext;
      if (ref) openReject({ project: ref.project, task: ref.task });
    });
    $("docs-clear").addEventListener("click", function () {
      var ref = docsContext;
      if (!ref) return;
      api("POST", approvalPath(ref, "comments"), { clear: true }).then(
        function () { return reloadDocs().then(function () { return refresh(true); }); },
        function (error) { $("docs-error").textContent = error.message; },
      );
    });
    refresh(true);
    timer = setInterval(refresh, POLL_MS);
  }

  init();
})();
