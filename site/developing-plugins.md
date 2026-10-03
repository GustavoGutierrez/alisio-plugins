# Developing Alisio plugins

[Español](./es/developing-plugins.md) · English

This guide covers first-party packages in this monorepo **and** independent plugins published from
another repository. Choose the path first; the plugin contract and safety limits apply to both. The
canonical upstream reference for the SDK and `PluginAPI` is the Alisio plugin documentation. This
catalog guide focuses on the packaging, publication and listing workflow rather than duplicating the
complete API reference.

Everything in this guide was checked against the upstream source
(`docs/plugins.md`, `packages/sdk/src/index.ts`, `packages/core/src/plugins/host.ts`,
`packages/core/src/runtime/modules.ts`, `packages/core/src/plugins/install.ts`). Where the upstream
documentation and the source disagree, this guide follows the source and calls it out as a
**documentation caveat**.

- [Choose your path](#choose-your-path)
- [Third-party quick path](#third-party-quick-path)
- [Catalog inclusion](#catalog-inclusion)
- [First-party quick path](#first-party-quick-path)
- [The contract](#the-contract)
- [Capability surface](#capability-surface)
- [Hard limits: how far plugins reach](#hard-limits-how-far-plugins-reach)
- [The most likely mistakes](#the-most-likely-mistakes)
- [Package shape and publishing](#package-shape-and-publishing)
- [Installing and smoke-testing](#installing-and-smoke-testing)
- [SDK version pinning](#sdk-version-pinning)
- [Testing in this repository](#testing-in-this-repository)
- [Documentation caveats](#documentation-caveats)

## Choose your path

| You are building… | Work here? | Release and catalog behavior |
| --- | --- | --- |
| An official, first-party `@alisio/plugin-*` package | Yes — create `packages/<name>/`. | The workspace checks, Changesets, release tooling, and automatic local catalog discovery apply. |
| An independent plugin owned by your team | No — use your own repository and publish it to npm. | You choose your tooling and release process. It is installable after npm publication; catalog listing requires maintainer review and a registry pull request. |

**Universal ecosystem recommendations** are marked below. Rules described as **first-party only**
are enforced by this repository's workspace tooling and must not be copied as claims about every
external plugin.

## Third-party quick path

Use this path when your package belongs in another repository. It does not require a fork of this
monorepo.

1. Create an ESM Node package and implement the default `definePlugin(...)` export described in
   [the contract](#the-contract).
2. Build JavaScript and declarations into `dist`, test the built package, and inspect the tarball.
3. Publish the package to npm, then install its published version with Alisio and run `plugins doctor`.
4. If you want a listing here, follow [Catalog inclusion](#catalog-inclusion). npm publication alone
   does **not** add a package to this catalog.

### External package baseline

These are the compatible, recommended defaults for an independently published plugin. The host
requires the `alisio-plugin` keyword to recognize an npm package; the other entries are ecosystem
or quality recommendations, except where your own package policy makes them mandatory.

| Concern | Recommended external-package baseline |
| --- | --- |
| Name | Prefer `@your-scope/alisio-plugin-<name>`. `@alisio/plugin-*` is reserved for first-party packages; the catalog registry can list any valid npm package name. |
| Metadata | Provide `description`, `license`, `repository`, `homepage`, and `bugs` so users and catalog maintainers can assess the package. |
| Host SDK | Put `@alisio/sdk` in both `peerDependencies` and `devDependencies`; do not import `@alisio/core` or another plugin. |
| Runtime and modules | Use ESM (`"type": "module"`), target Node `>=22.16`, and expose `./dist/index.js` plus `./dist/index.d.ts`. |
| Published contents | Include `dist`, a concise `README.md` with install/use instructions, an MIT `LICENSE` (or clearly declared alternative), and every resource or cover the plugin registers. |
| Quality | Keep unit tests; cover a happy path and an error/boundary path for each functional scenario. |
| Trust and data | Plugins run in-process, not in a sandbox. Validate untrusted names, paths, and child-session output; persist durable data atomically; avoid credentials and machine-specific paths in source and the tarball. Optional built-in integrations should fail open and remain capability-narrowed. |

Start from this manifest shape and adapt versions, scripts, and the package manager to your own
repository:

```json
{
  "name": "@your-scope/alisio-plugin-example",
  "version": "0.1.0",
  "description": "A concise description of the plugin.",
  "keywords": ["alisio-plugin"],
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/OWNER/REPOSITORY.git" },
  "homepage": "https://github.com/OWNER/REPOSITORY#readme",
  "bugs": { "url": "https://github.com/OWNER/REPOSITORY/issues" },
  "type": "module",
  "engines": { "node": ">=22.16" },
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "README.md", "LICENSE", "cover.svg"],
  "peerDependencies": { "@alisio/sdk": ">=0.1.0-alpha.10 <0.2.0" },
  "devDependencies": { "@alisio/sdk": "0.1.0-alpha.10" }
}
```

### Third-party release checklist

- [ ] `npm pack --dry-run` shows `dist/index.js`, `dist/index.d.ts`, `README.md`, `LICENSE`, and registered resources.
- [ ] Your repository's lint, type, test, and build checks pass; scan the packed tarball for credentials and local paths.
- [ ] The published package has the `alisio-plugin` keyword and an entry Alisio can resolve.
- [ ] Publish with your authorized npm workflow; this monorepo's Changesets and `publish-*` scripts are **first-party only**.
- [ ] Verify the registry result: `npm view <package> version`.
- [ ] Verify the consumer path: `alisio install npm:<package>@<version>`, then `alisio plugins doctor`.
- [ ] If applicable, verify configured credentials stay in Alisio/the environment rather than the package, and document the minimum compatible Alisio runtime.

## Catalog inclusion

This catalog is **not npm discovery**. Local packages under `packages/*` are discovered automatically;
an external package appears only after a maintainer accepts a pull request to this repository that
adds it to [`registry/plugins.json`](https://github.com/GustavoGutierrez/alisio-plugins/blob/main/registry/plugins.json).
There is no separate issue form or automated submission endpoint in this repository.

After publishing, open a pull request against
[`GustavoGutierrez/alisio-plugins`](https://github.com/GustavoGutierrez/alisio-plugins) that edits
`registry/plugins.json` and includes the requested review information below. Maintainers run the
scanner and commit its generated cache/pages; do not hand-edit generated catalog files.

The registry schema requires **only** `package`. Its optional fields are `title`, `npmUrl`,
`repository`, `homepage`, `cover`, `categories`, and `featured` — exactly as defined in
[`registry/plugins.schema.json`](https://github.com/GustavoGutierrez/alisio-plugins/blob/main/registry/plugins.schema.json).

```json
{
  "package": "@your-scope/alisio-plugin-example",
  "categories": ["tools"],
  "cover": "cover.svg"
}
```

| Maintainer review information | How it is used or verified |
| --- | --- |
| npm package name and published version; install command | `package` is the sole required registry field. The catalog derives `alisio install npm:<package>` and reads the latest npm version. Include the version you tested in the pull request. |
| Repository URL, homepage, bugs URL, description, and license | The scanner reads npm metadata; registry `repository` and `homepage` can override missing/incorrect packument values. `bugs`, description, and license have no registry override. |
| Category and capabilities | `categories` is an optional registry override. Use only: `model-provider`, `methodology-harness`, `memory`, `subagents`, `search`, `tools`, `security`, `analytics`, `mcp`, `storage`, `ui`, `decisions`. Explain actual capabilities in the PR; capabilities are not a schema field. |
| Peer SDK range, Node compatibility, tests and validation evidence | These are maintainer review evidence, not registry fields. Include your `@alisio/sdk` peer range, `engines.node`, commands/results, and the exact published version installed with Alisio. |
| Security and integration details | Explain network/process/write behavior, credential handling, durable-data behavior, optional integrations, and any resources. The scanner never imports or executes third-party code. |
| Cover and presentation | `cover` is optional. It may be a package-relative path such as `cover.svg`, or a `/...` path to a file already committed under `site/public`. Otherwise the scanner checks `package.json` `alisio.cover`, then root `cover.svg`, `.png`, `.jpg`, `.jpeg`, `.webp`. Prefer a 16:9, 1600×900 SVG under 512 KB and ensure it is included in the npm tarball. |

`npmUrl`, `title`, and `featured` are optional presentation overrides, not evidence substitutes.
The scanner fetches npm metadata and, only to find a cover, reads the published tarball without
executing it. A maintainer can reject or defer a registry change when the package, metadata, safety,
or validation evidence is insufficient.

## First-party quick path

```bash
corepack enable
pnpm install
pnpm check                 # lint, types, tests, build, pack check
pnpm diagrams:check        # committed SVGs are newer than their sources
```

This is the **first-party-only** path. Scaffold under `packages/<name>/` following the conventions in the root
[README](https://github.com/GustavoGutierrez/alisio-plugins/blob/main/README.md) and
[CONTRIBUTING.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/main/CONTRIBUTING.md).

## The contract

A plugin is an ES module whose **default export** is a `Plugin` object. Use the SDK's
`definePlugin` helper (an identity function that only adds typing) and `textResult` to build tool
results.

```ts
import { definePlugin, textResult } from "@alisio/sdk";

export default definePlugin({
  id: "acme.hello",
  name: "Acme Hello",
  description: "Adds a friendly greeting tool",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.tools.register({
      name: "hello",
      description: "Greets the user.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return textResult("Hello!");
      },
    });
  },
});
```

The host validates and enforces this contract:

| Member | Required | Rule |
| --- | --- | --- |
| `id` | yes | Matches `^[a-z0-9][a-z0-9.-]{0,63}$`, e.g. `acme.hello`. |
| `version` | yes | Strict semver: `^\d+\.\d+\.\d+(?:-[\w.-]+)?$` (a pre-release suffix is allowed; build metadata is not). |
| `apiVersion` | yes | Exactly `1`. |
| `setup(api)` | yes | A function; may be async. Registers everything. |
| `name`, `description` | no | Non-empty human-friendly catalog text used by `/plugins`. |
| `categories` | no | Optional catalog categories: `model-provider` or `methodology-harness`. The host validates the value strictly (see below) and also derives `model-provider` from provider registrations. |
| `extensions` | no | Declarative extension providers, registered at priority `0` before `setup` runs. |
| `dispose()` | no | Releases resources when Alisio closes. |

What the host guarantees:

- **Duplicate ids are rejected** (`Duplicate plugin: <id>`).
- **Contract validation runs before `setup`.** An invalid id, version, or `apiVersion` fails the load.
- **`setup` failures roll back every registration, then call `dispose()`.** Every `register`/`on`
  call returns an unregister function; the host reverses all of them on failure and then awaits
  `dispose()` before rethrowing.
- **Everything a plugin registers is removed automatically when it unloads.**

### Catalog categories and host compatibility

`categories` is one of the few fields the host validates against a closed set (the SDK's
`PluginCategory`). Validation is strict: a host that does not know a declared value **fails the load**
with a contract error instead of ignoring the unknown value. The known values are `model-provider`
(the original value) and `methodology-harness` (`@alisio/sdk` `0.1.0-alpha.10` / `@alisio/core`
`0.1.0-alpha.15` and newer).

A plugin cannot express a host-version dependency. Plugins depend on `@alisio/sdk` only, never on
`@alisio/core`, and the SDK peer range is not a host version the host enforces. So declaring a
category that a newer SDK introduced fails the load on older hosts, and no manifest field prevents
it. Document the minimum Alisio runtime in your README and give the upgrade command
(`npm install -g @alisio/alisio-code@<version>`, or `pnpm add -g` / `bun add -g`).

## Capability surface

Every namespace a plugin receives on `api`, what it gives you, how names are scoped, and how the
effect/permission model applies.

| Namespace | What it gives you | Naming / namespacing | Effect and permissions |
| --- | --- | --- | --- |
| `api.tools.register(tool)` | Tools the model can call. | External plugins get `p_<10-hex>_<name>` (10 hex chars of the SHA-256 of the plugin id); built-ins stay unprefixed. Must match `^[a-zA-Z0-9_-]{1,64}$` **after** prefixing. | Carries `effect` (`read`/`write`/`process`/`external`/`internal`). `read` is always allowed; `write`/`process`/`external` are gated by policy or approval. |
| `api.commands.register(name, handler, options?)` | Slash commands. | External: `<plugin id>:<name>` (e.g. `/acme.hello:name` or `/command acme.hello:name`); built-ins stay unprefixed. Duplicate names throw. | Not effect-gated; still runs in-process with full privileges. |
| `api.events.on(handler)` | Observe versioned `RunEvent`s (`schemaVersion`, `runId`, `sessionId`, `seq`, `type`, `timestamp`, `data`). | Per plugin. | Read-only; a throwing observer cannot break the run. |
| `api.context.register(provider)` | `() => Promise<string>` text added to the model context. | Per plugin. | Not gated. |
| `api.resources.skills(path)` / `.prompts(path)` / `.agents(path)` | Register resource directories relative to the plugin file. | Directories are tagged with the plugin id. | Not gated. Skills and prompt templates are visible to the host in the same boot; **agent definitions are not** (see hard limits). |
| `api.resources.list(kind)` | The directories every plugin registered for `skills`, `prompts` or `agents`, with the owner plugin id. | — | Read-only view. |
| `api.state.get(key)` / `.set(key, value)` | Small JSON state per plugin, persisted in the session database. | Scoped to the plugin id. | Not gated. |
| `api.storage.sqlite(path)` | A private (`0600`) SQLite file, creating parent directories (`0700`). Returns the synchronous `SqlDatabase` port (`exec`, `prepare`, `transaction`, `close`; prepared statements cached by SQL text; FTS5 available). | Caller-supplied path. | Not gated; the database is closed when the plugin unloads unless the plugin closed it first. |
| `api.compaction.register({ beforeCompact, afterCompact })` | Contribute instructions, output fields, injected context and a report to core compaction. | Per plugin. | Host timeout 15 s; a failure or timeout is recorded as a plugin failure and the core continues. |
| `api.session.onStart(handler)` | Text injected once at the start of a new, empty session (persisted). | Per plugin. | Host timeout 15 s; failures isolated. |
| `api.session.onEnd(handler)` | Called when an interactive session ends (`/clear`, `/exit`, quit). | Per plugin. | Host timeout 10 s; handlers run concurrently; failures isolated. |
| `api.model.complete(request)` | Provider-agnostic text completion. Plugins never import provider SDKs. | Per plugin. | Hard 120 s timeout; does not count against `limits.maxTokens`. |
| `api.models.list(signal?)` / `.resolve(reference, signal?)` | Credential-free access to configured `/connect` models; resolves canonical `provider/model` or a unique bare id. | Per plugin. | Not gated. |
| `api.providers.register(provider)` | Add selectable model-provider metadata and a factory. Registrations coexist; `/connect` selects one. | Unique by provider id. | Not gated by `effect`; provider credentials stay in the host. |
| `api.sessions.*` (spawn, create, run, get, children, ancestors, cancel, enqueue, isRunning, capabilities, model, workspace, setStatus) | Child sessions: separate persisted conversations with fresh context and **narrowed** permissions. | — | A child can never exceed its parent; aborting a parent aborts running descendants. |
| `api.ui.status(key, text, detail?)` / `.panel(id, provider)` / `.select(req)` / `.askQuestions(req)` / `.open(sessionId)` / `.interactive()` | Status text, tree panels, and interactive prompts. | Status keyed `plugin:key`; panels keyed `plugin:id`. | Interactive UIs only; headless calls resolve to `undefined`/`false` and never hang. |
| `api.extensions.register(point, provider, options?)` | Replace a typed host extension point: `mascot`, `startup-screen`, or `websearch`. | Resolution: highest `priority`, then plugin id, then registration order. | Not gated by `effect`; a slow or throwing provider falls back to the default. |

**The namespacing rule in one sentence:** external plugins are namespaced (tool names prefixed,
commands under `<plugin id>:`) and their `internal` effect is downgraded to `external`; built-in
plugins are unprefixed and may declare `internal`.

## Hard limits: how far plugins reach

This is the section to read before loading code you did not write.

| Limit | What it means |
| --- | --- |
| **No sandbox.** | Plugins run in-process with the user's full privileges. The `effect` field is *availability metadata*, not isolation. A plugin manifest or a subprocess is not a sandbox. |
| **`--read-only` disables external plugins entirely.** | They are not loaded. It also disables writes, processes, network tools and MCP. Built-in plugins are unaffected. When a slash-prompt template requires a capability that `--read-only` withholds, the CLI prints the exact capability flag (`--allow-write` / `--allow-process`) and tells the user to run without `--read-only`; install is refused outright. |
| **Child sessions only narrow.** | A child can never gain a capability its parent lacks. A read-only parent **poisons all descendants**: `readOnly` is inherited (`parent.readOnly || spec.readOnly`). |
| **External names are rewritten; `internal` is downgraded.** | External tool names get the `p_<hash>_` prefix; an external plugin's `internal` effect becomes `external`. |
| **Omitting `effect` means `external`, not `read`.** | In the runner, `effect` defaults to `external` (`t.effect ?? "external"`). Only declare `read` for tools with no side effects. |
| **`paths()` is not a write gate.** | A tool's `paths(input)` result feeds context resolution (`context.beforePaths`), so nested instructions load. It does not restrict what the tool may touch. |
| **Any external plugin auto-allows the `external` policy.** | When at least one external plugin loads (or any `p_`-prefixed tool is registered), the runtime `external` policy turns on. Enabling a plugin is a real widening of what the model may do. |
| **Hook timeouts are host-enforced but cannot preempt sync code.** | Compaction and session-start hooks: 15 s. Session-end hooks: 10 s. `model.complete`: a hard 120 s timeout. A timeout aborts the wait and the `AbortSignal`, but cannot stop blocking synchronous code. |
| **Extension renders are bounded.** | A provider has a 250 ms rendering budget, 12 lines for a `mascot` and 60 for a `startup-screen`. Rendering is synchronous, so a slow provider is replaced by the default *after* it returns; it cannot be preempted. |
| **Duplicate tool or command names throw.** | `Duplicate tool: <name>` and `Duplicate command <key>`. Tool names must fit `^[a-zA-Z0-9_-]{1,64}$` after prefixing. |
| **Plugins cannot import another plugin or `@alisio/core`.** | Depend on Node built-ins and `@alisio/sdk` only. |
| **External agent resources are not in the built-in subagents catalog in the same boot.** | The built-in `subagents` plugin reads `api.resources.list("agents")` during its own `setup`, which runs before external plugins activate. Skills and prompt templates are collected after all plugins activate, so they *are* visible. Workaround: execute child sessions directly with `api.sessions.create`/`.run` and load the packaged agent/skill files yourself — the reference plugin `@alisio/plugin-wayfinder` does exactly this. |
| **Headless UI calls never hang.** | `ui.select` and `ui.askQuestions` resolve to `undefined` (and every question id to `undefined`); `ui.open` returns `false`; `ui.interactive()` returns `false`. |
| **Installation runs npm with your privileges.** | `alisio install` runs `npm install --prefix …`, which may run the package's lifecycle scripts. The agent-facing `plugin_install` tool uses the `process` effect and is unavailable under `--read-only`. |

## The most likely mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Error: Child sessions are not available yet` / `Model resolution is not available yet` / `Model completion is not available yet` | `api.sessions.*`, `api.models.*` and `api.model.complete` are bound **after** plugins activate. Calling them directly inside `setup()` throws. | Defer those calls to tool execution, a command handler, or a lifecycle hook — anything that runs after startup. |
| `Capability denied: external` on a tool that obviously just reads | You omitted `effect`, so it defaulted to `external`, and the external policy is off. | Declare `effect: "read"` for side-effect-free tools. |
| `Duplicate tool: …` / `Duplicate command …` at load | Two registrations collide, or an external tool name exceeds 64 chars after the `p_<hash>_` prefix. | Uniquify names; keep the prefixed length within 64 characters. |
| Tool works locally, is missing after install | The package lacks `"keywords": ["alisio-plugin"]`, or `exports["."]`/`main`/`./index.js` does not resolve to the built entry. | Add the keyword and ship `dist` with a resolvable entry. |
| Agent definitions never show up in the subagents catalog | External agent resources are not visible in the same boot (see hard limits). | Register them for catalog interoperability, but run child sessions directly and load the files yourself. |
| A hook appears to run twice / state is duplicated | `setup` is called once per activation; re-registering on reload is expected. Everything is unregistered on unload. | Register idempotently or rely on the unload cleanup. |
| Diagram check fails on CI with no changes | `diagrams:check` compares mtimes, not hashes; a fresh checkout can make all files share a timestamp. | It is a local authoring aid, not a CI gate. Re-render with `pnpm diagrams`. |

## Package shape and publishing

| Requirement | Detail |
| --- | --- |
| Package name | **First-party only:** `@alisio/plugin-*`. For an external package, use a distinct npm name (for example `@your-scope/alisio-plugin-*`); the host and registry do not require that pattern. |
| Keyword | `alisio-plugin` is **required**; a package without it is rejected, so a typo cannot load an unrelated package. |
| Module format | ESM. Published plugins **must ship JavaScript** (plus declarations). |
| Entry resolution | `exports["."]` (`import`, then `node`, then `default`), then `main`, then `./index.js`. |
| Node target | `>=22.16`. |
| `alisio-plugin.json` | Required when a plugin is a **directory given as a path**: `{ "apiVersion": 1, "entry": "./index.js" }`, and the entry must stay inside the directory. Optional for an npm package (a package may ship one too). |
| Dependencies | Node built-ins and `@alisio/sdk` only. `@alisio/sdk` stays in **both** `peerDependencies` and `devDependencies`. Never import another plugin or `@alisio/core`. |
| Shipped files | `dist` JavaScript and declarations, README, MIT `LICENSE`, and every registered resource (e.g. `.agents`, `assets`). |
| Versioning here | **First-party only:** Changesets. Bump one package with `pnpm bump-one -- <name> <patch\|minor\|major> --summary "<text>"`, or run `pnpm changeset` then `pnpm run version` (which also runs `scripts/sync-versions.mjs`). `pnpm publish-one -- <name>` and `pnpm publish-all` are dry runs; add `--publish` for an intentional publish. |

No first-party version is published without explicit authorization and npm authentication. This repository stores
no secret; see [SECURITY.md](https://github.com/GustavoGutierrez/alisio-plugins/blob/main/SECURITY.md).

The **first-party** publish tooling runs a preflight per package: npm authentication (`npm login` or `NPM_TOKEN`), a
clean committed tree, matching `package.json`/`src/version.ts`, a packed tarball free of local machine
paths and credentials (`pnpm pack:check`, which runs the leak scanner over each tarball), and a version
not already on the registry. Dist-tags default to `latest`, or `next` for prerelease versions.
`pnpm release:changesets` is the Changesets-native, tag-creating flow used by CI; `pnpm publish-all`
is the explicit, preflighted flow.

First-party published packages carry no machine-specific paths and no credentials. The same guarantee is enforced
on every pull request by `pnpm check`: `leak:check` scans every tracked file and `pack:check` scans
each packed tarball, so both surfaces are covered before a merge.

## Installing and smoke-testing

`alisio install` installs an npm package into Alisio's **global** plugins directory and records the
package **name** (never the resolved path) in the global config's `plugins` array.

```bash
alisio install npm:@alisio/plugin-x            # latest
alisio install npm:@alisio/plugin-x@1.2.3      # pinned
alisio install @alisio/plugin-x                # bare name: same as npm:
alisio install npm:@alisio/plugin-x --update   # refresh to @latest, keep the name
alisio install npm:@alisio/plugin-x -y         # skip the pre-install confirmation
alisio install npm:@alisio/plugin-x --trust-plugin  # same as --yes
```

| Aspect | Behavior |
| --- | --- |
| Accepted specs | `npm:<package>[@<version>]`, or a bare package name. Names allow letters, digits, `.`, `_`, `-`, plus `/` for scoped names and `@` for a version. |
| Rejected specs | Unknown prefixes (`git:`, `file:`, `registry:`, URLs), absolute or `..` paths, and shell metacharacters. A failed install never reruns npm silently. |
| Where it lands | `<config home>/plugins/node_modules/<package>`; the name is added to `<config home>/config.json` (atomic write, unrelated fields preserved, no duplicates). |
| Privileges | `npm install` may run the package's lifecycle scripts with your user privileges. On an interactive terminal Alisio warns and asks for confirmation; headless runs must pass `--yes`/`--trust-plugin` or they fail before npm runs. |
| Under `--read-only` | Installing is refused and the plugin never loads. |

To smoke-test a local build:

```bash
alisio --plugin ./dist/index.js                 # explicit trust for this entry
alisio plugins list                             # installed/known plugins
alisio plugins doctor --plugin ./dist/index.js  # tools, commands, extensions, built-ins
```

`alisio plugins install`, `alisio plugins remove` and `alisio plugins validate` **do not exist**.
Installing is `alisio install`; removal is editing the global config and the plugins directory;
validation happens at load, surfaced by `alisio plugins doctor`.

## SDK version pinning

The published `@alisio/sdk` is **`0.1.0-alpha.10`** as of this writing. Verify the current version
before you pin:

```bash
npm view @alisio/sdk version
```

The upstream docs example pins `^0.1.0-alpha.16`, which is **stale** and ahead of what is published.
Prefer a range this repository actually uses:

```json
{
  "peerDependencies": { "@alisio/sdk": ">=0.1.0-alpha.10 <0.2.0" },
  "devDependencies": { "@alisio/sdk": "0.1.0-alpha.10" }
}
```

## Testing in this repository

- **Unit tests are required** for every plugin package.
- Cover **at least one happy path and one unhappy path per functional scenario** (positive, and
  negative/error/boundary/valid-alternative).
- **Strict TDD is an optional, explicitly recorded project decision**, not a default. Recording it is
  the reference plugin's convention, not a repository precondition; a coverage-first workflow is
  acceptable when the decision is written down.
- Tests run as part of `pnpm check` (`pnpm -r test`), so a failing test blocks review.

## Documentation caveats

Where the upstream docs and the source disagree, this guide follows the source:

1. **SDK pin example is stale.** The upstream docs show `^0.1.0-alpha.16`; the published version is
   `0.1.0-alpha.10` (check with `npm view @alisio/sdk version`).
2. **`extensions.register` covers more than the API table says.** The `PluginAPI` table lists
   `(mascot, startup-screen)`, but the SDK's typed `ExtensionPoints` map also includes `websearch`,
   and the extension points table documents it. Follow the SDK type.
3. **`ui.askQuestions` is missing from the upstream API table.** It exists in the SDK (`PluginAPI.ui`)
   and resolves every question id to `undefined` when no interactive UI is available.
4. **`setup` rollback also calls `dispose`.** The upstream "Plugin object" text says partial
   registrations are rolled back; the host first reverses every registration and then calls
   `dispose()` before rethrowing.

---

This guide and its Spanish mirror are kept in sync and must be updated together. The two versions
must always describe the same behaviour.
