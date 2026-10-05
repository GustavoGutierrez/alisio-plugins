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

## Execution Steps

1. Copy the package shape, not product behavior, from an existing package.
2. Write metadata, README, LICENSE, source, and tests as one work unit.
3. Register resources relative to the built entry and include them in `files`.
4. Run `pnpm check` and inspect the generated tarball through `pnpm pack:check`.

## Output Contract

Report package name and ID, dependencies, resources, tests, and exact check results.

## References

- `../../../AGENTS.md`
