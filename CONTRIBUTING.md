# Contributing to Alisio plugins

Thanks for contributing. This repository publishes independent `@alisio/plugin-*` packages, so a
change is reviewed as a package, not as a monolith. The authoring reference is
[docs/developing-plugins.md](./docs/developing-plugins.md).

## Quick path

```bash
corepack enable
pnpm install
pnpm check
```

## Add a plugin

1. Scaffold `packages/<name>/` following the package shape of the existing packages. Copy the
   *shape*, not product behaviour.
2. Set the package name to `@alisio/plugin-*` and include the `alisio-plugin` keyword.
3. Ship ESM JavaScript and declarations from `dist`, target Node `>=22.16`, and keep `@alisio/sdk`
   in both `peerDependencies` and `devDependencies`.
4. Include a description, a concise README with basic usage, its own MIT `LICENSE`, unit tests, and
   every resource it registers.
5. Never import another plugin or `@alisio/core`.
6. Load the project skill `.agents/skills/create-alisio-plugin/SKILL.md` before creating or
   restructuring a package.

## Required checks

| Command | What it verifies |
| --- | --- |
| `pnpm check` | `lint`, `typecheck`, `test`, `build`, and `pack:check` across every package. |
| `pnpm diagrams:check` | Every committed SVG is newer than its `.mmd` source (a local authoring aid). |

Run `pnpm check` before opening a pull request. `pnpm diagrams:check` is not part of `pnpm check`
because it compares mtimes, not content hashes; re-render with `pnpm diagrams` when you touch a
diagram.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`,
`chore:`, `test:`, `refactor:`). Keep each commit one reviewable work unit.

**Never add AI attribution.** No `Co-Authored-By` trailer naming an AI, no "Generated with" lines,
no AI tooling in the author or committer fields.

## Language policy

- **Bilingual, kept in sync (English + Spanish):** `README.md` / `README.es.md`, and
  `docs/` / `docs/es/`. Each pair links to its mirror and the two are updated in the same change.
  Spanish is neutral and professional.
- **English only:** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `AGENTS.md`, all source,
  all package READMEs, all code comments, and every diagram label.

## Testing and documentation expectations

- Unit tests are required; cover at least one happy path and one unhappy path per functional
  scenario.
- Strict TDD is an optional, explicitly recorded decision, not a default.
- Update the README of a package when its behaviour, commands, or options change.
- Update `docs/developing-plugins.md` **and** `docs/es/developing-plugins.md` together when the
  authoring contract changes.
- Use Changesets for versions: run `pnpm changeset`, describe the public change, and include it in
  the pull request.

## Pull requests

- Keep the change focused on one package or one concern where possible.
- State what changed, why, and the exact check results (`pnpm check`).
- Note what is intentionally out of scope.
- Reference the issue the change addresses when one exists.
- Expect a review of metadata, tests, licensing, packaged resources, and documentation.

## Security

Read [SECURITY.md](./SECURITY.md) before changing anything related to load, trust, or installation.
Plugins are trusted code: never imply a sandbox that does not exist.
