import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { definePlugin, type PluginAPI, textResult } from "@alisio/sdk";
import { buildActions } from "./apps.js";
import { E5Embedder } from "./engine/embedder.js";
import { type ModelSpec, resolveModel } from "./engine/models.js";
import { SetupManager } from "./engine/setup.js";
import { LanceStore } from "./engine/store.js";
import { errorCode, SemanticPluginError } from "./errors.js";
import { type Locale, messagesFor, resolveLocale } from "./messages.js";
import { NotebookDb } from "./notebook/db.js";
import { NotebookService } from "./notebook/service.js";
import { diskUse, resolvePaths } from "./paths.js";
import { VERSION } from "./version.js";

export const MIN_HOST = "0.11.7";

/**
 * One activation of the plugin. The host imports the plugin module once per process and calls
 * `setup` once per open workspace (the desktop app keeps a home workspace and a project open, and
 * evicts idle ones after 10 minutes), but `dispose()` carries no context. So nothing here is
 * module-global: each activation owns its resources and releases them when ITS app is unregistered
 * (the host does that when it closes that workspace). Registrations are undone by the host.
 */
interface Runtime {
  /** Releases this activation's resources (worker, SQLite, setup download). Idempotent, sync. */
  release(): void;
  hasApp(): boolean;
  idle(): boolean;
}
const runtimes = new Set<Runtime>();

