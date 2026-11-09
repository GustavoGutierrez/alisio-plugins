import { inspect } from "node:util";
import type { ProviderEvent, ProviderRegistration } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { findService } from "../src/catalog.js";
import {
  createFreeModelsPlugin,
  createProvider,
  DATA_MARKER,
  helpText,
  injectData,
} from "../src/index.js";
import { freeModelsFrom } from "../src/models.js";
import type { FreeModelsProvider } from "../src/provider.js";

type Call = { url: string; init: RequestInit };
const service = (id: string) => {
  const found = findService(id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
};
const sseBody = (...chunks: unknown[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
function mockFetch(respond: (url: string) => Response) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url);
  }) as typeof fetch;
  return { calls, fetcher };
}
const chatOk = () =>
  new Response(
    sseBody(
      { choices: [{ delta: { content: "hi" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    ),
    { status: 200 },
  );
const run = async (p: FreeModelsProvider) => {
  const events: ProviderEvent[] = [];
  for await (const e of p.stream({
    instructions: "be brief",
    messages: [{ role: "user", text: "hello" }],
    tools: [],
    maxOutputTokens: 32,
    signal: AbortSignal.timeout(1000),
  }))
    events.push(e);
  return events;
};
const header = (call: Call | undefined, name: string) =>
  (call?.init.headers as Record<string, string> | undefined)?.[name];

const registration = (hasApps = false) => {
  let found: ProviderRegistration | undefined;
  const commands = new Map<string, (args: string) => Promise<string>>();
  const apps: unknown[] = [];
  createFreeModelsPlugin().setup({
    providers: {
      register(value: ProviderRegistration) {
        found = value;
        return () => {};
      },
    },
    commands: {
      register(name: string, handler: (args: string) => Promise<string>) {
        commands.set(name, handler);
        return () => {};
      },
    },
    ...(hasApps
      ? {
          apps: {
            register(app: unknown) {
              apps.push(app);
              return () => {};
            },
          },
        }
      : {}),
  } as never);
  if (!found) throw new Error("missing registration");
  return { registration: found, commands, apps };
};

describe("registration", () => {
  it("defaults to Kilo Code and kilo-auto/free with an optional key field", () => {
    const { registration: r } = registration();
    expect(r.id).toBe("free-models");
    expect(r.defaultModel).toBe("kilo-auto/free");
    const select = r.fields.find((f) => f.key === "service");
    expect(select?.kind).toBe("select");
    expect(select?.defaultValue).toBe("kilo");
    expect(select?.options?.[0]?.value).toBe("kilo");
    expect(select?.options?.find((o) => o.value === "openrouter")?.label).toMatch(
      /20 requests per minute, 50 requests per day/,
    );
    const key = r.fields.find((f) => f.key === "apiKey");
    expect(key?.kind).toBe("secret");
    expect(key?.required).toBe(false);
    expect(key?.description).toContain("https://console.groq.com/keys");
    expect(r.fields.map((f) => f.key)).toEqual(["service", "apiKey"]);
    const p = r.create({ profile: {}, credentials: {} }) as FreeModelsProvider;
    expect(p.service.id).toBe("kilo");
    expect(p.model).toBe("kilo-auto/free");
  });

  it("registers the help command, and the app only when the host has apps", () => {
    expect(registration(false).apps).toHaveLength(0);
    const withApp = registration(true);
    expect(withApp.apps).toHaveLength(1);
    expect(withApp.commands.has("help")).toBe(true);
  });

  it("fails clearly, in both languages, when a key-required service has no key", () => {
    const { registration: r } = registration();
    expect(() => r.create({ profile: { service: "groq" }, credentials: {} })).toThrow(
      /Groq needs a free key\. 1\) Open https:\/\/console\.groq\.com\/keys.*Groq necesita una clave gratuita/,
    );
    expect(() => r.create({ profile: { service: "nope" }, credentials: {} })).toThrow(/Unknown/);
  });

  it("switches to the service default model when the profile still has another default", () => {
    const p = createProvider({
      profile: { service: "groq", model: "kilo-auto/free" },
      credentials: { apiKey: "gsk_test" },
    });
    expect(p.model).toBe("openai/gpt-oss-120b");
  });

  it("rejects a key that belongs to another service before it is sent", () => {
    expect(() =>
      createProvider({ profile: { service: "groq" }, credentials: { apiKey: "sk-or-v1-x" } }),
    ).toThrow(/looks like a key for OpenRouter/);
  });
});

describe("requests", () => {
  it("sends no Authorization header to keyless services, even when a key is stored", async () => {
    for (const id of ["kilo", "llm7", "ovh"]) {
      const { calls, fetcher } = mockFetch(chatOk);
      const p = createProvider(
        { profile: { service: id }, credentials: { apiKey: "secret-key" } },
        fetcher,
      );
      const events = await run(p);
      expect(events.at(-1)).toMatchObject({ type: "completed", usage: { input: 3, output: 1 } });
      expect(header(calls[0], "authorization")).toBeUndefined();
      expect(JSON.stringify(calls)).not.toContain("secret-key");
      expect(inspect(p, { showHidden: true })).not.toContain("secret-key");
    }
  });

  it("posts to the exact Kilo endpoint with the default model", async () => {
    const { calls, fetcher } = mockFetch(chatOk);
    await run(createProvider({ profile: {}, credentials: {} }, fetcher));
    expect(calls[0]?.url).toBe("https://api.kilo.ai/api/gateway/chat/completions");
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.model).toBe("kilo-auto/free");
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("sends a Bearer header when a key-required service has a key", async () => {
    const { calls, fetcher } = mockFetch(chatOk);
    await run(
      createProvider({ profile: { service: "groq" }, credentials: { apiKey: "gsk_abc" } }, fetcher),
    );
    expect(calls[0]?.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(header(calls[0], "authorization")).toBe("Bearer gsk_abc");
  });

  it("omits stream_options where the service is not known to accept it", async () => {
    const { calls, fetcher } = mockFetch(chatOk);
    await run(
      createProvider({ profile: { service: "mistral" }, credentials: { apiKey: "m" } }, fetcher),
    );
    expect(JSON.parse(String(calls[0]?.init.body)).stream_options).toBeUndefined();
  });

  it("explains rate-limit and key errors in plain words", async () => {
    const { fetcher } = mockFetch(() => new Response("", { status: 429 }));
    await expect(run(createProvider({ profile: {}, credentials: {} }, fetcher))).rejects.toThrow(
      /free limit reached/,
    );
  });
});

describe("free model listing", () => {
  it("keeps only Kilo entries flagged isFree with text output, kilo-auto/free first", async () => {
    const body = {
      data: [
        { id: "openrouter/free", isFree: true, pricing: { prompt: "0", completion: "0" } },
        { id: "paid/model", isFree: false, pricing: { prompt: "0.1", completion: "0.2" } },
        {
          id: "google/lyria-3-pro-preview",
          isFree: false,
          pricing: { prompt: "0", completion: "0" },
          architecture: { output_modalities: ["text", "audio"] },
        },
        { id: "kilo-auto/free", name: "Auto Free", isFree: true, context_length: 256000 },
        { id: "new/model:free", isFree: true, architecture: { output_modalities: ["text"] } },
      ],
    };
    const { calls, fetcher } = mockFetch(() => Response.json(body));
    const p = createProvider({ profile: {}, credentials: {} }, fetcher);
    const models = await p.listModels(AbortSignal.timeout(1000));
    expect(calls[0]?.url).toBe("https://api.kilo.ai/api/gateway/models");
    expect(header(calls[0], "authorization")).toBeUndefined();
    expect(models.map((m) => m.id)).toEqual([
      "kilo-auto/free",
      "openrouter/free",
      "new/model:free",
    ]);
    expect(models[0]?.name).toBe("Auto Free (free: 200 requests per hour (per IP address))");
    expect(models[0]?.contextWindow).toBe(256000);
  });

  it("keeps OpenRouter :free and zero-price text models only", () => {
    const models = freeModelsFrom(service("openrouter"), {
      data: [
        { id: "google/gemma-4-31b-it:free", pricing: { prompt: "0", completion: "0" } },
        { id: "openai/gpt-6", pricing: { prompt: "0.000002", completion: "0.00001" } },
        { id: "openrouter/free", pricing: { prompt: "0", completion: "0" } },
        {
          id: "google/lyria-3-clip-preview",
          pricing: { prompt: "0", completion: "0" },
          architecture: { output_modalities: ["text", "audio"] },
        },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["openrouter/free", "google/gemma-4-31b-it:free"]);
  });

  it("keeps LLM7 turbo-tier chat models only", () => {
    const models = freeModelsFrom(service("llm7"), {
      object: "list",
      data: [
        { id: "Inkling-Small", tier: "pro", model_type: "chat" },
        {
          id: "gpt-oss:20b",
          tier: "turbo",
          model_type: "chat",
          modalities: { input: ["text"], output: ["text"] },
          context_window: { tokens: 128000 },
        },
        { id: "turbo-image", tier: "turbo", model_type: "image" },
      ],
    });
    expect(models).toEqual([{ id: "gpt-oss:20b", contextWindow: 128000 }]);
  });

  it("matches pattern services and strips the Gemini models/ prefix", () => {
    const models = freeModelsFrom(service("gemini"), {
      data: [{ id: "models/gemini-2.5-flash" }, { id: "models/gemini-2.5-pro" }, { id: "x y" }],
    });
    expect(models.map((m) => m.id)).toEqual(["gemini-2.5-flash"]);
  });

  it("falls back to the static free list when the live listing fails", async () => {
    const { fetcher } = mockFetch(() => {
      throw new Error("offline");
    });
    const p = createProvider({ profile: {}, credentials: {} }, fetcher);
    const models = await p.listModels(AbortSignal.timeout(1000));
    expect(models.map((m) => m.id)).toEqual(service("kilo").freeModels.map((m) => m.id));
    const empty = mockFetch(() => Response.json({ data: [] }));
    const q = createProvider({ profile: {}, credentials: {} }, empty.fetcher);
    expect((await q.listModels(AbortSignal.timeout(1000))).length).toBeGreaterThan(0);
  });

  it("never calls the network for static services", async () => {
    const { calls, fetcher } = mockFetch(() => Response.json({ data: [] }));
    const p = createProvider({ profile: { service: "ovh" }, credentials: {} }, fetcher);
    expect((await p.listModels(AbortSignal.timeout(1000)))[0]?.id).toBe("gpt-oss-120b");
    expect(calls).toHaveLength(0);
  });
});

describe("help and app data", () => {
  it("prints plain steps and links, in English or Spanish", () => {
    expect(helpText("groq en", true)).toContain("1) Open https://console.groq.com/keys");
    expect(helpText("groq es", true)).toContain("1) Abre https://console.groq.com/keys");
    expect(helpText("en", false)).toContain("0.11.5");
    expect(helpText("", true)).not.toMatch(/\b(?:RPM|RPD|TPD|TPM|RPS)\b/);
  });

  it("injects the catalog JSON without a closing script tag", () => {
    const html = injectData(`<script>${DATA_MARKER}</script>`);
    const json = html.slice("<script>".length, -"</script>".length);
    expect(json).not.toContain("<");
    const data = JSON.parse(json);
    expect(data.en[0]).toMatchObject({ id: "kilo", needsKey: false, isDefault: true });
    expect(data.es.find((s: { id: string }) => s.id === "groq").steps.at(-1)).toMatch(/Pégala/);
  });
});
