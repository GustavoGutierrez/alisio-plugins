---
title: "Frontsmith"
description: "Runs a gated frontend engineering workflow with specialist agents, deterministic rule packs, architecture, accessibility and token checks, and a reproducible visual-fidelity pipeline."
pageClass: "plugin-detail"
---

<PluginDetail slug="frontsmith" />

![Frontsmith](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/cover.svg)

> Español: [README.es.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/plugin-frontsmith/README.es.md). The two READMEs must be updated together.

Frontsmith turns an Alisio session into a gated frontend engineering workflow. Specialist agents do
the judgment and creation work; deterministic code decides everything that code can decide: rule
packs, architecture boundaries, accessibility and token checks, performance budgets, and a
reproducible visual-fidelity pipeline. Agents never approve their own work, and a missing tool is
reported as blocked, never as a pass.

## Status

**Pre-release (0.1.0).** Everything below is implemented and covered by offline tests with scripted
fakes for the child sessions. What has **not** been exercised against a live Alisio host yet:

- real child sessions (the model-per-agent binding, the profiles of the agents, background jobs that
  outlive their command in the TUI, command time limits in a browser or a remote client);
- inline composite images in terminals, the dashboard through a remote web client, and how the
  Dock renders the Markdown artifacts;
- whether a vision model can read the fidelity captures (without one, `fs-fidelity-reviewer` works
  from the numeric report).

The real-browser probe ran once against Playwright and Chromium on Linux; it is skipped on machines
that do not provide Playwright. Custom agents are **planned, not shipped**: see "Limitations".

## Why it improves frontend quality

![Design choices, the mechanism behind each and the quality outcome it protects](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/quality-decisions.svg)

Each design choice is tied to a mechanism and to the outcome it protects, so a result is explainable
rather than hoped for.

## Requirements

- Node.js 22.16 or newer and `@alisio/sdk` 0.3 to 0.6.
- `git` on `PATH`. Optional, resolved from your project: `playwright` (with a Chromium browser) for
  the fidelity pipeline and `axe-core` for runtime accessibility checks.
- No credentials and no network access of its own.

## Install

```sh
alisio install npm:@alisio/plugin-frontsmith
```

## Quick start

1. `/frontsmith:init` creates `.frontsmith/config.json` and the gitignore entry for local evidence.
2. `/frontsmith:doctor` checks git, Node, the project commands, Playwright, axe-core, packs and models.
3. `/frontsmith:new login-form --level L1 -- Add an accessible login form` creates a feature. Without
   `--level` an interactive session asks; a headless run needs the flag.
4. `/frontsmith:next login-form` runs the next unit. Planning phases run inline; build, validate and
   review start a background job (use `--foreground` to run them inside the command).
5. When a unit waits for a person, the output names the exact command, for example
   `/frontsmith:approve login-form spec`. Approvals are never defaulted: an interactive session asks,
   a headless one prints the command.
6. `/frontsmith:status login-form` shows the phase, gates, tasks and the next command at any time.

## Methodology

![Phases from intake to archive, with gates, human approvals and the bounded loops](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/methodology-flow.svg)

A feature moves through phases (`intake`, `context`, `specify`, `ui-contract`, `tokens`, `plan`,
`test-design`, `build`, `validate`, `review`, `accept`, `archive`). Each phase ends in a gate whose
report is written to `docs/frontsmith//reports/`. Failed gates send the work back in
bounded loops: at most 2 bounces per task, 3 repair rounds, and 2 remediations, all configurable.
The `tokens` phase runs only when the UI contract needs new tokens.

## Agents

![The twelve agents hand envelopes to the coordinator, which writes the artifacts the next agents read](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/agent-roster.svg)

Agents return strict JSON envelopes that the code validates; the code, not the agent, writes
artifacts and moves phases. The reviewer never sees the implementer's narrative.