function createRuntime(api: PluginAPI): Runtime {
  const options = api.options ?? {};
  const locale: Locale = resolveLocale(options.locale);
  const m = messagesFor(locale);
  const paths = resolvePaths(api.paths);
  /** Fail-open registration: one failing piece never prevents the others (app, tool, commands). */
  const attempt = (register: () => unknown) => {
    try {
      register();
      return true;
    } catch {
      return false;
    }
  };
  let appRegistered = false;
  let spec: ModelSpec | undefined;
  try {
    spec = resolveModel(options.model);
  } catch {
    spec = undefined;
  }
  const store = new LanceStore({ dir: paths.lance });
  const embedder = spec ? new E5Embedder({ spec, cacheRoot: paths.models }) : undefined;
  const setup =
    spec && embedder
      ? new SetupManager({ spec, cacheRoot: paths.models, embedder, semantic: api.semantic })
      : undefined;
  if (api.semantic && embedder) {
    // A duplicate id (another copy of this plugin) keeps the previous registration (core SE-R2).
    attempt(() => api.semantic?.registerEmbedding(embedder));
    attempt(() => api.semantic?.registerStore(store));
  }

  let service: NotebookService | undefined;
  const notebooks = () => {
    if (!service) {
      if (!api.storage?.sqlite) throw new Error("storage unavailable");
      service = new NotebookService({
        db: new NotebookDb(api.storage.sqlite(paths.notebook)),
        semantic: () => api.semantic,
        complete: (request) => api.model.complete(request),
        ...(api.models ? { models: api.models } : {}),
        activeModel: (sessionId) => api.sessions?.model?.(sessionId),
      });
    }
    return service;
  };

  attempt(() =>
    api.tools.register({
      name: "notebook_search",
      description:
        "Search one of the user's Notebook notebooks (by title or id) and return the most relevant passages with their source name and page. Read-only.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: {
          notebook: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description: "Notebook title or id",
          },
          query: { type: "string", minLength: 1, maxLength: 4000 },
          topK: { type: "integer", minimum: 1, maximum: 8 },
        },
        required: ["notebook", "query"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const reference = typeof input.notebook === "string" ? input.notebook.trim() : "";
        const query = typeof input.query === "string" ? input.query.slice(0, 4000) : "";
        const topK = Number.isInteger(input.topK)
          ? Math.min(8, Math.max(1, input.topK as number))
          : 8;
        if (!reference || !query) return textResult("invalid_input", true);
        // Read-only: never create the notebook database from the tool.
        if (!service && !existsSync(paths.notebook)) return textResult("not_found", true);
        try {
          const nb = notebooks();
          const found = nb.db.findNotebook(reference);
          if (!found) return textResult("not_found", true);
          const { passages, keywordOnly } = await nb.retrieve(found.id, query, {
            signal: context.signal,
            keep: topK,
          });
          const out: Array<{ n: number; source: string; page: number | null; text: string }> = [];
          let budget = 16_000;
          for (const p of passages) {
            if (budget <= 0) break;
            const text = p.text.slice(0, budget);
            budget -= text.length;
            out.push({ n: p.n, source: p.sourceName, page: p.page, text });
          }
          return textResult(JSON.stringify({ notebook: found.title, keywordOnly, passages: out }));
        } catch (error) {
          return textResult(errorCode(error), true);
        }
      },
    }),
  );

  attempt(() =>
    api.commands.register(
      "setup",
      async (args) => {
        if (!setup) return m.unknownModel;
        if (args.trim() === "cancel") {
          return setup.cancelRunning() ? m.cancelled : m.nothingToCancel;
        }
        try {
          return await setup.commandText(locale);
        } catch (error) {
          return m.failed(errorCode(error));
        }
      },
      {
        description: "Download the local model once and activate semantic search.",
        argumentHint: "[cancel]",
      },
    ),
  );
  attempt(() =>
    api.commands.register(
      "status",
      async () => {
        const lines: string[] = [];
        const st = m.status;
        const semantic = api.semantic;
        const available = semantic?.available() ?? false;
        if (!semantic) lines.push(st.noApi);
        else {
          const active = semantic.active();
          lines.push(
            available
              ? st.available(active.embedding?.id ?? "?", active.store?.id ?? "?")
              : st.unavailable,
          );
          if (active.embedding)
            lines.push(st.activeModel(active.embedding.modelId, active.embedding.dimensions));
        }
        if (!spec) lines.push(st.unknownModel);
        else {
          const plan = await setup?.plan();
          lines.push(st.model(spec.label, !!plan?.prepared, plan?.bytes ?? 0));
          if (embedder) {
            const health = (await embedder.health()).status;
            lines.push(st.embedder(st.health[health] ?? health));
          }
        }
        const storeHealth = (await store.health()).status;
        lines.push(st.store(st.health[storeHealth] ?? storeHealth));
        if (existsSync(paths.notebook) || service) {
          try {
            lines.push(st.notebooks(notebooks().db.countNotebooks()));
          } catch {
            lines.push(st.notebooks(null));
          }
        } else lines.push(st.notebooks(0));
        lines.push(st.disk(await diskUse(paths.models), await diskUse(paths.lance)));
        return lines.join("\n");
      },
      { description: "Show semantic engine health, model, disk use and notebooks." },
    ),
  );
  attempt(() =>
    api.commands.register("help", async () => (api.apps ? m.help.withApp : m.help.withoutApp), {
      description: "Explain the Notebook app and semantic search.",
    }),
  );

  if (api.apps) {
    const actions = buildActions({
      service: notebooks,
      engine: {
        async status() {
          const semantic = api.semantic;
          const available = semantic?.available() ?? false;
          const plan = await setup?.plan();
          const running = setup?.running() ? setup.currentId() : undefined;
          return {
            semanticApi: !!semantic,
            available,
            keywordOnly: !available,
            active: semantic?.active() ?? { embedding: null, store: null },
            model: plan
              ? { key: plan.key, label: plan.label, bytes: plan.bytes, prepared: plan.prepared }
              : null,
            modelError: spec ? null : "unknown_model",
            setupJob: running ? (setup?.get(running) ?? null) : null,
            minHost: MIN_HOST,
          };
        },
        setup() {
          if (!setup) throw new SemanticPluginError("unknown_model");
          return { jobId: setup.start().id };
        },
        job: (id) => setup?.get(id) as Record<string, unknown> | undefined,
        cancel: (id) => setup?.cancel(id) ?? false,
      },
    });
    appRegistered = attempt(() =>
      api.apps?.register({
        id: "notebook",
        label: { en: "Notebook", es: "Cuaderno" },
        html: () => readFile(new URL("./embedded.html", import.meta.url), "utf8"),
        actions,
        busy: () => (service?.busy() ?? false) || (setup?.running() ?? false),
        // Called by the host when it closes this workspace: release this activation only.
        dispose: () => runtime.release(),
      }),
    );
  }

  function closeNotebooks() {
    const closing = service;
    service = undefined;
    if (!closing) return;
    closing.dispose();
    void closing
      .idle()
      .catch(() => {})
      .then(() => closing.db.close());
  }

  let released = false;
  const runtime: Runtime = {
    release() {
      if (released) return;
      released = true;
      runtimes.delete(runtime);
      setup?.dispose();
      embedder?.close();
      closeNotebooks();
    },
    hasApp: () => appRegistered,
    idle: () => !(service?.busy() ?? false) && !(setup?.running() ?? false),
  };
  return runtime;
}

export default definePlugin({
  id: "semantic",
  name: "Semantic",
  version: VERSION,
  apiVersion: 1,
  description:
    "Local semantic search (LanceDB + multilingual-e5-small) and a Notebook app grounded in your sources.",
  categories: ["search", "storage"],
  setup(api) {
    runtimes.add(createRuntime(api));
  },
  /**
   * The host gives no activation here, so this must not touch an activation that is still in use
   * by another workspace (0.1.0 did, which unregistered the live Notebook app: O13). Activations
   * with an app are released by their app's `dispose`; idle ones without an app (hosts without
   * `api.apps`) only hold resources that are reopened on demand.
   */
  dispose() {
    for (const runtime of [...runtimes]) if (!runtime.hasApp() && runtime.idle()) runtime.release();
  },
});
