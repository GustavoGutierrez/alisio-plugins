# Wayfinder

Wayfinder is a self-contained Alisio plugin for running resumable, specification-driven changes.
A deterministic coordinator owns transitions, gates, and durable state. Fresh child sessions
perform bounded analysis, implementation, and verification from package-owned agent and skill
resources.

Wayfinder is independent of other plugins, but it is not a standalone executable. It requires
Alisio, an active Alisio session, and a configured model.

## Quick path

Install it persistently through Alisio:

```bash
alisio install npm:@alisio/plugin-wayfinder
```

For project-local development instead:

```bash
npm install --save-dev @alisio/plugin-wayfinder
alisio --plugin @alisio/plugin-wayfinder
```

```text
/wayfinder:new add-health-check -- Expose a health endpoint for load balancers
/wayfinder:next add-health-check
/wayfinder:status add-health-check
```

Each `next` invocation runs at most one phase. Follow the command shown by `status`. Open questions
use `/wayfinder:answer <change> -- <clarification>`. Proposal and plan approval use
`/wayfinder:approve <change> <proposal|plan>`.

## Complete workflow

```text
/wayfinder:new add-health-check -- Expose a health endpoint for load balancers
/wayfinder:next add-health-check       # discovery
/wayfinder:next add-health-check       # proposal
/wayfinder:approve add-health-check proposal
/wayfinder:next add-health-check       # specification
/wayfinder:next add-health-check       # design
/wayfinder:next add-health-check       # plan
/wayfinder:approve add-health-check plan
/wayfinder:build add-health-check      # repeat once per pending unit
/wayfinder:verify add-health-check
/wayfinder:close add-health-check
```

Use `/wayfinder:status add-health-check` at any point to recover the next action. If a phase reports
a critical question, answer it and retry the same phase:

```text
/wayfinder:answer add-health-check -- Only authenticated internal load balancers may access it
/wayfinder:next add-health-check
```

## Architecture

The TypeScript `WayfinderCoordinator` is the workflow authority. It validates child JSON, enforces
gates, replaces each persisted file atomically, and advances durable state under
`.alisio/wayfinder/changes/<change>/`. Artifact and state updates are separate writes rather than one
cross-file transaction.

Runtime role instructions live in `.agents/agents`, while focused phase contracts live in
`.agents/skills`. Direct child sessions load and inline those canonical files, so execution does
not depend on skill discovery. TypeScript profiles define the effective permissions and limits for
this direct execution path; agent frontmatter describes the equivalent catalog-facing contract.

| Agent | Responsibility | Capabilities |
| --- | --- | --- |
| `coordinator` | Inspectable catalog-facing guidance; it is not the TypeScript workflow authority | Read-only, no process |
| `discoverer` | Repository evidence and critical questions | Read-only, no process |
| `proposer` | Approval-ready outcome and boundaries | Read-only, no process |
| `specifier` | Observable requirements | Read-only, no process |
| `designer` | Lean technical approach | Read-only, no process |
| `planner` | Ordered units and complete coverage | Read-only, no process |
| `implementer` | One approved work unit | Write and process |
| `verifier` | Independent evidence and checks | Read-only, process allowed |
| `archivist` | Archive-readiness inventory | Read-only, no process |

Each agent links one focused skill: `wayfinder-coordinate`, `wayfinder-discover`,
`wayfinder-propose`, `wayfinder-specify`, `wayfinder-design`, `wayfinder-plan`,
`wayfinder-implement`, `wayfinder-verify`, or `wayfinder-archive`. Child phases cannot delegate.

## Lifecycle and gates

```text
intent -> discovery -> proposal -> proposal approval -> specification -> design
       -> plan -> plan approval -> one-unit implementation -> independent verification
       -> archive readiness -> archive
```

