---
title: "Lumbre"
description: "Describe a landing page or a small web app and let your Alisio model build it, with reviewed changes and a live preview."
pageClass: "plugin-detail"
---

<PluginDetail slug="lumbre" />

[Español](https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/plugin-lumbre/README.es.md). Both READMEs must be updated together.

Describe a landing page or a small web app in your own words; the Alisio model you pick builds it,
you review every change before it is applied, and you open it live in your browser. Lumbre follows
Alisio's language (English or Spanish) and its light or dark theme.

## Requirements

- Alisio **0.11.6 or newer within 0.11.x** (the studio uses the plugin apps API and its approval
  prompt). On older hosts only the read-only tool `lumbre_projects` and the help command work.
- A connected model provider (`/connect`). Lumbre asks for no credentials of its own.
- Internet access the first time a stack with packages is installed.
- Node.js is the one inside Alisio. Astro needs Node.js 22.23.4 or newer; Lumbre says so if
  Alisio's is older.

## Use

1. Open **Lumbre · Web builder** in your project's Apps group.
2. Describe what you want, choose how it should be built and, optionally, a model. Select
   **Start building**.
3. Watch the progress card: every step is shown ("Thinking about the design…", "Writing
   index.html…", "Installing dependencies…", "Building…", "Starting preview…"), with the elapsed
   time and a **Cancel** button. When Alisio asks for permission, Lumbre shows "Waiting for your
   approval in Alisio…".
4. Review the changes: added, changed and deleted files, a diff per file, and any package the model
   asked for. Apply all of them, only the ones you tick, or discard them.
5. Open **Preview**: a static thumbnail of your page, plus **Start live preview** and **Open live
   in your browser**. The live preview reloads by itself when you apply changes.
6. Keep chatting to change it. If a build fails, Lumbre sends the error to the model and proposes a
   fix for you to review, at most twice in a row.
7. Use **Export** to copy the project into a new folder of your workspace, or download a ZIP.

**Code** shows every file (you can edit your own; Lumbre-managed files are read-only) and
**History** keeps the last 40 versions, any of which you can restore.

## Stacks

| Stack | What you get | Live preview |
| --- | --- | --- |
| HTML, CSS and JavaScript (optional Tailwind) | Plain files; Tailwind is compiled by its CLI | Lumbre's own loopback server with live reload |
| Vite + Tailwind | Plain JavaScript modules | Vite dev server |
| React + Vite + Tailwind | A React single-page app | Vite dev server |
| Astro + Tailwind | Content pages | Astro dev server |
| Next.js (full stack) | Pages and API route handlers | Next.js dev server |

Versions are pinned and each stack ships a committed lockfile, so installs run `npm ci`. The model
can ask for a few extra packages only from a per-stack allowlist (exact name and version), and you
approve each one in the review. Lumbre writes `package.json`, lockfiles and configuration files
itself; the model and the editor cannot change them.

## Safety and limits

- **Generated apps run as you, with no sandbox.** Installs, builds and dev servers are real
  processes on this computer with your account's permissions, started only after Alisio's process
  approval. Review the code before running or publishing it, and do not put real customer data or
  credentials in it.
- npm always runs with `--ignore-scripts`. Child processes get a minimal environment without your
  provider keys or tokens.
- Dev servers listen on `127.0.0.1` on a port chosen by Lumbre, with a strict port. A preview stops
  after 20 minutes without activity in Lumbre. Leftover servers from a crash are stopped the next
  time Lumbre opens, only after checking that they belong to the project.
- The thumbnail never runs your page's scripts and its styles are confined to the thumbnail.
- A project holds up to 150 text files and 3 MB of code. At most three jobs and three live
  previews run at once.

## Data

Projects, their history and the chat live in Alisio's private plugin state, one folder per project
and per workspace, so a damaged project never affects the others. Dependencies are installed
inside that folder (a framework project typically uses 100 to 400 MB). **Export** writes only into
a new or empty folder of your workspace.

## Troubleshooting

When a request fails, select **Show details** in the error card. It shows, without any of your
content: the model, its context window and the output budget Lumbre used (each one "reported by the
provider" or "estimated"), the tokens used, whether the files were written in parts, how many
continuations were needed and the reason.

- **"The model stopped before finishing."** Lumbre writes new projects in parts (a plan first, then
  batches of files) and asks the model to continue up to three times when an answer is cut by its
  output limit. If it still stops, the files that arrived are kept for review and the missing ones
  are listed. Ask it to continue, ask for a smaller change, or pick a model with a larger output
  limit.
- **Limits "estimated".** Some providers do not report a model's context window or output limit.
  Lumbre then assumes 128,000 tokens of context and asks for 32,768 output tokens; if the provider
  rejects that, it retries once with Alisio's own limit.
- **"The model did not finish (…)".** The reason in brackets comes from the provider: a rate limit,
  a timeout, rejected credentials or a request too large for the model. Try again later or choose
  another model.
- **"The model's answer was malformed."** The answer did not follow Lumbre's format. Try again; if
  it keeps happening, choose another model.

## Why npm is a dependency

Alisio's desktop app runs plugins inside its own runtime, where neither `node` nor `npm` is
guaranteed to exist. Lumbre therefore depends on `npm` 11.9.0 and runs it with Alisio's Node. It
adds about 2.4 MB to the download and 9.8 MB (1,797 files) once installed.

## Development

```sh
pnpm install
pnpm --filter @alisio/plugin-lumbre test
pnpm --filter @alisio/plugin-lumbre build
```

`LUMBRE_INTEGRATION=1 pnpm --filter @alisio/plugin-lumbre exec vitest run test/integration.test.ts`
installs, builds and serves every stack for real (network required). After changing a pinned
version, rebuild and run `node scripts/update-preset-locks.mjs` to regenerate the lockfiles.

## Resources and license

Agent `lmb-builder`; skills `lmb-web` and `lmb-fix` (also used as the builder's instructions);
read-only tool `lumbre_projects`; command `help`. MIT. Generated projects use their frameworks'
own licenses.
