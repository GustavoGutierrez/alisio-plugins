import { Context7Error } from "./errors.js";
import { VERSION } from "./version.js";

/**
 * Fixed, package-local JSON-RPC over Streamable HTTP client. There is intentionally
 * no MCP SDK dependency, no user-supplied endpoint, no redirect following, and no
 * retry: a single destination, one session per call, and a narrow message subset.
 */
export const MCP_ENDPOINT = "https://mcp.context7.com/mcp";
export const PROTOCOL_VERSION = "2025-03-26";
export const CLIENT_NAME = "alisio-plugin-context7";
export const REQUEST_TIMEOUT_MS = 10_000;
export const CLEANUP_TIMEOUT_MS = 2_000;
export const MAX_BODY_BYTES = 512 * 1024;

const MAX_SSE_EVENTS = 256;
const MAX_SSE_EVENT_CHARS = 128 * 1024;
const MAX_RETRY_AFTER = 86_400;
const RETRY_AFTER_SECONDS = /^\d{1,6}$/;
const SESSION_ID = /^[A-Za-z0-9._~+/=-]{1,256}$/;

export type Fetcher = typeof fetch;

export type McpClientOptions = {
  fetcher?: Fetcher;
  /** Read-only validated key; never exposed or serialized. `undefined` means anonymous. */
  apiKey?: string | undefined;
  version?: string;
};

/** The only part of a `tools/call` result this plugin reads. */
export type RemoteToolResult = { content: unknown[]; isError: boolean };

type ResponseMessage = { id: number | string; result: unknown };

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Context7Error("invalid response");
  return value as Record<string, unknown>;
}

/** Validate one parsed JSON-RPC message as a plain response; reject everything else. */
function asResponse(value: unknown): ResponseMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Context7Error("invalid response");
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== "2.0") throw new Context7Error("invalid response");
  if (typeof record.method === "string") throw new Context7Error("invalid response");
  if (record.error !== undefined) throw new Context7Error("invalid response");
  if (!("result" in record)) throw new Context7Error("invalid response");
  const id = record.id;
  if (typeof id !== "string" && typeof id !== "number") throw new Context7Error("invalid response");
  return { id, result: record.result };
}

/** Require exactly one response whose id matches the request. */
function selectResponse(values: readonly unknown[], requestId: number): ResponseMessage {
  const messages = values.map(asResponse);
  if (messages.length !== 1) throw new Context7Error("invalid response");
  const message = messages[0] as ResponseMessage;
  if (message.id !== requestId) throw new Context7Error("invalid response");
  return message;
}

function contentTypeOf(response: Response): "json" | "sse" | null {
  const raw = response.headers.get("content-type");
  if (!raw) return null;
  const value = raw.split(";")[0]?.trim().toLowerCase();
  if (value === "application/json") return "json";
  if (value === "text/event-stream") return "sse";
  return null;
}

function parseJsonMessage(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Context7Error("invalid response");
  }
  if (Array.isArray(value)) throw new Context7Error("invalid response");
  return value;
}

/** Incremental SSE parse, bounded by event count and per-event size. */
function parseSse(text: string): unknown[] {
  const messages: unknown[] = [];
  let dataLines: string[] = [];
  let eventChars = 0;
  const flush = () => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    dataLines = [];
    eventChars = 0;
    messages.push(parseJsonMessage(payload));
    if (messages.length > MAX_SSE_EVENTS) throw new Context7Error("invalid response");
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      const value = line.slice(5).replace(/^ /, "");
      eventChars += value.length;
      if (eventChars > MAX_SSE_EVENT_CHARS) throw new Context7Error("response exceeded limit");
      dataLines.push(value);
    }
  }
  flush();
  return messages;
}

/** Read a response body with a hard byte ceiling, cancelling the reader on overflow. */
async function readBounded(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES)
    throw new Context7Error("response exceeded limit");
  const body = response.body;
  if (!body) throw new Context7Error("invalid response");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* best effort */
        }
        throw new Context7Error("response exceeded limit");
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function readMessages(response: Response): Promise<unknown[]> {
  const kind = contentTypeOf(response);
  if (!kind) throw new Context7Error("invalid response");
  const text = await readBounded(response);
  return kind === "json" ? [parseJsonMessage(text)] : parseSse(text);
}

function retryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!RETRY_AFTER_SECONDS.test(trimmed)) return undefined;
  const seconds = Number(trimmed);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER);
}

/** Map HTTP status to the safe vocabulary; 3xx is a refused redirect. */
function checkStatus(response: Response): void {
  const status = response.status;
  if ((status >= 300 && status < 400) || response.redirected)
    throw new Context7Error("redirect refused");
  if (status === 429) throw new Context7Error("rate limited", retryAfterSeconds(response));
  if (status === 401 || status === 403) throw new Context7Error("authentication failed");
  if (status === 400 || status === 422) throw new Context7Error("invalid input");
  if (status === 404) throw new Context7Error("invalid response");
  if (status >= 500) throw new Context7Error("temporarily unavailable");
  if (!response.ok) throw new Context7Error("invalid response");
}

function readSessionId(response: Response): string | undefined {
  const raw = response.headers.get("mcp-session-id");
  if (raw === null) return undefined;
  const value = raw.trim();
  if (!SESSION_ID.test(value)) throw new Context7Error("invalid response");
  return value;
}

function assertToolAvailable(result: unknown, name: string): void {
  const record = asObject(result);
  const tools = record.tools;
  if (!Array.isArray(tools)) throw new Context7Error("invalid response");
  const present = tools.some(
    (tool) =>
      typeof tool === "object" &&
      tool !== null &&
      !Array.isArray(tool) &&
      (tool as Record<string, unknown>).name === name,
  );
  if (!present) throw new Context7Error("invalid response");
}

function asToolResult(result: unknown): RemoteToolResult {
  const record = asObject(result);
  const content = record.content;
  if (!Array.isArray(content)) throw new Context7Error("invalid response");
  return { content, isError: record.isError === true };
}

export function createMcpClient(options: McpClientOptions = {}) {
  const fetcher: Fetcher = options.fetcher ?? fetch;
  const apiKey = options.apiKey;
  const version = options.version ?? VERSION;

  const headers = (sessionId?: string): Record<string, string> => {
    const result: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (apiKey) result.authorization = `Bearer ${apiKey}`;
    if (sessionId) result["mcp-session-id"] = sessionId;
    return result;
  };

  const post = async (
    payload: unknown,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> => {
    if (signal.aborted) throw new Context7Error("temporarily unavailable");
    try {
      return await fetcher(MCP_ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: headers(sessionId),
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && /redirect/i.test(error.message))
        throw new Context7Error("redirect refused");
      throw new Context7Error("temporarily unavailable");
    }
  };

  const discard = async (response: Response): Promise<void> => {
    try {
      await response.body?.cancel();
    } catch {
      /* best effort */
    }
  };

  const cleanup = async (sessionId: string): Promise<void> => {
    try {
      const response = await fetcher(MCP_ENDPOINT, {
        method: "DELETE",
        redirect: "error",
        headers: headers(sessionId),
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      });
      await discard(response);
    } catch {
      /* cleanup is best effort and never changes the tool result */
    }
  };

  const call = async (
    name: string,
    args: Record<string, unknown>,
    outer: AbortSignal,
  ): Promise<RemoteToolResult> => {
    if (outer.aborted) throw new Context7Error("temporarily unavailable");
    const signal = AbortSignal.any([outer, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    let sessionId: string | undefined;
    try {
      const initialized = await post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: CLIENT_NAME, version },
          },
        },
        undefined,
        signal,
      );
      checkStatus(initialized);
      sessionId = readSessionId(initialized);
      asObject(selectResponse(await readMessages(initialized), 1).result);

      const notified = await post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId,
        signal,
      );
      checkStatus(notified);
      await discard(notified);

      const listed = await post(
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        sessionId,
        signal,
      );
      checkStatus(listed);
      assertToolAvailable(selectResponse(await readMessages(listed), 2).result, name);

      const invoked = await post(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } },
        sessionId,
        signal,
      );
      checkStatus(invoked);
      return asToolResult(selectResponse(await readMessages(invoked), 3).result);
    } finally {
      if (sessionId) await cleanup(sessionId);
    }
  };

  return { call, headers };
}
