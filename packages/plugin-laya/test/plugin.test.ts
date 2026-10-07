import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DecisionProvider,
  DecisionProviderError,
  type DecisionRequest,
  type PluginAPI,
} from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { createLayaPlugin } from "../src/index.js";
import { layaServe, writeRuntimeRecord } from "../src/runtime/install-state.js";
import { createPidfile } from "../src/runtime/pidfile.js";
import { warmupWire } from "../src/runtime/smoke.js";
import { Supervisor } from "../src/runtime/supervisor.js";
import { createHttpTransport } from "../src/transport/http.js";

const fakeServer = fileURLToPath(new URL("./fixtures/fake-laya-serve.mjs", import.meta.url));
let dir: string;
const plugins: ReturnType<typeof createLayaPlugin>[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-laya-plugin-"));
});
afterEach(async () => {
  // Dispose every plugin (stopping its server) before deleting the temp dir, so a background write
  // cannot race the removal (ENOTEMPTY).
  for (const plugin of plugins.splice(0)) {
    try {
      await plugin.dispose?.();
    } catch {
      // a plugin that is already disposed is fine
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface FakeHost {
  api: PluginAPI;
  commands: Map<string, (args: string) => Promise<string>>;
  providers: DecisionProvider[];
  unregistered: string[];
  setActive: (id: string | null) => void;
  askQuestions: ReturnType<typeof vi.fn>;
}

function fakeHost(
  parts: { decisions?: boolean; paths?: boolean; options?: Record<string, unknown> } = {},
): FakeHost {
  const commands = new Map<string, (args: string) => Promise<string>>();
  const providers: DecisionProvider[] = [];
  const unregistered: string[] = [];
  let active: string | null = null;
  const askQuestions = vi.fn(async () => ({}));
  const forbidden = (what: string) => () => {
    throw new Error(`unexpected registration: ${what}`);
  };
  const api = {
    tools: { register: forbidden("tool") },
    events: { on: forbidden("event") },
    context: { register: forbidden("context") },
    resources: { skills: forbidden("skills") },
    extensions: { register: forbidden("extension") },
    commands: {
      register: (name: string, handler: (args: string) => Promise<string>) => {
        commands.set(name, handler);
        return () => unregistered.push(`command:${name}`);
      },
    },
    ui: { interactive: () => false, askQuestions, status: vi.fn() },
    ...(parts.decisions === false
      ? {}
      : {
          decisions: {
            registerProvider: (provider: DecisionProvider) => {
              providers.push(provider);
              return () => unregistered.push(`provider:${provider.id}`);
            },
            available: () => active === "laya",
            activeProvider: () => (active ? { id: active, name: active } : null),
            tryDecide: async () => null,
          },
        }),
    ...(parts.paths
      ? {
          paths: {
            state: join(dir, "h-state"),
            config: join(dir, "h-config"),
            cache: join(dir, "h-state"),
          },
        }
      : {}),
    ...(parts.options ? { options: Object.freeze({ ...parts.options }) } : {}),
  } as unknown as PluginAPI;
  return { api, commands, providers, unregistered, setActive: (id) => (active = id), askQuestions };
}

const env = () => ({
  ALISIO_STATE_HOME: join(dir, "state"),
  ALISIO_CONFIG_HOME: join(dir, "config"),
});
const request: DecisionRequest = {
  version: 1,
  id: "t",
  state: "hi",
  decisions: { urgent: { type: "boolean", instruction: "urgent?" } },
};
const ctx = (timeoutMs = 1500) => ({ signal: new AbortController().signal, timeoutMs });

describe("plugin metadata", () => {
  it("exposes a stable id, version and the decisions category", () => {
    expect(plugin.id).toBe("laya");
    expect(plugin.apiVersion).toBe(1);
    expect(plugin.categories).toEqual(["decisions"]);
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("setup wiring", () => {
  it("registers four commands and the provider, and nothing else", async () => {
    const host = fakeHost();
    const laya = createLayaPlugin({ env: env(), home: dir, exitHook: false });
    await laya.setup(host.api);
    expect([...host.commands.keys()].sort()).toEqual(["activate", "cancel", "setup", "status"]);
    expect(host.providers).toHaveLength(1);
    expect(host.providers[0]).toMatchObject({ id: "laya", name: "Laya" });
    await laya.dispose?.();
  });

  it("registers only the commands on a core without api.decisions, api.paths or api.options", async () => {
    const host = fakeHost({ decisions: false });
    const laya = createLayaPlugin({ env: env(), home: dir, exitHook: false });
    await expect(laya.setup(host.api)).resolves.toBeUndefined();
    expect(host.providers).toHaveLength(0);
    const status = await host.commands.get("status")?.("");
    expect(status).toContain("0.3.0");
    expect(status).toMatch(/decisions API: no/);
    await laya.dispose?.();
  });

  it("starts no process and writes nothing in setup()", async () => {
    const makeSupervisor = vi.fn();
    const host = fakeHost();
    const laya = createLayaPlugin({ env: env(), home: dir, exitHook: false, makeSupervisor });
    await laya.setup(host.api);
    expect(makeSupervisor).not.toHaveBeenCalled();
    const { stat } = await import("node:fs/promises");
    await expect(stat(join(dir, "state"))).rejects.toThrow();
    await laya.dispose?.();
  });

  it("uses api.paths when present", async () => {
    const host = fakeHost({ paths: true });
    const laya = createLayaPlugin({ env: {}, home: dir, exitHook: false });
    await laya.setup(host.api);
    const status = await host.commands.get("status")?.("");
    expect(status).toMatch(/api\.paths: yes/);
    expect(status).toContain("h-state");
    await laya.dispose?.();
  });

  it("applies api.options and reports invalid host options as unavailable, not as a crash", async () => {
    const good = fakeHost({ options: { device: "cpu" } });
    const a = createLayaPlugin({ env: env(), home: dir, exitHook: false });
    await a.setup(good.api);
    expect(await good.commands.get("status")?.("")).toContain("device: cpu (host)");
    await a.dispose?.();

    const bad = fakeHost({ options: { device: "tpu", apiKey: "x" } });
    const b = createLayaPlugin({ env: env(), home: dir, exitHook: false });
    await b.setup(bad.api);
    const health = await bad.providers[0]?.health?.();
    expect(health?.status).toBe("unavailable");
    expect(health?.detail).toMatch(/device/);
    expect(health?.detail).not.toContain('"x"');
    await expect(bad.providers[0]?.decide(request, ctx())).rejects.toMatchObject({
      code: "unavailable",
    });
    await b.dispose?.();
  });

  it("unregisters the provider and commands and is safe to dispose twice", async () => {
    const host = fakeHost();
    const laya = createLayaPlugin({ env: env(), home: dir, exitHook: false });
    await laya.setup(host.api);
    await laya.dispose?.();
    await laya.dispose?.();
    expect(host.unregistered).toContain("provider:laya");
    expect(host.unregistered).toContain("command:setup");
  });

  it("works with the plugin disabled or uninstalled: decide rejects fast, no crash", async () => {
    const host = fakeHost();
    const laya = createLayaPlugin({ env: env(), home: dir, exitHook: false });
    await laya.setup(host.api);
    const started = Date.now();
    await expect(host.providers[0]?.decide(request, ctx())).rejects.toBeInstanceOf(
      DecisionProviderError,
    );
    expect(Date.now() - started).toBeLessThan(200);
    expect((await host.providers[0]?.health?.())?.status).toBe("unavailable");
    await laya.dispose?.();
  });

  it("registers the exit hook by default and removes it on dispose", async () => {
    const before = process.listenerCount("exit");
    const host = fakeHost();
    const laya = createLayaPlugin({ env: env(), home: dir });
    await laya.setup(host.api);
    expect(process.listenerCount("exit")).toBe(before + 1);
    await laya.dispose?.();
    expect(process.listenerCount("exit")).toBe(before);
  });
});

describe("activation end to end against the fake server", () => {
  async function installed() {
    const runtimeDir = join(dir, "state", "plugins", "laya", "runtime");
    const venv = join(runtimeDir, "venv-test");
    await mkdir(dirname(layaServe(venv)), { recursive: true });
    await writeFile(layaServe(venv), "#!/bin/sh\n");
    await writeRuntimeRecord(runtimeDir, {
      schemaVersion: 1,
      laya: "0.3.24",
      python: "3.12.1",
      torch: "cpu",
      device: "auto",
      models: ["multilingual"],
      venv: "venv-test",
      hub: { repo: "convaiinnovations/laya", revision: "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851" },
      installedAt: "2026-10-03T00:00:00.000Z",
    });
    return runtimeDir;
  }

  const until = async (predicate: () => Promise<boolean> | boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (!(await predicate())) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  function plug(mode = "slow-start:400", extraEnv: Record<string, string> = {}) {
    const plugin = createLayaPlugin({
      env: { ...env(), ...extraEnv },
      home: dir,
      exitHook: false,
      makeSupervisor: ({ paths, venvDir }) =>
        new Supervisor({
          command: () => ({ file: process.execPath, args: [fakeServer, `--mode=${mode}`] }),
          cwd: paths.runtime,
          buildEnv: (port, token) => ({
            PATH: process.env.PATH ?? "",
            LAYA_HOST: "127.0.0.1",
            LAYA_PORT: String(port),
            LAYA_API_KEY: token,
          }),
          pidfile: createPidfile(join(paths.runtime, "server.pid"), { venvRoot: venvDir }),
          makeTransport: (port, token) => createHttpTransport({ port, token }),
          warmupWire: warmupWire(),
          pollMs: 20,
          stopGraceMs: 300,
        }),
    });
    plugins.push(plugin);
    return plugin;
  }

  it("cold start falls back with not_ready (never blocking), then answers once warm; deactivate stops it", async () => {
    await installed();
    const host = fakeHost();
    const laya = plug();
    await laya.setup(host.api);
    const provider = host.providers[0] as DecisionProvider;

    expect((await provider.health?.())?.status).toBe("unavailable"); // not active yet
    await provider.activate?.();
    const started = Date.now();
    await expect(provider.decide(request, ctx())).rejects.toMatchObject({ code: "not_ready" });
    expect(Date.now() - started).toBeLessThan(300);
    expect((await provider.health?.())?.status).toBe("starting");

    await until(async () => (await provider.health?.())?.status === "ready");
    const result = await provider.decide(request, ctx());
    expect(result.decisions.urgent).toMatchObject({
      type: "boolean",
      value: true,
      probability: 0.9,
    });

    await provider.deactivate?.();
    await until(async () => (await provider.health?.())?.status === "unavailable");
    await expect(provider.decide(request, ctx())).rejects.toMatchObject({ code: "unavailable" });
    await laya.dispose?.();
  });

  it("forwards the recommend option of /laya:activate to the host's activate member", async () => {
    await installed();
    const host = fakeHost();
    const activate = vi.fn(async () => ({ status: "activated" as const }));
    (host.api.decisions as unknown as { activate: typeof activate }).activate = activate;
    const laya = plug();
    await laya.setup(host.api);
    const text = await (host.commands.get("activate") as (a: string) => Promise<string>)("");
    expect(text).toMatch(/now the active decision provider/);
    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith("laya", { recommend: true });
    await laya.dispose?.();
  });

  it("without preload the first decide starts the server and still rejects not_ready", async () => {
    await installed();
    const host = fakeHost();
    const laya = plug("slow-start:200", { ALISIO_LAYA_PRELOAD: "0" });
    await laya.setup(host.api);
    const provider = host.providers[0] as DecisionProvider;
    await provider.activate?.();
    expect((await provider.health?.())?.detail).toBe("server not started");
    await expect(provider.decide(request, ctx())).rejects.toMatchObject({ code: "not_ready" });
    await until(async () => (await provider.health?.())?.status === "ready");
    await expect(provider.decide(request, ctx())).resolves.toBeDefined();
    await laya.dispose?.();
  });

  it("honors an already-active Laya on a host without activate hooks", async () => {
    await installed();
    const host = fakeHost();
    host.setActive("laya");
    const laya = plug("fast");
    await laya.setup(host.api);
    const provider = host.providers[0] as DecisionProvider;
    await until(async () => (await provider.health?.())?.status === "ready");
    await laya.dispose?.();
  });

  it("dispose stops a running server within the 2000 ms budget", async () => {
    await installed();
    const host = fakeHost();
    const laya = plug("hang-sigterm");
    await laya.setup(host.api);
    const provider = host.providers[0] as DecisionProvider;
    await provider.activate?.();
    await until(async () => (await provider.health?.())?.status === "ready");
    const started = Date.now();
    await laya.dispose?.();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a server killed mid-flight surfaces as unavailable and recovers via backoff", async () => {
    await installed();
    const host = fakeHost();
    const laya = plug("crash-after:700");
    await laya.setup(host.api);
    const provider = host.providers[0] as DecisionProvider;
    await provider.activate?.();
    await until(async () => (await provider.health?.())?.status === "ready");
    await until(async () => (await provider.health?.())?.status === "unavailable");
    await expect(provider.decide(request, ctx())).rejects.toMatchObject({ code: "unavailable" });
    await laya.dispose?.();
  });
});
