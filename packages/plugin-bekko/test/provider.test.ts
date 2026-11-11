import { DecisionProviderError } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { createBekkoProvider } from "../src/provider.js";
import { BekkoRuntime } from "../src/runtime.js";
import type { Engine } from "../src/types.js";
import { deferred, fakeEngine, request } from "./helpers.js";

const decisions = request({
  go: { type: "boolean", instruction: "Proceed?" },
  pick: { type: "select", instruction: "Which?", options: { a: "A", b: "B" } },
});
const ctx = (timeoutMs = 1000) => ({ signal: new AbortController().signal, timeoutMs });

async function readyProvider(engine: Engine = fakeEngine()) {
  const runtime = new BekkoRuntime("68m", async () => engine);
  runtime.activate();
  await runtime.settled();
  return { runtime, provider: createBekkoProvider(runtime) };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionProviderError);
    return (error as DecisionProviderError).code;
  }
  throw new Error("expected a rejection");
}

describe("bekko provider", () => {
  it("declares every capability", () => {
    const provider = createBekkoProvider(new BekkoRuntime("68m", async () => fakeEngine()));
    expect(provider.id).toBe("bekko");
    expect(provider.capabilities).toEqual({ select: true, boolean: true, ordinal: true });
  });

  it("answers through the ready engine", async () => {
    const { provider } = await readyProvider();
    const result = await provider.decide(decisions, ctx());
    expect(result.decisions.go).toEqual({
      type: "boolean",
      value: true,
      confidence: 0.8,
      probability: 0.8,
    });
    expect(result.decisions.pick).toMatchObject({ type: "select", value: "a" });
    expect(await provider.health?.()).toEqual({ status: "ready" });
  });

  it("fails fast with unavailable while inactive", async () => {
    const provider = createBekkoProvider(new BekkoRuntime("68m", async () => fakeEngine()));
    expect(await code(provider.decide(decisions, ctx()))).toBe("unavailable");
    expect(await provider.health?.()).toMatchObject({ status: "unavailable" });
  });

  it("fails fast with not_ready while loading", async () => {
    const gate = deferred<Engine>();
    const runtime = new BekkoRuntime("68m", () => gate.promise);
    const provider = createBekkoProvider(runtime);
    await provider.activate?.();
    expect(await code(provider.decide(decisions, ctx()))).toBe("not_ready");
    expect(await provider.health?.()).toMatchObject({ status: "starting" });
    gate.resolve(fakeEngine());
    await runtime.settled();
    expect(await provider.health?.()).toEqual({ status: "ready" });
  });

  it("reports a load failure as unavailable with its reason", async () => {
    const runtime = new BekkoRuntime("68m", async () => {
      throw new Error("integrity check failed");
    });
    runtime.activate();
    await runtime.settled();
    const provider = createBekkoProvider(runtime);
    expect(await code(provider.decide(decisions, ctx()))).toBe("unavailable");
    expect(await provider.health?.()).toEqual({
      status: "unavailable",
      detail: "integrity check failed",
    });
  });

  it("maps a malformed model answer to invalid_response", async () => {
    const { provider } = await readyProvider(fakeEngine(() => ({ type: "noul", noul: 7 })));
    expect(await code(provider.decide(decisions, ctx()))).toBe("invalid_response");
  });

  it("maps a slow inference to timeout", async () => {
    const slow: Engine = { decide: () => new Promise(() => {}), dispose: async () => {} };
    const { provider } = await readyProvider(slow);
    expect(await code(provider.decide(decisions, ctx(20)))).toBe("timeout");
  });

  it("maps a caller abort to timeout", async () => {
    const slow: Engine = { decide: () => new Promise(() => {}), dispose: async () => {} };
    const { provider } = await readyProvider(slow);
    const controller = new AbortController();
    const pending = provider.decide(decisions, { signal: controller.signal, timeoutMs: 5000 });
    controller.abort();
    expect(await code(pending)).toBe("timeout");
  });

  it("deactivate releases the engine", async () => {
    const engine = fakeEngine();
    const { provider, runtime } = await readyProvider(engine);
    await provider.deactivate?.();
    expect(engine.disposed).toBe(true);
    expect(runtime.snapshot().state).toBe("inactive");
  });
});
