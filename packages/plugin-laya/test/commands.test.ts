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
const runtimes: LayaRuntime[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-laya-cmd-"));
});
afterEach(async () => {
  // Dispose every runtime (which waits for its setup job and stops the server) before deleting the
  // temp dir, so a background write cannot race the removal (ENOTEMPTY).
  for (const runtime of runtimes.splice(0)) {
    try {
      await runtime.dispose();
    } catch {
      // a runtime that is already disposed is fine
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
  runtimes.push(runtime);
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
    // The removal of the runtime directory is asynchronous, so poll instead of racing whenIdle().
    await vi.waitFor(async () => {
      await expect(stat(join(runtime.paths.runtime, "runtime.json"))).rejects.toThrow();
    });
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

type ActivateResult = {
  status:
    | "activated"
    | "already_active"
    | "other_provider_active"
    | "declined"
    | "needs_confirmation"
    | "disabled"
    | "unavailable";
  active?: string;
};

function hostWith(
  activate?: (id: string, options?: { recommend?: boolean }) => Promise<ActivateResult>,
  active: string | null = null,
) {
  return {
    decisions: true,
    paths: true,
    options: true,
    activeProviderId: () => active,
    registered: () => true,
    ...(activate ? { activate } : {}),
  };
}

describe("activation after setup", () => {
  const cases: Array<[ActivateResult, RegExp]> = [
    [{ status: "activated" }, /Laya is now the active decision provider/],
    [{ status: "already_active" }, /nothing to do/i],
    [
      { status: "other_provider_active", active: "builtin" },
      /builtin.*decisions\.provider = "laya"/s,
    ],
    [{ status: "declined" }, /\/laya:activate.*decisions\.provider = "laya"/s],
    [{ status: "needs_confirmation" }, /\/laya:activate.*decisions\.provider = "laya"/s],
    [{ status: "disabled" }, /disabled/i],
    [{ status: "unavailable" }, /decisions\.provider = "laya"/],
  ];

  it.each(cases)(
    "%j is stored in the job record and explained by /laya:status",
    async (result, text) => {
      const activate = vi.fn(async () => result);
      const { handlers, runtime } = await setup({ host: hostWith(activate) });
      await installRuntime();
      await runtime.refresh();
      await handlers.setup("");
      await runtime.jobs.whenIdle();
      expect(activate).toHaveBeenCalledOnce();
      expect(activate).toHaveBeenCalledWith("laya", { recommend: true });
      const stored = JSON.parse(
        await readFile(
          join(dir, "state", "plugins", "laya", "runtime", "jobs", "current.json"),
          "utf8",
        ),
      );
      expect(stored.activation.status).toBe(result.status);
      expect(typeof stored.activation.at).toBe("string");
      if (result.status === "activated" || result.status === "already_active") {
        await runtime.activate();
      }
      const out = await handlers.status();
      expect(out).toMatch(text);
      expect(await handlers.status()).toMatch(text);
      expect(activate).toHaveBeenCalledOnce();
    },
  );

  it("does not call activate when setup fails or is cancelled", async () => {
    const activate = vi.fn(async () => ({ status: "activated" as const }));
    const { handlers, runtime, install } = await setup({ host: hostWith(activate) });
    install.mockRejectedValueOnce(new InstallFailure("pip_failed", "installing packages", "boom"));
    await handlers.setup("");
    await runtime.jobs.whenIdle();
    expect(runtime.jobs.current()?.state).toBe("failed");
    expect(activate).not.toHaveBeenCalled();
    expect(runtime.jobs.current()?.activation).toBeUndefined();
  });

  it("activates after a successful repair but not after an uninstall", async () => {
    const activate = vi.fn(async () => ({ status: "activated" as const }));
    const { handlers, runtime } = await setup({ host: hostWith(activate) });
    await installRuntime();
    await handlers.setup("--repair");
    await runtime.jobs.whenIdle();
    expect(runtime.jobs.current()?.kind).toBe("repair");
    expect(activate).toHaveBeenCalledOnce();
    await handlers.setup("--uninstall --yes");
    await runtime.jobs.whenIdle();
    expect(activate).toHaveBeenCalledOnce();
  });

  it("treats a throwing activate as unavailable and keeps the install succeeded", async () => {
    const activate = vi.fn(async () => {
      throw new Error("host exploded: secret-token");
    });
    const { handlers, runtime } = await setup({ host: hostWith(activate as never) });
    await handlers.setup("");
    await runtime.jobs.whenIdle();
    expect(runtime.jobs.current()?.state).toBe("succeeded");
    expect(runtime.jobs.current()?.activation?.status).toBe("unavailable");
    expect(JSON.stringify(runtime.jobs.current())).not.toContain("secret-token");
  });

  it("on a core without activate, setup succeeds and status keeps the manual instruction", async () => {
    const { handlers, runtime } = await setup({ host: hostWith() });
    await installRuntime();
    await runtime.refresh();
    await handlers.setup("");
    await runtime.jobs.whenIdle();
    expect(runtime.jobs.current()?.state).toBe("succeeded");
    expect(runtime.jobs.current()?.activation).toBeUndefined();
    expect(await handlers.status()).toContain('decisions.provider = "laya"');
  });

  it("never writes the user's config.json when activating", async () => {
    const activate = vi.fn(async () => ({ status: "activated" as const }));
    const { handlers, runtime } = await setup({ host: hostWith(activate) });
    await handlers.setup("");
    await runtime.jobs.whenIdle();
    await expect(readFile(runtime.paths.configFile, "utf8")).rejects.toThrow();
  });
});

describe("/laya:activate", () => {
  it("retries the activation on demand and records the outcome", async () => {
    const activate = vi
      .fn<(id: string, options?: { recommend?: boolean }) => Promise<ActivateResult>>()
      .mockResolvedValueOnce({ status: "declined" })
      .mockResolvedValueOnce({ status: "activated" });
    const { handlers, runtime } = await setup({ host: hostWith(activate) });
    await installRuntime();
    await runtime.refresh();
    await handlers.setup("");
    await runtime.jobs.whenIdle();
    expect(runtime.jobs.current()?.activation?.status).toBe("declined");
    expect(await handlers.activate()).toMatch(/now the active decision provider/);
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenNthCalledWith(1, "laya", { recommend: true });
    expect(activate).toHaveBeenNthCalledWith(2, "laya", { recommend: true });
    expect(runtime.jobs.current()?.activation?.status).toBe("activated");
    activate.mockResolvedValueOnce({ status: "already_active" });
    expect(await handlers.activate()).toMatch(/already/i);
  });

  it("explains each non-activated status", async () => {
    for (const [result, text] of [
      [{ status: "needs_confirmation" }, /confirm/i],
      [{ status: "other_provider_active", active: "builtin" }, /builtin/],
      [{ status: "disabled" }, /disabled/i],
      [{ status: "unavailable" }, /decisions\.provider/],
    ] as Array<[ActivateResult, RegExp]>) {
      const { handlers, runtime } = await setup({ host: hostWith(async () => result) });
      await installRuntime();
      await runtime.refresh();
      expect(await handlers.activate()).toMatch(text);
    }
  });

  it("falls back to the manual instruction when the core has no activate", async () => {
    const { handlers, runtime } = await setup({ host: hostWith() });
    await installRuntime();
    await runtime.refresh();
    expect(await handlers.activate()).toContain('decisions.provider = "laya"');
  });

  it("asks for setup first when Laya is not installed, without calling the host", async () => {
    const activate = vi.fn(async () => ({ status: "activated" as const }));
    const { handlers } = await setup({ host: hostWith(activate) });
    expect(await handlers.activate()).toContain("/laya:setup");
    expect(activate).not.toHaveBeenCalled();
  });
});

describe("a setup job owned by another Alisio process", () => {
  async function foreignJob() {
    const jobs = join(dir, "state", "plugins", "laya", "runtime", "jobs");
    await mkdir(jobs, { recursive: true });
    const file = join(jobs, "current.json");
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        kind: "install",
        state: "running",
        startedAt: "2026-10-03T00:00:00.000Z",
        updatedAt: "2026-10-03T00:00:01.000Z",
        step: { n: 2, total: 6, name: "installing packages" },
        pid: process.ppid,
      }),
    );
    return file;
  }

  it("is reported as running elsewhere by status, setup and cancel, with no writes", async () => {
    const file = await foreignJob();
    const before = await readFile(file, "utf8");
    const { handlers, install, ui } = await setup();
    const status = await handlers.status();
    expect(status).toMatch(/running in another Alisio process/);
    expect(status).toContain("2/6");
    expect(status).not.toMatch(/interrupted/);
    expect(await handlers.setup("--yes")).toMatch(/another Alisio process/);
    expect(install).not.toHaveBeenCalled();
    expect(ui.askQuestions).not.toHaveBeenCalled();
    expect(await handlers.cancel()).toMatch(
      /only be cancelled from the (Alisio )?process that started it/,
    );
    expect(await readFile(file, "utf8")).toBe(before);
  });
});
