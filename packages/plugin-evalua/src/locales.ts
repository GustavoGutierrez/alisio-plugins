import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { CheckCollector, type CheckReport } from "./knowledge/report.js";
import { isRecord } from "./schemas.js";

/** Student-facing labels and templates (spec 9.3); data only, one file per language. */
export interface Locale {
  schemaVersion: 1;
  language: string;
  labels: Record<string, string>;
  sections: Record<string, string>;
  intro: {
    base: string;
    procedure: string;
    selection: string;
    clarity: string;
    calculator: string;
  };
  duration: { hours: string; minutes: string };
  instrument: Record<string, string>;
  rubric: Record<string, string>;
}

const MAX_BYTES = 128 * 1024;
const languagePattern = /^[a-z]{2,3}$/;

function readStringMap(
  value: unknown,
  subject: string,
  field: string,
  collector: CheckCollector,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) {
    collector.error("EVL-DOC-001", subject, `${field} must be a mapping`);
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || entry.trim() === "") {
      collector.error("EVL-DOC-001", subject, `${field}.${key} must be non-empty text`);
      continue;
    }
    out[key] = entry;
  }
  return out;
}

export function parseLocale(
  text: string,
  subject: string,
  collector: CheckCollector,
): Locale | undefined {
  if (Buffer.byteLength(text) > MAX_BYTES) {
    collector.error("EVL-DOC-001", subject, "locale file exceeds the size limit");
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parse(text, { schema: "core", maxAliasCount: 0, uniqueKeys: true });
  } catch (error) {
    collector.error(
      "EVL-DOC-001",
      subject,
      `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  if (!isRecord(parsed)) {
    collector.error("EVL-DOC-001", subject, "locale must be a mapping");
    return undefined;
  }
  const before = collector.results.length;
  const language =
    typeof parsed.language === "string" && languagePattern.test(parsed.language)
      ? parsed.language
      : undefined;
  if (language === undefined)
    collector.error("EVL-DOC-001", subject, "language must be a short tag");
  const labels = readStringMap(parsed.labels, subject, "labels", collector);
  const sections = readStringMap(parsed.sections, subject, "sections", collector);
  const duration = readStringMap(parsed.duration, subject, "duration", collector);
  const instrument = readStringMap(parsed.instrument, subject, "instrument", collector);
  const rubric = readStringMap(parsed.rubric, subject, "rubric", collector);
  const intro = readStringMap(parsed.intro, subject, "intro", collector);
  for (const required of ["base", "procedure", "selection", "clarity", "calculator"]) {
    if (intro[required] === undefined) {
      collector.error("EVL-DOC-001", subject, `intro.${required} is required`);
    }
  }
  for (const required of ["hours", "minutes"]) {
    if (duration[required] === undefined) {
      collector.error("EVL-DOC-001", subject, `duration.${required} is required`);
    }
  }
  if (collector.results.length > before || language === undefined) return undefined;
  return {
    schemaVersion: 1,
    language,
    labels,
    sections,
    intro: {
      base: intro.base ?? "",
      procedure: intro.procedure ?? "",
      selection: intro.selection ?? "",
      clarity: intro.clarity ?? "",
      calculator: intro.calculator ?? "",
    },
    duration: { hours: duration.hours ?? "", minutes: duration.minutes ?? "" },
    instrument,
    rubric,
  };
}

export interface LocaleCatalogue {
  locale?: Locale;
  report: CheckReport;
}

/** Loads `<dir>/<language>.yaml`. */
export async function loadLocale(dir: string, language = "es"): Promise<LocaleCatalogue> {
  const collector = new CheckCollector();
  let text: string;
  try {
    text = await readFile(join(dir, `${language}.yaml`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      collector.error("EVL-DOC-001", `locale ${language}`, "locale file not found");
      return { report: collector.report() };
    }
    throw error;
  }
  const locale = parseLocale(text, `locale ${language}`, collector);
  return { ...(locale === undefined ? {} : { locale }), report: collector.report() };
}
