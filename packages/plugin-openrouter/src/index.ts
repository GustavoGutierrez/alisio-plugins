import { definePlugin, type Plugin, type ProviderCreateRequest } from "@alisio/sdk";
import { OpenRouterProvider } from "./provider.js";
import { VERSION } from "./version.js";

const DEFAULT_ENV = "OPENROUTER_API_KEY";
const envName = (request: ProviderCreateRequest) =>
  typeof request.profile.apiKeyEnv === "string" && request.profile.apiKeyEnv.trim()
    ? request.profile.apiKeyEnv.trim()
    : DEFAULT_ENV;
export function createOpenRouterPlugin(): Plugin {
  return definePlugin({
    id: "openrouter",
    name: "OpenRouter",
    description: "OpenRouter OpenAI-compatible provider",
    categories: ["model-provider"],
    version: VERSION,
    apiVersion: 1,
    setup(api) {
      api.providers.register({
        id: "openrouter",
        name: "OpenRouter",
        description: "OpenRouter Chat Completions API",
        fields: [
          {
            key: "apiKey",
            label: "API key",
            kind: "secret",
            required: true,
            description: "Stored only in the global credentials file",
          },
          {
            key: "apiKeyEnv",
            label: "API key environment variable",
            kind: "text",
            required: false,
            defaultValue: DEFAULT_ENV,
            description: "Used only when no stored API key exists",
          },
        ],
        create(request) {
          const name = envName(request);
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
            throw new Error("API key environment variable name is invalid");
          const apiKey = request.credentials.apiKey || process.env[name];
          if (!apiKey)
            throw new Error(
              `OpenRouter API key is required (set it in /connect or export ${name})`,
            );
          return new OpenRouterProvider({
            apiKey,
            model:
              typeof request.profile.model === "string" ? request.profile.model : "openrouter/free",
          });
        },
      });
    },
  });
}
export { OpenRouterProvider } from "./provider.js";
export default createOpenRouterPlugin();
