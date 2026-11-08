import type {
  Attachment,
  ModelInfo,
  ModelProvider,
  ProviderEvent,
  ProviderOAuthHandle,
  ToolCall,
  Usage,
} from "@alisio/sdk";
import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParams,
  ResponseFunctionToolCall,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseStreamEvent,
  ResponseUsage,
} from "openai/resources/responses/responses";
import { API_BASE_URL } from "./chatgpt/constants.js";
import { ChatGPTError, safeCode, signInAgain } from "./chatgpt/errors.js";
import { FALLBACK_MODELS, parseModels } from "./chatgpt/models.js";

const image = (a: Attachment) => `data:${a.mimeType};base64,${a.data}`;
const usage = (value: ResponseUsage | undefined): Usage | undefined =>
  value && Number.isFinite(value.input_tokens) && Number.isFinite(value.output_tokens)
    ? {
        input: value.input_tokens,
        output: value.output_tokens,
        ...(Number.isFinite(value.input_tokens_details?.cached_tokens)
          ? { cachedInput: value.input_tokens_details.cached_tokens }
          : {}),
      }
    : undefined;
const output = (response: Response) => {
  const data = response.output;
  const calls: ToolCall[] = data
    .filter((item): item is ResponseFunctionToolCall => item.type === "function_call")
    .map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
  if (calls.some((c) => !c.id || !c.name || typeof c.arguments !== "string"))
    throw new Error("Incomplete tool call");
  const text = data
    .filter((item): item is ResponseOutputMessage => item.type === "message")
    .flatMap((item) => item.content)
    .filter((item): item is ResponseOutputText => item.type === "output_text")
    .map((item) => item.text)
    .join("");
  return { data, calls, text };
};
export interface OpenAIProviderConfig {
  apiKey?: string;
  model: string;
  /**
   * Sign-in session handle from the host (`request.oauth`). When present the provider asks it
   * for a fresh bearer on every request and never holds a static key (spec 025 D11).
   */
  oauth?: ProviderOAuthHandle;
  /** Provider id reported to the host; defaults to `openai`. */
  id?: string;
  /** Injected `fetch` (tests); defaults to the global one. */
  fetch?: typeof fetch;
}

type AuthFailure = "revoked" | "unauthorized" | undefined;
const REVOKED = "token_revoked";

const headerValue = (headers: unknown, name: string) =>
  headers instanceof Headers
    ? headers.get(name)
    : headers && typeof headers === "object"
      ? (headers as Record<string, unknown>)[name]
      : undefined;

const authFailure = (status: unknown, code: unknown, headers: unknown): AuthFailure => {
  if (status !== 401) return undefined;
  return code === REVOKED || headerValue(headers, "x-openai-ide-error-code") === REVOKED
    ? "revoked"
    : "unauthorized";
};

const classify = (error: unknown): AuthFailure =>
  error instanceof OpenAI.APIError
    ? authFailure(error.status, error.code, error.headers)
    : undefined;

const isAbort = (error: unknown) =>
  error instanceof OpenAI.APIUserAbortError ||
  (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));

