# Spec: `@alisio/plugin-swarm` v1 — a handoff-driven agent swarm harness for Alisio

- **Status:** draft for owner review. Phases 0 to 6 are implemented (see section 16). Not committed or published.
- **Package:** `@alisio/plugin-swarm`, plugin id `swarm`, directory `packages/plugin-swarm`, category `methodology-harness`.
- **Inspiration:** SwarmForge by Robert C. Martin (`unclebob/swarm-forge`, `main` branch) and a Spanish video review of it. This plugin is a clean-room reimplementation of the *ideas*; no upstream text or code is copied. Attribution goes in the README. The upstream licence was not found in the inspected checkout and must be confirmed in Phase 0 before any wording is reused.
- **Audience:** the implementer agent (Sonnet for code, Opus for decisions) and the owner.
- **Language policy:** this spec, all source, prompts, schemas, tests and package metadata are English. The repo-level README/site pairs (EN/ES) are updated with the plugin page. A bilingual package README is NOT assumed: it needs separate owner approval (AGENTS.md).
- **Out of scope for v1:** tmux, terminal-window management, driving external CLI agents (`claude`, `codex`, `copilot`, `grok`), the `platoon`/multi-squad idea, a native host UI tab (no such API exists), Windows-specific handling beyond "must not crash".

## 1. Goal and non-goals

### 1.1 Goal

Let an Alisio user run a **pipeline of specialised agents**, each working in its **own git worktree**, that exchange **committed work through durable handoffs**, with deterministic quality gates and a **local dashboard** to start work, watch agents, approve, answer clarifications, and stop everything. This reproduces the documented SwarmForge feature set:

| SwarmForge feature | v1 equivalent |
|---|---|
| Packs (two / four / six-pack) | Pack definitions (data), shipped + workspace-local |
| Forge with multiple projects, New / Open / Close / Teardown | Same, under `.alisio/swarm/` |
| One git worktree per role | Same, via `git` through `node:child_process` |
| One tmux session per agent | One Alisio **child session** per role (runner port; tmux is a future adapter) |
| File-based handoffs + daemon + two-call audit gate | File-based durable queue + in-process pump + two-pass audit |
| Approval gate after the specifier | Same, human gate in the dashboard and `/swarm:approve` |
| Clarifications (`clarify`/`answer`) | Child envelope `needs_clarification` + dashboard/command answer |
| Lieutenant (host chat agent) | Read-only Lieutenant child session behind the dashboard chat |
| Dashboard (swimlanes, Attention, Work Queue, Lieutenant chat) | Local web dashboard replicating that layout, plus TUI panel and text fallbacks |
| Engineering constitution (TDD, CRAP, mutation, DRY, Gherkin) | Role skills + deterministic gate runners |

### 1.2 Non-goals

