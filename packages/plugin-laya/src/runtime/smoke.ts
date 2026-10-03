/** Setup smoke test: start the freshly installed server, ask one question of each type, stop it. */
import type { DecisionRequest } from "@alisio/sdk";
import { decodeResponse, encodeRequest, type LayaWireRequest } from "../protocol/codec.js";
import type { Supervisor } from "./supervisor.js";

export const SMOKE_REQUEST: DecisionRequest = {
  version: 1,
  id: "laya-setup-smoke",
  state: { text: "The invoice was paid twice and the customer is asking for a refund." },
  decisions: {
    route: {
      type: "select",
      instruction: "Which team should handle this message?",
      options: { billing: "billing and payments", support: "technical support" },
    },
    refund: { type: "boolean", instruction: "Is the customer asking for a refund?" },
    severity: {
      type: "ordinal",
      instruction: "How urgent is this message?",
      levels: ["low", "medium", "high"],
    },
  },
};

/** Minimal request used to warm the model after the port opens. */
export function warmupWire(): LayaWireRequest {
  return encodeRequest({
    version: 1,
    id: "laya-warmup",
    state: "warm-up",
    decisions: { ready: { type: "boolean", instruction: "Is this a warm-up message?" } },
  }).wire;
}

export interface SmokeOptions {
  /** Max wait for readiness. */
  readyTimeoutMs?: number;
  pollMs?: number;
  model?: string;
}

export class SmokeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeFailure";
  }
}

/** Start, query, decode and stop. The supervisor is always stopped, even on failure. */
export async function runSmoke(
  supervisor: Supervisor,
  signal: AbortSignal,
  options: SmokeOptions = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + (options.readyTimeoutMs ?? 180_000);
  try {
    supervisor.ensureStarted();
    for (;;) {
      if (signal.aborted) throw new SmokeFailure("smoke test cancelled");
      const { state, detail } = supervisor.snapshot();
      if (state === "ready") break;
      if (state === "failed" || state === "backoff") {
        throw new SmokeFailure(`the local server did not start${detail ? `: ${detail}` : ""}`);
      }
      if (Date.now() > deadline)
        throw new SmokeFailure("the local server did not become ready in time");
      await new Promise((r) => setTimeout(r, pollMs));
    }
    const transport = supervisor.transport();
    if (!transport) throw new SmokeFailure("the local server is not reachable");
    const { wire, plan } = encodeRequest(
      SMOKE_REQUEST,
      options.model ? { model: options.model } : {},
    );
    const body = await transport.infer(wire, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    const result = decodeResponse(body, plan);
    const kinds = Object.values(result.decisions)
      .map((d) => d.type)
      .sort();
    if (kinds.join(",") !== "boolean,ordinal,select") {
      throw new SmokeFailure("the local server returned an unexpected answer shape");
    }
  } finally {
    await supervisor.stop();
  }
}
