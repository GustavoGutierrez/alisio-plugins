# Repository guidance

## Non-negotiable package rules

- Name every publishable package `@alisio/plugin-*` and include the `alisio-plugin` keyword.
- Keep the directory, npm name and metadata aligned: the package for `@alisio/plugin-<name>` lives in
  `packages/plugin-<name>`, and its `repository.directory` and `homepage` point at that same path. Its
  diagram sources live in `diagrams/plugin-<name>/`. Never rename a published package's npm name; a
  directory or resource rename ships with a Changeset.
- Give every plugin a short, unique **resource prefix** (2 to 5 lowercase letters, e.g. `wf-` for
  wayfinder, `swarm-` for swarm, `thesis-` for thesis) and apply it to **every agent and skill name**
  the plugin ships, in file names, frontmatter `name`, and every reference. Generic names such as
  `specifier`, `coder`, `reviewer` or `planner` collide with other plugins and the host catalog, so they
  are never allowed unprefixed. The prefix is distinct from every prefix already used in the monorepo.
  Commands and tools are already namespaced by plugin id and need no prefix.
- Keep plugins independently installable and self-contained. Never import another plugin or `@alisio/core`.
- Prefer Node built-ins and `@alisio/sdk`; add an npm dependency only when its value outweighs its maintenance cost.
- Use English for source, prompts, schemas, tests, documentation, and package metadata.
- Every package needs an accurate description, concise README with basic usage, its own MIT `LICENSE`, and unit tests.
- Ship ESM JavaScript and declarations from `dist`, target Node `>=22.16`, and keep `@alisio/sdk` as peer and dev dependency.
- Validate untrusted names, paths, and child-session output. Persist durable data atomically.
- Never commit a local machine path or a credential. `pnpm check` runs `leak:check` over every tracked
  file and `pack:check` over each packed tarball; the release preflight rescans each tarball, and a
  finding blocks the release. Credential-shaped findings are reported redacted, never printed.
- Keep optional built-in integrations fail-open and capability-narrowed; never use them as the
  source of truth for plugin lifecycle state or required artifacts.
- Substantial methodology plugins ship package-local `.agents/agents` definitions and multiple
  focused `.agents/skills` contracts, then use those same files for catalog registration and direct
  child-session instructions.
- Declare `repository`, `homepage`, and `bugs` metadata in every publishable package, pointing at the
  real remote `https://github.com/GustavoGutierrez/alisio-plugins`, and keep them consistent across
  the monorepo. Include the package `directory` in `repository` metadata.

## Language policy

- **Bilingual, kept in sync (English + Spanish):** repo-level user-facing docs — `README.md` /
  `README.es.md` and everything under `site/` / `site/es/`. Each pair links to its mirror, states
  that the two must be updated together, and is updated in the same change. Spanish is neutral and
  professional.
- **Bilingual package READMEs (exception, owner-approved):** `packages/plugin-thesis/README.md` /
  `README.es.md`, `packages/plugin-swarm/README.md` / `README.es.md`,
  `packages/plugin-frontsmith/README.md` / `README.es.md` and
  `packages/plugin-evalua/README.md` / `README.es.md`, under the same pairing rules as the
  repo-level docs. Usage samples under
  `packages/plugin-thesis/samples/` may be written in the language of the thesis they illustrate.
- **English only:** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, this file, all source,
  all other package READMEs, all code comments, and every diagram label.

## Required checks

Run `pnpm check` before review; CI runs the same command on pull requests. It chains `lint`,
`leak:check`, `typecheck`, `test`, `build`, and `pack:check`. The dynamic pack check verifies names,
metadata, exports, files, licenses, READMEs, built JavaScript/types, and packaged resources for every
publishable package, and runs the leak scanner over each tarball it builds; its resource policy is
documented in the header of `scripts/pack-check.mjs`. The leak check rejects local machine paths and
credential shapes in tracked files (`leak:check`) and in each packed tarball (`pack:check`); its rules
and allowlist are documented in the header of `scripts/leak-check.mjs`.
Run `pnpm diagrams:check` separately after touching a diagram (it is an mtime-based authoring aid,
not a CI gate). Use Changesets for semantic versions; never hand-publish without a prepared version.

## Project skills

- `.agents/skills/create-alisio-plugin/SKILL.md` — load when creating or restructuring a plugin package.
- `.agents/skills/release-alisio-plugin/SKILL.md` — load when versioning, packing, or publishing packages.
- `.agents/skills/plugin-diagrams/SKILL.md` — load when authoring Mermaid diagrams or rendering them to SVG.