| Agent | Role | Default tier |
| --- | --- | --- |
| `fs-coordinator` | Explains and operates Frontsmith through its commands; never advances a phase | fast |
| `fs-specifier` | Turns an intent into a verifiable spec with states and open questions | reasoning |
| `fs-ui-contractor` | Turns the spec and designs into an executable UI contract | reasoning |
| `fs-tokensmith` | Chooses token roles, names and contrast pairs, never colour values | standard |
| `fs-architect` | Minimal plan: components, layers, state, contracts, decisions, task contracts | reasoning |
| `fs-test-engineer` | Maps each acceptance criterion to a test; writes verification tests in build mode | standard |
| `fs-implementer` | Implements one UI task, test first where required | standard |
| `fs-data-engineer` | Implements one data-layer task: clients, stores, queries, mocks | standard |
| `fs-a11y-auditor` | Interprets accessibility reports, keyboard and focus behaviour | standard |
| `fs-fidelity-reviewer` | Classifies review items of the fidelity report and orders repairs | standard |
| `fs-reviewer` | Independently tries to refute that the change is ready | reasoning |
| `fs-archivist` | Writes the retrospective and proposes rule candidates | fast |

The agent and skill files ship in the package (`.agents/agents`, `.agents/skills`, 16 skills) and are
used both for the host catalog and for the instructions of each child session.

## Who decides what

![Decision flow for one check: code decides PASS or FAIL, agents classify only review items](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/who-decides.svg)

Code decides what code can measure. Agents classify heuristic signals (`REVIEW`) and can mark a
variation as acceptable, but they cannot overturn a `FAIL`. A required tool that is missing gives
`BLOCKED`, which stays visible until a person resolves or waives it.

## Rigor levels

| Level | For | Phases | Human approvals |
| --- | --- | --- | --- |
| L0 trivial | A typo, copy or local tweak | intake, context, build, validate, review | none |
| L1 small feature | A contained change | adds specify and a task plan | spec |
| L2 product feature | A normal feature | all phases | spec, UI contract, plan, acceptance |
| L3 high risk | Security, privacy or wide impact | as L2, two reviews, a decision record and a security or privacy risk | L2 plus a review sign-off |

Modes are `build` (default), `replicate`, `refine` and `redesign`; `replicate` needs at least one
reference file in the UI contract.

## Commands

All commands are `/frontsmith:` and return a usage line when an argument is wrong.

| Command | Arguments | Purpose |
| --- | --- | --- |
| `init` | | Create the project config and the gitignore entry |
| `doctor` | | Check what a run needs |
| `new` | ` [--level L0-L3] [--mode ...] -- ` | Create a feature |
| `status` | `[feature]` | Show one feature or list them |
| `next` | ` [--foreground]` | Run the next unit |
| `answer` | `  -- ` | Answer an open question |
| `approve` | ` spec\|ui-contract\|plan\|acceptance\|config\|review-signoff\|dependency ` | Record a human approval |
| `reject` | ` spec\|ui-contract\|plan\|acceptance -- ` | Send the comments back to the producing phase |
| `waive` | `   --until  -- ` | Waive a rule on some paths until a date |
| `verify-manual` | `  -- ` | Record manual evidence for a criterion |
| `stop` | `` | Abort the running job |
| `resume` | `` | Re-run an interrupted unit |
| `check` | `  [--task T-001]` | Run one gate ad hoc |
| `rules` | `list [pack] \| explain  \| test  \| promote ` | Browse and manage rules |
| `arch` | `init [preset] \| check` | Architecture configuration |
| `tokens` | `check \| generate --family ` | Check tokens or generate a palette |
| `fidelity` | `run  [cases] \| calibrate ` | Visual-fidelity run and calibration |
| `baseline` | `approve  [caseId] \| list ` | Approve reviewed captures as baselines |
| `budget` | `check \| baseline` | Performance budgets |
| `models` | `[check \| set \| unset \| reset \| pick \| explain]` | Per-agent model configuration |
| `dashboard` | `[feature]` | Print the URL of the local review dashboard |

## Tools

| Tool | Effect | Purpose |
| --- | --- | --- |
| `fs_status` | read | Phase, gates, tasks and next command, or the feature list |
| `fs_detect_stack` | read | Package manager, framework, styling and test tooling with evidence |
| `fs_inventory` | read | Components, hooks, stores and design tokens |
| `fs_rules_list` | read | Active rules, with resolution trails |
| `fs_rules_check` | read | Run the rule packs over the workspace |
| `fs_architecture_check` | read | Check imports against `.frontsmith/architecture.json` |
| `fs_tokens_check` | read | Check tokens, themes and required contrast pairs |
| `fs_contrast` | read | WCAG 2.2 contrast for colour pairs |
| `fs_palette_generate` | read | Deterministic palette from the curated catalog |
| `fs_models` | read | The model and source layer of every agent |
| `fs_gate_run` | process | Run one gate and return its report |
| `fs_phase_run` | process | Run the next unit in the agent loop, with progress |
| `fs_budget_check` | process | Check budgets, optionally building first |
| `fs_fidelity_run` | process | Measure and compare the rendered feature |
| `fs_a11y_run` | process | Runtime accessibility checks (axe-core) |

