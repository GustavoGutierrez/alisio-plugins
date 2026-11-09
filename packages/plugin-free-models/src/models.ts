import type { ModelInfo } from "@alisio/sdk";
import { type FreeModel, type FreeService, modelLimits } from "./catalog.js";
import { formatLimits } from "./limits.js";

type Entry = Record<string, unknown>;

/**
 * The single place that builds endpoint URLs. The base is used exactly as cataloged (no `/v1` is
 * ever added or assumed); only one trailing slash is removed before `/<path>` is appended.
 */
export function endpoint(baseURL: string, path: "chat/completions" | "models"): string {
  return `${baseURL.replace(/\/+$/, "")}/${path}`;
}

const record = (value: unknown): Entry | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Entry) : undefined;
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
const zero = (value: unknown) => value === 0 || value === "0";
const SAFE_ID = /^[\w.:/@+-]{1,200}$/;

function textOutput(entry: Entry): boolean {
  const architecture = record(entry.architecture);
  const output = strings(architecture?.output_modalities ?? record(entry.modalities)?.output);
  return output.length === 0 || (output.includes("text") && output.every((m) => m === "text"));
}

/** Reduces one live catalog entry to a free model, or `undefined` when it is not free. */
export function freeEntry(service: FreeService, raw: unknown): FreeModel | undefined {
  const entry = record(raw);
  if (!entry || typeof entry.id !== "string") return undefined;
  const id = service.listing === "pattern" ? entry.id.replace(/^models\//, "") : entry.id;
  if (!SAFE_ID.test(id)) return undefined;
  const pricing = record(entry.pricing);
  let free = false;
  switch (service.listing) {
    case "kilo":
      free = entry.isFree === true && textOutput(entry);
      break;
    case "openrouter":
      free =
        (id.endsWith(":free") || (zero(pricing?.prompt) && zero(pricing?.completion))) &&
        textOutput(entry);
      break;
    case "llm7":
      free =
        entry.tier === "turbo" &&
        (entry.model_type === undefined || entry.model_type === "chat") &&
        textOutput(entry);
      break;
    case "pattern":
      free = !!service.modelPattern?.test(id);
      break;
    case "static":
      free = false;
  }
  if (!free) return undefined;
  const context =
    positive(entry.context_length) ??
    positive(record(entry.context_window)?.tokens) ??
    positive(entry.context_window);
  return {
    id,
    ...(typeof entry.name === "string" && entry.name.length <= 200 ? { name: entry.name } : {}),
    ...(context ? { contextWindow: context } : {}),
  };
}

/** Free models from a `/models` body, in catalog order first, then the live order. */
export function freeModelsFrom(service: FreeService, body: unknown): FreeModel[] {
  const data = record(body)?.data ?? body;
  if (!Array.isArray(data)) return [];
  const live = data.flatMap((raw) => {
    const model = freeEntry(service, raw);
    return model ? [model] : [];
  });
  const rank = (id: string) => {
    const index = service.freeModels.findIndex((m) => m.id === id);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const unique = [...new Map(live.map((m) => [m.id, m])).values()];
  return unique.sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 500);
}

/** ModelInfo for the host list; the display name carries the free limits in plain words. */
export function toModelInfo(service: FreeService, model: FreeModel): ModelInfo {
  const known = service.freeModels.find((m) => m.id === model.id);
  const name = model.name ?? known?.name ?? model.id;
  const contextWindow = model.contextWindow ?? known?.contextWindow;
  return {
    id: model.id,
    name: `${name} (free: ${formatLimits(modelLimits(service, known ?? model))})`,
    ...(contextWindow ? { contextWindow } : {}),
  };
}
