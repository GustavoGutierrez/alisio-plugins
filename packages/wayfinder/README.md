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
/wayfinder:tdd add-health-check strict -- drive the new behavior test-first
/wayfinder:approve add-health-check plan
/wayfinder:build add-health-check      # repeat once per pending unit
/wayfinder:verify add-health-check     # verification passes, mutation decision required
/wayfinder:mutate add-health-check run -- cover the new branch
/wayfinder:verify add-health-check     # runs the bounded mutation check
/wayfinder:close add-health-check
```

Mutation testing is recommended, but the developer decides. Record `run` or `skip` with a reason
before archive; the decision is immutable per change. Skipping is fine when justified.

Test-first is also recommended and developer-decided. Record `strict` or `off` with a reason before
approving the plan; the decision is immutable per change.

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
| `mutationist` | One bounded mutation run on already-installed tooling | Read-only, process allowed |
| `archivist` | Archive-readiness inventory | Read-only, no process |

Each agent links one focused skill: `wayfinder-coordinate`, `wayfinder-discover`,
`wayfinder-propose`, `wayfinder-specify`, `wayfinder-design`, `wayfinder-plan`,
`wayfinder-implement`, `wayfinder-verify`, `wayfinder-mutate`, or `wayfinder-archive`. Child phases
cannot delegate.

## How agents communicate

Agents never call each other directly and do not inherit another agent's conversation. Every phase
communicates through the TypeScript `WayfinderCoordinator` and durable artifacts:

```text
User command
  -> WayfinderCoordinator loads one agent and its matching skill
  -> coordinator creates a fresh, capability-narrowed child session
  -> child returns one phase-specific JSON result
  -> coordinator validates the complete result
  -> coordinator renders the validated result as a Markdown artifact
  -> coordinator updates state.json
  -> a later phase receives the relevant persisted artifacts as context
