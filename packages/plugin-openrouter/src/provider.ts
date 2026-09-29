import type {
  Attachment,
  ModelInfo,
  ModelProvider,
  ProviderEvent,
  ToolCall,
  Usage,
} from "@alisio/sdk";
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

const BASE_URL = "https://openrouter.ai/api/v1";
const TTL = 5 * 60_000;
const FALLBACK: ModelInfo = { id: "openrouter/free", name: "OpenRouter Free" };
type OpenRouterModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown };
};
type OpenRouterChunk = ChatCompletionChunk & {
  error?: { message?: unknown };
  choices: Array<
    ChatCompletionChunk.Choice & {
      delta: ChatCompletionChunk.Choice.Delta & {
        reasoning?: unknown;
        reasoning_details?: unknown[];
      };
    }
  >;
};
type OpenRouterAssistantMessage = Extract<ChatCompletionMessageParam, { role: "assistant" }> & {
  reasoning_details?: unknown[];
};
const image = (a: Attachment) => `data:${a.mimeType};base64,${a.data}`;
const stringify = (value: unknown) => JSON.stringify(value);
export class OpenRouterProvider implements ModelProvider {
  readonly id = "openrouter";
  readonly model: string;
  #client: OpenAI;
  #catalog?: { expires: number; models: ModelInfo[] };
  constructor(config: { apiKey?: string; model: string }, client?: OpenAI) {
    this.model = config.model || "openrouter/free";
    if (!client && !config.apiKey) throw new Error("Missing OpenRouter API key");
    this.#client =
      client ??
      new OpenAI({ apiKey: config.apiKey, baseURL: BASE_URL, maxRetries: 0, timeout: 120_000 });
  }
  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    if (this.#catalog && this.#catalog.expires > Date.now()) return this.#catalog.models;
    try {
      const result: ModelInfo[] = [];
      for await (const m of this.#client.models.list({ signal })) {
        const x = m as unknown as OpenRouterModel;
        if (typeof x.id !== "string" || !x.id) continue;
        const modalities = Array.isArray(x.architecture?.input_modalities)
          ? x.architecture.input_modalities.filter((v: unknown) => typeof v === "string")
          : undefined;
        result.push({
          id: x.id,
          ...(typeof x.name === "string" ? { name: x.name } : {}),
          ...(typeof x.context_length === "number" && x.context_length > 0
            ? { contextWindow: x.context_length }
            : {}),
          ...(modalities?.length ? { inputModalities: modalities } : {}),
        });
        if (result.length >= 1000) break;
      }
      if (!result.some((m) => m.id === FALLBACK.id)) result.unshift(FALLBACK);
      this.#catalog = { expires: Date.now() + TTL, models: result };
      return result;
    } catch {
      return this.#catalog?.models ?? [FALLBACK];
    }
  }
  async *stream(request: Parameters<ModelProvider["stream"]>[0]): AsyncIterable<ProviderEvent> {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: request.instructions },
    ];
    for (const m of request.messages) {
      if (m.role === "user")
        messages.push(
          m.attachments?.length
            ? {
                role: "user",
                content: [
                  { type: "text", text: m.text },
                  ...m.attachments.map((a) => ({
                    type: "image_url" as const,
                    image_url: { url: image(a) },
                  })),
                ],
              }
            : { role: "user", content: m.text },
        );
      else if (m.role === "tool")
        messages.push({ role: "tool", tool_call_id: m.callId, content: stringify(m.result) });
      else {
        const assistant: OpenRouterAssistantMessage = {
          role: "assistant",
          content: m.text || null,
          ...(m.calls.length
            ? {
                tool_calls: m.calls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
          ...(m.providerData?.length ? { reasoning_details: m.providerData } : {}),
        };
        messages.push(assistant);
      }
    }
    const stream = await this.#client.chat.completions.create(
      {
        model: request.model || this.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: request.maxOutputTokens,
        ...(request.tools.length
          ? {
              tools: request.tools.map((t) => ({
                type: "function" as const,
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })) as ChatCompletionTool[],
            }
          : {}),
      },
      { signal: request.signal },
    );
    let text = "",
      finish: string | null = null,
      usage: Usage | undefined;
    const calls = new Map<number, ToolCall>();
    const reasoning: unknown[] = [];
    for await (const rawChunk of stream) {
      const chunk = rawChunk as OpenRouterChunk;
      if (chunk?.error)
        throw new Error(
          typeof chunk.error.message === "string"
            ? `OpenRouter stream error: ${chunk.error.message}`
            : "OpenRouter stream error",
        );
      const chunkUsage = chunk.usage;
      if (
        chunkUsage &&
        Number.isFinite(chunkUsage.prompt_tokens) &&
        Number.isFinite(chunkUsage.completion_tokens)
      ) {
        const cachedInput = chunkUsage.prompt_tokens_details?.cached_tokens;
        usage = {
          input: chunkUsage.prompt_tokens,
          output: chunkUsage.completion_tokens,
          ...(typeof cachedInput === "number" && Number.isFinite(cachedInput)
            ? { cachedInput }
            : {}),
        };
      }
      const choice = chunk?.choices?.[0];
      if (!choice) continue;
      if (typeof choice.delta?.content === "string") {
        text += choice.delta.content;
        yield { type: "text_delta", delta: choice.delta.content };
      }
      if (typeof choice.delta?.reasoning === "string")
        yield { type: "reasoning_delta", delta: choice.delta.reasoning };
      if (Array.isArray(choice.delta?.reasoning_details))
        reasoning.push(...choice.delta.reasoning_details);
      if (choice.delta?.refusal) throw new Error("OpenRouter provider refusal");
      for (const part of choice.delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? { id: "", name: "", arguments: "" };
        if (typeof part.id === "string") call.id = part.id;
        if (typeof part.function?.name === "string") call.name += part.function.name;
        if (typeof part.function?.arguments === "string") call.arguments += part.function.arguments;
        calls.set(part.index, call);
      }
      if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
    }
    if (!(["stop", "tool_calls", "length"] as string[]).includes(finish ?? ""))
      throw new Error(`OpenRouter response incomplete: ${finish ?? "stream ended"}`);
    const complete = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    if (complete.some((c) => !c.id || !c.name)) throw new Error("Incomplete tool call");
    if (finish === "length" && !text.trim())
      throw new Error("OpenRouter response cut off before usable content");
    yield {
      type: "completed",
      message: {
        role: "assistant",
        text,
        calls: complete,
        ...(reasoning.length ? { providerData: reasoning } : {}),
        ...(finish === "length" ? { truncated: true } : {}),
      },
      ...(usage ? { usage } : {}),
    };
  }
}
