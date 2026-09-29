import { definePlugin, type Plugin, type ProviderCreateRequest } from "@alisio/sdk";
import { OpenAIProvider } from "./provider.js";
import { VERSION } from "./version.js";

const API_KEY_ENV = "OPENAI_API_KEY";
export function createOpenAIPlugin(): Plugin {
  return definePlugin({
    id: "openai",
    name: "OpenAI",
    description: "Official OpenAI Responses API provider",
    categories: ["model-provider"],
    version: VERSION,
    apiVersion: 1,
    setup(api) {
      api.providers.register({
        id: "openai",
        name: "OpenAI",
        description: "OpenAI Responses API",
        fields: [
          {
            key: "apiKey",
            label: "API key",
            kind: "secret",
            required: true,
            description: "Stored only in the global credentials file",
          },
        ],
        create(request: ProviderCreateRequest) {
          const apiKey = request.credentials.apiKey || process.env[API_KEY_ENV];
          if (!apiKey)
            throw new Error(
              `OpenAI API key is required (set it in /connect or export ${API_KEY_ENV})`,
            );
          return new OpenAIProvider({
            apiKey,
            model: typeof request.profile.model === "string" ? request.profile.model : "",
          });
        },
      });
    },
  });
}
export { OpenAIProvider } from "./provider.js";
export default createOpenAIPlugin();
