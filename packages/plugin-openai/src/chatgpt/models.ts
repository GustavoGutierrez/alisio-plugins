import type { ModelInfo } from "@alisio/sdk";

/** Minimal static list, used only when the models endpoint fails (spec 025 D-33). */
/** Model preselected for new `chatgpt` profiles; also the listing fallback. */
export const DEFAULT_MODEL = "gpt-5.6-terra";

export const FALLBACK_MODELS: readonly ModelInfo[] = Object.freeze([{ id: DEFAULT_MODEL }]);

const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const positive = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/**
 * Parses `GET /v1/models` with a SIWC bearer, which answers `{models:[...]}` (filtered to
 * `visibility == "list"` and `supported_in_api`, ordered by `priority`), and also accepts the
 * standard `{data:[...]}` shape. Returns `undefined` for any other body.
 */
export function parseModels(body: unknown): ModelInfo[] | undefined {
  if (!isRecord(body)) return undefined;
  if (Array.isArray(body.models))
    return body.models
      .filter(isRecord)
      .filter(
        (m) =>
          typeof m.slug === "string" &&
          MODEL_ID.test(m.slug) &&
          m.visibility === "list" &&
          m.supported_in_api === true,
      )
      .map((m, index) => ({
        m,
        index,
        priority: typeof m.priority === "number" && Number.isFinite(m.priority) ? m.priority : null,
      }))
      .sort((a, b) =>
        a.priority === b.priority
          ? a.index - b.index
          : a.priority === null
            ? 1
            : b.priority === null
              ? -1
              : a.priority - b.priority,
      )
      .map(({ m }) => {
        const contextWindow = positive(m.context_window);
        return {
          id: m.slug as string,
          ...(typeof m.display_name === "string" && m.display_name.length <= 200
            ? { name: m.display_name }
            : {}),
          ...(contextWindow ? { contextWindow } : {}),
        };
      });
  if (Array.isArray(body.data))
    return body.data
      .filter(isRecord)
      .filter((m) => typeof m.id === "string" && MODEL_ID.test(m.id))
      .map((m) => ({
        id: m.id as string,
        ...(typeof m.owned_by === "string" ? { ownedBy: m.owned_by } : {}),
      }));
  return undefined;
}
