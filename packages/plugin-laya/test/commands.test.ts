import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CommandDeps, createCommandHandlers, parseSetupArgs } from "../src/commands.js";
import { layaServe, writeRuntimeRecord } from "../src/runtime/install-state.js";
import { InstallCancelled, InstallFailure } from "../src/runtime/installer.js";
import type { Runner } from "../src/runtime/runner.js";
import { LayaRuntime, type ServerSupervisor } from "../src/runtime.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-laya-cmd-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const throwingRunner: Runner = {
  async run() {
    throw new Error("a process was spawned before consent");
  },
};

function fakeSup() {
  let snap: { state: string; detail?: string } = { state: "stopped" };
  return {
    snapshot: () => snap,
    transport: () => null,
    ensureStarted: vi.fn(),
    noteConnectionFailure: vi.fn(),
    recordLatency: vi.fn(),
    stop: vi.fn(async () => {}),
    killNow: vi.fn(),
    status: () => ({
      state: "stopped" as const,
      restarts: 2,
      lastError: "the local server exited (1)",
      latencyMedianMs: 82,
    }),
    output: () => "",
    reset: vi.fn(),
    set: (s: typeof snap) => (snap = s),
  } as unknown as ServerSupervisor & { set: (s: { state: string; detail?: string }) => void };
}

async function setup(over: Partial<CommandDeps> = {}, env: Record<string, string> = {}) {
  const sup = fakeSup();
  const runtime = new LayaRuntime({
    env: { ALISIO_STATE_HOME: join(dir, "state"), ALISIO_CONFIG_HOME: join(dir, "config"), ...env },
    home: dir,
    platform: "linux",
    makeSupervisor: () => sup,
  });
  await runtime.init();
  const ui = {
    interactive: vi.fn(() => true),
    askQuestions: vi.fn(
      async () => ({ "laya-setup-consent": "install" }) as Record<string, string | undefined>,
    ),
    status: vi.fn(),
  };
  const install = vi.fn(async (input: { onStep: (n: number, name: string) => void }) => {
    input.onStep(1, "creating environment");
    return { laya: "0.3.24" } as never;
  });
  const discover = vi.fn(async () => ({
    ok: true as const,
    command: "python3",
    args: [],
    version: "3.12.1",
  }));
  const deps: CommandDeps = {
    runtime,
    ui,
    runner: throwingRunner,
    env: {},
    host: {
      decisions: true,
      paths: true,
      options: true,
      activeProviderId: () => null,
      registered: () => true,
    },
    discover,
    install: install as never,
    smoke: vi.fn(async () => {}),
    nvidia: () => false,
    now: () => new Date("2026-10-03T00:10:00Z"),
    ...over,
  };
  return { deps, handlers: createCommandHandlers(deps), runtime, ui, install, discover, sup };
}

async function installRuntime(models = ["multilingual"]) {
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
    models: models as never,
    venv: "venv-test",
    hub: { repo: "convaiinnovations/laya", revision: "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851" },
    installedAt: "2026-10-03T00:00:00.000Z",
  });
}

describe("parseSetupArgs", () => {
  it("parses flags in both `--x v` and `--x=v` forms", () => {
    expect(parseSetupArgs("--device cpu --model=english --yes")).toEqual({
      ok: true,
      flags: { device: "cpu", model: "english", yes: true, repair: false, uninstall: false },
    });
    expect(parseSetupArgs("")).toEqual({
      ok: true,
      flags: { yes: false, repair: false, uninstall: false },
    });
  });

  it.each([
    ["--bogus"],
    ["--device"],
    ["--device tpu"],
    ["--model nope"],
    ["--repair --uninstall"],
    ["extra words"],
    ["--device=cpu --device=cuda"],
  ])("rejects %s", (text) => {
    expect(parseSetupArgs(text).ok).toBe(false);
  });
});

