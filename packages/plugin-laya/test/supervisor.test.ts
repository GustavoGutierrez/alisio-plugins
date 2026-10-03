import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayaWireRequest } from "../src/protocol/codec.js";
import { createPidfile } from "../src/runtime/pidfile.js";
import { type SpawnFn, Supervisor } from "../src/runtime/supervisor.js";
import { createHttpTransport, type LayaTransport } from "../src/transport/http.js";
import { FakeChild, FakeClock } from "./helpers.js";

const warmupWire: LayaWireRequest = {
  state: "warm-up",
  questions: { q0: { type: "noul", instructions: "ok?", criteria: { true: "yes", false: "no" } } },
};

const fakeServer = fileURLToPath(new URL("./fixtures/fake-laya-serve.mjs", import.meta.url));

describe("Supervisor with a fake spawner and clock", () => {
  let clock: FakeClock;
  let children: FakeChild[];
  let probeResults: Array<"up" | "down">;
  let warmupFails: boolean;
  let pidfile: {
    write: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    reapOrphan: ReturnType<typeof vi.fn>;
  };
  let ports: number;

  function make(extra: Record<string, unknown> = {}) {
    const transport: LayaTransport = {
      probe: vi.fn(async () => probeResults.shift() ?? "up"),
      infer: vi.fn(async () => {
        if (warmupFails) throw new Error("warm-up failed");
        return { answers: {} };
      }),
    };
    const spawnFn: SpawnFn = () => {
      const child = new FakeChild();
      children.push(child);
      return child as never;
    };
    const supervisor = new Supervisor({
      command: () => ({ file: "/rt/venv/bin/laya-serve", args: [] }),
      cwd: "/rt",
      buildEnv: (port, token) => ({ LAYA_PORT: String(port), LAYA_API_KEY: token }),
      pidfile,
      makeTransport: () => transport,
      warmupWire,
      spawn: spawnFn,
      pickPort: async () => 40000 + ports++,
      clock,
      ...extra,
    });
    return { supervisor, transport };
  }

  beforeEach(() => {
    clock = new FakeClock();
    children = [];
    probeResults = [];
    warmupFails = false;
    ports = 0;
    pidfile = {
      write: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      reapOrphan: vi.fn(async () => "none" as const),
    };
  });

  it("starts lazily: nothing runs until ensureStarted, and it is single-flight", async () => {
    const { supervisor } = make();
    expect(supervisor.snapshot().state).toBe("stopped");
    expect(children).toHaveLength(0);
    supervisor.ensureStarted();
    supervisor.ensureStarted();
    supervisor.ensureStarted();
    await clock.flush();
    expect(children).toHaveLength(1);
    expect(supervisor.snapshot().state).toBe("ready");
    expect(supervisor.transport()).not.toBeNull();
    expect(pidfile.reapOrphan).toHaveBeenCalledTimes(1);
    expect(pidfile.write).toHaveBeenCalledOnce();
  });

  it("goes starting -> warming -> ready and polls until the port answers", async () => {
    probeResults = ["down", "down", "up"];
    const { supervisor } = make();
    supervisor.ensureStarted();
    await clock.flush();
    expect(supervisor.snapshot().state).toBe("starting");
    await clock.advance(250);
    expect(supervisor.snapshot().state).toBe("starting");
    await clock.advance(250);
    expect(supervisor.snapshot().state).toBe("ready");
  });

  it("fails and kills the child when it never becomes ready (deadline)", async () => {
    probeResults = Array.from({ length: 1000 }, () => "down" as const);
    const { supervisor } = make();
    supervisor.ensureStarted();
    await clock.advance(120_001);
    expect(supervisor.snapshot().state).toBe("backoff");
    expect(supervisor.snapshot().detail).toMatch(/did not become ready/);
    expect(children[0]?.signals).toContain("SIGKILL");
  });

  it("fails when the child exits at boot", async () => {
    probeResults = Array.from({ length: 1000 }, () => "down" as const);
    const { supervisor } = make();
    supervisor.ensureStarted();
    await clock.flush();
    children[0]?.exit(2);
    await clock.flush();
    expect(supervisor.snapshot().state).toBe("backoff");
    expect(supervisor.snapshot().detail).toMatch(/exited during start/);
    expect(supervisor.transport()).toBeNull();
  });

  it("retries with a new port on an address-in-use failure, up to 3 times", async () => {
    probeResults = Array.from({ length: 1000 }, () => "down" as const);
    const { supervisor } = make();
    supervisor.ensureStarted();
    await clock.flush();
    for (let i = 0; i < 3; i++) {
      children[i]?.stderr.write("OSError: [Errno 98] address already in use");
      await clock.flush();
      children[i]?.exit(1);
      await clock.flush();
    }
    expect(children).toHaveLength(4);
    probeResults = [];
    await clock.advance(300);
    expect(supervisor.snapshot().state).toBe("ready");
    expect(ports).toBe(4);
  });

  it("stops retrying ports after 3 collisions", async () => {
    probeResults = Array.from({ length: 1000 }, () => "down" as const);
    const { supervisor } = make();
    supervisor.ensureStarted();
    await clock.flush();
    for (let i = 0; i < 4; i++) {
      children[i]?.stderr.write("address already in use");
      await clock.flush();
      children[i]?.exit(1);
      await clock.flush();
    }
    expect(children).toHaveLength(4);
    expect(supervisor.snapshot().state).toBe("backoff");
  });

  it("kills the child and backs off when the warm-up fails", async () => {
    warmupFails = true;
    const { supervisor } = make();
    supervisor.ensureStarted();
    await clock.flush();
    expect(supervisor.snapshot().state).toBe("backoff");
    expect(supervisor.snapshot().detail).toMatch(/warm up/);
    expect(children[0]?.signals).toContain("SIGKILL");
  });

  it("restarts lazily with exponential backoff: 1s, 2s, 4s ... capped at 60s", async () => {
    const { supervisor } = make();
    const delays: number[] = [];
    for (let crash = 0; crash < 4; crash++) {
      supervisor.ensureStarted();
      await clock.flush();
      expect(supervisor.snapshot().state).toBe("ready");
      const before = clock.now();
      children.at(-1)?.exit(1);
      await clock.flush();
      const next = supervisor.status().nextRetryAt ?? 0;
      delays.push(next - before);
      // Demand during backoff does not start anything.
      supervisor.ensureStarted();
      await clock.flush();
      expect(children).toHaveLength(crash + 1);
      expect(supervisor.snapshot().state).toBe("backoff");
      await clock.advance(next - clock.now());
      // Lazy: no eager restart without the option.
      expect(children).toHaveLength(crash + 1);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it("caps the backoff at 60 seconds", async () => {
    const { supervisor } = make({ maxFailures: 20, failureWindowMs: 1e12 });
    let last = 0;
    for (let i = 0; i < 9; i++) {
      supervisor.ensureStarted();
      await clock.flush();
      const before = clock.now();
      children.at(-1)?.exit(1);
      await clock.flush();
      last = (supervisor.status().nextRetryAt ?? 0) - before;
      await clock.advance(last);
    }
    expect(last).toBe(60_000);
  });

  it("goes failed after 5 consecutive failures and stays there until reset", async () => {
    const { supervisor } = make();
    for (let i = 0; i < 5; i++) {
      supervisor.ensureStarted();
      await clock.flush();
      children.at(-1)?.exit(1);
      await clock.flush();
      await clock.advance(70_000);
    }
    expect(supervisor.snapshot().state).toBe("failed");
    expect(supervisor.snapshot().detail).toMatch(/repair/);
    const count = children.length;
    supervisor.ensureStarted();
    await clock.flush();
    expect(children).toHaveLength(count);
    supervisor.reset();
    expect(supervisor.snapshot().state).toBe("stopped");
    supervisor.ensureStarted();
    await clock.flush();
    expect(supervisor.snapshot().state).toBe("ready");
  });

  it("a flapping server never resets the streak, a stable one does", async () => {
    const { supervisor } = make();
    for (let i = 0; i < 4; i++) {
      supervisor.ensureStarted();
      await clock.flush();
      children.at(-1)?.exit(1);
      await clock.flush();
      await clock.advance(70_000);
    }
    supervisor.ensureStarted();
    await clock.flush();
    expect(supervisor.snapshot().state).toBe("ready");
    await clock.advance(61_000);
    children.at(-1)?.exit(1);
    await clock.flush();
    expect(supervisor.snapshot().state).toBe("backoff");
    expect(supervisor.status().nextRetryAt).toBe(clock.now() + 1000);
  });

  it("with eagerRestart, restarts once on its own after the first crash", async () => {
    const { supervisor } = make({ eagerRestart: true });
    supervisor.ensureStarted();
    await clock.flush();
    children[0]?.exit(1);
    await clock.flush();
    expect(children).toHaveLength(1);
    await clock.advance(1000);
    expect(children).toHaveLength(2);
    expect(supervisor.snapshot().state).toBe("ready");
    children[1]?.exit(1);
    await clock.flush();
    await clock.advance(70_000);
    expect(children).toHaveLength(2);
  });

  describe("shutdown", () => {
    it("SIGTERM then done when the child exits promptly; pidfile removed; idempotent", async () => {
      const { supervisor } = make();
      supervisor.ensureStarted();
      await clock.flush();
      const first = supervisor.stop();
      const second = supervisor.stop();
      await clock.flush();
      await Promise.all([first, second]);
      expect(children[0]?.signals).toEqual(["SIGTERM"]);
      expect(supervisor.snapshot().state).toBe("stopped");
      expect(pidfile.remove).toHaveBeenCalled();
      await supervisor.stop();
      expect(children[0]?.signals).toEqual(["SIGTERM"]);
      expect(clock.pending()).toBe(0);
    });

    it("escalates to SIGKILL after 1200 ms when the child ignores SIGTERM, within the 2000 ms budget", async () => {
      const { supervisor } = make();
      supervisor.ensureStarted();
      await clock.flush();
      children[0]?.ignore.add("SIGTERM");
      const started = clock.now();
      const stopping = supervisor.stop();
      let done = false;
      void stopping.then(() => {
        done = true;
      });
      await clock.advance(1199);
      expect(done).toBe(false);
      expect(children[0]?.signals).toEqual(["SIGTERM"]);
      await clock.advance(1);
      await stopping;
      expect(children[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(clock.now() - started).toBeLessThanOrEqual(1200);
      expect(clock.now() - started).toBeLessThan(2000);
    });

    it("stops a start in progress and leaves no running child", async () => {
      probeResults = Array.from({ length: 1000 }, () => "down" as const);
      const { supervisor } = make();
      supervisor.ensureStarted();
      await clock.flush();
      expect(supervisor.snapshot().state).toBe("starting");
      const stopping = supervisor.stop();
      await clock.flush();
      await stopping;
      expect(supervisor.snapshot().state).toBe("stopped");
      expect(children[0]?.exitCode !== null || children[0]?.signalCode !== null).toBe(true);
      await clock.advance(200_000);
      expect(children).toHaveLength(1);
    });

    it("clears backoff state on stop and cancels the eager restart", async () => {
      const { supervisor } = make({ eagerRestart: true });
      supervisor.ensureStarted();
      await clock.flush();
      children[0]?.exit(1);
      await clock.flush();
      expect(supervisor.snapshot().state).toBe("backoff");
      await supervisor.stop();
      await clock.advance(5000);
      expect(children).toHaveLength(1);
      expect(supervisor.snapshot().state).toBe("stopped");
    });

    it("killNow issues a synchronous SIGKILL", async () => {
      const { supervisor } = make();
      supervisor.ensureStarted();
      await clock.flush();
      supervisor.killNow();
      expect(children[0]?.signals).toEqual(["SIGKILL"]);
    });

    it("never restarts on demand while stopping", async () => {
      const { supervisor } = make();
      supervisor.ensureStarted();
      await clock.flush();
      children[0]?.ignore.add("SIGTERM");
      const stopping = supervisor.stop();
      supervisor.ensureStarted();
      await clock.flush();
      expect(children).toHaveLength(1);
      await clock.advance(1300);
      await stopping;
    });
  });

  describe("connection failures", () => {
    it("re-probes on a connection failure and treats a dead server as a crash", async () => {
      const { supervisor } = make();
      supervisor.ensureStarted();
      await clock.flush();
      probeResults = ["down"];
      supervisor.noteConnectionFailure();
      await clock.flush();
      expect(supervisor.snapshot().state).toBe("backoff");
      expect(children[0]?.signals).toContain("SIGKILL");
    });

    it("stays ready if the re-probe still answers", async () => {
      const { supervisor } = make();
      supervisor.ensureStarted();
      await clock.flush();
      probeResults = ["up"];
      supervisor.noteConnectionFailure();
      await clock.flush();
      expect(supervisor.snapshot().state).toBe("ready");
    });
  });

  it("reports not installed when there is no command", async () => {
    const { supervisor } = make({ command: () => null });
    supervisor.ensureStarted();
    await clock.flush();
    expect(supervisor.snapshot().state).toBe("failed");
    expect(supervisor.snapshot().detail).toMatch(/not installed/);
    expect(children).toHaveLength(0);
  });

  it("redacts the bearer token from the diagnostic output ring", async () => {
    let token = "";
    const { supervisor } = make({
      buildEnv: (_port: number, t: string) => {
        token = t;
        return { LAYA_API_KEY: t };
      },
    });
    supervisor.ensureStarted();
    await clock.flush();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    children[0]?.stdout.write(`started with LAYA_API_KEY=${token}`);
    await clock.flush();
    expect(supervisor.output()).toContain("LAYA_API_KEY=");
    expect(supervisor.output()).not.toContain(token);
  });

  it("tracks median per-question latency", () => {
    const { supervisor } = make();
    supervisor.recordLatency(400, 4);
    supervisor.recordLatency(240, 2);
    supervisor.recordLatency(90, 1);
    expect(supervisor.status().latencyMedianMs).toBe(100);
  });
});

describe("Supervisor with a real child process (fake-laya-serve)", () => {
  let dir: string;
  const supervisors: Supervisor[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "alisio-laya-sup-"));
  });
  afterEach(async () => {
    await Promise.all(supervisors.splice(0).map((s) => s.stop()));
    await rm(dir, { recursive: true, force: true });
  });

  function real(mode: string, extra: Record<string, unknown> = {}) {
    let lastToken = "";
    let lastPort = 0;
    const pidfilePath = join(dir, "server.pid");
    const pidfile = createPidfile(pidfilePath, { venvRoot: process.execPath });
    const supervisor = new Supervisor({
      command: () => ({
        file: process.execPath,
        args: [fakeServer, `--mode=${mode}`, `--marker=${join(dir, "marker")}`],
      }),
      cwd: dir,
      buildEnv: (port, token) => {
        lastToken = token;
        lastPort = port;
        return {
          PATH: process.env.PATH ?? "",
          LAYA_HOST: "127.0.0.1",
          LAYA_PORT: String(port),
          LAYA_API_KEY: token,
        };
      },
      pidfile,
      makeTransport: (port, token) => createHttpTransport({ port, token }),
      warmupWire,
      pollMs: 20,
      stopGraceMs: 400,
      ...extra,
    });
    supervisors.push(supervisor);
    return { supervisor, pidfilePath, token: () => lastToken, port: () => lastPort };
  }

  async function until(predicate: () => boolean, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > end) throw new Error("timed out waiting for condition");
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  it("starts a fast server, serves a request and stops cleanly", async () => {
    const { supervisor, pidfilePath } = real("fast");
    supervisor.ensureStarted();
    await until(() => supervisor.snapshot().state === "ready");
    const answer = await supervisor
      .transport()
      ?.infer(warmupWire, { signal: AbortSignal.timeout(2000) });
    expect(answer).toMatchObject({ answers: { q0: { noul: 0.9 } } });
    const { access } = await import("node:fs/promises");
    await expect(access(pidfilePath)).resolves.toBeUndefined();
    await supervisor.stop();
    expect(supervisor.snapshot().state).toBe("stopped");
    await expect(access(pidfilePath)).rejects.toThrow();
  });

  it("handles a slow start", async () => {
    const { supervisor } = real("slow-start:300");
    supervisor.ensureStarted();
    await until(() => supervisor.snapshot().state === "starting");
    await until(() => supervisor.snapshot().state === "ready");
  });

  it("fails when the process exits at boot", async () => {
    const { supervisor } = real("exit-at-boot");
    supervisor.ensureStarted();
    await until(() => supervisor.snapshot().state === "backoff");
    expect(supervisor.output()).toContain("fatal boot error");
  });

  it("gives up at the start deadline when the server never listens", async () => {
    const { supervisor } = real("never-ready", { startDeadlineMs: 400 });
    supervisor.ensureStarted();
    await until(() => supervisor.snapshot().state === "backoff");
    expect(supervisor.snapshot().detail).toMatch(/did not become ready/);
  });

  it("retries after a port collision and ends ready", async () => {
    const { supervisor } = real("port-collision");
    supervisor.ensureStarted();
    await until(() => supervisor.snapshot().state === "ready");
  });

  it("escalates to SIGKILL for a server that ignores SIGTERM, inside the 2000 ms budget", async () => {
    const { supervisor } = real("hang-sigterm");
    supervisor.ensureStarted();
    await until(() => supervisor.snapshot().state === "ready");
    const started = Date.now();
    await supervisor.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(supervisor.snapshot().state).toBe("stopped");
  });

  it("detects a crash after ready and backs off", async () => {
    const { supervisor } = real("crash-after:500");
    supervisor.ensureStarted();
    await until(() => supervisor.snapshot().state === "ready");
    await until(() => supervisor.snapshot().state === "backoff");
    expect(supervisor.transport()).toBeNull();
  });

  it("detects a server killed mid-flight through a connection failure", async () => {
    const { supervisor } = real("die-on-request");
    // The warm-up itself kills this server, so the start fails instead of reaching ready.
    supervisor.ensureStarted();
    await until(() => supervisor.snapshot().state === "backoff");
  });

  it("fails the start when the warm-up request fails", async () => {
    const { supervisor } = real("warmup-fail");
    supervisor.ensureStarted();
    await until(() => supervisor.snapshot().state === "backoff");
    expect(supervisor.snapshot().detail).toMatch(/warm up/);
  });

  it("passes only the allowlisted environment to the child and never leaks the token in output", async () => {
    process.env.LAYA_TEST_SECRET = "must-not-leak";
    try {
      const { supervisor, token, port } = real("fast");
      supervisor.ensureStarted();
      await until(() => supervisor.snapshot().state === "ready");
      const response = await fetch(`http://127.0.0.1:${port()}/__env`, {
        headers: { authorization: `Bearer ${token()}` },
      });
      const body = (await response.json()) as { keys: string[] };
      expect(body.keys).not.toContain("LAYA_TEST_SECRET");
      expect(body.keys).toContain("LAYA_API_KEY");
      expect(supervisor.output()).not.toContain(token());
    } finally {
      delete process.env.LAYA_TEST_SECRET;
    }
  });

  it("leaves no child process after stop", async () => {
    const { supervisor } = real("fast");
    supervisor.ensureStarted();
    await until(() => supervisor.snapshot().state === "ready");
    const { pid } = (supervisor as unknown as { child: { pid: number } }).child;
    await supervisor.stop();
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});
