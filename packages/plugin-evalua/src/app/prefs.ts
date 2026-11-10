import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../schemas.js";
import { atomicWrite, canonicalJson, stateDirectory } from "../storage.js";

/** A model-drafted wording kept until the teacher saves it (never applied before `wording.save`). */
export interface WordingDraft {
  templates: Record<string, string[]>;
  dropped: number;
  model: string | null;
  fallback: boolean;
  at: string;
}

/** A finding of the last build, as the app shows it. */
export interface BuildFinding {
  id: string;
  severity: "error" | "warning";
  message: string;
}

export interface LastBuild {
  at: string;
  findings: BuildFinding[];
  pdf: boolean;
}

/** `<ws>/.alisio/evalua/app.json` (app spec D5): app-only data; the chat never reads it. */
export interface AppPrefs {
  schemaVersion: 1;
  model: string | null;
  wording: Record<string, WordingDraft>;
  lastBuild: Record<string, LastBuild>;
}

const MAX_PREFS_BYTES = 512 * 1024;
const examKey = /^e[0-9]{2,3}$/;

export const emptyPrefs = (): AppPrefs => ({
  schemaVersion: 1,
  model: null,
  wording: {},
  lastBuild: {},
});

export function prefsFile(workspace: string): string {
  return join(stateDirectory(workspace), "app.json");
}

const strings = (value: unknown, max: number): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").slice(0, max)
    : [];

function readWording(value: unknown): WordingDraft | undefined {
  if (!isRecord(value) || !isRecord(value.templates)) return undefined;
  const templates: Record<string, string[]> = {};
  for (const [family, list] of Object.entries(value.templates))
    templates[family] = strings(list, 5);
  return {
    templates,
    dropped: Number.isInteger(value.dropped) ? (value.dropped as number) : 0,
    model: typeof value.model === "string" ? value.model : null,
    fallback: value.fallback === true,
    at: typeof value.at === "string" ? value.at : "",
  };
}

function readLastBuild(value: unknown): LastBuild | undefined {
  if (!isRecord(value)) return undefined;
  const findings = Array.isArray(value.findings)
    ? value.findings.filter(isRecord).map((entry) => ({
        id: String(entry.id ?? ""),
        severity: entry.severity === "error" ? ("error" as const) : ("warning" as const),
        message: String(entry.message ?? ""),
      }))
    : [];
  return {
    at: typeof value.at === "string" ? value.at : "",
    findings,
    pdf: value.pdf === true,
  };
}

/** Tolerant reader: a missing, unreadable or foreign file is an empty preference set. */
export function parsePrefs(text: string): AppPrefs {
  if (Buffer.byteLength(text) > MAX_PREFS_BYTES) return emptyPrefs();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyPrefs();
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) return emptyPrefs();
  const prefs = emptyPrefs();
  if (typeof parsed.model === "string" && parsed.model.length <= 200) prefs.model = parsed.model;
  for (const [key, value] of Object.entries(isRecord(parsed.wording) ? parsed.wording : {})) {
    const draft = examKey.test(key) ? readWording(value) : undefined;
    if (draft) prefs.wording[key] = draft;
  }
  for (const [key, value] of Object.entries(isRecord(parsed.lastBuild) ? parsed.lastBuild : {})) {
    const build = examKey.test(key) ? readLastBuild(value) : undefined;
    if (build) prefs.lastBuild[key] = build;
  }
  return prefs;
}

export async function readPrefs(workspace: string): Promise<AppPrefs> {
  try {
    return parsePrefs(await readFile(prefsFile(workspace), "utf8"));
  } catch {
    return emptyPrefs();
  }
}

/** Atomic write (temporary file + rename), private to the user like `state.json`. */
export async function writePrefs(workspace: string, prefs: AppPrefs): Promise<void> {
  await atomicWrite(prefsFile(workspace), canonicalJson(prefs), 0o600);
}