## Configuration

`.frontsmith/config.json` is optional except for `schemaVersion`; unknown keys are rejected with a
diagnostic that names the JSON pointer. A JSON Schema for editors ships in `schemas/`.

```json
{
  "schemaVersion": 1,
  "paths": {
    "artifacts": "docs/frontsmith",
    "sourceRoots": ["src"],
    "themeOutput": "src/styles/frontsmith-tokens.css",
    "tokenFiles": ["src/styles/**/*.css"]
  },
  "defaults": { "level": "L2", "mode": "build" },
  "commands": {
    "typecheck": ["pnpm", "typecheck"],
    "lint": ["pnpm", "lint"],
    "test": ["pnpm", "test"],
    "testRelated": ["pnpm", "vitest", "related", "--run", "{files}"],
    "build": ["pnpm", "build"]
  },
  "accessibility": { "target": "AA" },
  "fidelity": {
    "baseUrl": "http://127.0.0.1:5173",
    "serve": {
      "command": ["pnpm", "dev", "--port", "5173", "--strictPort"],
      "readyUrl": "http://127.0.0.1:5173/",
      "timeoutMs": 60000
    }
  },
  "limits": { "maxBounces": 2, "maxRepairRounds": 3, "maxRemediations": 2 },
  "dashboard": { "enabled": true }
}
```

Commands are argv arrays, never shell strings. Missing commands are inferred from `package.json`
scripts and reported with their source. `defaults.level` only preselects the interactive option; a
headless `new` still needs `--level`. The files under `.frontsmith/` are protected: a child session
that changes them raises a blocker until a person runs `/frontsmith:approve  config`.

## Model configuration

