/**
 * Catalog of free, OpenAI-compatible (Chat Completions) LLM services.
 *
 * Source: https://github.com/mnfst/awesome-free-llm-apis (README), plus keyless `/models` probes
 * of Kilo Code, LLM7.io, OVHcloud, OpenRouter, NVIDIA NIM, Aion Labs and Gonka Broker. Free tiers
 * change often, so every live listing is filtered to free models and falls back to `freeModels`.
 */

/** Free usage limits, in plain numbers. Every field is optional; absent means "not published". */
export interface FreeLimits {
  requestsPerSecond?: number;
  requestsPerMinute?: number;
  requestsPerHour?: number;
  requestsPerDay?: number;
  requestsPerMonth?: number;
  tokensPerMinute?: number;
  tokensPerDay?: number;
  tokensPerMonth?: number;
  concurrentRequests?: number;
  /** The published figures are approximate ("about"). */
  approximate?: boolean;
  /** Who the limits are counted for. */
  scope?: LimitScope;
}

export type LimitScope = "per-ip" | "per-model" | "per-ip-per-model" | "shared" | "per-account";

/** A short note shown next to the limits, keyed so the formatter can translate it. */
export type NoteId =
  | "no-account"
  | "no-credit-card"
  | "prompts-may-be-logged"
  | "prompts-may-train"
  | "non-commercial"
  | "phone-verification"
  | "developer-program"
  | "eu-hosted"
  | "roleplay"
  | "limits-unpublished"
  | "router-picks-model"
  | "key-ignored";

export interface FreeModel {
  id: string;
  name?: string;
  contextWindow?: number;
  /** Model-specific limits; they override the service limits field by field. */
  limits?: FreeLimits;
}

/**
 * How live `/models` results are reduced to free models.
 * - `kilo`: entries flagged `isFree: true` with text output.
 * - `openrouter`: `:free` ids or zero prompt/completion price, text output only.
 * - `llm7`: `tier: "turbo"` chat models (anonymous and free-token tier).
 * - `pattern`: ids matching `modelPattern` (services that expose no price data).
 * - `static`: no live call; `freeModels` is the list.
 */
export type ListingMode = "kilo" | "openrouter" | "llm7" | "pattern" | "static";

export interface FreeService {
  id: string;
  name: string;
  baseURL: string;
  needsKey: boolean;
  /** Where to sign up or create the free API key. */
  keyUrl: string;
  /** Known key prefix; a key with another service's prefix is rejected before it is sent. */
  keyPrefix?: string;
  defaultModel: string;
  freeModels: FreeModel[];
  listing: ListingMode;
  modelPattern?: RegExp;
  /** Whether the service accepts `stream_options.include_usage` (verified or documented). */
  streamUsage: boolean;
  limits: FreeLimits;
  notes: NoteId[];
  /**
   * Plain steps to get the free key (key-required services only). The first step opens `keyUrl`;
   * the formatter appends the final "paste it here" step.
   */
  keySteps?: KeySteps;
}

export interface KeySteps {
  en: string[];
  es: string[];
}

export const DEFAULT_SERVICE_ID = "kilo";
export const DEFAULT_MODEL = "kilo-auto/free";