Advancement stops on critical questions, malformed or turn-limited output, incomplete plan or
verification coverage, missing implementation paths/check evidence, unfinished units, failed
verification, or incomplete archive inventory. Failed verification creates at most two resumable
remediation units. Implementation reports are context only; the verifier must inspect current files
and run focused commands independently. Wayfinder does not claim immutable Git provenance.

Proposal and plan approval are explicit. In an interactive UI, `next` asks one concise confirmation.
In headless use, it returns an actionable blocked status and requires `approve`; scope is never
silently accepted.

## Commands

| Command | Purpose |
| --- | --- |
| `/wayfinder:new <name> -- <intent>` | Create durable intent and state |
| `/wayfinder:status [name]` | List changes, or show detailed progress and the next action when a name is provided |
| `/wayfinder:answer <name> -- <text>` | Append clarification during discovery, proposal, or specification |
| `/wayfinder:next <name>` | Run exactly one analytical phase, or request a pending approval |
| `/wayfinder:approve <name> <proposal\|plan>` | Record explicit approval |
| `/wayfinder:build <name>` | Implement exactly one pending unit |
| `/wayfinder:verify <name>` | Independently verify every requirement exactly once |
| `/wayfinder:close <name>` | Validate readiness and move the change to archive |

Change names must contain 1–48 lowercase letters, digits, or hyphens and must start with a letter or
digit.

## Persistence and recovery

Active changes use:

```text
.alisio/wayfinder/changes/<change>/
├── state.json
├── intent.md
├── clarifications.md       # when needed
├── discovery.md
├── proposal.md
├── specification.md
├── design.md
├── plan.md
├── progress.md
├── verification.md
└── archive-readiness.md
```

Closed changes move to `.alisio/wayfinder/archive/YYYY-MM-DD-<change>/` and no longer appear in the
active change list. Individual files use temporary-file replacement with mode `0600`. Archive uses
a directory rename followed by a closed-state write with best-effort rollback if that write fails;
it is not a crash-proof multi-operation transaction.

Do not edit these files while commands are running. Wayfinder does not currently lock a change
against concurrent commands, so run only one Wayfinder command for a given change at a time.

Recovery rules:

- For malformed or turn-limited child output, retry the same phase after correcting the cause.
- For critical questions, run `answer` and then retry `next`.
- Run `build` repeatedly until every planned unit is complete.
- Failed verification may create up to two resumable remediation units.
- After the remediation limit is exhausted, the change remains in verification and requires human
  reassessment rather than another automatic loop.

## Requirements and capability boundaries

| Requirement | Value |
| --- | --- |
| Node.js | `>=22.16` |
| Alisio SDK peer | `>=0.1.0-alpha.9 <0.2.0` |
| Runtime dependencies | Node.js built-ins and `@alisio/sdk` only |

Child capabilities can only narrow the active parent session. The implementer needs parent write and
process capabilities; the verifier needs process capability. Without them, those phases cannot
complete.

## Standalone behavior

The package imports only `@alisio/sdk` and Node built-ins; it never imports another plugin or
`@alisio/core`. It registers `../.agents/agents` and `../.agents/skills` for inspection and future
catalog interoperability. Current Alisio activation order can prevent newly registered external
agents from appearing in the built-in subagents catalog. Wayfinder therefore treats direct
`api.sessions.create/run` execution as primary and loads the same packaged resources itself.

Memory support is optional, fail-open, and read-only. If `memory_search` and `memory_get` survive
Alisio's parent-capability intersection, a child may use privacy-safe high-level context. Memory is
never lifecycle authority, required evidence, or a destination for source, secrets, prompts,
personal data, or absolute paths.

External plugins execute inside the Alisio process with the user's privileges. Agent permissions,
read-only profiles, and tool allowlists reduce model capabilities but are not an operating-system
sandbox. Review the package before loading it.

## Links

- [Source](https://github.com/GustavoGutierrez/alisio-plugins/tree/main/packages/wayfinder)
- [Issues](https://github.com/GustavoGutierrez/alisio-plugins/issues)
