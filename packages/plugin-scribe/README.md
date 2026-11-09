# @alisio/plugin-scribe

![Scribe](https://gustavogutierrez.github.io/alisio-plugins/covers/scribe.svg)

Scientific writing studio for Alisio: multiple LaTeX documents, agent-generated proposals that you
review before they become revisions, attachments, revision history and offline PDF builds with a
bundled TeX engine. It does not start another server, open a browser window or ask for provider
credentials.

## Requirements

- Node `>=22.16`.
- **Alisio 0.11.6 or newer** for the full studio. The plugin apps API (`api.apps`) arrived in 0.11.5,
  and 0.11.6 lets studio actions ask for approval like the chat: drafting needs `write` and building
  a PDF needs `process`. Alisio shows the usual prompt (allow once, allow for the session, deny); a
  denied or read-only session makes the studio say which permission is missing.
- On older hosts (no `api.apps`), Scribe still loads: it registers the `scribe_documents` tool, the
  read-only `documents` view, the agents/skills and the `help` command, and skips the studio. Since
  documents are created only from the studio, the tool and view stay empty there and `help` says
  that the studio is unavailable.

## Install

```bash
alisio install npm:@alisio/plugin-scribe
```

Open a trusted project and select **Scribe · Writing / Scribe · Redacción** in the **Apps** group
above **Projects**. The projects panel remains available; **Back to chat** restores the
conversation.

## How it integrates

- `api.apps.register` supplies a self-contained HTML bundle (`dist/embedded.html`, built from
  `web/`) and declared read, write and process action handlers.
- The host mounts it in a sandboxed iframe (opaque origin, no forms, no network). Its one inline
  script carries the host nonce; PDF.js renders previews with a `blob:` worker, without eval or
  WASM, from bytes returned by an action.
- The frame accepts only the first `alisio.app.connect` port from `window.parent` and sends every
  action over it to Alisio's authenticated server, never directly to providers. It keeps fewer
  than 8 requests in flight, pauses polling while hidden and shows an unavailable state when the
  host answers `not_found` (for example after the plugin is disabled).
- Long work (agent drafts and PDF builds) returns a job at once and the studio polls it, so no
  action holds the host's 30-second request limit.
- The host gates every action by its effect with the session's existing permissions, without a
  prompt: mutating actions, including job cancellation, need write permission and PDF builds also
  need process permission.
- The Alisio locale controls all UI labels (English/Spanish); the studio has no language selector
  of its own. Manuscript language is separate.
- The backend uses Alisio sessions, model configuration, tool permissions and private state paths.

## Features

Multiple documents; physics/mathematics/computing starting points; model selection; agent-generated
LaTeX proposals; explicit review/apply/discard; manual LaTeX/BibTeX editing; revision conflict checks;
history/restore; attachments; document search/archive; JSON project import/export; `.tex` import;
source ZIP export; PDF build jobs, cancellation and downloads; ES/EN messages.

## Configuration

Set `pluginOverrides["alisio.scribe"].options` through Alisio configuration:

| Option | Meaning |
|---|---|
| `locale` | `"es"` or `"en"`; default locale reported to the studio. |
| `allowedTools` | Explicit existing effective tool names available to the child agent; empty by default. |

Tools from other plugins go through the existing agent runner; this plugin does not import other
plugins or bypass their effect gates. Child sessions deny write and process permissions; an
allowlist never grants privileges absent from their parent.

## PDF compilation

Scribe uses Tectonic 0.16.9. No Docker or system TeX is needed.

- **Linux x64:** the package ships the static (musl) upstream build at
  `compiler/linux-x64/tectonic`, so builds work on any x86_64 Linux, glibc or musl (including
  Ubuntu 22.04 and Debian 12). If that file is missing, Scribe falls back to the `node-tectonic`
  binary, which needs glibc 2.39 or newer; on older systems PDF builds then fail with a build error.
- **Windows x64, Linux arm64 and macOS x64/arm64:** the platform binary of `node-tectonic` 1.1.0,
  installed automatically (Linux arm64 is already a static build). Do not omit optional
  dependencies when installing.

The package contains a 215 MB compressed offline TeX archive (`compiler/bundle.zip`): a TeX Live
2023 subset with LaTeX (recommended and extra), English, Spanish, Portuguese, French and German,
mathematics and science (including `siunitx` and algorithm packages), graphics (`tikz`,
`pgfplots`), bibliographies (`biblatex` with the BibTeX backend, `natbib`), recommended fonts and
XeTeX font support. The first build creates the LaTeX format cache; later builds reuse it. Builds
never download packages or send document contents anywhere. Before compiling, Scribe checks the
document's classes, packages and babel languages against `compiler/bundle-manifest.json` and names
anything missing. Packages outside the snapshot, `biber` and LuaLaTeX-only templates are not
supported. The archive is produced by the maintainer script `scripts/vendor-tex-bundle.py`; end
users never run it.

Tectonic runs with `--untrusted`, a private temporary directory, a minimal allowlisted environment
(path, home, temp, locale and cache variables only), a 180-second timeout, bounded log and PDF size,
and cancellation. It is a native process under Alisio's process permission, not an OS sandbox.
PDF.js is bundled for in-editor previews. See `THIRD_PARTY_NOTICES.md` and the archive's
`LICENSES` directory for TeX and font licenses.

## Persistence and limits

Atomic JSON storage (and atomic PDF writes) per workspace with an in-process write queue. Run one
host process per Scribe state directory. A stored document that cannot be read is skipped (with a
process warning) instead of breaking the document list. Jobs are persisted and marked interrupted
after restart, never replayed. Idempotency covers retries within the running process only.

The same limits apply when editing and when importing, so every exported project can be imported:

| Limit | Value |
|---|---|
| Single attachment | 25 MiB |
| All attachments of a document | 100 MiB, at most 200 files |
| Revisions kept | 200 (older revisions are pruned when a new one is added) |
| LaTeX source / bibliography | 400,000 / 100,000 characters per revision |
| Project file selected in the studio | 256 MiB |

Binary attachments are not OCR-extracted or passed to the model. References require human
verification.

## Development

```bash
pnpm --filter @alisio/plugin-scribe build
pnpm --filter @alisio/plugin-scribe typecheck
pnpm --filter @alisio/plugin-scribe test
```

Tests run with Vitest against `src`, including jsdom tests of the studio UI and its handshake, and
a check that the built page meets the frame CSP. The real-engine PDF test is skipped when no
Tectonic binary can run on the current machine.

Both vendored files are git-ignored (too large for the repository) and must exist before packing:

```bash
cd packages/plugin-scribe
# 1. A portable TeX Live 2023 subset in a scratch directory (no root access, nothing system-wide).
TL=/absolute/scratch/tl2023
REPO=https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2023/tlnet-final
curl -fLO $REPO/install-tl-unx.tar.gz && tar xzf install-tl-unx.tar.gz
sed "s|@TEXDIR@|$TL|g" scripts/texlive-2023.profile > "$TL.profile"
perl install-tl-*/install-tl --no-interaction --profile "$TL.profile" --repository $REPO
# 2. The flat bundle and its manifest (also takes the generated font maps and language.dat).
python3 scripts/vendor-tex-bundle.py $TL/texmf-dist
# 3. The static Tectonic binary for linux-x64.
node scripts/vendor-tectonic.mjs       # compiler/linux-x64/tectonic, checksum-verified download
```

`vendor-tex-bundle.py` leaves out what Tectonic never reads (listed in
`scripts/tex-bundle-excludes.txt`) and fails if two different files would share a name in the flat
archive. `compiler/bundle-manifest.json` is small and committed; `compiler/bundle.zip` is not.

`vendor-tectonic.mjs` downloads the pinned upstream release asset, verifies the tarball and binary
SHA-256 digests and writes the binary atomically; `--from <tar.gz>` uses a local copy instead.
`scripts/verify-host-integration.mjs <alisio-checkout>` exercises the plugin inside a locally
built Alisio that ships the plugin apps API.

## License

MIT
