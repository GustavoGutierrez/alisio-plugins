# Repository guidance

## Non-negotiable package rules

- Name every publishable package `@alisio/plugin-*` and include the `alisio-plugin` keyword.
- Keep plugins independently installable and self-contained. Never import another plugin or `@alisio/core`.
- Prefer Node built-ins and `@alisio/sdk`; add an npm dependency only when its value outweighs its maintenance cost.
- Use English for source, prompts, schemas, tests, documentation, and package metadata.
- Every package needs an accurate description, concise README with basic usage, its own MIT `LICENSE`, and unit tests.
- Ship ESM JavaScript and declarations from `dist`, target Node `>=22.16`, and keep `@alisio/sdk` as peer and dev dependency.
- Validate untrusted names, paths, and child-session output. Persist durable data atomically.
- Keep optional built-in integrations fail-open and capability-narrowed; never use them as the
  source of truth for plugin lifecycle state or required artifacts.
- Substantial methodology plugins ship package-local `.agents/agents` definitions and multiple
  focused `.agents/skills` contracts, then use those same files for catalog registration and direct
  child-session instructions.
- Do not add repository, homepage, or bugs metadata until a real remote exists.

## Required checks

Run `pnpm check` before review. The dynamic pack check verifies names, metadata, exports, files,
licenses, READMEs, built JavaScript/types, and packaged resources for every publishable package.
Use Changesets for semantic versions; never hand-publish without a prepared version.

## Project skills

- `.agents/skills/create-alisio-plugin/SKILL.md` — load when creating or restructuring a plugin package.
- `.agents/skills/release-alisio-plugin/SKILL.md` — load when versioning, packing, or publishing packages.
