---
name: create-alisio-plugin
description: "Trigger: create plugin, scaffold plugin, add Alisio plugin. Build an independent publishable package using repository conventions."
license: Apache-2.0
metadata:
  author: "alisio-contributors"
  version: "1.0"
---

## Activation Contract

Load this skill before creating or restructuring a package under `packages/`.

## Hard Rules

- Name the package `@alisio/plugin-*`; give the runtime plugin a valid stable ID.
- Put the package in `packages/plugin-<name>` (same `<name>` as the npm name) and point `repository.directory`
  and `homepage` at it; diagram sources go in `diagrams/plugin-<name>/`.
- Choose a short unique resource prefix (2-5 lowercase letters) and prefix EVERY agent and skill name
  (file/directory, frontmatter `name`, references). Check the prefix is unused in the monorepo
  (`ls packages/*/.agents/agents packages/*/.agents/skills`). Never ship generic names like `coder` or `planner`.
- Depend on no plugin or `@alisio/core`. Keep runtime dependencies minimal.
- Ship ESM JavaScript, declarations, README, MIT LICENSE, and all registered resources.
- Keep `@alisio/sdk` in peer and dev dependencies, never as a workspace dependency.
- Validate paths and external output before mutation; use atomic durable writes.
- Add tests and never invent remote metadata.

## Decision Gates

| Need | Action |
| --- | --- |
| SDK contract | Import from `@alisio/sdk` only |
| General utility | Prefer a Node built-in |
| Shared plugin logic | Duplicate a small stable primitive or create a non-plugin library only with maintainer approval |
| Model should act | Tool (`api.tools.register`) |
| One-shot user action | Command (`api.commands.register`) |
| Read-only output in the chat | View |
| A full working surface (editor, studio, dashboard) | Plugin app (`api.apps?.register`, Alisio >= 0.11.5) |

## Plugin Apps Rules

Source of truth: the site guide's "Plugin apps" section and the `@alisio/sdk` types
(`PluginAppDefinition`, `PLUGIN_APP_LIMITS`). Do not use the original apps spec.

- Feature-detect: register tools/commands/views first, then `if (api.apps) api.apps.register(...)`;
  explain the minimum host (Alisio 0.11.5) in help text and never open a separate UI as a fallback.
  A plugin that needs its app uses peer `@alisio/sdk >=0.11.5 <0.12.0`.
- Lifecycle: register in `setup`; `register()` returns an unregister function; `dispose` is
  synchronous and idempotent; `busy()` returns `true` during background work; keep state per activation.
- Actions: declare `effect` and an `inputSchema` without `$ref`/`$id`/`$async`; from Alisio 0.11.6 an
  effect the chat would ask about shows the chat's approval prompt, and a denial returns
  `not_permitted` with `effect: "write" | "process"` (name the missing permission to the user; 0.11.5
  never prompts). Calls time out at 30 s from handler start, not while approval waits (up to 10 min),
  so keep the frame's own response guard longer than that (honor `ctx.signal`, return a job id for long work);
  take the session from `ctx`; return JSON-serializable results; never echo inputs or secrets in errors.
- Frame: `nonce="__ALISIO_NONCE__"` on every inline script; no `<form>` submits; no network, external
  URLs, `eval` or WebAssembly; inline assets or use `data:`/`blob:`; opaque origin.
- Transport: accept only the first `alisio.app.connect` whose `event.source === window.parent`, keep
  its port, follow `locale` messages, pause on hidden `visibility`, show "unavailable" on `not_found`.
- i18n: labels `{ en, es }` with `en` as fallback; no own language selector.
- Tests: unit-test handlers and the HTML builder (nonce present, no external URLs, no forms); check
  visually with `alisio serve` 0.11.5+.

## Execution Steps

1. Copy the package shape, not product behavior, from an existing package.
2. Write metadata, README, LICENSE, source, and tests as one work unit.
3. Register resources relative to the built entry and include them in `files`.
   Ship a 16:9 `cover.svg` (1600×900) and a square `icon.svg` (512×512) at the package root, both
   listed in `files`, plus `"alisio": { "icon": "icon.svg" }` in `package.json`; follow the site guide's "Cover and icon artwork" rules.
4. Run `pnpm check` and inspect the generated tarball through `pnpm pack:check`.

## Output Contract

Report package name and ID, dependencies, resources, tests, and exact check results.

## References

- `../../../AGENTS.md`
