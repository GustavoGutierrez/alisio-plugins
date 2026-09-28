# Changesets

Run `pnpm changeset` for every publishable change. Choose the affected package and semantic bump,
then commit the generated Markdown file with the change. Maintainers run `pnpm run version` to apply
prepared versions (`changeset version` plus `node scripts/sync-versions.mjs`).

Two release paths exist and are not interchangeable:

- `pnpm release:changesets` (alias `pnpm release`) — the Changesets-native flow. It runs
  `pnpm check && changeset publish`, which creates git tags. CI drives this.
- `pnpm publish-all` — the explicit operator flow. It runs the release preflight per package and is
  a dry run until you pass `--publish`.
