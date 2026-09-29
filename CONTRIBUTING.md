# Contributing to Alisio plugins

Thanks for contributing. This repository publishes independent `@alisio/plugin-*` packages, so a
change is reviewed as a package, not as a monolith. The authoring reference is
[site/developing-plugins.md](./site/developing-plugins.md).

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
| `pnpm check` | `lint`, `leak:check`, `typecheck`, `test`, `build`, and `pack:check` across every package; `pack:check` also runs the leak scanner over each tarball it builds. |
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
  `site/` / `site/es/`. Each pair links to its mirror and the two are updated in the same change.
  Spanish is neutral and professional.
- **English only:** `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `AGENTS.md`, all source,
  all package READMEs, all code comments, and every diagram label.

## Testing and documentation expectations

- Unit tests are required; cover at least one happy path and one unhappy path per functional
  scenario.
- Strict TDD is an optional, explicitly recorded decision, not a default.
- Update the README of a package when its behaviour, commands, or options change.
- Update `site/developing-plugins.md` **and** `site/es/developing-plugins.md` together when the
  authoring contract changes.
- Use Changesets for versions: run `pnpm changeset`, describe the public change, and include it in
  the pull request.

## Releasing

Releases are explicit and dry-run first. Nothing is published without an authorized operator and
working npm authentication.

Prerequisite (once per machine):

```bash
npm login        # or export NPM_TOKEN with publish rights on the @alisio scope
npm whoami       # must print your username
```

Bump and publish one package:

```bash
pnpm bump-one -- @alisio/plugin-<name> patch --summary "Public change summary"
pnpm publish-one -- @alisio/plugin-<name>             # dry run: preflight, test, build, pack check
pnpm publish-one -- @alisio/plugin-<name> --publish   # real publish (--otp <code> for 2FA)
```

Preview or publish every package:

```bash
pnpm publish-all           # dry run for every package
pnpm publish-all --publish # real publish for every package
```

Rules the tooling enforces: the working tree must be clean and committed; `package.json` and
`src/version.ts` must agree; a version already on the registry is refused; dist-tags default to
`latest` and to `next` for prerelease versions (`--tag` overrides). `pnpm bump-one` writes one
changeset, then runs `changeset version`, which applies **every** pending changeset, not just the
one it wrote. For the first release, delete changesets already contained in the shipped version
before publishing. `pnpm release:changesets` (alias `pnpm release`) is the Changesets-native,
tag-creating flow driven by CI; `pnpm publish-all` is the explicit preflighted flow. They are not
interchangeable.


## Never commit secrets

This repository must never contain a local machine path or a credential — not in the working tree and
not in a published package. Two layered guards enforce it. `pnpm leak:check` scans every tracked file,
and `pnpm pack:check` packs each publishable package and runs the same leak scanner over the tarball
that would ship. The release preflight repeats the tarball scan before publishing.

```bash
pnpm leak:check                                    # scan tracked files
node scripts/leak-check.mjs --tarball <file.tgz>   # scan a packed archive
node scripts/leak-check.mjs --package <name>       # pack one package and scan it
```

Both run inside `pnpm check`, so a leak fails the pull request; the release preflight blocks the
release. The report names the file, the line, and the rule; a credential-shaped match is redacted, so
the guard never prints a secret.

If a leak is found: remove the material from the source — replace an absolute path with a relative one
or `os.homedir()`/`os.tmpdir()`, and move any credential to an environment variable — rebuild if the
value was baked into `dist`, then rerun `pnpm leak:check` and `pnpm pack:check` (both are in
`pnpm check`). If a real credential was ever committed, rotate it; deleting the file is not enough
because history keeps it.


## Pull requests

- Keep the change focused on one package or one concern where possible.
- State what changed, why, and the exact check results (`pnpm check`).
- Note what is intentionally out of scope.
- Reference the issue the change addresses when one exists.
- Expect a review of metadata, tests, licensing, packaged resources, and documentation.

## Security

Read [SECURITY.md](./SECURITY.md) before changing anything related to load, trust, or installation.
Plugins are trusted code: never imply a sandbox that does not exist.
