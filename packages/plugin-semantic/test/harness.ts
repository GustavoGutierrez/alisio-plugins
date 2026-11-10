import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EmbeddingProvider,
  PluginAPI,
  PluginAppDefinition,
  SemanticApi,
  ToolDefinition,
  VectorStoreProvider,
} from "@alisio/sdk";
import plugin from "../src/index.js";
import { openTestDb } from "./sqlite.js";

export interface Harness {
  api: PluginAPI;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, (args: string) => Promise<string>>;
  apps: PluginAppDefinition[];
  embeddings: EmbeddingProvider[];
  stores: VectorStoreProvider[];
  root: string;
  completions: unknown[];
  /** Emulates the host closing this workspace: `plugin.dispose()`, then undo its registrations. */
  close: () => Promise<void>;
  cleanup: () => Promise<void>;
}

export interface HarnessOptions {
  semantic?: Partial<SemanticApi> | "absent";
  apps?: boolean;
  options?: Record<string, unknown>;
  workspace?: string;
  /** Reuse a state root (a second activation on the same machine). */
  root?: string;
  complete?: (request: unknown) => Promise<string>;
  models?: Array<{
    reference: string;
    provider?: string;
    profile?: string;
    providerName?: string;
    model?: { id: string; name?: string };
  }>;
}

/** Runs the real plugin entry against a fake host. */
export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "sem-plugin-")));
  const undo: Array<() => void> = [];
  const track = (fn: () => void) => {
    undo.push(fn);
    return fn;
  };
  const h = {
    tools: new Map<string, ToolDefinition>(),
    commands: new Map<string, (args: string) => Promise<string>>(),
    apps: [] as PluginAppDefinition[],
    embeddings: [] as EmbeddingProvider[],
    stores: [] as VectorStoreProvider[],
    completions: [] as unknown[],
  };
  const semantic =
    options.semantic === "absent"
      ? undefined
      : ({
          available: () => false,
          active: () => ({ embedding: null, store: null }),
          registerEmbedding: (p: EmbeddingProvider) => {
            h.embeddings.push(p);
            return () => {};
          },
          registerStore: (p: VectorStoreProvider) => {
            h.stores.push(p);
            return () => {};
          },
          ...(options.semantic ?? {}),
        } as unknown as SemanticApi);
  const api = {
    paths: { state: join(root, "state"), config: join(root, "config"), cache: join(root, "cache") },
    // Pin the command language so tests do not depend on the machine's LANG.
    options: options.options ?? { locale: "en" },
    storage: { sqlite: (path: string) => openTestDb(path) },
    sessions: { workspace: () => options.workspace ?? root, model: () => "acme/fast" },
    models: {
      list: async () =>
        options.models ?? [
          {
            reference: "acme/fast",
            provider: "acme",
            profile: "default",
            providerName: "Acme",
            model: { id: "fast", name: "Fast" },
          },
        ],
      resolve: async (reference: string) => {
        const found = (options.models ?? [{ reference: "acme/fast" }]).find(
          (m) => m.reference === reference,
        );
        if (!found) throw new Error("unknown model");
        return found;
      },
    },
    model: {
      complete: async (request: unknown) => {
        h.completions.push(request);
        return options.complete ? options.complete(request) : "An answer [1].";
      },
    },
    tools: {
      register: (tool: ToolDefinition) => {
        h.tools.set(tool.name, tool);
        return track(() => h.tools.delete(tool.name));
      },
    },
    commands: {
      register: (name: string, handler: (args: string) => Promise<string>) => {
        h.commands.set(name, handler);
        return track(() => h.commands.delete(name));
      },
    },
    ...(semantic ? { semantic } : {}),
    ...(options.apps === false
      ? {}
      : {
          apps: {
            register: (app: PluginAppDefinition) => {
              h.apps.push(app);
              // Like the host registry: unregistering removes the app and calls its dispose once.
              let removed = false;
              return track(() => {
                if (removed) return;
                removed = true;
                h.apps.splice(h.apps.indexOf(app), 1);
                app.dispose?.();
              });
            },
          },
        }),
  } as unknown as PluginAPI;
  await plugin.setup(api);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await plugin.dispose?.();
    for (const fn of undo.reverse()) fn();
  };
  return {
    ...h,
    api,
    root,
    close,
    cleanup: async () => {
      await close();
      if (!options.root) await rm(root, { recursive: true, force: true });
    },
  };
}
