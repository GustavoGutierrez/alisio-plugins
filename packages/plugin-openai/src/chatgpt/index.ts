import type { ProviderCreateRequest, ProviderRegistration } from "@alisio/sdk";
import { OpenAIProvider } from "../provider.js";
import { type ChatGPTDeps, createBrowserMethod } from "./siwc.js";

export type { ChatGPTDeps } from "./siwc.js";
export { createBrowserMethod } from "./siwc.js";

/**
 * The sign-in-only `chatgpt` provider (spec 025 O2, §5.8): same Responses provider as `openai`,
 * with the credential source switched to the host's sign-in handle.
 */
export function createChatGPTRegistration(deps: ChatGPTDeps = {}): ProviderRegistration {
  return {
    id: "chatgpt",
    name: "ChatGPT Plus/Pro",
    description: "OpenAI Responses API using your ChatGPT plan (Sign in with ChatGPT, preview)",
    fields: [],
    auth: [createBrowserMethod(deps)],
    create(request: ProviderCreateRequest) {
      // Feature detection: hosts before @alisio/sdk 0.11 ignore `auth` and pass no handle.
      if (request.oauth === undefined) throw new Error("ChatGPT sign-in requires Alisio >= 0.11");
      return new OpenAIProvider({
        id: "chatgpt",
        model: typeof request.profile.model === "string" ? request.profile.model : "",
        oauth: request.oauth,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    },
  };
}
