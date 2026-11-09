import type {
  Attachment,
  Message,
  ModelInfo,
  ModelProvider,
  ProviderEvent,
  ToolCall,
  ToolDefinition,
  Usage,
} from "@alisio/sdk";
import type { FreeService } from "./catalog.js";
import { missingKeyMessage } from "./limits.js";
import { endpoint, freeModelsFrom, toModelInfo } from "./models.js";
import { VERSION } from "./version.js";

const TTL = 5 * 60_000;
const LIST_TIMEOUT = 15_000;
const USER_AGENT = `alisio-plugin-free-models/${VERSION}`;

// biome-ignore lint/suspicious/noExplicitAny: stream payloads are validated field-by-field at each use site.
type Json = Record<string, any>;

export interface FreeModelsProviderConfig {
  service: FreeService;
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

const dataUrl = (a: Attachment) => `data:${a.mimeType};base64,${a.data}`;

async function* sse(response: Response, label: string): AsyncIterable<Json> {
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? " (check the key)"
        : response.status === 429
          ? " (free limit reached, try again later)"
          : "";
    throw new Error(`${label} request failed: HTTP ${response.status}${hint}`);
  }
  if (!response.body) throw new Error(`${label} response has no body`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data) as Json;
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function functionTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

export function chatMessages(instructions: string, messages: Message[]): Json[] {
  const output: Json[] = [{ role: "system", content: instructions }];
  for (const message of messages) {
    if (message.role === "user")
      output.push({
        role: "user",
        content: message.attachments?.length
          ? [
              ...(message.text.trim() ? [{ type: "text", text: message.text }] : []),
              ...message.attachments.map((a) => ({
                type: "image_url",
                image_url: { url: dataUrl(a) },
              })),
            ]
          : message.text,
      });
    else if (message.role === "tool")
      output.push({
        role: "tool",
        tool_call_id: message.callId,
        content: JSON.stringify(message.result),
      });
    else
      output.push({
        role: "assistant",
        content: message.text || null,
        ...(message.calls.length
          ? {
              tool_calls: message.calls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      });
  }
  return output;
}

/** One OpenAI-compatible Chat Completions client for one cataloged free service. */
export class FreeModelsProvider implements ModelProvider {
  readonly id: string;
  readonly model: string;
  readonly service: FreeService;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  #catalog?: { expires: number; models: ModelInfo[] };

  constructor(config: FreeModelsProviderConfig) {
    this.service = config.service;
    this.model = config.model || config.service.defaultModel;
    this.id = `free-models:${config.service.id}`;
    // Keyless services are always used anonymously so a stored key never leaves for them.
    const key = config.service.needsKey ? config.apiKey?.trim() : undefined;
    if (config.service.needsKey && !key) throw new Error(missingKeyMessage(config.service));
    this.#apiKey = key;
    this.#fetch = config.fetch ?? fetch;
  }

  /** Request headers; `authorization` is present only for key-required services. */
  headers(json: boolean): Record<string, string> {
    return {
      accept: json ? "text/event-stream" : "application/json",
      "user-agent": USER_AGENT,
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
    };
  }

  #fallback(): ModelInfo[] {
    return this.service.freeModels.map((m) => toModelInfo(this.service, m));
  }

  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    if (this.#catalog && this.#catalog.expires > Date.now()) return this.#catalog.models;
    if (this.service.listing === "static") return this.#fallback();
    try {
      const response = await this.#fetch(endpoint(this.service.baseURL, "models"), {
        headers: this.headers(false),
        signal: AbortSignal.any([signal, AbortSignal.timeout(LIST_TIMEOUT)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const live = freeModelsFrom(this.service, await response.json());
      if (!live.length) return this.#fallback();
      const models = live.map((m) => toModelInfo(this.service, m));
      this.#catalog = { expires: Date.now() + TTL, models };
      return models;
    } catch {
      // Fail open: the curated free list is always a usable answer.
      return this.#catalog?.models ?? this.#fallback();
    }
  }

  async *stream(request: Parameters<ModelProvider["stream"]>[0]): AsyncIterable<ProviderEvent> {
    const label = this.service.name;
    const response = await this.#fetch(endpoint(this.service.baseURL, "chat/completions"), {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        model: request.model || this.model,
        messages: chatMessages(request.instructions, request.messages),
        stream: true,
        ...(this.service.streamUsage ? { stream_options: { include_usage: true } } : {}),
        max_tokens: request.maxOutputTokens,
        ...(request.tools.length ? { tools: functionTools(request.tools) } : {}),
      }),
      signal: request.signal,
    });
    let text = "";
    let finish: string | undefined;
    let usage: Usage | undefined;
    const calls = new Map<number, ToolCall>();
    for await (const chunk of sse(response, label)) {
      if (chunk.error) {
        const message = typeof chunk.error.message === "string" ? `: ${chunk.error.message}` : "";
        throw new Error(`${label} stream error${message.slice(0, 300)}`);
      }
      if (
        chunk.usage &&
        Number.isFinite(chunk.usage.prompt_tokens) &&
        Number.isFinite(chunk.usage.completion_tokens)
      ) {
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
        usage = {
          input: chunk.usage.prompt_tokens,
          output: chunk.usage.completion_tokens,
          ...(typeof cached === "number" && Number.isFinite(cached) ? { cachedInput: cached } : {}),
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (typeof reasoning === "string" && reasoning)
        yield { type: "reasoning_delta", delta: reasoning };
      if (typeof choice.delta?.content === "string" && choice.delta.content) {
        text += choice.delta.content;
        yield { type: "text_delta", delta: choice.delta.content };
      }
      for (const part of choice.delta?.tool_calls ?? []) {
        const index = typeof part.index === "number" ? part.index : 0;
        const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof part.id === "string" && part.id) call.id = part.id;
        if (typeof part.function?.name === "string") call.name += part.function.name;
        if (typeof part.function?.arguments === "string") call.arguments += part.function.arguments;
        calls.set(index, call);
      }
      if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
    }
    if (finish !== "stop" && finish !== "tool_calls" && finish !== "length")
      throw new Error(`${label} response incomplete: ${finish ?? "stream ended"}`);
    const completed = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (completed.some((call) => !call.id || !call.name)) throw new Error("Incomplete tool call");
    if (finish === "length" && !text.trim() && !completed.length)
      throw new Error(`${label} response cut off by max output tokens before any usable content`);
    yield {
      type: "completed",
      message: {
        role: "assistant",
        text,
        calls: completed,
        ...(finish === "length" ? { truncated: true } : {}),
      },
      ...(usage ? { usage } : {}),
    };
  }
}