![Model resolution: four layers are checked in order before the agent's default tier applies](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/model-resolution.svg)

Every agent has a tier (`reasoning`, `standard`, `fast`) and every tier defaults to `inherit`, which
uses the model of your session. The plugin cannot know your providers, so binding models is yours.
Five layers apply, highest first: a runtime override (`/frontsmith:models set`), a fenced block in the
project `AGENTS.md`, the `models` key of `.frontsmith/config.json`, the host plugin options, and the
default. Reasoning effort is not part of the host child-session contract, so only models are bound.

````markdown
```frontsmith-models
tier.reasoning = openrouter/anthropic/claude-opus-4.1
tier.standard  = inherit
tier.fast      = openrouter/google/gemini-2.5-flash
agent.fs-reviewer    = @reasoning
agent.fs-implementer = openai/gpt-5-codex
```
````

`/frontsmith:models` shows the effective model and the layer that produced it for each agent,
`/frontsmith:models check` validates every selector with the host, and an invalid layer fails closed
with a diagnostic that names it.

## Rule packs

![Packs are activated by stack and level, merged by precedence, validated and then evaluated](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/rule-packs.svg)

Rules are data: JSON packs evaluated by a closed set of 20 engines. Fifteen packs ship with 130
rules (91 deterministic, 39 advisory): accessibility, architecture, components, CSS, Tailwind,
tokens, performance, testing, governance, design heuristics and the framework packs for React, Next.js,
Vue, Svelte and Angular. A project adds packs under `.frontsmith/packs//pack.json`, extends or
overrides shipped rules with a justification, and silences a minor rule on one line:

```css
/* frontsmith-disable-next-line FS-TOK-002 -- legacy spacing scale kept until the redesign */
```

Blocker and major rules cannot be suppressed; a human waiver (`/frontsmith:waive`) with an expiry date
covers those. `alisio-frontsmith check` and `/frontsmith:rules list|explain|test|promote` browse
them.

## Architecture presets

`/frontsmith:arch init [preset]` writes `.frontsmith/architecture.json` from one of four presets:
`feature-sliced`, `hexagonal`, `layered` or `atomic`. The check reports forbidden layer directions,
cross-slice imports, imports that bypass a public API, cycles (each reported once with its members),
role violations and unmapped files, and resolves `tsconfig` paths and package `imports`. A catalog of
18 patterns is available to the architect, each verified by shipped rules where possible.

## Visual fidelity

![The fidelity loop: measure, compare regions, repair at most three rounds, then accept or fail](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/fidelity-loop.svg)

The pipeline renders the real feature in Chromium at the viewports of the UI contract and measures
the rendered elements against the contract; it then compares regions with human-approved baselines.
It reports local defects that a single global score would hide. Baselines are approved by a person
(`/frontsmith:baseline approve`, never during acceptance) and are valid only for the recorded browser
version and operating system. `/frontsmith:fidelity calibrate` repeats unchanged captures and injects
known defects to derive thresholds; until a region is calibrated its result is `REVIEW`, never
`PASS`. Without Playwright, a browser, a baseline or a calibrated oracle the check is `BLOCKED`.

## Status and resume

![Feature states: phases with human approvals, plus blocked and interrupted states](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/feature-states.svg)

State lives in `docs/frontsmith//` and `.frontsmith/`; writes are atomic and one job per
feature runs at a time. After a host restart, an attempt that was running becomes `interrupted` and
`/frontsmith:resume ` re-runs that unit from its start. State written by a newer Frontsmith
is read-only.

## TUI and web

Commands return Markdown with headings, lists, pipe tables and links; tools return a short text
summary first, then the primary block for that tool, then the primary image. Human approvals ask
through the host question UI with the recommended option marked, and when nothing can answer, the
output shows the exact command to run. The TUI also shows the running phase and job in its footer.

`/frontsmith:dashboard [feature]` starts a review dashboard on `127.0.0.1` with a gate board, the
fidelity composites (reference, actual and diff side by side), the active rules, and approve, reject
and baseline buttons. It uses a random per-run token exchanged for a cookie, checks the `Host` and
`Origin` headers, sets a strict Content-Security-Policy and needs the token in a header for every
change. It is optional (`dashboard.enabled`) and only reachable from the machine that runs Alisio;
through a remote web client use the Dock previews and the tool images instead.

## CLI and CI

`alisio-frontsmith` runs the deterministic part without a session: `detect`, `check`, `arch`,
`tokens`, `contrast`, `palette`, `models`, `gate`, `fidelity`, `budget` and `doctor`. Gates that need
agents report those checks as skipped. Exit codes: `0` PASS, `1` FAIL, `2` usage or environment error,
`3` BLOCKED, `4` REVIEW only; `--json` prints the machine-readable report.

```sh
npx alisio-frontsmith check . --json
npx alisio-frontsmith gate login-form G7 . --json
```

## Architecture

![Interface, application, domain and infrastructure; dependencies point inward](https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/plugin-frontsmith/assets/architecture.svg)

Commands, tools, the CLI and the dashboard are thin front ends over one services facade, so they
cannot drift apart. Dependencies point inward: the domain imports nothing from Node or the host, and
the package runs its own architecture checker over its sources in a test.

## Security

- Identifiers are validated and paths are contained in the workspace; symlink escapes are refused.
- No shell is used anywhere: project commands are argv arrays with timeouts, output caps and a
  scrubbed environment, and never run while a protected file is tampered with.
- Child output is untrusted: strict envelopes, size caps, unknown keys rejected, never executed and
  never rendered as HTML.
- The browser probe only visits the configured loopback `baseUrl` and blocks other origins unless
  the contract lists them. Evidence stays in the git-ignored `.alisio/frontsmith/`.
- The dashboard binds to loopback only and protects every request as described above.

## Limitations

- Pre-release: see "Status" for what has only been verified with fakes.
- Custom agents are planned, not shipped. The `agents.custom` key is accepted so that model bindings
  can already name an agent, but no custom agent is loaded or run in this release.
- Flow-annotated JavaScript is not parsed; unparsable files are reported for review and skipped.
- Line-count checks in the fidelity pipeline are approximate and map to `REVIEW`.
- Baselines are not portable across browser versions or operating systems.

## License

MIT