/** Host errors (for example `OAUTH_SIGN_IN_REQUIRED` from `oauth.get()`) are wrapped by openai-node. */
const hostError = (error: unknown): Error | undefined => {
  const cause = error instanceof OpenAI.OpenAIError ? (error as { cause?: unknown }).cause : error;
  if (!(cause instanceof Error)) return undefined;
  const code: unknown = (cause as Error & { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("OAUTH_") ? cause : undefined;
};

/** Secret-free error for the sign-in path: never carries a response body. */
const sanitize = (error: unknown, status?: number, rawCode?: unknown): Error => {
  if (error instanceof ChatGPTError || isAbort(error)) return error as Error;
  const host = hostError(error);
  if (host) return host;
  const httpStatus = error instanceof OpenAI.APIError ? error.status : status;
  const code = safeCode(error instanceof OpenAI.APIError ? error.code : rawCode);
  if (code?.startsWith("subscription_sharing"))
    return new ChatGPTError(`Your ChatGPT plan cannot be used for this request (${code})`, {
      code,
    });
  if (error instanceof OpenAI.APIConnectionError || error instanceof TypeError)
    return new ChatGPTError("Could not reach the OpenAI API");
  return new ChatGPTError(
    httpStatus
      ? `ChatGPT request failed (HTTP ${httpStatus}${code ? `, ${code}` : ""})`
      : "ChatGPT request failed",
  );
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: unknown,
    readonly headers: Headers,
  ) {
    super(`HTTP ${status}`);
  }
}

export class OpenAIProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  #client: OpenAI;
  #oauth: ProviderOAuthHandle | undefined;
  #fetch: typeof fetch;
  constructor(config: OpenAIProviderConfig, client?: OpenAI) {
    this.id = config.id ?? "openai";
    this.model = config.model;
    this.#oauth = config.oauth;
    this.#fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const oauth = config.oauth;
    if (oauth) {
      this.#client =
        client ??
        new OpenAI({
          // Evaluated by openai-node on every request, so each one carries a fresh bearer.
          apiKey: async () => (await oauth.get()).access,
          // Pinned: environment overrides must never redirect or decorate the bearer.
          baseURL: API_BASE_URL,
          adminAPIKey: null,
          organization: null,
          project: null,
          webhookSecret: null,
          maxRetries: 0,
          timeout: 120_000,
          ...(config.fetch ? { fetch: config.fetch } : {}),
        });
      return;
    }
    if (!client && !config.apiKey) throw new Error("Missing OpenAI API key");
    this.#client = client ?? new OpenAI({ apiKey: config.apiKey, maxRetries: 0, timeout: 120_000 });
  }
  /**
   * Runs `call` with the sign-in recovery rules (spec 025 D7e, D20): 401 `token_revoked` marks
   * the session as needing sign-in without retry; a plain 401 renews once and retries; a second
   * plain 401 marks sign-in required. Without a sign-in session it runs `call` unchanged.
   */
  async #authorized<T>(call: () => Promise<T>): Promise<T> {
    const oauth = this.#oauth;
    if (!oauth) return call();
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        const failure =
          error instanceof HttpError
            ? authFailure(error.status, error.code, error.headers)
            : classify(error);
        if (!failure)
          throw error instanceof HttpError
            ? sanitize(error, error.status, error.code)
            : sanitize(error);
        if (failure === "revoked" || attempt > 0) {
          await oauth.invalidate("sign_in_required");
          throw signInAgain();
        }
        await oauth.invalidate();
      }
    }
  }
  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    if (this.#oauth) return this.#listSignedInModels(signal, this.#oauth);
    const models: ModelInfo[] = [];
    for await (const m of this.#client.models.list({ signal }))
      if (typeof m.id === "string" && m.id)
        models.push({
          id: m.id,
          ...(typeof m.owned_by === "string" ? { ownedBy: m.owned_by } : {}),
        });
    return models;
  }
  /** `GET /v1/models` with a bearer answers `{models:[...]}`, which openai-node cannot page. */
  async #listSignedInModels(signal: AbortSignal, oauth: ProviderOAuthHandle) {
    try {
      return await this.#authorized(async () => {
        const { access } = await oauth.get(signal);
        const response = await this.#fetch(`${API_BASE_URL}/models`, {
          method: "GET",
          headers: { authorization: `Bearer ${access}`, accept: "application/json" },
          redirect: "error",
          signal,
        });
        const body: unknown = await response.json().catch(() => undefined);
        if (!response.ok) {
          const error = (body as { error?: { code?: unknown } } | undefined)?.error;
          throw new HttpError(response.status, error?.code, response.headers);
        }
        const models = parseModels(body);
        if (!models) throw new ChatGPTError("OpenAI returned an invalid model list");
        return models;
      });
    } catch (error) {
      // Sign-in and cancellation failures surface; any other endpoint failure uses the fallback.
      if (isAbort(error) || (error as { code?: unknown }).code === "OAUTH_SIGN_IN_REQUIRED")
        throw error;
      return FALLBACK_MODELS.map((m) => ({ ...m }));
    }
  }
  async *stream(request: Parameters<ModelProvider["stream"]>[0]): AsyncIterable<ProviderEvent> {
    const input: ResponseInputItem[] = [];
    for (const m of request.messages) {
      if (m.role === "user") {
        const content: ResponseInputContent[] = [];
        if (m.text.trim()) content.push({ type: "input_text", text: m.text });
        for (const a of m.attachments ?? [])
          content.push({ type: "input_image", image_url: image(a), detail: "auto" });
        input.push(content.length ? { role: "user", content } : { role: "user", content: m.text });
      } else if (m.role === "tool")
        input.push({
          type: "function_call_output",
          call_id: m.callId,
          output: JSON.stringify(m.result),
        });
      else if (m.providerData && Array.isArray(m.providerData))
        input.push(...(m.providerData as ResponseInputItem[]));
      else throw new Error("Missing provider continuation data for Responses session");
    }
    const signedIn = this.#oauth !== undefined;
    const stream = await this.#authorized(() =>
      this.#client.responses.create(
        {
          model: request.model || this.model,
          instructions: request.instructions,
          input,
          stream: true,
          store: false,
          include: ["reasoning.encrypted_content"],
          // The sign-in preview does not accept max_output_tokens (spec 025 §5.8).
          ...(signedIn ? {} : { max_output_tokens: request.maxOutputTokens }),
          tools: request.tools.map((t) => ({
            type: "function" as const,
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            strict: false,
          })) as NonNullable<ResponseCreateParams["tools"]>,
        },
        { signal: request.signal },
      ),
    );
    yield* signedIn ? this.#sanitized(this.#events(stream)) : this.#events(stream);
  }
  async *#sanitized(events: AsyncIterable<ProviderEvent>): AsyncIterable<ProviderEvent> {
    try {
      yield* events;
    } catch (error) {
      // Plugin-raised stream errors carry fixed messages; openai-node errors may echo a body.
      throw error instanceof OpenAI.OpenAIError ? sanitize(error) : error;
    }
  }
  async *#events(stream: AsyncIterable<ResponseStreamEvent>): AsyncIterable<ProviderEvent> {
    let completed = false;
    for await (const event of stream) {
      if (event?.type === "response.output_text.delta" && typeof event.delta === "string")
        yield { type: "text_delta", delta: event.delta };
      if (
        event?.type === "response.reasoning_summary_text.delta" &&
        typeof event.delta === "string"
      )
        yield { type: "reasoning_delta", delta: event.delta };
      if (event?.type === "error" || event?.type === "response.failed")
        throw new Error("OpenAI response failed");
      if (event?.type === "response.completed" || event?.type === "response.incomplete") {
        completed = true;
        const result = output(event.response);
        if (event.type === "response.incomplete" && !result.text.trim() && !result.calls.length)
          throw new Error("OpenAI response cut off before usable content");
        const responseUsage = usage(event.response.usage);
        yield {
          type: "completed",
          message: {
            role: "assistant",
            text: result.text,
            calls: result.calls,
            providerData: result.data,
            ...(event.type === "response.incomplete" ? { truncated: true } : {}),
          },
          ...(responseUsage ? { usage: responseUsage } : {}),
        };
      }
    }
    if (!completed) throw new Error("OpenAI Responses stream ended before completion");
  }
}
