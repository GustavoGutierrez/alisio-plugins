import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { CheckCollector, type CheckFinding, type CheckReport } from "./knowledge/report.js";
import { isRecord } from "./schemas.js";

/** A visual theme (spec 10.5): a token map of CSS custom properties, plus a name. */
export interface Theme {
  schemaVersion: 1;
  id: string;
  name: Record<string, string>;
  tokens: Record<string, string>;
}

export interface ThemeLayer {
  dir: string;
  layer: "shipped" | "workspace";
}

export interface ThemesCatalogue {
  themes: Theme[];
  report: CheckReport;
}

const MAX_THEME_BYTES = 64 * 1024;
const idPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;
const tokenNamePattern = /^[a-z][A-Za-z0-9]*$/;

export const DOC_THEME = "EVL-DOC-005";

export function parseThemeFile(
  text: string,
  subject: string,
  collector: CheckCollector,
): Theme | undefined {
  if (Buffer.byteLength(text) > MAX_THEME_BYTES) {
    collector.error(DOC_THEME, subject, "theme file exceeds the size limit");
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parse(text, { schema: "core", maxAliasCount: 0, uniqueKeys: true });
  } catch (error) {
    collector.error(
      DOC_THEME,
      subject,
      `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
  if (!isRecord(parsed)) {
    collector.error(DOC_THEME, subject, "theme must be a mapping");
    return undefined;
  }
  const before = collector.results.length;
  if (parsed.schemaVersion !== 1) {
    collector.error(DOC_THEME, subject, "schemaVersion must be 1");
  }
  const id = typeof parsed.id === "string" && idPattern.test(parsed.id) ? parsed.id : undefined;
  if (id === undefined) collector.error(DOC_THEME, subject, "id must be a lowercase theme id");
  const name: Record<string, string> = {};
  if (isRecord(parsed.name)) {
    for (const [language, value] of Object.entries(parsed.name)) {
      if (typeof value === "string" && value.trim() !== "") name[language] = value;
    }
  }
  if (name.es === undefined) collector.error(DOC_THEME, subject, "name must include an es text");
  const tokens: Record<string, string> = {};
  if (!isRecord(parsed.tokens)) {
    collector.error(DOC_THEME, subject, "tokens must be a mapping of CSS custom properties");
  } else {
    for (const [key, value] of Object.entries(parsed.tokens)) {
      if (!tokenNamePattern.test(key)) {
        collector.error(DOC_THEME, subject, `token "${key}" must be a camelCase name`);
        continue;
      }
      if (typeof value !== "string" || value.trim() === "") {
        collector.error(DOC_THEME, subject, `token "${key}" must be a non-empty string`);
        continue;
      }
      tokens[key] = value;
    }
  }
  if (collector.results.length > before || id === undefined) return undefined;
  return { schemaVersion: 1, id, name, tokens };
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Loads theme layers in precedence order (shipped first, workspace last; later wins by id). */
export async function loadThemeLayers(layers: readonly ThemeLayer[]): Promise<ThemesCatalogue> {
  const collector = new CheckCollector();
  const byId = new Map<string, Theme>();
  const order: string[] = [];
  for (const layer of layers) {
    for (const folder of await listDirectories(layer.dir)) {
      let text: string;
      try {
        text = await readFile(join(layer.dir, folder, "theme.yaml"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const theme = parseThemeFile(text, `theme ${folder}`, collector);
      if (theme === undefined) continue;
      if (!byId.has(theme.id)) order.push(theme.id);
      byId.set(theme.id, theme);
    }
  }
  const themes = order
    .map((id) => byId.get(id))
    .filter((theme): theme is Theme => theme !== undefined);
  return { themes, report: collector.report() };
}

export interface ThemeResolution {
  theme?: Theme;
  finding?: CheckFinding;
}

/** Resolves `exam.yaml.template` to a theme; an unknown id is `EVL-DOC-005`. */
export function resolveTheme(themes: readonly Theme[], id: string): ThemeResolution {
  const theme = themes.find((entry) => entry.id === id);
  if (theme !== undefined) return { theme };
  return {
    finding: {
      id: DOC_THEME,
      severity: "error",
      subject: "exam",
      message: `unknown template "${id}"; known themes: ${themes.map((entry) => entry.id).join(", ")}`,
    },
  };
}
