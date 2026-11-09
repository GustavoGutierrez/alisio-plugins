import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin, type PluginAPI, type PluginAppAction, textResult } from "@alisio/sdk";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { ScribeError } from "./types.js";
import { VERSION } from "./version.js";

const READ_ACTIONS = [
  "context",
  "models",
  "documents.list",
  "documents.get",
  "jobs.list",
  "projects.export",
  "sources.export",
  "pdf.get",
];
const WRITE_ACTIONS = [
  "projects.import",
  "jobs.cancel",
  "documents.create",
  "documents.settings",
  "revision.save",
  "revision.restore",
  "proposal.apply",
  "proposal.discard",
  "assets.add",
  "assets.remove",
  "draft.generate",
];
const PROCESS_ACTIONS = ["pdf.compile"];

const HELP_WITH_APP =
  "Open Scribe from the Apps group in the project sidebar / Abre Scribe desde el grupo Aplicaciones del panel de proyectos.";
const HELP_WITHOUT_APP =
  "This Alisio host has no plugin apps API, so the Scribe studio is unavailable: it needs Alisio 0.11.6 or newer. The scribe_documents tool and the documents view still work. / Este host de Alisio no tiene la API de apps de plugins, así que el estudio de Scribe no está disponible: requiere Alisio 0.11.6 o posterior. La herramienta scribe_documents y la vista de documentos siguen funcionando.";

export default definePlugin({
  id: "alisio.scribe",
  name: "Scribe",
  version: VERSION,
  apiVersion: 1,
  description: "Scientific writing studio with agent-assisted LaTeX, revisions and PDF builds.",
  categories: ["tools", "ui"],
  setup(api) {
    const disposers: Array<() => void> = [];
    const services = new Map<string, Promise<Service>>();
    const liveServices = new Set<Service>();
    const workspaces = new Map<string, Promise<{ store: Store; busy: Set<string> }>>();

    // `api.apps` ships with Alisio 0.11.5; older hosts leave it out. Everything else registers
    // first, so the tool, view and help keep working there (fail-open).
    api.resources.agents("../.agents/agents");
    api.resources.skills("../.agents/skills");
    const options = api.options ?? {};
    const root = api.paths?.state;

    function workspaceStore(workspace: string) {
      let shared = workspaces.get(workspace);
      if (!shared) {
        if (!root) throw new Error("Scribe requires api.paths (Alisio 0.11.5 or newer).");
        const dir = join(root, createHash("sha256").update(workspace).digest("hex").slice(0, 32));
        shared = (async () => {
          const store = new Store(dir);
          await store.init();
          await store.recover();
          return { store, busy: new Set<string>() };
        })();
        workspaces.set(workspace, shared);
      }
      return shared;
    }
    function service(sessionId: string) {
      const workspace = api.sessions.workspace(sessionId);
      const key = `${sessionId}:${workspace}`;
      let instance = services.get(key);
      if (!instance) {
        instance = (async () => {
          const shared = await workspaceStore(workspace);
          const created = new Service(
            api,
            shared.store,
            sessionId,
            {
              locale: options.locale === "es" ? "es" : "en",
              allowedTools: Array.isArray(options.allowedTools)
                ? options.allowedTools.filter((s): s is string => typeof s === "string")
                : [],
            },
            shared.busy,
          );
          liveServices.add(created);
          return created;
        })();
        services.set(key, instance);
      }
      return instance;
    }

    disposers.push(
      api.commands.register("help", async () => (api.apps ? HELP_WITH_APP : HELP_WITHOUT_APP)),
    );
    disposers.push(
      api.tools.register({
        name: "scribe_documents",
        description: "List Scribe documents for the current workspace.",
        effect: "read",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, context) {
          if (!context.session) return textResult("An active session is required.");
          // No lazy storage creation/recovery for a tool declared read-only.
          const workspace = api.sessions.workspace(context.session);
          const existing = services.get(`${context.session}:${workspace}`);
          return textResult(
            existing
              ? JSON.stringify(await (await existing).store.list())
              : "Open Scribe to initialize its document store.",
          );
        },
      }),
    );
    if (api.views)
      disposers.push(
        api.views.register({
          id: "documents",
          description: "Scribe document summaries.",
          async handler(_params, context) {
            const instance = services.get(`${context.sessionId}:${context.workspace}`);
            return instance ? (await instance).store.list() : [];
          },
        }),
      );

    if (!api.apps) return;
    const actions: Record<string, PluginAppAction> = {};
    for (const action of [...READ_ACTIONS, ...WRITE_ACTIONS, ...PROCESS_ACTIONS])
      actions[action] = {
        effect: READ_ACTIONS.includes(action)
          ? "read"
          : PROCESS_ACTIONS.includes(action)
            ? "process"
            : "write",
        inputSchema: { type: "object" },
        async handler(input, context) {
          context.signal.throwIfAborted();
          try {
            const instance = await service(context.sessionId);
            const args = (input ?? {}) as Record<string, unknown>;
            return { value: await instance.invoke(action, args, context.idempotencyKey) };
          } catch (error) {
            return { error: error instanceof ScribeError ? error.code : "operation_failed" };
          }
        },
      };
    disposers.push(
      api.apps.register({
        id: "studio",
        label: { en: "Scribe · Writing", es: "Scribe · Redacción" },
        html: () => readFile(new URL("./embedded.html", import.meta.url), "utf8"),
        actions,
        busy: () => [...liveServices].some((s) => s.controllers.size > 0),
        dispose() {
          for (const value of services.values())
            void value.then((instance) => instance.dispose()).catch(() => {});
          services.clear();
          workspaces.clear();
          liveServices.clear();
        },
      }),
    );
  },
});

export type { PluginAPI };
export { Service, Store };
