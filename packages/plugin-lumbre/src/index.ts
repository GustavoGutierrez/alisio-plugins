import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { definePlugin, type PluginAPI, textResult } from "@alisio/sdk";
import { buildActions } from "./apps.js";
import { LumbreError } from "./errors.js";
import { composeInstructions, type InstructionMode } from "./instructions.js";
import { messagesFor, resolveLocale } from "./messages.js";
import type { StackId } from "./presets.js";
import { ProjectRuntime } from "./runtime.js";
import { Service } from "./service.js";
import { ProjectStore } from "./store.js";
import { registerAgentTools } from "./tools.js";
import { VERSION } from "./version.js";

const require = createRequire(import.meta.url);

/** The npm CLI shipped as a dependency, run through Alisio's own Node (Electron as Node). */
function npmCli() {
  try {
    return join(dirname(require.resolve("npm/package.json")), "bin", "npm-cli.js");
  } catch {
    throw new LumbreError("install_failed");
  }
}

/** Opens the live preview in the system browser (loopback URLs only). */
function openUrl(url: string): Promise<void> {
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(url))
    return Promise.reject(new LumbreError("browser_unavailable"));
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  return new Promise((ok, fail) => {
    const child = spawn(cmd as string, args as string[], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      detached: true,
    });
    child.once("error", () => fail(new LumbreError("browser_unavailable")));
    child.once("spawn", () => {
      child.unref();
      ok();
    });
  });
}

const instructionCache = new Map<string, Promise<string>>();
function instructions(mode: InstructionMode, stack: StackId) {
  const key = `${mode}:${stack}`;
  let cached = instructionCache.get(key);
  if (!cached) {
    cached = composeInstructions(mode, stack).catch((error) => {
      instructionCache.delete(key);
      throw error;
    });
    instructionCache.set(key, cached);
  }
  return cached;
}

/**
 * One activation per open workspace. The host calls `setup` per workspace and `dispose()` without
 * context, so nothing here is module-global: each activation owns its services and releases them
 * when ITS app is unregistered.
 */
interface Activation {
  release(): void;
  hasApp(): boolean;
  idle(): boolean;
}
const activations = new Set<Activation>();

function activate(api: PluginAPI): Activation {
  const m = messagesFor(resolveLocale(api.options?.locale));
  const services = new Map<string, Promise<Service>>();
  const live = new Set<Service>();
  let released = false;
  let appRegistered = false;
  const rootFor = (workspace: string) => {
    if (!api.paths) throw new LumbreError("unavailable");
    return join(api.paths.state, createHash("sha256").update(workspace).digest("hex").slice(0, 32));
  };
  const service = (workspace: string) => {
    if (released) return Promise.reject(new LumbreError("unavailable"));
    let s = services.get(workspace);
    if (!s) {
      const root = rootFor(workspace);
      s = new Service({
        workspace,
        root,
        cacheDir: join(api.paths?.cache ?? root, "npm"),
        ...(api.models ? { models: api.models } : {}),
        sessions: {
          create: (spec) => api.sessions.create(spec),
          run: (id, prompt, options) => api.sessions.run(id, prompt, options),
          cancel: (id) => api.sessions.cancel(id),
          model: (id) => api.sessions.model(id),
        },
        instructions,
        npmCli,
        runtime: (options) => new ProjectRuntime(options),
        openUrl,
      }).init();
      services.set(workspace, s);
      s.then((v) => {
        if (released) v.dispose();
        else live.add(v);
      }).catch(() => services.delete(workspace));
    }
    return s;
  };
  const attempt = (register: () => unknown) => {
    try {
      register();
      return true;
    } catch {
      return false;
    }
  };

  attempt(() =>
    api.commands.register("help", async () => (api.apps ? m.helpWithApp : m.helpWithoutApp), {
      description: "Explain the Lumbre web builder.",
    }),
  );
  attempt(() =>
    api.tools.register({
      name: "lumbre_projects",
      description:
        "List the user's Lumbre web projects in this workspace (title, stack, last update). Read-only.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, ctx) {
        try {
          const root = rootFor(ctx.workspace);
          // Read-only: never create Lumbre's state from the tool.
          if (!existsSync(join(root, "projects"))) return textResult(m.noProjects);
          const store = new ProjectStore(root);
          const { projects, damaged } = await store.load();
          if (!projects.length && !damaged.length) return textResult(m.noProjects);
          return textResult(
            JSON.stringify({
              projects: projects.map((p) => ({
                title: p.title,
                stack: p.stack,
                archived: p.archived,
                updatedAt: new Date(p.updatedAt).toISOString(),
              })),
              damaged: damaged.length,
            }),
          );
        } catch (error) {
          return textResult(error instanceof LumbreError ? error.code : "operation_failed", true);
        }
      },
    }),
  );

  if (api.apps) {
    // Each call resolves the service of its own workspace (from the host context, never the input).
    const actions = buildActions((context) => service(context.workspace));
    // Agent-mode tools: they find the workspace's LIVE service (never start one) and refuse
    // every call that does not come from a running Lumbre job.
    attempt(() =>
      registerAgentTools(api, (workspace) => {
        for (const s of live) if (s.workspace === workspace) return s;
        return undefined;
      }),
    );
    appRegistered = attempt(() =>
      api.apps?.register({
        id: "studio",
        label: { en: "Lumbre · Web builder", es: "Lumbre · Creador web" },
        html: () => readFile(new URL("./embedded.html", import.meta.url), "utf8"),
        actions,
        busy: () => [...live].some((s) => s.busy()),
        dispose: () => activation.release(),
      }),
    );
  }

  const activation: Activation = {
    release() {
      if (released) return;
      released = true;
      activations.delete(activation);
      for (const s of live) s.dispose();
      live.clear();
      services.clear();
    },
    hasApp: () => appRegistered,
    idle: () => ![...live].some((s) => s.busy()),
  };
  return activation;
}

export default definePlugin({
  id: "alisio.lumbre",
  name: "Lumbre",
  version: VERSION,
  apiVersion: 1,
  description:
    "Describe a landing page or a small web app and let your Alisio model build it, with reviewed changes and a live preview.",
  categories: ["tools", "ui"],
  setup(api) {
    api.resources.agents("../.agents/agents");
    api.resources.skills("../.agents/skills");
    activations.add(activate(api));
  },
  /** Releases only activations without an app (those with one are released by the app's dispose). */
  dispose() {
    for (const a of [...activations]) if (!a.hasApp() && a.idle()) a.release();
  },
});
