import { describe, expect, it } from "vitest";
import { BekkoRuntime } from "../src/runtime.js";
import { deferred, fakeEngine } from "./helpers.js";

describe("BekkoRuntime", () => {
  it("stays inactive and loads nothing until activated", async () => {
    let calls = 0;
    const runtime = new BekkoRuntime("68m", async () => {
      calls++;
      return fakeEngine();
    });
    runtime.ensureStarted();
    await runtime.settled();
    expect(calls).toBe(0);
    expect(runtime.snapshot().state).toBe("inactive");
  });

  it("loads once in the background and becomes ready", async () => {
    let calls = 0;
    const gate = deferred<void>();
    const runtime = new BekkoRuntime("17m", async (variant, progress) => {
      calls++;
      expect(variant).toBe("17m");
      progress("download 50%");
      await gate.promise;
      return fakeEngine();
    });
    runtime.activate();
    runtime.activate();
    runtime.ensureStarted();
    expect(runtime.snapshot()).toMatchObject({ state: "loading", detail: "download 50%" });
    expect(runtime.current()).toBeNull();
    gate.resolve();
    await runtime.settled();
    expect(calls).toBe(1);
    expect(runtime.snapshot().state).toBe("ready");
    expect(runtime.current()).not.toBeNull();
  });

  it("reports a failure and retries on the next start", async () => {
    let attempt = 0;
    const runtime = new BekkoRuntime("68m", async () => {
      attempt++;
      if (attempt === 1) throw new Error("network down");
      return fakeEngine();
    });
    runtime.activate();
    await runtime.settled();
    expect(runtime.snapshot()).toMatchObject({ state: "failed", detail: "network down" });
    runtime.ensureStarted();
    await runtime.settled();
    expect(runtime.snapshot().state).toBe("ready");
  });

  it("discards a load that finishes after deactivation", async () => {
    const gate = deferred<void>();
    const engine = fakeEngine();
    const runtime = new BekkoRuntime("68m", async () => {
      await gate.promise;
      return engine;
    });
    runtime.activate();
    const loading = runtime.settled();
    await runtime.deactivate();
    gate.resolve();
    await loading;
    await new Promise((r) => setTimeout(r, 0));
    expect(runtime.snapshot().state).toBe("inactive");
    expect(engine.disposed).toBe(true);
  });

  it("disposes the loaded engine and refuses to restart after dispose", async () => {
    const engine = fakeEngine();
    const runtime = new BekkoRuntime("68m", async () => engine);
    runtime.activate();
    await runtime.settled();
    await runtime.dispose();
    expect(engine.disposed).toBe(true);
    runtime.activate();
    expect(runtime.snapshot().state).toBe("inactive");
  });
});