export const SERVICES: readonly FreeService[] = [
  {
    id: "kilo",
    name: "Kilo Code",
    baseURL: "https://api.kilo.ai/api/gateway",
    needsKey: false,
    keyUrl: "https://app.kilo.ai/profile",
    defaultModel: DEFAULT_MODEL,
    freeModels: [
      { id: "kilo-auto/free", name: "Kilo Auto Free", contextWindow: 256_000 },
      { id: "openrouter/free", name: "OpenRouter Free Models Router", contextWindow: 200_000 },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "NVIDIA Nemotron 3 Ultra" },
      { id: "nvidia/nemotron-3.5-lightning:free", name: "NVIDIA Nemotron 3.5 Lightning" },
      { id: "cohere/north-mini-code:free", name: "Cohere North Mini Code" },
    ],
    listing: "kilo",
    streamUsage: true,
    limits: { requestsPerHour: 200, scope: "per-ip" },
    notes: ["no-account", "router-picks-model", "prompts-may-be-logged", "key-ignored"],
  },
  {
    id: "llm7",
    name: "LLM7.io",
    baseURL: "https://api.llm7.io/v1",
    needsKey: false,
    keyUrl: "https://token.llm7.io",
    defaultModel: "gpt-oss:20b",
    freeModels: [
      { id: "gpt-oss:20b", contextWindow: 128_000 },
      { id: "codestral-latest", contextWindow: 32_000 },
      { id: "mistral-Nemo-Instruct-2407", contextWindow: 128_000 },
    ],
    listing: "llm7",
    streamUsage: true,
    limits: { scope: "per-ip" },
    notes: ["no-account", "limits-unpublished", "prompts-may-be-logged", "key-ignored"],
  },
  {
    id: "ovh",
    name: "OVHcloud AI Endpoints",
    baseURL: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    needsKey: false,
    keyUrl: "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/",
    defaultModel: "gpt-oss-120b",
    freeModels: [
      { id: "gpt-oss-120b", contextWindow: 131_072 },
      { id: "gpt-oss-20b", contextWindow: 131_072 },
      { id: "Qwen3.5-397B-A17B", contextWindow: 262_144 },
      { id: "Qwen3.8-27B", contextWindow: 262_144 },
      { id: "Qwen3.6-27B", contextWindow: 262_144 },
      { id: "Qwen3.5-9B", contextWindow: 262_144 },
      { id: "Meta-Llama-3_3-70B-Instruct", contextWindow: 131_072 },
      { id: "Mistral-Small-3.2-24B-Instruct-2506", contextWindow: 131_072 },
      { id: "Qwen2.5-VL-72B-Instruct", contextWindow: 32_768 },
    ],
    listing: "static",
    streamUsage: true,
    limits: { requestsPerMinute: 2, scope: "per-ip-per-model" },
    notes: ["no-account", "eu-hosted", "key-ignored"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    needsKey: true,
    keyUrl: "https://openrouter.ai/keys",
    keyPrefix: "sk-or-",
    defaultModel: "openrouter/free",
    freeModels: [
      { id: "openrouter/free", name: "OpenRouter Free Models Router" },
      { id: "google/gemma-4-31b-it:free" },
      { id: "google/gemma-4-26b-a4b-it:free" },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free" },
      { id: "nvidia/nemotron-3.5-lightning:free" },
      { id: "cohere/north-mini-code:free" },
    ],
    listing: "openrouter",
    streamUsage: true,
    limits: { requestsPerMinute: 20, requestsPerDay: 50, scope: "shared" },
    notes: ["no-credit-card", "prompts-may-be-logged"],
    keySteps: {
      en: [
        "Open https://openrouter.ai/keys and sign in with Google, GitHub or email.",
        'Click "Create API Key", give it any name and confirm.',
        "Copy the key now: it is shown only once.",
      ],
      es: [
        "Abre https://openrouter.ai/keys e inicia sesión con Google, GitHub o correo.",
        'Pulsa "Create API Key", ponle cualquier nombre y confirma.',
        "Copia la clave ahora: solo se muestra una vez.",
      ],
    },
  },
  {
    id: "groq",
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    needsKey: true,
    keyUrl: "https://console.groq.com/keys",
    keyPrefix: "gsk_",
    defaultModel: "openai/gpt-oss-120b",
    freeModels: [
      { id: "openai/gpt-oss-120b", contextWindow: 131_072 },
      { id: "openai/gpt-oss-20b", contextWindow: 131_072 },
      { id: "qwen/qwen3.8-27b", contextWindow: 131_072 },
    ],
    listing: "static",
    streamUsage: true,
    limits: { requestsPerMinute: 30, requestsPerDay: 1000, scope: "per-model" },
    notes: ["no-credit-card"],
    keySteps: {
      en: [
        "Open https://console.groq.com/keys and sign in with Google, GitHub or email.",
        'Click "Create API Key" and give it any name.',
        "Copy the key now: it is shown only once.",
      ],
      es: [
        "Abre https://console.groq.com/keys e inicia sesión con Google, GitHub o correo.",
        'Pulsa "Create API Key" y ponle cualquier nombre.',
        "Copia la clave ahora: solo se muestra una vez.",
      ],
    },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/app/apikey",
    keyPrefix: "AIza",
    defaultModel: "gemini-2.5-flash",
    freeModels: [{ id: "gemini-2.5-flash" }],
    listing: "pattern",
    modelPattern: /^(?:gemini-\d+(?:\.\d+)?-flash(?:-lite)?|gemma-4-[\w-]+)$/,
    streamUsage: true,
    limits: { scope: "per-account" },
    notes: ["no-credit-card", "limits-unpublished", "prompts-may-train"],
    keySteps: {
      en: [
        "Open https://aistudio.google.com/app/apikey and sign in with your Google account.",
        'Click "Create API key" and pick or create a project.',
        "Copy the key.",
      ],
      es: [
        "Abre https://aistudio.google.com/app/apikey e inicia sesión con tu cuenta de Google.",
        'Pulsa "Create API key" y elige o crea un proyecto.',
        "Copia la clave.",
      ],
    },
  },
  {
    id: "mistral",
    name: "Mistral AI",
    baseURL: "https://api.mistral.ai/v1",
    needsKey: true,
    keyUrl: "https://console.mistral.ai/api-keys",
    defaultModel: "mistral-small-latest",
    freeModels: [{ id: "mistral-small-latest" }],
    listing: "pattern",
    modelPattern: /^(?:mistral-(?:small|medium|large)|ministral-|codestral)[\w.-]*$/,
    streamUsage: false,
    limits: {
      requestsPerSecond: 1,
      tokensPerMinute: 500_000,
      approximate: true,
      scope: "per-account",
    },
    notes: ["no-credit-card", "prompts-may-train"],
    keySteps: {
      en: [
        "Open https://console.mistral.ai/api-keys and create an account or sign in.",
        "Choose the free plan if asked; you may need to verify a phone number.",
        'Click "Create new key" and copy it: it is shown only once.',
      ],
      es: [
        "Abre https://console.mistral.ai/api-keys y crea una cuenta o inicia sesión.",
        "Elige el plan gratuito si te lo pide; puede que tengas que verificar un teléfono.",
        'Pulsa "Create new key" y cópiala: solo se muestra una vez.',
      ],
    },
  },
  {
    id: "cohere",
    name: "Cohere",
    baseURL: "https://api.cohere.ai/compatibility/v1",
    needsKey: true,
    keyUrl: "https://dashboard.cohere.com/api-keys",
    defaultModel: "command-r7b-12-2024",
    freeModels: [{ id: "command-r7b-12-2024" }],
    listing: "pattern",
    modelPattern: /^(?:command-|c4ai-aya-)[\w.-]+$/,
    streamUsage: false,
    limits: { requestsPerMinute: 20, requestsPerMonth: 1000, scope: "per-account" },
    notes: ["no-credit-card", "non-commercial"],
    keySteps: {
      en: [
        "Open https://dashboard.cohere.com/api-keys and create an account or sign in.",
        'A free "Trial" key is already listed; you can also create a new trial key.',
        "Copy the trial key.",
      ],
      es: [
        "Abre https://dashboard.cohere.com/api-keys y crea una cuenta o inicia sesión.",
        'Ya aparece una clave gratuita "Trial"; también puedes crear otra.',
        "Copia la clave de prueba.",
      ],
    },
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    baseURL: "https://integrate.api.nvidia.com/v1",
    needsKey: true,
    keyUrl: "https://build.nvidia.com/explore/discover",
    keyPrefix: "nvapi-",
    defaultModel: "openai/gpt-oss-20b",
    freeModels: [
      { id: "openai/gpt-oss-20b", contextWindow: 131_072 },
      { id: "nvidia/nemotron-3-ultra-550b-a55b", contextWindow: 1_000_000 },
      { id: "google/gemma-4-31b-it", contextWindow: 262_144 },
    ],
    listing: "static",
    streamUsage: true,
    limits: { requestsPerMinute: 40, requestsPerDay: 10_000, scope: "per-model" },
    notes: ["developer-program"],
    keySteps: {
      en: [
        "Open https://build.nvidia.com/explore/discover and sign in or create a free NVIDIA account (it joins the free Developer Program).",
        'Open any model and click "Get API Key", then "Generate Key".',
        "Copy the key: it starts with nvapi-.",
      ],
      es: [
        "Abre https://build.nvidia.com/explore/discover e inicia sesión o crea una cuenta gratuita de NVIDIA (te une al Developer Program gratuito).",
        'Abre cualquier modelo y pulsa "Get API Key" y luego "Generate Key".',
        "Copia la clave: empieza por nvapi-.",
      ],
    },
  },
  {
    id: "zai",
    name: "Z AI",
    baseURL: "https://api.z.ai/api/paas/v4",
    needsKey: true,
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    defaultModel: "glm-4.7-flash",
    freeModels: [{ id: "glm-4.7-flash" }],
    listing: "pattern",
    modelPattern: /^glm-[\d.]+v?-flash$/i,
    streamUsage: false,
    limits: { concurrentRequests: 1, scope: "per-account" },
    notes: ["no-credit-card"],
    keySteps: {
      en: [
        "Open https://z.ai/manage-apikey/apikey-list and create an account or sign in.",
        'Click "Create a new API key" and give it any name.',
        "Copy the key.",
      ],
      es: [
        "Abre https://z.ai/manage-apikey/apikey-list y crea una cuenta o inicia sesión.",
        'Pulsa "Create a new API key" y ponle cualquier nombre.',
        "Copia la clave.",
      ],
    },
  },
  {
    id: "aion",
    name: "Aion Labs",
    baseURL: "https://api.aionlabs.ai/v1",
    needsKey: true,
    keyUrl: "https://www.aionlabs.ai/app/api-keys/",
    defaultModel: "aion-labs/aion-3.0-mini",
    freeModels: [
      { id: "aion-labs/aion-3.0-mini", contextWindow: 131_072 },
      { id: "aion-labs/aion-3.0", contextWindow: 131_072 },
      { id: "aion-labs/aion-2.0", contextWindow: 131_072 },
      { id: "aion-labs/aion-rp-llama-3.1-8b", contextWindow: 32_768 },
    ],
    listing: "static",
    streamUsage: false,
    limits: { requestsPerMinute: 15, tokensPerDay: 20_000, scope: "per-account" },
    notes: ["no-credit-card", "roleplay"],
    keySteps: {
      en: [
        "Open https://www.aionlabs.ai/app/api-keys/ and create an account or sign in.",
        "Create a new key.",
        "Copy the key.",
      ],
      es: [
        "Abre https://www.aionlabs.ai/app/api-keys/ y crea una cuenta o inicia sesión.",
        "Crea una clave nueva.",
        "Copia la clave.",
      ],
    },
  },
  {
    id: "gonka",
    name: "Gonka Broker",
    baseURL: "https://proxy.gonkabroker.com/v1",
    needsKey: true,
    keyUrl: "https://app.gonkabroker.com/signup",
    defaultModel: "zai-org/GLM-5.3-Flash",
    freeModels: [
      { id: "zai-org/GLM-5.3-Flash", contextWindow: 400_000 },
      { id: "deepseek-ai/DeepSeek-V4-Flash-0731", contextWindow: 400_000 },
      { id: "MiniMaxAI/MiniMax-M2.7", contextWindow: 200_000 },
    ],
    listing: "static",
    streamUsage: false,
    limits: { tokensPerMonth: 1_000_000, approximate: true, scope: "shared" },
    notes: ["no-credit-card", "phone-verification"],
    keySteps: {
      en: [
        "Open https://app.gonkabroker.com/signup and create an account.",
        "Verify a real mobile phone number by text message (internet phone numbers are not accepted); the free tokens arrive after this.",
        "Create a key in the dashboard and copy it.",
      ],
      es: [
        "Abre https://app.gonkabroker.com/signup y crea una cuenta.",
        "Verifica un número de móvil real por SMS (no se aceptan números de internet); los tokens gratis llegan después.",
        "Crea una clave en el panel y cópiala.",
      ],
    },
  },
];

export function findService(id: string | undefined): FreeService | undefined {
  return SERVICES.find((service) => service.id === id);
}

/** Model limits override service limits field by field. */
export function modelLimits(service: FreeService, model?: FreeModel): FreeLimits {
  return { ...service.limits, ...(model?.limits ?? {}) };
}