- No LLM does orchestration. A **TypeScript coordinator** owns routing, state and gates; children return strict JSON envelopes that code validates (same pattern as Wayfinder/thesis).
- No promise that agents obey prompts: every rule that can be checked deterministically is checked by code (the video's key point: "build the verifier, don't just ask for TDD").
- No dependency on any other plugin or `@alisio/core`.

## 2. Verified current state

### 2.1 Sources inspected

- SwarmForge `main` branch (README, `handoff-protocol.md`, `swarmforge/scripts/*.bb`, `swarmforge/constitution/articles/*`, `roles/lieutenant.prompt`, `dashboard.html`, `project-swarm.jpg`). **The pack branches and every role prompt except the Lieutenant are absent from the checkout**, so the specifier/coder/cleaner/refactorer/architect/hardener/QA prompts below are **authored here** from the README role tables, the constitution articles and the video; they are not transcriptions.
- The transcript is a YouTuber's review, not a talk by Martin. Statements about Martin's intent are second-hand. Not stated anywhere: numeric thresholds for CRAP, mutation score and complexity; retries/rollback after QA rejection; merge conflicts between parallel roles. This spec therefore defines them explicitly (Section 8) and marks them as **our** decisions.

### 2.2 Alisio SDK facts the design depends on

SDK range `>=0.3.0 <0.7.0` (dev `0.3.0`), as in `packages/plugin-thesis/package.json`. Feature-detect `api.paths`, `api.views`, `api.options`.

| Need | API | Notes / constraint |
|---|---|---|
| Run an agent | `api.sessions.create/run/cancel/enqueue/workspace` | Only callable after startup (not in `setup()`); commands, tools, hooks only |
| Per-role isolation | `ChildSessionSpec.workspace`, `id?`, `tools`, `permission`, `readOnly`, `maxTurns`, `timeoutMs`, `maxOutputTokens`, `model` | A child can never exceed the parent's permissions; the user session must allow write + process |
| Children cannot call plugin tools | child `tools.allow` accepts built-in names only | **Hence all agent→coordinator communication is the final JSON envelope**, not a tool call |
| Git worktrees, dashboard server | `node:child_process`, `node:http` | No SDK git/exec/tmux API; no sandbox; plugin must clean up its own processes |
| Human decisions | `ui.askQuestions`, `ui.select` | Returns `undefined` when headless → every gate also has a command and a dashboard action |
| Rich output | `ToolResult` UI blocks (`table`, `mermaid`, `tree`, `progress`, `markdown`, `diff`) | Used for the text/TUI fallback of the board |
| TUI tree | `api.ui.panel(id, provider)` | Nobody in the repo uses it yet; fail-open |
| Web data | `api.views.register(...)` | Read-only JSON; no plugin tab exists. Registered as a forward-compatible data source only |
| State | `api.paths.state` (optional), workspace `.alisio/swarm/` | Atomic writer pattern from `packages/plugin-wayfinder/src/storage.ts` |
| Commands | return a single string; no abort, no progress | One unit per command; long work runs in the background pump |
| Cleanup | `dispose()` capped at 2 s, not run on `/reload` or SIGKILL | Pidfile + stale-process reaping (pattern: `packages/plugin-laya/src/runtime/supervisor.ts`) |
| Agents catalog | External agents are invisible to the subagents catalog in the same boot | Load `.agents/agents/*.md` ourselves (`loadRoleInstructions`), per AGENTS.md "same files for registration and child instructions" |

### 2.3 What does NOT exist (design-around)

1. **No UI tab / webview / dashboard API for plugins.** The requested "tab with the flow" is delivered as a **local web dashboard** served by the plugin on `127.0.0.1` and opened with `/swarm:dashboard` (returns the URL; also opens the browser when possible). Fallbacks: `ui.panel` tree, `/swarm:status` with UI blocks. If a host tab API appears, the same JSON state (`views` data source `swarm-board`) feeds it with no core change.
2. **No tmux/terminal API.** Agent "panes" are the child session transcript, shown in the dashboard as a live text tail. Observability replaces `tmux attach`.
3. **No plugin-controlled messaging between running children**: all routing goes through the coordinator and workspace files.
4. **Unverified (Phase 0 must settle):** how the host schedules many concurrent plugin-driven `sessions.run` calls against subagent limits (`maxConcurrentPerParent 4`, `maxConcurrentTotal 8`), whether a promise that outlives its command keeps running, and how child `permission: ask` behaves headless.

## 3. Architecture decisions

| ID | Decision | Rationale |
|---|---|---|
| AD-1 | Ports and adapters. Core domain is pure TypeScript with no `node:*` imports; adapters implement ports: `AgentRunner`, `Isolation`, `HandoffStore`, `BoardStore`, `GateRunner`, `Clock`, `Notifier`, `DashboardServer`. | User requires agnostic / independent / polymorphic design; testability with fakes |
| AD-2 | v1 `AgentRunner` adapter = Alisio child sessions. A `cli-tmux` adapter (spawn external CLIs in tmux) is a documented future adapter, not built. | Matches current capabilities; keeps the door open to SwarmForge's original topology |
| AD-3 | Coordinator is code. Children return envelopes validated by `parseEnvelope` (strict, schema-versioned). Invalid or `turnsExceeded` output is rejected, never "repaired". | Wayfinder precedent; agents cannot call plugin tools |
| AD-4 | Handoffs are **durable files** in the project, committed work travels by **git commit SHA**, delivery by an **in-process pump** (event-driven, with a 1 s safety tick) instead of a separate daemon. | Preserves SwarmForge's crash-recovery and auditability without a second process |
| AD-5 | The audit gate is a **two-pass handshake**: first `handoff` envelope is parked as `audit_pending`; the coordinator sends the audit challenge to the same child session (`run` again, context preserved); an unchanged second envelope releases it, a changed one restarts the challenge. Audit count is shown on the card (✓ N in the screenshot). | Reproduces upstream behaviour without tool calls |
| AD-6 | Every acceptance criterion that can be machine-checked is a **gate** run by code after the agent claims done (tests green, test file touched, coverage, CRAP, mutation, structure). Failing gates bounce the work back to the same role with the report. | The video's central lesson |
| AD-7 | Gate tooling is **toolchain-profile driven** (commands + output parsers declared as data), with built-in profiles for `node-ts` first; `go`, `java`, `python`, `clojure` profiles are data files the user can add in workspace. | Language-agnostic; avoids re-implementing coverage/mutation engines |
| AD-8 | Packs are **data** (`pack.json` + role prompt files), shipped (`two-pack`, `four-pack`, `six-pack`) and workspace-local under `.alisio/swarm/packs/`, same loader. | Polymorphism; mirrors upstream `swarmforge.conf` |
| AD-9 | Dashboard is a dependency-free static page + JSON API on `127.0.0.1` with a per-run random token, `Host`/`Origin` checks and no external network. | Localhost services are attackable via DNS rebinding / CSRF |
| AD-10 | All mutating dashboard actions call the same application services as the commands. One implementation, three front ends (dashboard, commands, TUI). | Avoids drift; headless parity |
| AD-11 | Persistence: JSON with `schemaVersion`, atomic write (`wx` tmp + `rename`, mode 0600), single-writer per file through an in-process mutex per project. No cross-file transactions: recovery replays from the handoff files (source of truth) and rebuilds the board. | SDK has no locking/transactions |
| AD-12 | Model selection per role is user-owned: `pluginOverrides.swarm.options.roles.<role>.model`; default inherits the session model. | Provider agnostic |

## 4. Domain model and contracts

### 4.1 Identifiers (validated everywhere, untrusted)

- `projectName`, `taskName`: `^[a-z0-9][a-z0-9-]{0,47}$` (task display text may be free-form; the slug is derived and collision-checked).
- `role`: `^[a-z][a-z0-9-]{0,23}$` (no `_`, no `/`).
- `taskId`: `YYYYMMDDTHHMMSSffffffZ-<slug>`.
- `commit`: exactly 10 lowercase hex characters (as upstream) and must resolve with `git cat-file -e`.
- Paths: always relative, contained under the project root (`assertRelativePath`), never following symlinks out.

### 4.2 Pack definition (`pack.json`)

```json
{
  "schemaVersion": 1,
  "name": "six-pack",
  "description": "...",
  "toolchain": "node-ts",
  "approval": { "after": "specifier" },
  "roles": [
    { "id": "specifier", "agent": "specifier", "isolation": "master", "receive": "task", "propagation": "forward-only" },
    { "id": "coder", "agent": "coder", "isolation": "worktree", "receive": "task", "propagation": "forward-only" }
  ],
  "gates": { "coder": ["tests-green", "test-first", "coverage"], "cleaner": ["crap", "dry"], "hardener": ["mutation"], "qa": ["acceptance"] }
}
```

Rules (ported from `parse-window-line` validation): file order is the forward pipeline; **exactly one** role has `isolation: "master"` (it works on the project's main checkout); `receive` is `task` (one handoff) or `batch` (all equal-priority handoffs as a unit); `propagation` is `forward-only | back-one | back-all` (extra merge-only copies headed `non-forwarding: true`). The **last role's** handoff is terminal: it is delivered merge-only to every other role and moves the card to Done.

Shipped packs (from the README): `two-pack` coder → cleaner; `four-pack` specifier → coder → refactorer → architect; `six-pack` specifier → coder → cleaner → architect → hardener → qa. In six-pack `architect` and `hardener` run **sequentially** by default; a pack may declare a `parallel` stage (`{ "parallel": ["architect","hardener"] }`) whose join is defined in 8.4 — this addresses the explicit ambiguity noted in the transcript review.

### 4.3 Handoff file

Path: `<project>/.alisio/swarm/handoffs/<NN>_<UTC>_<seq>_from_<sender>_to_<r1_r2>.handoff`, header block + blank line + generated body (same shape as upstream so it is human-readable):

```
id: <uuid>
from: <role>            to: <role[,role]>        priority: 50
type: git_handoff|note  task: <taskName>         task_id: <taskId>
commit: <10hex>         task_base_commit: <10hex>
approved: true|false    non-forwarding: true|false
created_at / enqueued_at / dequeued_at / completed_at: <ISO-8601>
```

Directories per role: `outbox/`, `sent/`, `failed/`, `inbox/{new,in_process,completed}`, `audit_pending/`, `pending_approval/`. `note` bodies are one line ≤ 80 chars and only sent when the pack says so. Reserved headers can never be set by an agent.

The generated body tells the receiver to merge the sender's commit (`git merge --no-edit <commit>` in its own worktree; no-op if already an ancestor). The **coordinator performs the merge itself** with argv-array `git`, then tells the child to continue; merge conflicts are handed to the receiving role as a task ("resolve conflicts, keep tests green").

### 4.4 Child output envelopes (strict JSON, `schemaVersion: 1`)

```
{ "kind": "handoff",       "commit": "<10hex>", "summary": "...", "evidence": [ { "requirement": "...", "proof": "..." } ] }
{ "kind": "needs_clarification", "question": "..." }
{ "kind": "blocked",       "reason": "..." }
{ "kind": "note",          "message": "<=80 chars" }
```

Everything else, malformed JSON, extra keys, or `turnsExceeded: true` ⇒ run rejected, state preserved, surfaced as **Needs your decision** (retry / delete / accept-unchanged), never auto-retried more than once.

### 4.5 Board and task state

`board/tasks.json` (`schemaVersion: 1`): `{ name, taskId, lane, createdAt, updatedAt, auditCount, status }`, with `status ∈ queued | working | waiting_approval | rejected | merging | clarifying | blocked | done`. The task body is also committed as `tasks/<name>.md` (`# name` + text) by the master role, as upstream does. Lanes are the pack's role ids plus `done`.

### 4.6 Attention items (dashboard + commands)

`approval`, `clarification`, `blocked`, `gate-failed`, `decision`. Each has `id`, `project`, `task`, `createdAt`, and the allowed actions. Approvals and clarifications are persisted files so they survive restarts.

## 5. Package design

### 5.1 Module layout (`packages/plugin-swarm/src`)

```
domain/      pack.ts  task.ts  handoff.ts  envelope.ts  pipeline.ts  attention.ts   (pure)
app/         forge.ts  project.ts  tasks.ts  pump.ts  audit.ts  gates.ts  approval.ts  lieutenant.ts  teardown.ts
ports/       agent-runner.ts  isolation.ts  handoff-store.ts  board-store.ts  gate-runner.ts  notifier.ts
adapters/    child-session-runner.ts  git-worktree.ts  fs-handoff-store.ts  fs-board-store.ts  process-gate-runner.ts
dashboard/   server.ts  api.ts  auth.ts  state.ts   (assets/dashboard.html, dashboard.css, dashboard.js)
toolchains/  node-ts.json  (+ loader; go/java/python/clojure examples under docs)
resources.ts index.ts version.ts
```

### 5.2 Agents (`.agents/agents/swarm-*.md`, every name carries the `swarm-` prefix since Phase 3; pack role ids stay short; frontmatter per the Wayfinder contract, plus `timeoutMs` and `maxOutputTokens`; `disallowedTools` includes `task`, `delegate`, `subagent`, `sessions_create`)

| Agent | Mode | Writes | Responsibility |
|---|---|---|---|
| `swarm-lieutenant` | primary | no | Chat with the operator; summarises status, suggests packs/projects, points at `mission.md`; **never implements** (upstream rule) |
| `swarm-specifier` | subagent | yes (specs, `tasks/`) | Works from the card and tree only; asks clarifications; writes Gherkin features/scenarios with examples; completes the whole card, then one handoff; stops at the approval gate |
| `swarm-coder` | subagent | yes | One **behaviour slice** at a time: failing unit test first, minimum production code, green, commit, handoff |
| `swarm-cleaner` | subagent | yes | Confirms unit + acceptance green; runs CRAP/DRY gates and refactors until under threshold |
| `swarm-refactorer` | subagent | yes | Structure/readability refactor, tests stay green (four-pack) |
| `swarm-architect` | subagent | yes | Applies architecture rules (modules, clear boundaries, isolate high-level policy, dependency direction); tests green before and after; fixes local errors before handoff |
| `swarm-hardener` | subagent | yes (tests only) | Runs differential mutation testing; adds/strengthens tests to kill surviving mutants; does not change production behaviour |
| `swarm-qa` | subagent | no (reports) | Final acceptance against the approved spec; one handoff per SHA; its handoff is the terminal broadcast |

All role prompts share the **engineering constitution** (below) and the handoff rules; they are English, concise, and never describe orchestration to the child (the coordinator is not told to the child as something to run).

### 5.3 Skills (`.agents/skills/<name>/SKILL.md`, six-heading contract, `Trigger:` ≤ 250 chars, `license: MIT`)

1. `swarm-handoff-protocol` — envelope kinds, one handoff per task, evidence trace, forwarding rules, merge ownership.
2. `swarm-engineering-constitution` — small increments, separate testable core from IO, no homemade metrics, differential mutation only, local verification before handoff, `By <role>.` commit byline.
3. `swarm-gherkin-spec` — clarify first, features/scenarios with concrete examples, approval stop.
4. `swarm-tdd-slice` — behaviour slice, red-green, commit only when green, test file must exist in the diff.
5. `swarm-cleaner-metrics` — CRAP/complexity/coverage reading, refactor loop, DRY.
6. `swarm-architecture-rules` — module partitioning, dependency rule, boundaries, structure-preserving refactors.
7. `swarm-mutation-hardening` — mutant triage, killing survivors with behaviour tests, equivalent-mutant reporting.
8. `swarm-qa-acceptance` — acceptance trace to the approved spec, no duplicate handoffs.
9. `swarm-clarification` — when to ask, one question per envelope, how to resume.
10. `swarm-lieutenant` — advisory chat contract and its hard "never implement" rule.
11. `swarm-toolchain-profile` — how to read the gate report for the active toolchain.

### 5.4 Tools (effect classes; cancellable via `ctx.signal`)

| Tool | Effect | Purpose |
|---|---|---|
| `swarm_status` | read | Board, attention, work queue as UI blocks (table + mermaid flow) |
| `swarm_task_new` | write | Create a card and queue the note to the master role |
| `swarm_gate_run` | process | Run one named gate for a role/task and return the structured report |
| `swarm_doctor` | process | Check `git`, worktree support, toolchain commands, writable dirs |

### 5.5 Commands (`/swarm:*`)

`init`, `doctor`, `pack list|show`, `project new|open|close|list`, `task new|delete|retry`, `status`, `dashboard`, `approve <id>`, `reject <id> retry|delete|accept [-- comments]`, `answer <id> -- <text>`, `chat -- <text>`, `stop <project>`, `teardown --confirm TEARDOWN`.

Each command does one unit of work and returns a string; long work is handed to the **pump** which runs in the background. Interactive gates use `ui.askQuestions` when `ui.interactive()`; otherwise the command forms above are the contract.

## 6. Isolation (git worktrees)

- `git worktree add -B swarm/<project>/<role> <project>/.worktrees/<role>` via `execFile("git", argv)`; never `shell:true`.
- The `master` role works on the project's main checkout on its current branch.
- `.gitignore` gets `.alisio/swarm/` and `.worktrees/` entries (idempotent).
- A commit-msg hook appends `By <role>.` when missing; `--no-verify` is forbidden by the constitution and detected by the gate (hook marker in the commit).
- Children get `workspace = <worktree path>`; `tools.allow` = file and git read/write built-ins and `run_process` only for write roles; read-only roles use `readOnly: true`.
- Project paths must resolve under the workspace or an explicitly opened directory; no `..`, no symlink escape.

## 7. Projects, packs and the forge

- **Forge root:** `<workspace>/.alisio/swarm/` with `projects/`, `packs/`, `forge.json` (`schemaVersion`, open projects).
- **New project:** name, optional GitHub clone (`owner/repo` → `https://github.com/<repo>.git`, argv `git clone`, 409-style error if the directory exists), mission text (`mission.md`), pack choice, editable pack copy. `git init` on `master` with an initial commit when not cloned.
- **Open:** refresh shipped role prompts into the project, keep the project's pack, mission, source and state; start the pump for that project. **Close:** stop the pump and worktree bookkeeping; never touch project directories. **Restart:** nothing is running until a project is opened; state is rebuilt from handoff files.
- **Teardown:** requires the literal confirmation `TEARDOWN`; cancels child sessions, stops the pump and dashboard server, removes the pidfile; leaves project directories intact.

## 8. Runtime behaviour

### 8.1 Pump

Event-driven (on handoff written, on child run completion) plus a 1 s tick. Per project it serialises board writes. A role runs at most one task at a time; `batch` roles collect equal-priority inbox items. Concurrency across roles respects a configurable cap (default 3) below the host subagent limits.

### 8.2 Task lifecycle

`New Task` → note handoff from the phantom sender `(New Task)` to the master role → child run → envelope → audit handshake (AD-5) → gate run (AD-6) → handoff file → delivery + coordinator-side merge in the receiver worktree → receiver child run … → terminal handoff → card Done.

### 8.3 Approval gate (packs with `approval.after`)

The master role's single-recipient `git_handoff` is held in `pending_approval/` and appears under Attention. Documents view shows task docs and the diff, with per-document comments; **Approve is disabled while comments exist**. Reject offers: **Retry** (snapshot the rejected commit under `refs/swarm/rejected/<task>`, restore the base, increment audit count, re-run the master role with the findings and comments), **Delete** (archive and remove the card, handoffs, audit state), **Accept unchanged**.

### 8.4 Gates and failure handling (our definitions where upstream is silent)

- **Bounce:** a failing gate returns the report to the same role, once per audit round; after `maxBounces` (default 2) the task becomes `blocked` → **Needs your decision**.
- **QA rejection:** QA returns `blocked` with traced findings; the coordinator routes the task back to the **coder** with those findings (default) or to the role named in the finding, bounded by `maxBounces`.
- **Parallel stage join:** continues only when all parallel roles have handed off; their commits are merged in pack order by the coordinator; conflicts go to the next role in the pipeline.
- **Thresholds are pack data, never hard-coded:** defaults `coverage ≥ 80 %`, `cyclomatic complexity ≤ 6` per function, `CRAP ≤ 8`, `mutation score ≥ 80 %` on changed code (the transcript states none; these are our defaults and configurable). CRAP formula is the published one: `CC² × (1 − coverage)³ + CC`.
- **Turn limit / timeout:** reject partial output (AD-3), keep the worktree, ask the operator.
- **Token budget:** each role has `maxTurns`, `timeoutMs`, `maxOutputTokens`; a swarm-wide soft cap (`options.tokenBudget`) pauses the pump and raises a decision (the video's main criticism was runaway cost; idle roles never run until they have mail — **no eager agents**).

### 8.5 Clarifications and chat

A child returns `needs_clarification`; the card shows `clarifying`; the answer (dashboard or `/swarm:answer`) is delivered with `run(sessionId, answer)` on the same session. Dashboard chat messages go to the Lieutenant child session; replies are plain text.

## 9. Dashboard (the "tab")

**Owner decision (complementary only).** The dashboard is a **follow-up view** of the work running in the current workspace, not a control panel. Everything that creates, opens, closes or tears down projects and tasks, the Lieutenant chat and budget changes are done from the Alisio chat with `/swarm:*` commands. The page offers only what the chat does poorly: a live board of many roles, per-role activity, an event log, review evidence (documents and a side-by-side diff with per-document comments) and the human-gate decisions made while reviewing that evidence (Approve, Reject, Answer, Retry, Delete). Every control is useful, necessary or complementary to Alisio; anything that merely duplicates a command is dropped. Every role, the Lieutenant included, runs as an Alisio child session and the page labels the runner "Alisio". Styling uses design tokens aligned with the Alisio web app under `--swarm-*` names, system light/dark plus an explicit override.

Served by `node:http` on `127.0.0.1:<ephemeral>`, started by `/swarm:dashboard [project | project/task]` (the optional argument deep-links with a hash), stopped by teardown or `dispose`. Static assets in `assets/`, vanilla JS/CSS, no CDN, no framework. State via `GET /api/state` polled every 2 s.

**Layout:**

1. **Top bar:** title, live chip, "needs your decision" count (also in the tab title and favicon badge), token budget, pause-refresh toggle, theme, optional chime.
2. **Filters:** project, role, status.
3. **Attention strip** (hidden when empty): `Approval` / `Clarification` / `Blocked` / `Gate failed` tag, `project/task` deep link, buttons `Documents`, `Approve`, `Reject`, `Answer`, `Retry`, `Delete` as allowed, and **Copy command** (the equivalent `/swarm:*` command).
4. **Board (left):** one band per running project (name shows the mission); **one column per pack role in order + DONE**; cards show task name, audit check count, status snippet, a merging highlight and a copy-command button. An empty state tells the user to start from the chat.
5. **Right rail:** **Work Queue** (rows Task / Role / Age, a live-idle-none dot with a text label, a 0-6 activity meter, the Alisio session id with a copy button, role link opens the transcript tail) and an **Activity** log (handoffs, merges, gate results, bounces, approval waits). Draggable splitters; independent scrolling.
6. **Dialogs:** Reject (Delete / Retry with comments / Accept unchanged), Answer, Documents (task files, side-by-side or unified diff, per-document comments), Mission, agent tail.
7. **Accessibility/theming:** semantic HTML, keyboard reachable native dialogs, light/dark via CSS custom properties with an explicit background, status never conveyed by colour alone, WCAG AA text contrast in both themes, usable at phone width.

**API (all that exists):** `GET /`, `GET /api/state`, `GET /api/agents/:role/tail`, `GET /api/doc`, `GET /api/mission`, `POST /api/approvals/:id/{approve,comments,reject}`, `POST /api/clarifications/:id/answer`, `POST /api/tasks/{delete,retry}`. Every route validates input with the identifier rules of 4.1 and returns JSON errors. A test asserts that no other mutating route exists. Project and task creation, open/close, chat, teardown and budget changes are not exposed.

**Fallbacks (fail-open):** `ui.panel` tree (projects → roles → task), `/swarm:status` UI blocks (`table` + `mermaid` pipeline), `views.register("swarm-board")` returning the same state JSON when `api.views` exists.

## 10. Security model

- No shell anywhere; `execFile`/`spawn` with argv arrays, timeouts, output caps, scrubbed environment (no secrets passed to gate commands).
- Dashboard: bind `127.0.0.1` only; random 256-bit token required on every request (cookie + header); reject unexpected `Host`/`Origin`; no CORS; CSP `default-src 'self'`; render all agent/task text as text, never HTML; body size cap 256 KiB.
- Child output is untrusted: schema-validated, path-contained, never executed; document viewer only serves files inside the project root.
- Persisted data: atomic writes, mode 0600/0700, schema-versioned; handoff/board files are never trusted without revalidation on load.
- Git: refuse worktree paths outside the project; never `--force` pushes; the plugin never pushes or opens PRs in v1.
- Repo rules: no local machine paths or credential shapes in any tracked file or test fixture (`leak:check` scans tracked files only — use synthetic paths such as `/scratch/p`, `/cache/c`, `/h/u`).

## 11. Test strategy (strict TDD; vitest, offline)

- **Domain unit tests:** pack parsing/validation (exactly one master, ordering, bad names), envelope parser (every reject path), audit state machine, pipeline routing incl. terminal broadcast and `back-one/back-all`, CRAP formula, threshold evaluation.
- **Adapter tests with fakes:** `AgentRunner` fake scripts child output; `Isolation` against a real temp git repo for worktree create/merge/conflict; fs stores crash/replay (kill mid-write, rebuild board from handoffs).
- **Gate runner:** fixture toolchain commands and parsers (pass, fail, timeout, garbage output).
- **Dashboard:** HTTP tests for every route (auth missing/wrong, bad Origin, bad identifiers, size cap, teardown confirmation), plus one browser-level smoke test of the static page against a fake state (the repo has Playwright MCP available locally; keep it out of `pnpm check` unless a runner is already configured).
- **Plugin harness:** fake `PluginAPI` (pattern from `packages/plugin-thesis/test/helpers/harness.ts`): command parity with dashboard actions, headless `askQuestions` fallback, `dispose` cleanup.
- **Do not pin prompt wording in tests** (upstream rule, also sound here); test envelopes and behaviour.
- At least one happy and one unhappy path per scenario; `pnpm check` must pass.

## 12. Phases

| Phase | Deliverable | Acceptance |
|---|---|---|
| 0 | Verification spike | Written results for: upstream licence; background promise outliving a command; concurrent `sessions.run` against host limits; headless child `permission: ask`; `api.paths`/`views` availability on the installed host; child workspace = worktree behaviour |
| 1 | Package skeleton, domain, packs, envelope, state stores, `doctor`, `init` | Domain tests green; `pnpm check` green |
| 2 | Isolation + handoff pump + audit handshake, `task new`, `status`, two-pack end-to-end with a fake runner | Replay/crash test passes; terminal broadcast marks Done |
| 3 | Real child-session runner, roles/skills, approval gate, clarifications, four-pack | Manual run on a sample repo; gates bounce and block correctly |
| 4 | Gates + `node-ts` toolchain (coverage, CRAP, mutation), six-pack, hardener/QA | Thresholds configurable; failing gate blocks handoff |
| 5 | Dashboard (server, API, UI, security) + TUI panel + views | Layout matches Section 9; security tests green |
| 6 | Docs, diagrams (pipeline, handoff sequence, audit state machine), site pages EN/ES, changeset, cover | `pnpm check`, `docs:check`, `diagrams:check` green |

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Host does not run plugin-driven children concurrently or limits them | Pipeline serialises | Phase 0 test; cap + sequential fallback is already valid |
| Background promise dies with the command | Swarm stops silently | Phase 0; if it dies, run the pump inside a tool call with `ctx.signal` and keep the session alive |
| Agents bypass hooks/TDD | Quality illusion | Gates are code; bounce + block (AD-6) |
| Token cost explosion | Real money | No idle agents, per-role caps, swarm budget, small default pack |
| Localhost dashboard attacked | Local compromise | AD-9 token/Host/Origin/CSP, text-only rendering |
| Merge conflicts across roles | Stuck cards | Coordinator merges, receiver resolves, bounded bounces |
| Upstream licence unknown | Legal | Clean-room prompts; confirm licence in Phase 0 |
| Prompts authored without upstream role prompts | Behaviour drift from SwarmForge | Documented here; iterate with real runs; do not claim parity |

## 14. Open questions for the owner

Resolved:

1. Package/plugin name: **`@alisio/plugin-swarm`, id `swarm`** (confirmed by the owner).

2. v1 ships the **`node-ts` toolchain only** (confirmed by the owner).
3. The package ships **`README.md` (English) and `README.es.md` (Spanish)**, owner-approved. AGENTS.md must be updated in the same change to add `packages/plugin-swarm/README.md` / `README.es.md` to the bilingual-package exception, under the same pairing rules as plugin-thesis.

## 16. Phase results

### 16.1 Phase 0: verification (static and local only)

Everything below was verified from files on disk. Items that need a running Alisio host are marked
**manual** and must be settled before Phase 3 depends on them. No machine paths are recorded here.

| Question | Result |
|---|---|
| Upstream licence | **Not confirmed.** The inspected `main` checkout has no `LICENSE` or `COPYING` file, and neither `README.md` nor `AGENTS.md` mentions a licence. The only licence strings in the tree belong to third-party packages in a dashboard test lockfile and say nothing about the project. The plugin therefore stays a clean-room reimplementation (no upstream text or code), credits the author in the README only, and the licence must be confirmed on the upstream GitHub repository before any wording is reused. **Manual.** |
| `api.paths` | Typed as optional in `@alisio/sdk` 0.3.0: `{ state, config, cache }`, created by the host with mode 0700; the doc comment says it is absent on a core that predates it. Feature-detect it. The plugin does not use it yet (all state is workspace-local under `.alisio/swarm`). Runtime availability on the installed host is **manual**. |
| `api.views` | Typed as optional: `views?.register(ViewDefinition)`. A view has an id (lowercase, digits, dashes, at most 40 characters), a description, optional primitive-only `params`, and `handler(params, { sessionId, workspace, signal })` returning JSON. Read-only is a contract, not a sandbox. Not used yet (Phase 5). |
| `api.options` | Typed as optional `Readonly<Record<string, JsonValue>>`, frozen at `setup`. The plugin parses `maxConcurrent` and `roles.<role>.model` leniently (invalid values fall back to defaults). |
| Child sessions | `ChildSessionSpec` carries `parentId`, optional preassigned `id`, `title`, `agent`, `instructions`, `tools.allow/deny`, `model`, `readOnly`, `permission.write/process` (`allow`, `ask`, `deny`), `workspace`, `maxTurns`, `timeoutMs`, `maxTokens`, `maxOutputTokens`. `run(id, prompt, { signal })` returns `{ id, status, text, usage, error?, turnsExceeded? }`, which is what the `AgentRunner` port maps onto. `create` resolves a model selector, `spawn` does not. `workspace` is documented as "Workspace root for the child (e.g. a git worktree)". Actual behaviour with a worktree is **manual**. |
| Commands | `handler(args, context?: { sessionId?: string }) => Promise<string>`; the workspace comes from `sessions.workspace(sessionId)`, so a missing session is an error the plugin reports. |
| UI blocks | `table`, `key-value`, `tree`, `code`, `markdown`, `diff`, `terminal`, `mermaid` (field `source`), `math`, `json`, `test-results`, `progress`, `artifact` exist, so `swarm_status` uses `table` and `mermaid`. |
| Installed host SDK | A newer `@alisio/sdk` 0.4.x is installed in the user-level plugin directory (the host core itself is not readable there). Its type surface for `PluginAPI`, sessions, paths, views and UI blocks is identical to 0.3.0; the only difference is additive dashboard-generation types unrelated to this plugin. The declared peer range `>=0.3.0 <0.7.0` stands. |
| Background promise outliving a command | Cannot be settled from types. **Manual.** Phase 2 does not depend on it: the pump is started by `/swarm:project new|open` and tested with `drain()`. |
| Concurrent `sessions.run` against subagent limits | Cannot be settled from types. **Manual.** The pump already caps concurrency (`maxConcurrent`, default 3) and degrades to sequential. |
| Headless child `permission: ask` | Cannot be settled from types. **Manual.** Role agents declare `permission.write/process` as `allow` or `deny`, never `ask`. |

### 16.2 Phases 1 and 2: what was built

Package `@alisio/plugin-swarm` (id `swarm`, `packages/plugin-swarm`), version 0.1.0. Domain (pure):
identifiers, pack, task/board with `rebuildBoard`, handoff header and file names, strict envelope
parser, pipeline routing (terminal broadcast, `back-one`, `back-all`), attention derivation, the
`node-ts` toolchain profile parser, CRAP and threshold evaluation. Adapters: atomic fs board and
handoff stores with crash and replay, git worktree isolation (argv arrays only, scrubbed
environment, commit-msg hook), and a placeholder runner that fails visibly. Application: audit
handshake, in-process pump, `ProjectRuntime`, `Forge`. Plugin: `init`, `doctor`, `pack`, `project`,
`task`, `status` commands and the `swarm_status`, `swarm_doctor`, `swarm_task_new` tools. Eight role
agents and eleven skills (six-heading contract) ship in `.agents`.

### 16.3 Decisions made where the spec was silent or ambiguous

1. **Master role must be the first role.** The pipeline entry receives new tasks, so a master in the
   middle would starve earlier roles. Enforced by `parsePack`.
2. **Shipped data lives in `assets/`** (`assets/packs/<name>/pack.json`, `assets/toolchains/node-ts.json`),
   loaded relative to the built entry, so the same loader works from `src` and `dist`.
3. **Layout inside a project:** `.alisio/swarm/handoffs/<role>/{outbox,sent,failed,audit_pending,pending_approval,inbox/{new,in_process,completed}}`,
   `.alisio/swarm/board/tasks.json`, `.alisio/swarm/pack.json` (editable copy), `.alisio/swarm/mission.md`,
   worktrees in `.worktrees/<role>`. New repositories also commit a root `mission.md`; clones keep swarm
   state out of `.gitignore` through `.git/info/exclude`.
4. **Audit "unchanged" means the same commit.** Summaries and evidence text are never compared.
   `maxAuditRounds` (default 3, pack `limits`) bounds restarts; exhaustion blocks the card.
5. **Invalid output gets one automatic retry per run** (also for failed runs, unknown commits, `note`
   envelopes where a handoff is required, and turn-limit output); a second failure blocks the card.
6. **A restart is an implicit retry.** Holds that live only in memory (clarifying, blocked) and parked
   audits do not survive a restart; `in_process` items are requeued and the board is rebuilt from the
   handoff files. Held approvals survive because they are files.
7. **Delivery order for crash safety:** the parked handoff moves to the outbox, the inbox items are
   completed, then the handoff is delivered. A crash in between is replayed by `recover` instead of
   re-running the role.
8. **Batch roles** claim equal-priority inbox items of the same task only.
9. **Single-role packs** end a task with a merge-only handoff addressed to the role itself.
10. **Merge-only copies that conflict** are aborted and reported as an error event; the commit is merged
    later with the next forwarding handoff.
11. **Agent names `specifier` and `coder` etc. overlapped with Wayfinder's `specifier`.** Resolved in
    Phase 3 by the `swarm-` prefix (see 16.5): the host catalog behaviour for duplicates was never
    needed.

### 16.4 Phase 3 pickup list (done, see 16.5)

- Real `AgentRunner` over child sessions (`create` per `project/role` session key, `run` with the
  prompt, `cancelProject` through `cancel`), with `tools`/`permission`/`readOnly` per agent file and
  `options.roles.<role>.model`.
- `approve`, `reject`, `answer`, `task delete|retry`, `chat`, `stop`, `teardown` commands. The pump
  already parks approvals in `pending_approval`, holds clarifications and exposes `answer`; it does not
  yet release an approval or retry a blocked card.
- Wire `GateRunner` (port declared) and bounce handling (Phases 3 and 4).
- Resolve the manual Phase 0 items against a real host, and the agent-name overlap in decision 11.

### 16.5 Phase 3: what was built

- **Agent rename.** All eight agents are `swarm-<role>`; pack role ids are unchanged. One map,
  `agentForRole` in `resources.ts`, turns a role id into an agent name; shipped packs carry the
  prefixed `agent` field. Agent frontmatter gained `timeoutMs` and `maxOutputTokens`;
  `loadAgentProfile` returns tools, deny list, limits, `readOnly` and `permission` (`allow`/`deny`
  only) with the same instructions text that is registered with the host.
- **`ChildSessionRunner`** (`adapters/child-session-runner.ts`): one lazily created child per
  `project/role` key, `workspace` = the role's worktree, `tools.allow/deny`, `permission`, `readOnly`,
  `maxTurns`, `timeoutMs`, `maxOutputTokens` from the profile and `model` from
  `options.roles.<role>.model`. Status mapping: `cancelled`/`interrupted` to cancelled, anything not
  `completed` to failed; `turnsExceeded` passes through so the pump rejects partial output. A parent
  session is the session of the last swarm command or tool call. `api.sessions` is read lazily and is
  never touched in `setup()`. `cancelProject` and `cancelAll` abort the in-flight call and call
  `sessions.cancel`; the entry is dropped so the next run creates a new child. Tested against a fake
  `sessions` API and end to end through `registerSwarm`.
- **Services facade** (`app/services.ts`, AD-10). `SwarmServices` is the single implementation
  behind commands, tools and, in Phase 5, the dashboard: `createTask`, `approve`, `reject`, `answer`,
  `retryTask`, `acceptTask`, `deleteTask`, `addComment`, `clearComments`, `attention`, `chat`,
  `stopProject`, `runProject`, `budget`, `raiseBudget`, `gateRun`, `ask`, `onTeardown`, `shutdown`,
  `teardown`. The coordinator only parses arguments and renders strings.
- **Operator actions** (`app/operator.ts`, behind `ProjectRuntime.approve/reject/...`). Approve
  delivers the held handoff with `approved: true` and is refused while per-document comments exist.
  Reject Retry snapshots the rejected commit at `refs/swarm/rejected/<task>`, restores the role's base
  commit (refused with a clear message when the checkout has uncommitted changes), discards the held
  handoff, increments the audit count and queues a note to the role with the original task text, the
  findings and the per-document comments. Delete archives card, state and handoff headers and bodies
  under `.alisio/swarm/archive/<taskId>.json`, then removes handoffs, state and card; it is refused
  while the task is running. Accept releases the held handoff unchanged. `task retry` puts a held
  role's work back with a fresh allowance.
- **Persistence.** `.alisio/swarm/state/<taskId>.json` (`TaskState`: bases per role, hold, pending
  answer, approval comments, bounces, rejections) behind a write-through cache so `attention()` stays
  synchronous. Items persisted across restarts: clarifications, agent-reported blocks, gate failures
  and approvals with their comments.
- **Commands** added: `approve`, `reject`, `answer`, `chat`, `stop`, `teardown`, `task
  delete|retry|accept`, plus `comment`, `run` and `budget` (not in 5.5, see 16.7). Interactive gates
  go through `services.ask` (`ui.askQuestions`); headless, or when the user skips, the command usage
  is returned as the error.
- **Lifecycle.** The pump starts on project open (`autoStart`), halts on close, stop, teardown and
  dispose; `dispose` and `teardown` run `shutdown` (stop every forge, `runner.cancelAll`,
  `gates.cancelAll`, registered `onTeardown` cleanups such as the future dashboard server). A pidfile
  `.alisio/swarm/swarm.pid` is claimed on the first open and released when the last project stops; a
  dead previous owner is reaped and reported, a live foreign owner is reported and never touched.

### 16.6 Phase 4: what was built

- **`ProcessGateRunner`** (`adapters/process-gate-runner.ts`) over `createExec`
  (`adapters/process-exec.ts`): `spawn` with argv arrays (no shell), a process group per command so a
  timeout kills the whole tree, per-command timeouts (test 5 min, coverage 10 min, mutation 30 min),
  an output cap (4 MiB, the process is killed beyond it) and a scrubbed environment (`PATH`, `HOME`,
  temp and locale variables, `CI=1`; no credentials). `ProcessTracker` lets close, stop, teardown and
  dispose cancel running gates (`cancelAll(under?)` by project directory).
- **Gates.** `tests-green`, `test-first` (test file in `git diff <base>..HEAD`), `coverage`
  (Istanbul `json-summary`), `crap` (ESLint `complexity` JSON joined with per-file coverage, changed
  files only, `crap()` from Phase 1), `dry` (in-process duplicate-block detector, window 6, only
  duplicates involving a changed file), `mutation` (Stryker report; differential through `--mutate`
  on the changed source files and a changed-files filter in the parser; score = killed plus timeout
  over killed, timeout, survived and uncovered), `acceptance` (profile `acceptance` command, else
  `test`), `structure` (skipped with a reason). Thresholds come from `GateRequest.thresholds`
  (pack data). The toolchain profile gained an optional `report` path per command and the
  `acceptance` command. Parsers are covered with pass, fail, timeout and garbage fixtures.
- **Bounce logic** in the pump, after an unchanged audit: gates run in pack order and stop at the
  first failure; the report returns to the same role with a new audit round; more than
  `limits.maxBounces` failures hold the task as `gate-failed` (card `blocked`, persisted, parked
  handoff kept so the operator can Accept). A gate that reports `error` (could not run) holds
  immediately without bouncing.
- **QA rejection routing.** The last role's `blocked` envelope routes back (a phantom note with the
  findings) to a `route: <role>` line when it names an earlier role, else the role's `rejectTo`
  (new optional pack field naming an earlier role), else `coder`, else the first role; bounded by
  `maxBounces` per task, then held as `blocked`.
- **Parallel stages.** `releasePlan`/`stageOf`/`joinSource` in `domain/pipeline.ts`. The role before a
  stage fans out one handoff to every stage role; a stage role parks its handoff in the new
  `join_pending` location; when every stage role of the task has parked, the coordinator delivers
  them to the next role in pack order (under the tick lock) and that role claims them as one batch
  and merges them in order, conflicts becoming part of its task. `resumeJoins` completes a join after
  a restart. `parsePack` now rejects a stage containing the master or last role and an approval gate
  inside a stage.
- **Token budget.** `options.tokenBudget` (at least 1000) feeds a persisted `UsageMeter`
  (`.alisio/swarm/usage.json`). `RunResult.usage` is recorded after each run; once the cap is reached
  no new runs start, a `decision:<project>:budget` attention item appears (actions `raise`, `stop`)
  and `/swarm:budget raise <n>` resumes. In-flight runs finish (soft cap).
- **Tool** `swarm_gate_run` (effect `process`): project, role, gate and an optional task (for the
  diff base).

### 16.7 Deviations and decisions beyond the spec

1. **Commands beyond 5.5:** `comment` (needed so the approval gate and its "approve disabled while
   comments exist" rule are testable and reachable without the dashboard), `run` (foreground pump,
   the degradation path of section 13 when background promises die) and `budget`.
2. **`reject <id> retry` re-runs the role that owns the approval gate** (the master in all shipped
   packs), restoring that role's base commit recorded when it first started the task. The base is per
   role (`TaskState.bases`), not a single task base.
3. **Persistence of holds is selective.** Persisted: clarifications, agent-reported `blocked`, gate
   failures, approvals. Not persisted (restart is an implicit retry, as in 16.3 item 6): output
   rejected twice, audit rounds exhausted, merge or runtime errors.
4. **After a restart a restored clarification starts a fresh session** and the question is repeated
   with the answer in the first prompt; a live hold keeps resuming the same session.
5. **`structure` is skipped, not verified.** No deterministic checker exists for architecture rules
   in v1; the report says so.
6. **CRAP uses the file's line coverage for every function in the file** (Istanbul summaries have no
   per-function coverage); coverage for `coverage` is the overall line coverage.
7. **Gate base commit** is the role's HEAD after merging its inputs (`GateRequest.since`); the
   `test-first` and mutation scope therefore cover only the role's own commits.
8. **Parallel stages:** propagation (`back-one`, `back-all`) of stage roles is applied per role at
   join time; the approval gate cannot sit inside a stage.
9. **Gates run only when a runner is configured.** `registerSwarm` defaults to the process runner;
   tests pass `gates: null`. The Forge and the pump stay ungated without a `GateRunner`.
10. **Pidfile reaping covers the owner pidfile, not orphan gate processes** after a SIGKILL of the
    host: gate children are short-lived and killed by their own timeout only while the host lives.
    Not implemented: killing recorded children of a dead owner (pid reuse risk).
11. **Approval retry refuses on a dirty checkout** instead of discarding uncommitted changes.

### 16.8 Manual Phase 0 items still unverified, and how the design degrades

None of these can be settled without a running Alisio host; the code is written so a negative result
degrades instead of breaking.

| Item | If it fails | Degradation already in place |
| --- | --- | --- |
| A promise that outlives its command keeps running | The pump (a `setInterval` plus `setImmediate` ticks, `unref`ed) stops advancing after a command returns | `/swarm:run <project> [--seconds n]` drains the project inside one command; state is on disk, so every restart or run resumes. The spec 13 fallback of running the pump inside a tool call with `ctx.signal` is not built. |
| Concurrent `sessions.run` against subagent limits | Runs queue or fail | `options.maxConcurrent` (1 to 8) down to 1 makes the pipeline sequential; a failed run is retried once and then held. |
| Headless child `permission: ask` | A child would block | No agent declares `ask` (`loadAgentProfile` rejects it); permissions are `allow` or `deny`. |
| Child `workspace` = worktree honoured | Children would edit the parent workspace | Gates and merges run in the worktree path and the handoff commit must exist there (`hasCommit`), so a wrong workspace surfaces as rejected output. |
| `api.paths`, `api.views` | Unavailable | Not used yet (state is workspace-local). Phase 5 feature-detects them. |
| Upstream licence | Unknown | Clean-room prompts, attribution only. |

### 16.9 What Phase 5 (dashboard) must pick up

- Call `SwarmServices` only (`coordinator.services`): `attention`, `approve`, `reject`, `answer`,
  `addComment`, `clearComments`, `createTask`, `deleteTask`, `retryTask`, `acceptTask`, `chat`,
  `stopProject`, `teardown`, `budget`, `raiseBudget`; register the server cleanup with
  `services.onTeardown` so teardown and dispose stop it.
- Still missing for the Documents view: a service that returns the task documents (`specs/`,
  `tasks/`) and the diff between a role's base (`TaskState.bases`) and the held commit, contained under
  the project root. Comments already exist (`addComment`, `comments(task)` on the runtime) but are not
  exposed per document by a read service.
- The `swarm-board` view and the `ui.panel` tree should reuse `Forge.snapshot`, which now carries
  persisted attention (`detail` text, `gate-failed` kind, comment-aware approve action).
- Agent transcript tails: `ChildSessionRunner` keeps the child session id per key but does not expose
  it; add a read accessor if the dashboard shows tails.
- Budget and attention chime: `Notifier` already emits `attention` events (including the budget
  decision) and `task-done`.
- Lieutenant chat history is not stored by the plugin: the dashboard must keep its own transcript.

### 16.10 Phases 5 and 6: what was built

> Superseded in part by 16.13: the Lieutenant chat (`chatHistory`, `/api/chat`), pack editing and project creation in the dashboard were removed. The services remain for the commands.

- **Services added** (`app/services.ts`, all tested): `state` (the `GET /api/state` snapshot, built
  from `Forge.snapshot`; no filesystem paths), `documents` (task documents and the diff from the gate
  role's base to the held commit, read from the git object store; comments per document; `approvable`),
  `agentTail`, `chatHistory` (persisted, bounded to 100 messages, `.alisio/swarm/chat.json`),
  `mission`, `openProject`, `closeProject`, `listProjects`, `listPacks`, `packDefinition`. `Isolation`
  gained `changedFiles`, `diff` and `readFileAt`; `NewProjectInput` gained `packDefinition` (an edited
  pack, validated by `parsePack`).
- **Server** (`dashboard/server.ts`, `api.ts`, `auth.ts`; `state.ts` lives in `app/state.ts`): `node:http`
  on `127.0.0.1`, ephemeral port. Token in the query of `GET /` only, exchanged for an HttpOnly
  SameSite=Strict cookie; reads accept cookie or `X-Swarm-Token`, mutations require the header (the page
  gets the token from a meta tag). Host and Origin checks, no CORS, CSP `default-src 'self'`, 256 KiB cap
  (413), JSON only (415), identifiers validated, service errors mapped to 400/404/409, system errors
  to a generic 500. Stopped by `services.onTeardown`, so teardown, dispose and the teardown route all
  stop it; `/swarm:dashboard` is idempotent per workspace and opens a browser best effort.
- **UI** (`assets/dashboard.html/css/js`, vanilla, no CDN): verified once with headless Chromium
  against a fake state at 1300 px and 390 px: layout matches the screenshot (top bar, attention strip,
  bands with one column per role plus DONE, work queue, Lieutenant chat, splitters), dialogs open, no
  horizontal page scroll on a phone. Not in `pnpm check`.
- **Fallbacks:** `ui.panel("swarm")` tree (projects, roles, tasks) and `views.register("swarm-board")`,
  both feature-detected and fail-open; `/swarm:status` already carried table and mermaid blocks.
- **Docs:** seven diagrams in `diagrams/plugin-swarm/` rendered to `packages/plugin-swarm/assets/`
  (architecture, pack pipelines, handoff sequence, task states, audit states, approval flow, dashboard),
  embedded in both READMEs; repo README plugin lists and the site pages regenerated.

### 16.11 Deviations in Phases 5 and 6

> Superseded in part by 16.13: items 2 and 4 (extra chat, pack and accept routes; plugin-persisted chat history) no longer apply to the dashboard.

1. **No transcript API.** `api.sessions` exposes no history, so the "transcript tail" is a bounded log of
   prompts and replies the `ChildSessionRunner` records itself (`AgentRunner.inspect`, 40 entries of up to
   2000 characters, in memory). It is lost on restart and is not the host transcript.
2. **Extra routes** beyond section 9: `GET /api/chat` (history), `GET /api/packs/:name` (pack JSON for the
   editor), `POST /api/tasks/accept` and `POST /api/budget/raise` (Blocked and budget attention items).
3. **Activity meter** is the number of runs started in the last ten minutes, capped at 6 (at least 1 while
   live). The dot is live (pump running the role), idle (conversation, card or mail) or none.
4. **Chat history is plugin-persisted** and recorded only for successful exchanges.
5. **Cookie on mutations is not enough by design**: a cookie-only POST is refused, which also closes CSRF.
6. **No changeset was added.** The package is unreleased at 0.1.0 and the release skill says to drop
   changesets whose changes ship in the first version; add one only when a later change needs it.
7. **Seven diagrams** (the task and audit state machines are separate, single-concept diagrams).

### 16.12 Still unverified (manual, needs a live Alisio host)

All Phase 0 manual items of 16.8 remain open, plus: that `/swarm:dashboard` can open a browser from the
host process; that child runs started from dashboard requests (chat) find a parent session (they use the
session of the last swarm command); that `ui.panel` and `views.register` behave as typed; the visual
check was a fake-state render, not a run with live agents; the upstream licence is still unconfirmed.

### 16.13 Owner decisions that changed Phase 5 (supersede the earlier Phase 5 notes above)

1. **Follow-up only, complementary only.** The dashboard no longer creates, opens, closes or tears down projects or tasks, has no Lieutenant chat and no budget control (removed: `POST /api/projects*`, `POST /api/tasks`, `POST /api/tasks/accept`, `/api/chat`, `/api/teardown`, `/api/budget/raise`, `GET /api/packs/:name`). The services behind them stay for the commands. Remaining mutating routes: approvals (approve, comments, reject), clarification answers, task retry and delete. A test asserts that list and that removed routes answer 404 or 405.
2. **Added glue:** copy-command buttons, Alisio session ids with copy, a decision count in the tab title and favicon, project/role/status filters, a pause-refresh toggle, hash deep links (`/swarm:dashboard <project>/<task>`), a side-by-side diff, and an Activity log fed by `activity` notifier events from the pump (handoff, merge, gate, bounce, approval; in memory, last 50 in `GET /api/state`).
3. **The runner is "Alisio".** State and agent tails carry `runner: "Alisio"`; no other backend is named in the UI, demo data or docs (upstream names appear only in the attribution note).
4. **Native look.** Palette, font stack, radii, focus ring and light/dark behaviour follow the Alisio web app tokens under `--swarm-*` names; text contrast was computed at or above 4.5:1 in both themes; control borders use a mixed token to reach 3:1.
5. **Demo helper.** `demo/dashboard-demo.mjs` (repository only, not packed) serves the dashboard with synthetic data and synthetic paths for screenshots.
6. Section 16.10 to 16.11 items about chat history routes, pack editing and project creation in the UI no longer apply to the dashboard (the services remain).

### 16.14 Documentation screenshots

The PNGs in `packages/plugin-swarm/assets/screenshots/` are captured from the synthetic demo, never from a real workspace (no local paths, tokens or Alisio chat captures). To regenerate:

1. `pnpm --filter @alisio/plugin-swarm build`, then `node packages/plugin-swarm/demo/dashboard-demo.mjs` (prints the link with a throwaway token; stop it afterwards).
2. With headless Chromium (Playwright), open the link at 1440x900 and take viewport-only screenshots (never the browser chrome, so the token is not visible): board light and dark (`colorScheme` emulation), the work queue pane (`#rail` at 1440x1300), the transcript tail (click the `coder` role), Documents (first Documents button), Reject (type a comment), the empty state (intercept `/api/state` and return empty `projects`, `attention` and `activity`), and a 390x844 phone view.
3. Quantise to a 128-colour palette (for example Pillow `quantize(128)`, no dithering) so each file stays under 100 KB, and read every image to confirm it shows no machine path or token.
