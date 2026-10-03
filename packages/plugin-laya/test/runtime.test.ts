import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "../src/provider.js";
import { layaServe, writeRuntimeRecord } from "../src/runtime/install-state.js";
import { LayaRuntime, type ServerSupervisor } from "../src/runtime.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-laya-rt-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakeSupervisor() {
  let snap: RuntimeSnapshot = { state: "stopped" };
  const sup = {
    snapshot: () => snap,
    transport: () => null,
    ensureStarted: vi.fn(() => {
      snap = { state: "starting" };
    }),
    noteConnectionFailure: vi.fn(),
    recordLatency: vi.fn(),
    stop: vi.fn(async () => {
      snap = { state: "stopped" };
    }),
    killNow: vi.fn(),
    status: () => ({ state: "stopped" as const, restarts: 0 }),
    output: () => "",
    reset: vi.fn(),
  };
  return {
    sup: sup as unknown as ServerSupervisor & typeof sup,
    set: (s: RuntimeSnapshot) => (snap = s),
  };
}

async function install(models = ["multilingual"]) {
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

function make(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const fake = fakeSupervisor();
  const runtime = new LayaRuntime({
    env: { ALISIO_STATE_HOME: join(dir, "state"), ALISIO_CONFIG_HOME: join(dir, "config"), ...env },
    home: dir,
    platform: "linux",
    makeSupervisor: () => fake.sup,
    ...extra,
  });
  return { runtime, fake };
}

describe("LayaRuntime snapshot", () => {
  it("is not_installed before setup", async () => {
    const { runtime } = make();
    await runtime.init();
    expect(runtime.snapshot().state).toBe("not_installed");
  });

  it("reports invalid configuration first", async () => {
    const { runtime } = make({}, { ALISIO_LAYA_DEVICE: "tpu" });
    await runtime.init();
    expect(runtime.snapshot().state).toBe("config_invalid");
  });

  it("reports a missing checkpoint for the configured model", async () => {
    await install(["english"]);
    const { runtime } = make();
    await runtime.init();
    expect(runtime.snapshot()).toMatchObject({ state: "not_installed" });
    expect(runtime.snapshot().detail).toMatch(/multilingual/);
  });

  it("is inactive until activate, then follows the supervisor", async () => {
    await install();
    const { runtime, fake } = make({}, { ALISIO_LAYA_PRELOAD: "0" });
    await runtime.init();
    expect(runtime.snapshot().state).toBe("inactive");
    await runtime.activate();
    expect(runtime.snapshot().state).toBe("stopped");
    fake.set({ state: "ready" });
    expect(runtime.snapshot().state).toBe("ready");
  });

  it("falls back to the host's active-provider check when activate is never called", async () => {
    await install();
    const { runtime } = make({ hostIsActive: () => true }, { ALISIO_LAYA_PRELOAD: "0" });
    await runtime.init();
    expect(runtime.snapshot().state).toBe("stopped");
    runtime.ensureStarted();
    expect(runtime.snapshot().state).toBe("starting");
  });

  it("reports setup_running while a job runs and never starts the server", async () => {
    await install();
    const { runtime, fake } = make();
    await runtime.init();
    await runtime.activate();
    let release!: () => void;
    runtime.jobs.start("repair", () => new Promise<void>((r) => (release = r)));
    expect(runtime.snapshot().state).toBe("setup_running");
    runtime.ensureStarted();
    expect(fake.sup.ensureStarted).toHaveBeenCalledTimes(1); // only the activate-time start, before the job
    release();
    await runtime.jobs.whenIdle();
  });
});

describe("activation lifecycle", () => {
  it("activate with preload starts the server in the background; without it, nothing", async () => {
    await install();
    const withPreload = make();
    await withPreload.runtime.init();
    await withPreload.runtime.activate();
    expect(withPreload.fake.sup.ensureStarted).toHaveBeenCalledOnce();

    const without = make({}, { ALISIO_LAYA_PRELOAD: "0" });
    await without.runtime.init();
    await without.runtime.activate();
    expect(without.fake.sup.ensureStarted).not.toHaveBeenCalled();
  });

  it("activate is a no-op when not installed, config invalid, or a job runs", async () => {
    const notInstalled = make();
    await notInstalled.runtime.init();
    await notInstalled.runtime.activate();
    expect(notInstalled.fake.sup.ensureStarted).not.toHaveBeenCalled();

    await install();
    const invalid = make({}, { ALISIO_LAYA_MODEL: "nope" });
    await invalid.runtime.init();
    await invalid.runtime.activate();
    expect(invalid.fake.sup.ensureStarted).not.toHaveBeenCalled();
  });

  it("activate never throws even when reading state fails", async () => {
    const { runtime } = make();
    vi.spyOn(runtime, "readInstalled").mockRejectedValue(new Error("boom"));
    await expect(runtime.activate()).resolves.toBeUndefined();
  });

  it("deactivate stops the server, is idempotent and never throws", async () => {
    await install();
    const { runtime, fake } = make();
    await runtime.init();
    await runtime.activate();
    await runtime.deactivate();
    await runtime.deactivate();
    expect(fake.sup.stop).toHaveBeenCalled();
    expect(runtime.snapshot().state).toBe("inactive");
    fake.sup.stop.mockRejectedValueOnce(new Error("x"));
    await expect(runtime.deactivate()).resolves.toBeUndefined();
  });

  it("deactivate returns promptly even when stopping is slow", async () => {
    await install();
    const { runtime, fake } = make();
    await runtime.init();
    await runtime.activate();
    fake.sup.stop.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    await runtime.deactivate();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("dispose cancels a running job and stops the server in parallel", async () => {
    await install();
    const { runtime, fake } = make();
    await runtime.init();
    await runtime.activate();
    let aborted = false;
    runtime.jobs.start(
      "repair",
      (ctx) =>
        new Promise<void>((_r, reject) =>
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("x"));
          }),
        ),
    );
    await runtime.dispose();
    expect(aborted).toBe(true);
    expect(fake.sup.stop).toHaveBeenCalled();
  });

  it("killNow forwards the synchronous kill", async () => {
    await install();
    const { runtime, fake } = make();
    await runtime.init();
    await runtime.activate();
    runtime.killNow();
    expect(fake.sup.killNow).toHaveBeenCalledOnce();
  });

  it("refresh stops the old server and rebuilds from the new record", async () => {
    await install();
    const { runtime, fake } = make();
    await runtime.init();
    await runtime.activate();
    await runtime.refresh();
    expect(fake.sup.stop).toHaveBeenCalled();
    expect(runtime.installed.kind).toBe("installed");
  });
});
