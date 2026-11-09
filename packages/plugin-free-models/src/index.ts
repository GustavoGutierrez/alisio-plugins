import { readFile } from "node:fs/promises";
import { definePlugin, type Plugin, type ProviderCreateRequest } from "@alisio/sdk";
import {
  DEFAULT_MODEL,
  DEFAULT_SERVICE_ID,
  type FreeService,
  findService,
  SERVICES,
} from "./catalog.js";
import {
  formatKeySteps,
  formatLimits,
  formatNotes,
  formatOption,
  formatService,
  keyStepList,
  type Locale,
  resolveLocale,
} from "./limits.js";
import { FreeModelsProvider } from "./provider.js";
import { VERSION } from "./version.js";

export const PLUGIN_ID = "free-models";
/** The JSON string placeholder in web/index.html, quotes included, replaced by the catalog data. */
export const DATA_MARKER = '"__FREE_MODELS_DATA__"';

const keyless = SERVICES.filter((s) => !s.needsKey).map((s) => s.name);

const SERVICE_DESCRIPTION = `Kilo Code works right away: no account and no key. ${keyless.join(", ")} need no key. Providers marked "needs a free key" ask for one; the Key field below says where to get it, and /free-models:help <provider> shows the steps.`;

const KEY_DESCRIPTION = `Needed only for providers marked "needs a free key"; leave it empty for ${keyless.join(", ")}. Sign in and create a free key here: ${SERVICES.filter(
  (s) => s.needsKey,
)
  .map((s) => `${s.name} ${s.keyUrl}`)
  .join("; ")}.`;

const APP_NOTE: Record<Locale, string> = {
  en: "On Alisio 0.11.5 or newer, the Free models page in the workspace shows these services with a step-by-step guide.",
  es: "En Alisio 0.11.5 o posterior, la página Modelos gratis del espacio de trabajo muestra estos servicios con una guía paso a paso.",
};

const profileString = (request: ProviderCreateRequest, key: string) =>
  typeof request.profile[key] === "string" ? String(request.profile[key]).trim() : "";

/** Picks the profile model, or the service default when the model belongs to another service. */
export function resolveModel(service: FreeService, requested: string): string {
  if (!requested) return service.defaultModel;
  if (service.freeModels.some((m) => m.id === requested)) return requested;
  const otherDefault = SERVICES.some(
    (other) => other.id !== service.id && other.defaultModel === requested,
  );
  return otherDefault ? service.defaultModel : requested;
}

/** Throws when the key clearly belongs to another cataloged service, so it is never sent there. */
export function assertKeyFits(service: FreeService, key: string): void {
  const owner = SERVICES.find(
    (other) => other.id !== service.id && other.keyPrefix && key.startsWith(other.keyPrefix),
  );
  if (owner && !(service.keyPrefix && key.startsWith(service.keyPrefix)))
    throw new Error(
      `This key looks like a key for ${owner.name}, not for ${service.name}. Pick ${owner.name} or paste a ${service.name} key. / Esta clave parece de ${owner.name}, no de ${service.name}. Elige ${owner.name} o pega una clave de ${service.name}.`,
    );
}

export function createProvider(
  request: ProviderCreateRequest,
  fetcher?: typeof fetch,
): FreeModelsProvider {
  const requested = profileString(request, "service") || DEFAULT_SERVICE_ID;
  const service = findService(requested);
  if (!service)
    throw new Error(
      `Unknown free service "${requested.slice(0, 40)}". Choose one of: ${SERVICES.map((s) => s.id).join(", ")}`,
    );
  const apiKey = service.needsKey ? request.credentials.apiKey?.trim() : undefined;
  if (apiKey) assertKeyFits(service, apiKey);
  return new FreeModelsProvider({
    service,
    model: resolveModel(service, profileString(request, "model")),
    ...(apiKey ? { apiKey } : {}),
    ...(fetcher ? { fetch: fetcher } : {}),
  });
}

/** Help command output (Markdown): every service, or one service when its id is given. */
export function helpText(args: string, hasApp: boolean): string {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const locale = resolveLocale(words.find((w) => w === "es" || w === "en"));
  const service = words.map((w) => findService(w)).find(Boolean);
  const intro =
    locale === "es"
      ? "Modelos gratis: elige un proveedor en la conexión free-models. Kilo Code funciona sin cuenta ni clave."
      : "Free models: pick a provider in the free-models connection. Kilo Code works with no account and no key.";
  const body = (service ? [service] : SERVICES).map((s) => formatService(s, locale)).join("\n\n");
  return [intro, "", body, ...(hasApp ? [] : ["", APP_NOTE[locale]])].join("\n");
}

/** JSON the app frame renders; built from the one catalog module. */
export function appData() {
  const pick = (locale: Locale) =>
    SERVICES.map((s) => ({
      id: s.id,
      name: s.name,
      needsKey: s.needsKey,
      keyUrl: s.keyUrl,
      isDefault: s.id === DEFAULT_SERVICE_ID,
      defaultModel: s.defaultModel,
      models: s.freeModels.map((m) => m.id),
      limits: formatLimits(s.limits, locale),
      notes: formatNotes(s.notes, locale),
      steps: s.needsKey ? keyStepList(s, locale) : [],
    }));
  return { en: pick("en"), es: pick("es") };
}

/** Embeds the data JSON safely inside the HTML (no `<` can close the script element). */
export function injectData(html: string): string {
  const json = JSON.stringify(appData()).replace(/</g, "\\u003c");
  return html.replace(DATA_MARKER, () => json);
}

export function createFreeModelsPlugin(fetcher?: typeof fetch): Plugin {
  return definePlugin({
    id: PLUGIN_ID,
    name: "Free Models",
    description: "Free LLM access with minimal setup: Kilo Code by default, plus other free tiers",
    categories: ["model-provider"],
    version: VERSION,
    apiVersion: 1,
    setup(api) {
      api.providers.register({
        id: PLUGIN_ID,
        name: "Free Models",
        description: "Free OpenAI-compatible models; Kilo Code works with no account or key",
        defaultModel: DEFAULT_MODEL,
        fields: [
          {
            key: "service",
            label: "Provider",
            kind: "select",
            required: true,
            defaultValue: DEFAULT_SERVICE_ID,
            description: SERVICE_DESCRIPTION,
            options: SERVICES.map((s) => ({ value: s.id, label: formatOption(s) })),
          },
          {
            key: "apiKey",
            label: "Key",
            kind: "secret",
            required: false,
            description: KEY_DESCRIPTION,
          },
        ],
        create: (request) => createProvider(request, fetcher),
      });
      // `api.commands` and `api.apps` are optional extras; the provider above never depends on them.
      api.commands?.register("help", async (args) => helpText(args ?? "", !!api.apps), {
        description: "Free services, their free limits and how to get a free key",
        argumentHint: "[service] [en|es]",
      });
      if (!api.apps) return;
      api.apps.register({
        id: "guide",
        label: { en: "Free models", es: "Modelos gratis" },
        html: async () =>
          injectData(await readFile(new URL("./embedded.html", import.meta.url), "utf8")),
      });
    },
  });
}

export type { FreeService } from "./catalog.js";
export { FreeModelsProvider } from "./provider.js";
export { findService, formatKeySteps, formatLimits, SERVICES };
export default createFreeModelsPlugin();
