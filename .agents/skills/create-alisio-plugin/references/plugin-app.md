# Building an app-type plugin (reference: `packages/plugin-scribe`)

Use this when the plugin needs its own full-page UI (a studio, editor or dashboard) served through
`api.apps.register`. The rules in `SKILL.md` ("Plugin Apps Rules") still apply; this file is the
recipe. Scribe is the working reference for every step: read the named file before writing the
equivalent.

## 1. Package layout

```text
packages/plugin-<name>/
  src/index.ts           # definePlugin: tools/commands/views first, then the app (feature-detected)
  src/apps.ts            # re-export SDK app types; plugin-side helpers (e.g. schema keyword check)
  src/service.ts         # the actions' real logic, testable without a host
  web/index.html         # frame shell; references style.css and app.js (rewritten by the build)
  web/app.js             # frame entry: handshake, request/response, rendering
  web/*.js               # plain browser modules (i18n, pure helpers, icons)
  web/style.css
  scripts/embedded-html.mjs  # builds ONE self-contained HTML string
  scripts/build-ui.mjs       # writes dist/embedded.html
  test/frame.test.ts     # HTML builder + handshake tests (jsdom)
  test/ui.test.ts        # rendering/behavior tests of web/ code
```

`web/` is source only and is not in `files`; only `dist/embedded.html` ships. Build with
`"build": "tsc -p tsconfig.json && node scripts/build-ui.mjs"` and keep `"prepack": "pnpm build"`.

## 2. Peer range

| App needs | Peer `@alisio/sdk` |
| --- | --- |
| Read-only actions | `>=0.11.5 <0.12.0` |
| `write`/`process` actions with the host approval prompt | `>=0.11.6 <0.12.0` (Scribe) |

Match the devDependency to the minimum (`0.11.6`) and state the minimum Alisio version in the
README and in the help command text.

## 3. Register the app (`src/index.ts`)

- Register everything that works without the app first; then `if (!api.apps) return;`. The help
  command returns a text that explains the app needs Alisio >= the minimum (see Scribe's
  `HELP_WITHOUT_APP`). Never open a fallback UI.
- Build `actions` as a map `name -> { effect, inputSchema, handler }`. Group names by effect
  (Scribe: `READ_ACTIONS`, `WRITE_ACTIONS`, `PROCESS_ACTIONS`) so the effect is never guessed.
- Handler shape:

```ts
async handler(input, context) {
  context.signal.throwIfAborted();
  try {
    const instance = await service(context.sessionId); // session from ctx, never from input
    return { value: await instance.invoke(action, input ?? {}, context.idempotencyKey) };
  } catch (error) {
    return { error: error instanceof PluginError ? error.code : "operation_failed" }; // codes only
  }
}
```

- Do not re-check `api.sessions.capabilities` in handlers: the host already approved or denied.
- `html: () => readFile(new URL("./embedded.html", import.meta.url), "utf8")` (read lazily).
- `busy: () => <any background job running>`; `dispose()` synchronous, idempotent, and clears
  per-activation state. Push the unregister function into the plugin's disposers.
- Return JSON-serializable values within `PLUGIN_APP_LIMITS.resultBytes`. Long work (compiles,
  imports) starts a job and returns its id; the frame polls a read action.

## 4. Build the single HTML file (`scripts/embedded-html.mjs`)

The frame CSP is `default-src 'none'` with a per-request nonce, so the page must be self-contained:

- Inline CSS into `<style>`; inline all JS into ONE `<script nonce="__ALISIO_NONCE__">`.
- Concatenate plain modules in dependency order: strip `export ` and the app's `import` lines,
  wrap in an async IIFE. Bundle npm code (e.g. PDF.js) with esbuild `format: "iife"`; load worker
  sources as text and start them from a `blob:` URL.
- Escape `</script` in the inlined JS. Inline images as `data:` URIs (Scribe injects its icon as a
  CSS variable).
- Keep the output under `PLUGIN_APP_LIMITS.htmlBytes` (8 MB).
- Libraries must run without `eval`, `new Function` and WebAssembly (PDF.js:
  `isEvalSupported: false`, `useWasm: false`).

## 5. Frame transport (`web/app.js`)

```js
let hostPort;
const pending = new Map();
window.addEventListener("message", (event) => {
  if (hostPort || event.source !== window.parent ||
      event.data?.type !== "alisio.app.connect" || !event.ports[0]) return;
  hostPort = event.ports[0];
  setLocale(event.data.locale);
  hostPort.onmessage = ({ data: m }) => {
    if (m?.type === "locale") changeLocale(m.locale);
    if (m?.type === "visibility") (visible = m.visible !== false) && refresh();
    if (m?.type === "response") settle(m); // m.id, m.result, m.error, m.effect
  };
  hostPort.start();
});
// request: hostPort.postMessage({ type: "request", id, action, input, idempotencyKey? })
```

- `idempotencyKey` on every mutation (Scribe reuses the request id).
- Response guard per request: longer than approval wait + timeout (Scribe:
  `RESPONSE_GUARD_MS = 11 min`). After ~3 s on a mutation, show an "awaiting approval" notice that
  stays until the response arrives.
- Error mapping: `message.error` is the host transport code, `message.result.error` the plugin
  code. `not_found` -> "app unavailable" state. `not_permitted` -> name the permission from
  `message.effect` (`write`/`process`), falling back to the action's known effect on older hosts.
- Respect `PLUGIN_APP_LIMITS.inFlight` (8) concurrent requests; pause polling while hidden.
- No `<form>` (no `allow-forms`); use buttons and `<dialog>`. Downloads use `blob:` URLs. Never
  call `fetch`, `XMLHttpRequest`, `WebSocket` or external URLs.
- i18n: follow the host locale only (`en` fallback); handle singular/plural strings.

## 6. Tests (copy Scribe's `test/frame.test.ts` pattern)

- Builder: size <= `htmlBytes`; every `<script>` has the nonce and no `src`; no `<form>`, `<link>`,
  `@import`, or external `src/href/url()`.
- Sources: no `https?://`, `fetch`/XHR/WebSocket/EventSource, `eval`/`new Function`/`WebAssembly`.
- Handshake (jsdom + `MessageChannel`): ignores messages not from `window.parent`, ignores a second
  connect, sends correctly shaped requests, maps `not_permitted` + `effect` and `not_found`.
- Handlers through the plugin entry: effects per action, schemas free of `$ref`/`$id`/`$async`,
  error codes without echoed input, `dispose` idempotent, registration skipped when `api.apps` is
  missing.
- Keep pure UI logic in a separate module (Scribe's `web/derive.js`) so it is unit-testable.

## 7. Heavy vendored assets (only if the app needs a native tool)

Scribe ships a TeX bundle and a static Tectonic binary. If a plugin needs that:

- Generate assets with a committed, reproducible maintainer script; git-ignore the large outputs,
  commit only small manifests, and list the outputs in `files`.
- Prefer static (musl) binaries over glibc-linked ones; run them with an allowlisted environment.
- npm rejects tarballs much above ~115 MB (a 223 MB tarball got E413). Check `npm pack --dry-run`
  size before asking the owner to publish.
- Document third-party licenses in `THIRD_PARTY_NOTICES.md` and the rebuild steps in the README.

## 8. Visual check

Run the plugin in `alisio serve` (>= the minimum host) and verify: handshake, locale switch,
approval prompt on write/process actions, denial message, hidden-tab pause, and both themes.
