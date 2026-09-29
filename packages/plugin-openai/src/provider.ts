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
  Response,
  ResponseCreateParams,
  ResponseFunctionToolCall,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseUsage,
} from "openai/resources/responses/responses";

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
export class OpenAIProvider implements ModelProvider {
  readonly id = "openai";
  readonly model: string;
  #client: OpenAI;
  constructor(config: { apiKey?: string; model: string }, client?: OpenAI) {
    this.model = config.model;
    if (!client && !config.apiKey) throw new Error("Missing OpenAI API key");
    this.#client = client ?? new OpenAI({ apiKey: config.apiKey, maxRetries: 0, timeout: 120_000 });
  }
  async listModels(signal: AbortSignal): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    for await (const m of this.#client.models.list({ signal }))
      if (typeof m.id === "string" && m.id)
        models.push({
          id: m.id,
          ...(typeof m.owned_by === "string" ? { ownedBy: m.owned_by } : {}),
        });
    return models;
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
    const stream = await this.#client.responses.create(
      {
        model: request.model || this.model,
        instructions: request.instructions,
        input,
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: request.maxOutputTokens,
        tools: request.tools.map((t) => ({
          type: "function" as const,
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
          strict: false,
        })) as NonNullable<ResponseCreateParams["tools"]>,
      },
      { signal: request.signal },
    );
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
