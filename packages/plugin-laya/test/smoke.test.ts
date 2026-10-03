import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPidfile } from "../src/runtime/pidfile.js";
import { runSmoke, SmokeFailure, warmupWire } from "../src/runtime/smoke.js";
import { Supervisor } from "../src/runtime/supervisor.js";
import { createHttpTransport } from "../src/transport/http.js";

const fakeServer = fileURLToPath(new URL("./fixtures/fake-laya-serve.mjs", import.meta.url));
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-laya-smoke-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function supervisorFor(mode: string) {
  return new Supervisor({
    command: () => ({ file: process.execPath, args: [fakeServer, `--mode=${mode}`] }),
    cwd: dir,
    buildEnv: (port, token) => ({
      PATH: process.env.PATH ?? "",
      LAYA_HOST: "127.0.0.1",
      LAYA_PORT: String(port),
      LAYA_API_KEY: token,
    }),
    pidfile: createPidfile(join(dir, "server.pid"), { venvRoot: process.execPath }),
    makeTransport: (port, token) => createHttpTransport({ port, token }),
    warmupWire: warmupWire(),
    pollMs: 20,
    stopGraceMs: 300,
  });
}

describe("runSmoke", () => {
  it("passes against a healthy server and stops it", async () => {
    const supervisor = supervisorFor("fast");
    await runSmoke(supervisor, new AbortController().signal, { pollMs: 20 });
    expect(supervisor.snapshot().state).toBe("stopped");
  });

  it("fails when the server never starts and still stops it", async () => {
    const supervisor = supervisorFor("exit-at-boot");
    await expect(
      runSmoke(supervisor, new AbortController().signal, { pollMs: 20 }),
    ).rejects.toBeInstanceOf(SmokeFailure);
    expect(supervisor.snapshot().state).toBe("stopped");
  });

  it("fails when readiness times out", async () => {
    const supervisor = supervisorFor("slow-start:5000");
    await expect(
      runSmoke(supervisor, new AbortController().signal, { pollMs: 20, readyTimeoutMs: 200 }),
    ).rejects.toBeInstanceOf(SmokeFailure);
    expect(supervisor.snapshot().state).toBe("stopped");
  });

  it("stops when cancelled", async () => {
    const supervisor = supervisorFor("slow-start:5000");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(runSmoke(supervisor, controller.signal, { pollMs: 20 })).rejects.toBeInstanceOf(
      SmokeFailure,
    );
    expect(supervisor.snapshot().state).toBe("stopped");
  });
});
