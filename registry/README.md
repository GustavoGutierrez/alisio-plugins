# Plugin catalog registry and data pipeline

The documentation site at `site/` builds entirely from a **committed cache**. Nothing in
`pnpm docs:build` touches the network; `pnpm docs:scan` is the only command that does.

## Quick path

| Goal | Command |
| --- | --- |
| Refresh the cache and regenerate pages (network) | `pnpm docs:scan` |
| Same, but never touch the network | `pnpm docs:scan --offline` |
| Refetch every entry, ignoring the freshness window | `pnpm docs:scan --force` |
| Fail the command when any entry could not be gathered | `pnpm docs:scan --strict` |
| Validate the cache and the site offline (no network) | `pnpm docs:check` |
| Build the site | `pnpm docs:build` |
| Everything, in CI order | `pnpm check` |

`pnpm docs:check` and `pnpm docs:build` run inside `pnpm check`, so a stale cache or a broken link
blocks a pull request.

## Register a third-party plugin

Edit [`plugins.json`](./plugins.json) and add one object. Only `package` is required; everything
else is an optional override. The JSON Schema is
[`plugins.schema.json`](./plugins.schema.json).

```json
{
  "schemaVersion": 1,
  "plugins": [
    { "package": "@acme/alisio-plugin-search" },
    {
      "package": "@acme/alisio-plugin-notes",
      "title": "Acme Notes",
      "categories": ["tools", "storage"],
      "cover": "assets/cover.png",
      "featured": true
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `package` | The npm package name. The only required field. |
| `title` | Display name override (defaults to the package name). |
| `npmUrl` | npm page override (defaults to the canonical package URL). |
| `repository` / `homepage` | Metadata overrides when the packument is wrong or missing. |
| `cover` | Cover override; see the convention below. |
| `categories` | Category override. Unknown values are ignored. |
| `featured` | Promotes the plugin in catalog surfaces. |

Packages under `packages/*` are discovered automatically and **must not** be registered here unless
they need an override; a registry entry for a local package is merged on top of the automatic entry.

## What the scanner reads

| Source | Read | Never done |
| --- | --- | --- |
| Local package | `dist/index.js` plugin object (id, name, description, version, categories), `package.json`, `README.md`, `cover.*` | — |
| Third-party package | The npm **packument** (name, description, license, author, maintainers, repository, homepage, keywords, latest version, publish times, unpacked size, dependency and peer counts, README) and the published **tarball** (only to extract the cover) | Importing or executing the package. Reading arbitrary URLs from the README. |

Downloads-per-month is optional: a failure degrades to `null`. A failure for one entry never aborts
the scan; it is reported on stderr and, with `--strict`, makes the command exit non-zero.

Tarballs are listed before extraction and rejected if any entry is absolute or contains `..`.

## The cache

`site/.vitepress/data/plugins.json` is committed and read by the site at build time. Each entry
carries the fields the catalog displays: `name`, `slug`, `title`, `description`, `version`,
`publishedAt`, `firstPublishedAt`, `author`, `maintainers`, `license`, `repository`, `homepage`,
`bugs`, `npmUrl`, `categories`, `keywords`, `unpackedSize`, `dependencyCount`, `peerCount`,
`installName`, `cover`, `readme`, and `source` (`local` or `third-party`).

## Cover convention

A plugin may ship an optional cover. The scanner resolves it in this order:

1. The registry entry's **`cover`** field.
   - A value starting with `/` is a file already committed under `site/public`, for example
     `/covers/acme.png`.
   - Any other value is a path **inside the package**, for example `assets/cover.png`.
2. `package.json` → **`alisio.cover`**, a path inside the package.
3. The convention at the package root, searched in this extension order:
   **`cover.svg`**, `cover.png`, `cover.jpg`, `cover.jpeg`, `cover.webp`.

Declared paths are rejected when they are absolute or escape the package. The resolved file is
copied to `site/public/covers/<slug>.<ext>`; a stale copy with another extension is removed, and
unreferenced copies are pruned. When nothing resolves, the branded default at
`site/public/assets/covers/default-cover.svg` is used, and it is also the runtime fallback when a
cover fails to load.

For third-party packages the cover is taken from the published tarball, so the file must be included
in the package's `files` (or not excluded by `.npmignore`). Local packages in this repository ship
`cover.svg` in `files`.

### Dimension rule

| Property | Value | Why |
| --- | --- | --- |
| Aspect ratio | **16:9** | A single ratio for the list thumbnail and the detail cover. |
| Recommended size | **1600 × 900** | Crisp on a HiDPI detail view. |
| Minimum size | **640 × 360** | Legible as a 300 px card thumbnail. |
| SVG viewBox | `0 0 1600 900` | The four local covers use it. |
| Maximum file size | **512 KB** | Keeps the repository and the site payload small. |
| Format | **SVG** preferred, then PNG, JPG/JPEG, WebP | SVG is crisp, tiny and reproducible. |

Both the card thumbnail and the detail cover render with `aspect-ratio: 16 / 9` and
`object-fit: cover`, so an off-ratio cover is cropped, never distorted.

The four local covers embed a downscaled Alisio mascot mark
(`site/.vitepress/theme/assets/alisio-mark.png`, derived from Alisio's `logo.png`, MIT) so the SVG
stays self-contained when it is rendered through an `<img>` element.

## URL shape

Slugs are stable and readable. They are derived from the package name by stripping an
`@alisio/plugin-` prefix, flattening any other scope into `scope-name`, lowercasing, and replacing
runs of unsupported characters with `-`.

| Package | Slug | English URL | Spanish URL |
| --- | --- | --- | --- |
| `@alisio/plugin-wayfinder` | `wayfinder` | `/alisio-plugins/plugins/wayfinder` | `/alisio-plugins/es/plugins/wayfinder` |
| `@acme/alisio-plugin-notes` | `acme-alisio-plugin-notes` | `/alisio-plugins/plugins/acme-alisio-plugin-notes` | `/alisio-plugins/es/plugins/acme-alisio-plugin-notes` |

The static index of every plugin is `/alisio-plugins/plugins/` (Spanish: `/alisio-plugins/es/plugins/`).
Slug collisions are reported by the scanner and must be resolved by renaming.

## Generated files (do not edit by hand)

- `site/.vitepress/data/plugins.json`
- `site/plugins/*.md` and `site/es/plugins/*.md`
- `site/public/covers/*`

Edit the registry, a `package.json`, a README or a cover instead, then run `pnpm docs:scan`.

## Publication safety

Generated files are treated as published artifacts. Before writing, the scanner neutralizes text
against the leak guard's own rules (`scripts/leak-check.mjs`), so a third-party README cannot smuggle
a machine path or a credential-shaped string into a tracked file. README markdown embedded into a
page is additionally sanitized against the VitePress pipeline it will be compiled by: HTML comments
(the `<!-- @include -->` directive), raw HTML tags (Vue directives and `v-html`), `<<<` snippet
imports, `{{ }}` interpolations and `javascript:` URLs are neutralized, and in-page `#anchors` that
would not resolve are unwrapped to plain text.

## Test seams

The scanner is driven end to end by `scripts/scan-plugins.integration.test.mjs`, which points it at a
throwaway scan root and a local HTTP registry. These environment variables exist only for that test
and default to production values:

| Variable | Default |
| --- | --- |
| `ALISIO_PLUGIN_SCAN_ROOT` | The repository root. |
| `ALISIO_PLUGIN_REGISTRY` | `<scan root>/registry/plugins.json` |
| `ALISIO_PLUGIN_CACHE` | `<scan root>/site/.vitepress/data/plugins.json` |
| `ALISIO_PLUGIN_COVERS` | `<scan root>/site/public/covers` |
| `ALISIO_NPM_REGISTRY` | `https://registry.npmjs.org` |
| `ALISIO_NPM_DOWNLOADS` | `https://api.npmjs.org/downloads` |
