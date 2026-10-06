import { CALIBRATION_MUTATIONS } from "./calibration.js";

/** How the probe finds an element: exactly one primary form (spec 9.2 `locator`). */
export interface ProbeLocator {
  role?: string;
  name?: string;
  testId?: string;
  css?: string;
  label?: string;
  text?: string;
}

export interface ProbeCase {
  id: string;
  /** Absolute URL under `baseUrl`. */
  url: string;
  viewport: [number, number];
  dpr: number;
  theme: "light" | "dark";
  locale: string;
  timezone: string;
  reducedMotion: "reduce" | "no-preference";
  localStorage: Record<string, string>;
  /** CSS selectors hidden before the capture (volatile content only). */
  masks: string[];
}

export interface ProbeRequest {
  schemaVersion: 1;
  baseUrl: string;
  browser: "chromium" | "firefox" | "webkit";
  cases: ProbeCase[];
  elements: Array<{ id: string; locator: ProbeLocator }>;
  styleProps: string[];
  /** Calibration only: extra unchanged captures per case. */
  repetitions: number;
  /** Calibration only: mutations applied to the `mutate` elements, one capture each. */
  mutations: string[];
  mutate: string[];
  keyboard: { focusOrder: string[] };
  axe: boolean;
  /** Origins besides `baseUrl` the pages may load (fonts, CDN); everything else is aborted (spec 19). */
  allowedOrigins: string[];
}

export type RequestParse = { ok: true; request: ProbeRequest } | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;
const ID = /^[a-z][a-z0-9-]{1,47}$/;
const STYLE_PROP = /^[a-z][a-z-]{1,40}$/;

/** The probe validates its own input: it is a separate process reading a file. */
export function parseProbeRequest(raw: unknown): RequestParse {
  const errors: string[] = [];
  if (!isRecord(raw) || raw.schemaVersion !== 1)
    return { ok: false, errors: ["the request needs schemaVersion 1"] };
  if (typeof raw.baseUrl !== "string" || !LOOPBACK.test(raw.baseUrl.replace(/\/$/, "")))
    errors.push("baseUrl must be http://127.0.0.1:<port> or http://localhost:<port>");
  if (raw.browser !== "chromium" && raw.browser !== "firefox" && raw.browser !== "webkit")
    errors.push("browser must be chromium, firefox or webkit");
  if (!Array.isArray(raw.cases) || raw.cases.length === 0 || raw.cases.length > 200)
    errors.push("cases must hold 1 to 200 cases");
  else
    raw.cases.forEach((c: unknown, index: number) => {
      if (!isRecord(c) || typeof c.id !== "string" || !ID.test(c.id))
        errors.push(`cases/${index}/id is invalid`);
      else {
        if (
          typeof c.url !== "string" ||
          typeof raw.baseUrl !== "string" ||
          !c.url.startsWith(raw.baseUrl.replace(/\/$/, ""))
        )
          errors.push(`cases/${index}/url must be under baseUrl`);
        if (
          !Array.isArray(c.viewport) ||
          c.viewport.length !== 2 ||
          !c.viewport.every((n) => Number.isInteger(n) && n >= 1 && n <= 10000)
        )
          errors.push(`cases/${index}/viewport must be [width, height]`);
        if (c.theme !== "light" && c.theme !== "dark")
          errors.push(`cases/${index}/theme must be light or dark`);
        if (typeof c.dpr !== "number" || c.dpr < 1 || c.dpr > 4)
          errors.push(`cases/${index}/dpr must be 1 to 4`);
        if (!isRecord(c.localStorage)) errors.push(`cases/${index}/localStorage must be an object`);
        if (
          !Array.isArray(c.masks) ||
          !c.masks.every((m) => typeof m === "string" && m.length <= 300)
        )
          errors.push(`cases/${index}/masks must be selectors`);
      }
    });
  if (!Array.isArray(raw.elements) || raw.elements.length > 500)
    errors.push("elements must be a list of at most 500");
  else
    raw.elements.forEach((e: unknown, index: number) => {
      if (!isRecord(e) || typeof e.id !== "string" || !ID.test(e.id) || !isRecord(e.locator))
        errors.push(`elements/${index} is invalid`);
    });
  if (
    !Array.isArray(raw.styleProps) ||
    !raw.styleProps.every((p) => typeof p === "string" && STYLE_PROP.test(p))
  )
    errors.push("styleProps must be CSS property names");
  if (
    !Number.isInteger(raw.repetitions) ||
    (raw.repetitions as number) < 0 ||
    (raw.repetitions as number) > 20
  )
    errors.push("repetitions must be 0 to 20");
  if (
    !Array.isArray(raw.mutations) ||
    !raw.mutations.every((m) => (CALIBRATION_MUTATIONS as readonly string[]).includes(m as string))
  )
    errors.push("mutations must come from the calibration list");
  if (!Array.isArray(raw.mutate) || !raw.mutate.every((m) => typeof m === "string" && ID.test(m)))
    errors.push("mutate must list element ids");
  if (!isRecord(raw.keyboard) || !Array.isArray(raw.keyboard.focusOrder))
    errors.push("keyboard.focusOrder must be a list");
  if (typeof raw.axe !== "boolean") errors.push("axe must be a boolean");
  if (
    !Array.isArray(raw.allowedOrigins) ||
    !raw.allowedOrigins.every((o) => typeof o === "string" && /^https?:\/\/[^/\s]+$/.test(o))
  )
    errors.push("allowedOrigins must be origins");
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, request: raw as unknown as ProbeRequest };
}

/** What the probe prints on its last stdout line. */
export type ProbeSummary =
  | { status: "ok"; cases: number; outDir: string }
  | { status: "BLOCKED"; reason: string; hint: string };