```

The coordinator uses `api.sessions.create` and `api.sessions.run` for each phase. A malformed,
partial, turn-limited, or schema-invalid response is rejected before state advances. The child
session cannot write lifecycle state directly; even the implementer may modify only the assigned
workspace unit and must return evidence to the coordinator.

This artifact-mediated handoff keeps phases independently resumable. For example, the specifier
works from the approved proposal, the planner works from the specification and design, and the
verifier checks the implemented workspace against the persisted requirements. Agent definitions
also deny `task`, `delegate`, `subagent`, and `sessions_create`, so no phase can create a hidden
delegation chain.

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

Passing verification no longer advances straight to archive: it exposes an explicit mutation-testing
decision gate. There is no implicit skip. In an interactive UI the coordinator asks one concise
question and persists the answer; headless use returns an actionable blocked status naming
`/wayfinder:mutate`. Verification that passes without a recorded decision cannot reach archive.

Proposal and plan approval are explicit. In an interactive UI, `next` asks one concise confirmation.
In headless use, it returns an actionable blocked status and requires `approve`; scope is never
silently accepted. Plan approval additionally requires a recorded test-first decision for changes
created by the current code; without it, the transition to implementation is blocked and
`/wayfinder:tdd` is named. A change already past plan approval from an earlier version is
grandfathered and is not retroactively gated (see the TDD section).

## Mutation testing

Mutation testing is recommended, but the developer decides. The decision, mode, tool, stack, and
reason are persisted per change and are immutable.

| Topic | Behavior |
| --- | --- |
| Decision gate | `verify` cannot advance to archive until `/wayfinder:mutate <change> run\|skip -- <reason>` is recorded |
| `skip` | Verification passed → advance to archive. Verification pending → archive after it passes |
| `run` | Instructs `/wayfinder:verify`, which runs the bounded mutation check |
| Tooling | Only tooling already present in the project; never installed, never added as a dependency |
| Unavailable | Persists `unavailableReason` and advances to archive without blocking |
| Survivors | Only non-equivalent survivors fail; an equivalent survivor needs a written justification |
| Failure | Creates one `test-strengthening` unit for the affected requirements and survivor files |
| Targeted recovery | Re-runs mutation over the prior scope, then re-verifies only the affected requirement ids |
| Budget | Mutation remediation is separate and bounded to two attempts, then stops for human reassessment |

Bounds: changed-scope cap `20` files, reported-survivor cap `50`, child timeout `600000` ms, and the
concurrency bound `2` applied only where the tool supports it. Survivor text is never interpolated
into a command; the mutationist receives an argument list and never edits files.

Scope capability: some tools accept a bounded file scope, others can only mutate the whole
repository. A bounded (`--mode changed`) decision never silently expands to whole-repo.

| Tool | Bounded scope | Concurrency bound |
| --- | --- | --- |
| Stryker (JS/TS) | `--mutate` paths | applied (`--concurrency 2`) |
| `cargo-mutants` (Rust) | `--file` paths | applied (`--jobs 2`) |
| `gremlins` (Go) | positional package/path patterns | applied (`--workers 2`) |
| `go-mutesting` (Go) | positional patterns | not applied |
| `mutmut` (Python) | `--paths-to-mutate` | not applied |
| `cosmic-ray` (Python) | whole repository only | not applied |
| `pitest` (Java) | whole repository only | not applied |

For a whole-repository-only tool, a `changed`-mode run is refused rather than silently expanded;
re-run with `--mode full` to allow it explicitly. The refusal is non-blocking: the reason is
persisted and the change advances to archive.

Test-strengthening enforcement: a `test-strengthening` unit is accepted only when every reported
changed path is a test path (`test/`, `tests/`, or `__tests__/` segments, a bare `test`/`tests`/
`spec`/`specs` filename, or `.test.`, `.spec.`, `_test.`, `Test.`, `Spec.` filenames). A production
edit is rejected and the unit stays pending.

This guardrail applies only to the paths the implementing child reports and uses a filename/directory
heuristic, so a production file placed under a `test`-style directory or named `*Test.*`/`*Spec.*`
can pass it. The independent verifier still inspects the workspace, so this is a guardrail, not a
hard sandbox.

Detection uses the project's own manifests and lockfiles:

| Stack | Marker | Already-installed tools |
| --- | --- | --- |
| JavaScript/TypeScript | `package.json` | Stryker (`@stryker-mutator/*` or local binary/config) |
| Rust | `Cargo.toml` | `cargo-mutants` |
| Python | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `tox.ini` | `mutmut`, `cosmic-ray` |
| Go | `go.mod` | `gremlins`, `go-mutesting` |
| Java | `pom.xml`, `build.gradle`, `build.gradle.kts` | `pitest` |

When nothing is detected, the coordinator recommends and continues without blocking.

## Test-first (TDD)

TDD is recommended, but the developer decides. The decision is persisted per change, is immutable,
and gates plan approval. There is no implicit default.

| Topic | Behavior |
| --- | --- |
| Gate position | Approving the plan cannot transition to implementation until `/wayfinder:tdd <change> strict\|off -- <reason>` is recorded |
| Recommendation | `strict` when the plan has non-exempt units; `off` only when every unit is exempt |
| `off` | No test-first evidence is required for any unit |
| `strict` | Non-exempt units must provide test-first evidence (see below) |
| Exemption | A unit marked `tddExempt: true` must carry a non-blank `tddExemptReason` (whitespace-only is rejected); exemptions are irrelevant when the decision is `off` |
| Grandfathering | A change already past plan approval without a decision predates this gate and is not retroactively gated; every change created by the current code must record a decision at plan approval |
| Immutability | A second `/wayfinder:tdd` call is rejected |

Under `strict`, an implementation result for a non-exempt unit is rejected (the unit stays pending and
no state advances) unless it reports all of:

- at least one test path in `changedPaths`;
- a `testFirst` object with a failing run before the change and a passing run after;
- the failing and passing runs referencing the same test scope (identical command).

The rejection message names the required scope and the next command. Mutation-generated
`test-strengthening` units are already test-scoped, so they are exempt from the test-first evidence.

Enforcement is report-based and applies only to the paths and commands the implementing child
returns, using a filename/directory heuristic: a production file placed under a `test`-style directory
or named `*Test.*`/`*Spec.*` can pass, and a fabricated failing run is not independently detected.
The independent verifier still inspects the workspace and runs focused checks, so this is a guardrail,
not a sandbox.

Legacy grandfather policy: a change that reached implementation before this gate existed has no
recorded decision and is intentionally neither blocked nor retroactively gated; it proceeds through
implementation and verification without test-first enforcement. Every change created by the current
code must record a decision at plan approval. This policy is pinned by a test so it cannot drift.

## Commands

| Command | Purpose |
| --- | --- |
| `/wayfinder:new <name> -- <intent>` | Create durable intent and state |
| `/wayfinder:status [name]` | List changes, or show detailed progress and the next action when a name is provided |
| `/wayfinder:answer <name> -- <text>` | Append clarification during discovery, proposal, or specification |
| `/wayfinder:next <name>` | Run exactly one analytical phase, or request a pending approval |
| `/wayfinder:approve <name> <proposal\|plan>` | Record explicit approval |
| `/wayfinder:tdd <name> <strict\|off> -- <reason>` | Record the immutable test-first decision before plan approval |
| `/wayfinder:mutate <name> <run\|skip> [--mode changed\|full] -- <reason>` | Record the immutable mutation-testing decision |
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
├── verification-targeted.md   # after mutation remediation
├── mutation.md                # when a decision or run is recorded
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
- Mutation testing requires an explicit `/wayfinder:mutate` decision before archive.
- Non-equivalent survivors create a `test-strengthening` unit; strengthen tests only, never change
  production behavior to satisfy the tool.
- Mutation remediation has its own budget of two attempts, separate from verification remediation.

## Requirements and capability boundaries

| Requirement | Value |
| --- | --- |
| Node.js | `>=22.16` |
| Alisio SDK peer | `>=0.1.0-alpha.9 <0.2.0` |
| Runtime dependencies | Node.js built-ins and `@alisio/sdk` only |

Child capabilities can only narrow the active parent session. The implementer needs parent write and
process capabilities; the verifier and mutationist need process capability. Without them, those
phases cannot complete.

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
