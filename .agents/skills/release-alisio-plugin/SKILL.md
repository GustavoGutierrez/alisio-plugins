---
name: release-alisio-plugin
description: "Trigger: changeset, bump plugin, publish plugin, release plugins. Prepare and verify independent npm package releases safely."
license: Apache-2.0
metadata:
  author: "alisio-contributors"
  version: "1.1"
---

## Activation Contract

Load this skill for versioning, packing, publishing, or release workflow changes.

## Hard Rules

- Never publish without explicit user authorization and working npm authentication
  (`npm login`, or `NPM_TOKEN`) with publish rights on the `@alisio` scope.
- Default is a dry run. Real publishing requires the explicit `--publish` flag.
- The working tree must be clean and committed, so what is published is exactly what is reviewed.
- `package.json` and `src/version.ts` must agree; fix with `pnpm run version` or
  `node scripts/sync-versions.mjs` and rebuild.
- Never publish a version that already exists on the registry; bump first.
- A prerelease version defaults to the `next` dist-tag; pass `--tag` to override. Never promote a
  prerelease to `latest` by accident.
- Pass `--otp <code>` for accounts with two-factor authentication.
- Never commit tokens or credentials. Publish only `@alisio/plugin-*` packages with public access.
- First release: delete changeset files whose changes are already contained in the shipped version
  before publishing `0.1.0`, so `changeset version` does not double-count them.

## Decision Gates

| Intent | Command |
| --- | --- |
| Preview one package (dry run, default) | `pnpm publish-one -- <name>` |
| Publish one prepared package | `pnpm publish-one -- <name> --publish` |
| Bump one package | `pnpm bump-one -- <name> <patch\|minor\|major> --summary "<text>"` |
| Preview all packages (dry run, default) | `pnpm publish-all` |
| Publish all prepared packages | `pnpm publish-all --publish` |
| Changesets-native flow (creates git tags, used by CI) | `pnpm release:changesets` |

`pnpm release:changesets` (alias `pnpm release`) runs `pnpm check && changeset publish`. It creates
git tags and is what the release workflow drives. `pnpm publish-all` is the explicit operator flow:
it runs the preflight per package and is dry-run by default. They are not interchangeable.

## Execution Steps

1. Confirm `npm whoami` succeeds and the working tree is clean.
2. Bump: `pnpm bump-one -- <name> <bump> --summary "<text>"`. It writes one changeset, then runs
   `changeset version` — which applies EVERY pending changeset — followed by
   `node scripts/sync-versions.mjs`.
3. Review the version, changelog, and `git status`, then run `pnpm check`.
4. Preview one package with `pnpm publish-one -- <name>`; publish only after review with
   `pnpm publish-one -- <name> --publish`.
5. For the whole workspace, preview with `pnpm publish-all`, then publish with
   `pnpm publish-all --publish`.
6. Record package names, versions, dist-tags, checks, and registry outcome.

## Output Contract

Return packages and versions, dist-tag used, changesets applied, exact checks, publish mode
(dry run or real), and any registry errors. State plainly what was published and what was skipped.

## References

- `../../../AGENTS.md`
- `scripts/lib/release.mjs`, `scripts/bump-one.mjs`, `scripts/publish-one.mjs`, `scripts/publish-all.mjs`
- `site/developing-plugins.md` and `site/es/developing-plugins.md`
