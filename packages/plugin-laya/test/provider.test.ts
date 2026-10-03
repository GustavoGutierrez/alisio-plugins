import { DecisionProviderError, type DecisionRequest } from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import { LayaProtocolError, LayaTimeoutError, LayaUnavailableError } from "../src/errors.js";
import { createLayaProvider, type RuntimeSnapshot, type RuntimeStatus } from "../src/provider.js";
import type { LayaTransport } from "../src/transport/http.js";

const request: DecisionRequest = {
  version: 1,
  id: "t",
  state: "hello",
  decisions: {
    urgent: { type: "boolean", instruction: "Is it urgent?" },
  },
};

const goodBody = { answers: { q0: { noul: 0.9, confidence: 0.9, answer_confidence: 0.9 } } };

function fakes(initial: RuntimeSnapshot = { state: "ready" }) {
  let snapshot = initial;
  const transport: LayaTransport = {
    probe: vi.fn(async () => "up" as const),
    infer: vi.fn(async () => goodBody),
  };
  const runtime: RuntimeStatus = {
    snapshot: () => snapshot,
    ensureStarted: vi.fn(),
    transport: () => (snapshot.state === "ready" ? transport : null),
    noteConnectionFailure: vi.fn(),
    recordLatency: vi.fn(),
  };
  return {
    transport,
    runtime,
    set: (s: RuntimeSnapshot) => {
      snapshot = s;
    },
  };
}

const context = (timeoutMs = 1500) => ({ signal: new AbortController().signal, timeoutMs });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DecisionProviderError);
    return (error as DecisionProviderError).code;
  }
  throw new Error("expected a rejection");
}

describe("provider shape", () => {
  it("declares id, name and all three capabilities", () => {
    const { runtime } = fakes();
    const provider = createLayaProvider({ runtime });
    expect(provider.id).toBe("laya");
    expect(provider.name).toBe("Laya");
    expect(provider.capabilities).toEqual({ select: true, boolean: true, ordinal: true });
  });
});

describe("decide", () => {
  it("returns decoded answers when ready", async () => {
    const { runtime, transport } = fakes();
    const provider = createLayaProvider({ runtime });
    const result = await provider.decide(request, context());
    expect(result.decisions.urgent).toMatchObject({ type: "boolean", value: true });
    expect(transport.infer).toHaveBeenCalledOnce();
    expect(runtime.recordLatency).toHaveBeenCalledOnce();
  });

  it("pins the configured single checkpoint per request", async () => {
    const { runtime, transport } = fakes();
    const provider = createLayaProvider({ runtime, model: "multilingual" });
    await provider.decide(request, context());
    const wire = (transport.infer as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(wire.model).toBe("multilingual");
  });

  it("never calls health or probe on the decide path", async () => {
    const { runtime, transport } = fakes();
    const provider = createLayaProvider({ runtime });
    await provider.decide(request, context());
    expect(transport.probe).not.toHaveBeenCalled();
  });

  it.each([
    [{ state: "starting" }, "not_ready"],
    [{ state: "warming" }, "not_ready"],
    [{ state: "failed", detail: "exit 1" }, "unavailable"],
    [{ state: "backoff", detail: "retry in 4s" }, "unavailable"],
    [{ state: "not_installed" }, "unavailable"],
    [{ state: "setup_running" }, "unavailable"],
    [{ state: "inactive" }, "unavailable"],
    [{ state: "config_invalid", detail: "bad device" }, "unavailable"],
  ] as Array<[RuntimeSnapshot, string]>)(
    "rejects fast for %j with %s without contacting the server",
    async (snapshot, code) => {
      const { runtime, transport } = fakes(snapshot);
      const provider = createLayaProvider({ runtime });
      expect(await codeOf(provider.decide(request, context()))).toBe(code);
      expect(transport.infer).not.toHaveBeenCalled();
      expect(runtime.ensureStarted).not.toHaveBeenCalled();
    },
  );

  it("starts the server in the background on an idle active provider and rejects not_ready", async () => {
    const { runtime } = fakes({ state: "stopped" });
    const provider = createLayaProvider({ runtime });
    expect(await codeOf(provider.decide(request, context()))).toBe("not_ready");
    expect(runtime.ensureStarted).toHaveBeenCalledOnce();
  });

  it("rejects an over-limit request as internal without contacting the server", async () => {
    const { runtime, transport } = fakes();
    const provider = createLayaProvider({ runtime });
    const bad = { ...request, decisions: {} } as DecisionRequest;
    expect(await codeOf(provider.decide(bad, context()))).toBe("internal");
    expect(transport.infer).not.toHaveBeenCalled();
  });

  it("maps timeout, invalid response, server failure and unknown errors", async () => {
    const cases: Array<[unknown, string]> = [
      [new LayaTimeoutError(), "timeout"],
      [new LayaProtocolError("bad_json", "x"), "invalid_response"],
      [new LayaUnavailableError("failed", "x"), "unavailable"],
      [new LayaUnavailableError("overloaded", "x"), "unavailable"],
      [new Error("state leaked: secret"), "internal"],
    ];
    for (const [error, code] of cases) {
      const { runtime, transport } = fakes();
      (transport.infer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);
      const provider = createLayaProvider({ runtime });
      expect(await codeOf(provider.decide(request, context()))).toBe(code);
    }
  });

  it("maps an invalid JSON shape to invalid_response", async () => {
    const { runtime, transport } = fakes();
    (transport.infer as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ nope: true });
    const provider = createLayaProvider({ runtime });
    expect(await codeOf(provider.decide(request, context()))).toBe("invalid_response");
  });

  it("flags a connection failure so the runtime re-probes (process died mid-flight)", async () => {
    const { runtime, transport } = fakes();
    (transport.infer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new LayaUnavailableError("failed", "connection", { connection: true }),
    );
    const provider = createLayaProvider({ runtime });
    expect(await codeOf(provider.decide(request, context()))).toBe("unavailable");
    expect(runtime.noteConnectionFailure).toHaveBeenCalledOnce();
  });

  it("enforces the decision deadline even when the transport ignores the signal", async () => {
    const { runtime, transport } = fakes();
    (transport.infer as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_w: unknown, c: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          c.signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
        }),
    );
    const provider = createLayaProvider({ runtime });
    expect(await codeOf(provider.decide(request, context(40)))).toBe("timeout");
  });

  it("honors the caller's abort signal", async () => {
    const { runtime, transport } = fakes();
    (transport.infer as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_w: unknown, c: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          c.signal.addEventListener("abort", () => reject(new DOMException("x", "AbortError")));
        }),
    );
    const provider = createLayaProvider({ runtime });
    const controller = new AbortController();
    const promise = provider.decide(request, { signal: controller.signal, timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 20);
    expect(await codeOf(promise)).toBe("timeout");
  });

  it("limits in-flight calls to 4 and rejects the rest as unavailable", async () => {
    const { runtime, transport } = fakes();
    const release: Array<() => void> = [];
    (transport.infer as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => release.push(() => resolve(goodBody))),
    );
    const provider = createLayaProvider({ runtime });
    const pending = Array.from({ length: 4 }, () => provider.decide(request, context()));
    expect(await codeOf(provider.decide(request, context()))).toBe("unavailable");
    for (const r of release) r();
    await Promise.all(pending);
    (transport.infer as ReturnType<typeof vi.fn>).mockImplementation(async () => goodBody);
    await expect(provider.decide(request, context())).resolves.toBeDefined();
  });

  it("does not leak decision state into error messages", async () => {
    const { runtime, transport } = fakes();
    (transport.infer as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("hello is the secret state"),
    );
    const provider = createLayaProvider({ runtime });
    try {
      await provider.decide(request, context());
    } catch (error) {
      expect((error as Error).message).not.toContain("secret");
    }
  });
});