describe("/laya:setup", () => {
  it("does nothing before consent: no spawn, no write, no install", async () => {
    const { handlers, ui, install, runtime } = await setup();
    ui.askQuestions.mockResolvedValueOnce({ "laya-setup-consent": "cancel" });
    const out = await handlers.setup("");
    expect(out).toMatch(/cancel/i);
    expect(install).not.toHaveBeenCalled();
    expect(runtime.jobs.current()).toBeUndefined();
    await expect(stat(join(dir, "state"))).rejects.toThrow();
  });

  it.each([[{}], [{ "laya-setup-consent": undefined }], [{ other: "install" }]])(
    "treats %j as no consent",
    async (answers) => {
      const { handlers, ui, install } = await setup();
      ui.askQuestions.mockResolvedValueOnce(answers as never);
      expect(await handlers.setup("")).toMatch(/cancel/i);
      expect(install).not.toHaveBeenCalled();
    },
  );

  it("shows the exact plan in the consent question", async () => {
    const { handlers, ui } = await setup();
    await handlers.setup("");
    const question = ui.askQuestions.mock.calls[0]?.[0].questions[0];
    expect(question.question).toContain("laya[serve]==");
    expect(question.question).toContain("huggingface.co");
    expect(question.options.map((o: { value: string }) => o.value)).toEqual(["install", "cancel"]);
  });

  it("refuses headless without --yes and starts nothing", async () => {
    const { handlers, ui, install } = await setup();
    ui.interactive.mockReturnValue(false);
    const out = await handlers.setup("");
    expect(out).toContain("--yes");
    expect(ui.askQuestions).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("accepts --yes without prompting and still prints the plan", async () => {
    const { handlers, ui, runtime } = await setup();
    ui.interactive.mockReturnValue(false);
    const out = await handlers.setup("--yes");
    expect(ui.askQuestions).not.toHaveBeenCalled();
    expect(out).toContain("laya[serve]==");
    await runtime.jobs.whenIdle();
  });

  it("returns immediately after consent without awaiting the install", async () => {
    let release!: () => void;
    const { handlers, runtime, install } = await setup();
    install.mockImplementation(
      () => new Promise((r) => (release = () => r({ laya: "0.3.24" } as never))),
    );
    const out = await handlers.setup("");
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    expect(out).toMatch(/started/i);
    expect(out).toContain("/laya:status");
    expect(out).toContain("/laya:cancel");
    expect(runtime.jobs.current()?.state).toBe("running");
    release();
    await runtime.jobs.whenIdle();
    expect(runtime.jobs.current()?.state).toBe("succeeded");
  });

  it("a second /laya:setup while running starts nothing and reports status", async () => {
    let release!: () => void;
    const { handlers, runtime, install, ui } = await setup();
    install.mockImplementation(
      () => new Promise((r) => (release = () => r({ laya: "0.3.24" } as never))),
    );
    await handlers.setup("");
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    ui.askQuestions.mockClear();
    const out = await handlers.setup("");
    expect(out).toMatch(/already running/i);
    expect(install).toHaveBeenCalledOnce();
    expect(ui.askQuestions).not.toHaveBeenCalled();
    release();
    await runtime.jobs.whenIdle();
  });

  it("reports preflight problems and starts nothing", async () => {
    const { handlers, discover, install, ui } = await setup();
    discover.mockResolvedValueOnce({
      ok: false,
      reason: "Python 3.9 found; 3.10 or newer is required",
    } as never);
    const out = await handlers.setup("");
    expect(out).toContain("3.10");
    expect(ui.askQuestions).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("rejects bad flags with a usage message", async () => {
    const { handlers, install } = await setup();
    expect(await handlers.setup("--device tpu")).toMatch(/device/);
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses to run with an invalid configuration", async () => {
    const { handlers, install } = await setup({}, { ALISIO_LAYA_DEVICE: "tpu" });
    expect(await handlers.setup("")).toMatch(/configuration/i);
    expect(install).not.toHaveBeenCalled();
  });

  it("persists --device/--model to config.json only after a successful install", async () => {
    const { handlers, runtime, install } = await setup();
    install.mockRejectedValueOnce(
      new InstallFailure("pip_failed", "installing packages", "installing packages failed"),
    );
    await handlers.setup("--device cpu --model english");
    await runtime.jobs.whenIdle();
    await expect(readFile(runtime.paths.configFile, "utf8")).rejects.toThrow();

    await handlers.setup("--device cpu --model english");
    await runtime.jobs.whenIdle();
    expect(JSON.parse(await readFile(runtime.paths.configFile, "utf8"))).toMatchObject({
      device: "cpu",
      model: "english",
    });
  });

  it("passes the effective config to the installer and stops a running server first", async () => {
    const { handlers, runtime, install, sup } = await setup();
    await handlers.setup("--model auto");
    await runtime.jobs.whenIdle();
    expect(install.mock.calls[0]?.[0]).toMatchObject({ config: { model: "auto" } });
    expect(sup.stop).not.toBeUndefined();
  });

  it("a cancelled install ends cancelled and writes no config", async () => {
    const { handlers, runtime, install } = await setup();
    install.mockImplementation(async (input: { signal: AbortSignal }) => {
      await new Promise((_r, reject) =>
        input.signal.addEventListener("abort", () => reject(new InstallCancelled())),
      );
      return {} as never;
    });
    await handlers.setup("--device cpu");
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    expect(await handlers.cancel()).toMatch(/cancel/i);
    await runtime.jobs.whenIdle();
    expect(runtime.jobs.current()?.state).toBe("cancelled");
    await expect(readFile(runtime.paths.configFile, "utf8")).rejects.toThrow();
  });

  it("updates the status line during the job and clears it at the end", async () => {
    const { handlers, runtime, ui } = await setup();
    await handlers.setup("");
    await runtime.jobs.whenIdle();
    const texts = ui.status.mock.calls.map((c) => c[1]);
    expect(texts.some((t) => typeof t === "string" && t.includes("creating environment"))).toBe(
      true,
    );
    expect(texts.at(-1)).toBeUndefined();
  });

  it("after a successful install of an active provider with preload, starts the server", async () => {
    const { handlers, runtime, sup } = await setup();
    await installRuntime();
    await runtime.activate();
    sup.ensureStarted = vi.fn();
    await handlers.setup("--repair");
    await runtime.jobs.whenIdle();
    await new Promise((r) => setImmediate(r));
    expect(sup.ensureStarted).toHaveBeenCalled();
  });
});

describe("/laya:setup --uninstall", () => {
  it("asks for confirmation and removes the runtime only after a yes", async () => {
    await installRuntime();
    const { handlers, ui, runtime } = await setup();
    ui.askQuestions.mockResolvedValueOnce({ "laya-uninstall-confirm": "cancel" });
    expect(await handlers.setup("--uninstall")).toMatch(/cancel/i);
    expect((await stat(join(runtime.paths.runtime, "runtime.json"))).isFile()).toBe(true);

    ui.askQuestions.mockResolvedValueOnce({ "laya-uninstall-confirm": "remove" });
    expect(await handlers.setup("--uninstall")).toMatch(/started/i);
    await runtime.jobs.whenIdle();
    await expect(stat(join(runtime.paths.runtime, "runtime.json"))).rejects.toThrow();
    expect(runtime.installed.kind).toBe("none");
  });

  it("requires --yes when headless", async () => {
    await installRuntime();
    const { handlers, ui, runtime } = await setup();
    ui.interactive.mockReturnValue(false);
    expect(await handlers.setup("--uninstall")).toContain("--yes");
    expect((await stat(join(runtime.paths.runtime, "runtime.json"))).isFile()).toBe(true);
  });
});

describe("/laya:cancel", () => {
  it("is a no-op with a clear message when no job runs", async () => {
    const { handlers } = await setup();
    expect(await handlers.cancel()).toMatch(/no setup job/i);
  });
});

describe("/laya:status", () => {
  it("guides a fresh user to setup", async () => {
    const { handlers } = await setup();
    const out = await handlers.status();
    expect(out).toContain("not installed");
    expect(out).toContain("/laya:setup");
    expect(out).toMatch(/decisions API: yes/);
  });

  it("states host support and the version requirement when decisions are missing", async () => {
    const { handlers } = await setup({
      host: {
        decisions: false,
        paths: false,
        options: false,
        activeProviderId: () => null,
        registered: () => false,
      },
    });
    const out = await handlers.status();
    expect(out).toMatch(/decisions API: no/);
    expect(out).toContain("0.3.0");
  });

  it("shows config values with their sources", async () => {
    const { handlers } = await setup({}, { ALISIO_LAYA_DEVICE: "cpu" });
    const out = await handlers.status();
    expect(out).toContain("device: cpu (env)");
    expect(out).toContain("model: multilingual (default)");
    expect(out).toContain("preload: true (default)");
  });

  it("shows the installed pin, checkpoints, server state, restarts, last error and latency", async () => {
    await installRuntime();
    const { handlers, runtime, sup } = await setup({
      host: {
        decisions: true,
        paths: true,
        options: true,
        activeProviderId: () => "laya",
        registered: () => true,
      },
    });
    await runtime.activate();
    sup.set({ state: "ready" });
    const out = await handlers.status();
    expect(out).toContain("laya 0.3.24");
    expect(out).toContain("multilingual");
    expect(out).toMatch(/server: ready/);
    expect(out).toMatch(/restarts: 2/);
    expect(out).toContain("the local server exited (1)");
    expect(out).toMatch(/82 ms/);
  });

  it("tells the user to activate the provider when installed but inactive", async () => {
    await installRuntime();
    const { handlers } = await setup();
    expect(await handlers.status()).toContain('decisions.provider = "laya"');
  });

  it("flags an outdated runtime", async () => {
    await installRuntime();
    const { handlers, runtime } = await setup();
    if (runtime.installed.kind === "installed")
      runtime.installed = { ...runtime.installed, outdated: true };
    expect(await handlers.status()).toContain("/laya:setup --repair");
  });

  it("reports a running job with step and elapsed time, and a failed job with its code", async () => {
    let release!: () => void;
    const { handlers, runtime, install } = await setup();
    install.mockImplementation(async (input: { onStep: (n: number, name: string) => void }) => {
      input.onStep(2, "installing packages");
      await new Promise<void>((r) => (release = r));
      return {} as never;
    });
    await handlers.setup("");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await runtime.jobs.flush();
    const running = await handlers.status();
    expect(running).toMatch(/running/);
    expect(running).toContain("2/6");
    expect(running).toContain("installing packages");
    expect(running).toContain("/laya:cancel");
    release();
    await runtime.jobs.whenIdle();

    install.mockRejectedValueOnce(
      new InstallFailure(
        "pip_failed",
        "installing packages",
        "installing packages failed: no network",
      ),
    );
    await handlers.setup("");
    await runtime.jobs.whenIdle();
    const failed = await handlers.status();
    expect(failed).toContain("failed");
    expect(failed).toContain("pip_failed");
  });

  it("collapses the home directory and never prints tokens", async () => {
    const { handlers } = await setup({ env: { HOME: dir } });
    const out = await handlers.status();
    expect(out).not.toContain(dir);
    expect(out).not.toMatch(/Bearer|[0-9a-f]{64}/);
  });
});
