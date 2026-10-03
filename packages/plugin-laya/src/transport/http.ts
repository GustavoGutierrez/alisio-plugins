/** Loopback-only HTTP client for the Laya server. Zero dependencies: global `fetch`. */
import { LayaProtocolError, LayaTimeoutError, LayaUnavailableError } from "../errors.js";
import type { LayaWireRequest } from "../protocol/codec.js";

export type ProbeResult = "up" | "down" | "auth";

export interface InferContext {
  signal: AbortSignal;
}

/** The seam a future remote provider reuses: the codec feeds it, the provider consumes it. */
export interface LayaTransport {
  probe(signal?: AbortSignal): Promise<ProbeResult>;
  infer(wire: LayaWireRequest, context: InferContext): Promise<unknown>;
}

export interface HttpTransportOptions {
  port: number;
  token: string;
  host?: string;
  maxBodyBytes?: number;
  fetchImpl?: typeof fetch;
}

const LOOPBACK = "127.0.0.1";
const DEFAULT_MAX_BODY = 1024 * 1024;

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new LayaProtocolError("body_too_large", "response body is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new LayaProtocolError("body_too_large", "response body is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof LayaProtocolError) throw error;
    if (signal.aborted || isAbort(error)) throw new LayaTimeoutError();
    throw new LayaUnavailableError("failed", "connection to the local server failed", {
      connection: true,
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createHttpTransport(options: HttpTransportOptions): LayaTransport {
  const host = options.host ?? LOOPBACK;
  if (host !== LOOPBACK) throw new Error("the Laya transport only connects to 127.0.0.1");
  const base = `http://${host}:${options.port}`;
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const doFetch = options.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${options.token}` };

  async function request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, { ...init, redirect: "manual", signal });
    } catch (error) {
      if (signal.aborted || isAbort(error)) throw new LayaTimeoutError();
      throw new LayaUnavailableError("failed", "connection to the local server failed", {
        connection: true,
      });
    }
  }

  return {
    async probe(signal) {
      const guard = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(2000)])
        : AbortSignal.timeout(2000);
      try {
        const response = await request("/health", { method: "GET", headers }, guard);
        await response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) return "auth";
        return response.status === 200 ? "up" : "down";
      } catch {
        return "down";
      }
    },

    async infer(wire, context) {
      const response = await request(
        "/v1/systemone",
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(wire),
        },
        context.signal,
      );
      const { status } = response;
      if (status >= 300 && status < 400) {
        await response.body?.cancel().catch(() => {});
        throw new LayaProtocolError("redirect", "the local server redirected the request");
      }
      if (status !== 200) {
        await response.body?.cancel().catch(() => {});
        if (status === 401 || status === 403) {
          throw new LayaUnavailableError("failed", "the local server rejected the access token");
        }
        if (status === 413 || status === 422) {
          throw new LayaProtocolError(
            "rejected",
            `the local server rejected the request (${status})`,
          );
        }
        if (status === 503)
          throw new LayaUnavailableError("overloaded", "the local server is overloaded");
        throw new LayaUnavailableError("failed", `the local server failed (${status})`);
      }
      const type = response.headers.get("content-type") ?? "";
      if (!type.toLowerCase().includes("application/json")) {
        await response.body?.cancel().catch(() => {});
        throw new LayaProtocolError("bad_content_type", "unexpected response content type");
      }
      const text = await readBounded(response, limit, context.signal);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new LayaProtocolError("bad_json", "response is not valid JSON");
      }
    },
  };
}
