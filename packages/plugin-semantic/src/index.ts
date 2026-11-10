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

interface Runtime {
  dispose(): void;
}
let current: Runtime | undefined;

function createRuntime(api: PluginAPI): Runtime {
  const options = api.options ?? {};
  const locale: Locale = resolveLocale(options.locale);
  const m = messagesFor(locale);
  const paths = resolvePaths(api.paths);
  const disposers: Array<() => void> = [];
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
    try {
      disposers.push(api.semantic.registerEmbedding(embedder));
      disposers.push(api.semantic.registerStore(store));
    } catch {
      // A duplicate id (another copy of this plugin) keeps the previous registration (core SE-R2).
    }
  }

  let service: NotebookService | undefined;
  const notebooks = () => {
    if (!service) {
      if (!api.storage?.sqlite) throw new Error("storage unavailable");
      service = new NotebookService({
        db: new NotebookDb(api.storage.sqlite(paths.notebook)),
        semantic: () => api.semantic,
        complete: (request) => api.model.complete(request),
      });
    }
    return service;
  };

  disposers.push(
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

  disposers.push(
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
  disposers.push(
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
  disposers.push(
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
    disposers.push(
      api.apps.register({
        id: "notebook",
        label: { en: "Notebook", es: "Cuaderno" },
        html: () => readFile(new URL("./embedded.html", import.meta.url), "utf8"),
        actions,
        busy: () => (service?.busy() ?? false) || (setup?.running() ?? false),
        dispose: () => closeNotebooks(),
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

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      setup?.dispose();
      embedder?.close();
      closeNotebooks();
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // Host already removed it.
        }
      }
    },
  };
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
    current?.dispose();
    current = createRuntime(api);
  },
  dispose() {
    current?.dispose();
    current = undefined;
  },
});
