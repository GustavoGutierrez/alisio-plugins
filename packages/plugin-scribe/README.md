# @alisio/plugin-scribe

Scientific writing studio for Alisio: multiple LaTeX documents, agent-generated proposals that you
review before they become revisions, attachments, revision history and offline PDF builds with a
bundled TeX engine. It does not start another server, open a browser window or ask for provider
credentials.

## Requirements

- Node `>=22.16`.
- **The first Alisio release with the plugin apps API** (`api.apps`) for the full studio. That API
  is still in development and is not part of `@alisio/sdk` 0.11.4; `src/apps.ts` holds its local
  structural types until an SDK release ships them.
- On older hosts (no `api.apps`), Scribe still loads: it registers the `scribe_documents` tool, the
  read-only `documents` view, the agents/skills and the `help` command, and skips the studio. Since
  documents are created only from the studio, the tool and view stay empty there and `help` says
  that the studio is unavailable.

## Install

```bash
alisio install npm:@alisio/plugin-scribe
```

Open a trusted project and select **Scribe · Writing / Scribe · Redacción** under that project.
The sidebar remains available; **Back to chat / Volver al chat** restores the conversation.

## How it integrates

- `api.apps.register` supplies a self-contained HTML bundle (`dist/embedded.html`, built from
  `web/`) and declared read, write and process action handlers.
- The host mounts it in an isolated iframe inside the main area; no same-origin DOM access.
- A MessageChannel carries actions to Alisio's authenticated server, never directly to providers.
- Every mutating action, including job cancellation, requires session write permission; PDF builds
  also require process permission.
- The Alisio locale controls all UI labels (English/Spanish). Manuscript language is separate.
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

Scribe depends on `node-tectonic` 1.1.0, whose platform binary is installed automatically for
Windows x64, Linux x64/arm64 and macOS x64/arm64. No Docker or system TeX is needed. On Linux the
binary requires a recent glibc (2.38 or newer); on older systems PDF builds fail with a build error.
Do not omit optional dependencies when installing.

The package contains a 110 MB compressed offline TeX archive (`compiler/bundle.zip`). The first
build creates the LaTeX format cache; later builds reuse it. Builds never download packages or send
document contents anywhere. Packages outside the snapshot and LuaLaTeX-only templates are not
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

Tests run with Vitest against `src`, including a jsdom test of the studio UI. The real-engine
PDF test is skipped when the Tectonic binary cannot run on the current machine.
`scripts/verify-host-integration.mjs <alisio-checkout>` exercises the plugin inside a locally
built Alisio that ships the plugin apps API.

## License

MIT
