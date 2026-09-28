---
name: release-alisio-plugin
description: "Trigger: changeset, version plugin, publish plugin, release plugins. Prepare and verify independent npm package releases safely."
license: Apache-2.0
metadata:
  author: "alisio-contributors"
  version: "1.0"
---

## Activation Contract

Load this skill for versioning, packing, publishing, or release workflow changes.

## Hard Rules

- Never publish without explicit user authorization and npm authentication.
- Use Changesets; keep package and runtime plugin versions synchronized.
- Run the complete check and inspect packed contents before publishing.
- Publish only packages named `@alisio/plugin-*` with public access.
- Never commit tokens, registry credentials, or invented remote metadata.

## Decision Gates

| Intent | Command |
| --- | --- |
| Preview one package | `pnpm publish-one -- <name>` |
| Publish one prepared package | `pnpm publish-one -- <name> --publish` |
| Prepare versions | `pnpm version` |
| Publish all prepared versions | `pnpm publish-all` |

## Execution Steps

1. Create a Changeset describing the public change.
2. Run `pnpm version`, review versions and changelogs, then run `pnpm check`.
3. Use the preview path before an explicitly authorized publish.
4. Record package names, versions, checks, and registry outcome.

## Output Contract

Return packages and versions, Changesets used, exact checks, publish mode, and any registry errors.

## References

- `../../../AGENTS.md`