describe("health", () => {
  it.each([
    [
      { state: "config_invalid", detail: "device must be cpu" },
      "unavailable",
      "device must be cpu",
    ],
    [{ state: "not_installed" }, "unavailable", "not installed: run /laya:setup"],
    [{ state: "setup_running" }, "unavailable", "setup in progress"],
    [{ state: "inactive" }, "unavailable", "provider not active"],
    [{ state: "starting" }, "starting", undefined],
    [{ state: "warming" }, "starting", undefined],
    [{ state: "stopped" }, "unavailable", "server not started"],
    [{ state: "failed", detail: "exit 1" }, "unavailable", "exit 1"],
    [{ state: "backoff", detail: "retry in 4s" }, "unavailable", "retry in 4s"],
  ] as Array<[RuntimeSnapshot, string, string | undefined]>)(
    "reports %j as %s",
    async (snapshot, status, detail) => {
      const { runtime, transport } = fakes(snapshot);
      const provider = createLayaProvider({ runtime });
      const health = await provider.health?.();
      expect(health?.status).toBe(status);
      if (detail) expect(health?.detail).toContain(detail);
      expect(runtime.ensureStarted).not.toHaveBeenCalled();
      expect(transport.probe).not.toHaveBeenCalled();
    },
  );

  it("probes the server when ready, and reports unavailable if it does not answer", async () => {
    const { runtime, transport } = fakes();
    const provider = createLayaProvider({ runtime });
    expect((await provider.health?.())?.status).toBe("ready");
    (transport.probe as ReturnType<typeof vi.fn>).mockResolvedValueOnce("down");
    const second = await createLayaProvider({ runtime }).health?.();
    expect(second?.status).toBe("unavailable");
  });

  it("caches the probe result for at most 5 seconds", async () => {
    let now = 1000;
    const { runtime, transport } = fakes();
    const provider = createLayaProvider({ runtime, now: () => now });
    await provider.health?.();
    await provider.health?.();
    expect(transport.probe).toHaveBeenCalledTimes(1);
    now += 5001;
    await provider.health?.();
    expect(transport.probe).toHaveBeenCalledTimes(2);
  });

  it("never exceeds its time budget when the probe hangs", async () => {
    const { runtime, transport } = fakes();
    (transport.probe as ReturnType<typeof vi.fn>).mockImplementation(
      (signal?: AbortSignal) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve("down"));
        }),
    );
    const provider = createLayaProvider({ runtime, healthBudgetMs: 50 });
    const started = Date.now();
    const health = await provider.health?.();
    expect(Date.now() - started).toBeLessThan(500);
    expect(health?.status).toBe("unavailable");
  });
});
