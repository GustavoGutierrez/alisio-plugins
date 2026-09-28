# Wayfinder

Wayfinder is a self-contained Alisio plugin for a resumable, specification-driven change lifecycle.
A deterministic coordinator owns transitions and atomic persistence; fresh child sessions perform
bounded analysis, implementation, and verification from package-owned agent and skill resources.

## Quick path

```bash
npm install --save-dev @alisio/plugin-wayfinder
alisio --plugin @alisio/plugin-wayfinder
```

```text
/wayfinder:new add-health-check -- Expose a health endpoint for load balancers
/wayfinder:next add-health-check
/wayfinder:status add-health-check
```

Follow the command shown by `status`. Open questions use
`/wayfinder:answer <change> -- <clarification>`. Proposal and plan approval use
`/wayfinder:approve <change> <proposal|plan>`.

## Architecture

The coordinator validates child JSON, enforces gates, and atomically writes durable state under
`.alisio/wayfinder/changes/<change>/`. TypeScript owns phase metadata, permissions, limits, and
validators. Runtime role instructions live only in `.agents/agents`, while focused phase contracts
live in `.agents/skills`. Direct child sessions load and inline those canonical files, so execution
does not depend on skill discovery.

| Agent | Responsibility | Capabilities |
| --- | --- | --- |
| `coordinator` | Inspectable command interoperability | Read-only, no process |
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
       -> archive readiness -> atomic archive
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
| `new <name> -- <intent>` | Create durable intent and state |
| `status [name]` | Show phase, progress, remediation count, and next action |
| `answer <name> -- <text>` | Add clarification to a blocked early phase |
| `next <name>` | Run discovery through planning, or request approval |
| `approve <name> <proposal\|plan>` | Record explicit approval |
| `build <name>` | Implement exactly one pending unit |
| `verify <name>` | Independently verify every requirement exactly once |
| `close <name>` | Validate readiness and atomically move the change to archive |

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

External plugins are trusted code. Review the package before loading it.

## Links

- [Source](https://github.com/GustavoGutierrez/alisio-plugins/tree/main/packages/wayfinder)
- [Issues](https://github.com/GustavoGutierrez/alisio-plugins/issues)
