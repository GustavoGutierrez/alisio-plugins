# Alisio plugins

Independent, self-contained plugins for [Alisio](https://www.npmjs.com/package/@alisio/sdk).

## Quick path

```bash
corepack enable
pnpm install
pnpm check
```

| Package | Purpose |
| --- | --- |
| [`@alisio/plugin-wayfinder`](https://github.com/GustavoGutierrez/alisio-plugins/tree/main/packages/wayfinder#readme) | Coordinates a durable specification-driven development workflow with bounded child sessions. |

Packages are versioned independently with Changesets. Run `pnpm changeset`, then `pnpm version`.
`pnpm publish-one -- @alisio/plugin-wayfinder` performs a dry run; add `--publish` for an intentional
publish. `pnpm publish-all` checks and publishes all versions prepared by Changesets. Publishing
requires npm authentication and an `@alisio` organization account; this repository stores no secret.
