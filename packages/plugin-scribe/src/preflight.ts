import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Basenames of the LaTeX resources in `compiler/bundle.zip`, written by
 * `scripts/vendor-tex-bundle.py` next to the bundle. Preflight is skipped when it is absent.
 */
export interface BundleManifest {
  texlive: string;
  files: ReadonlySet<string>;
}

/** What the bundled engine is missing for a document. Names only: no paths, no document text. */
export interface PreflightReport {
  /** Document classes and packages without a `.cls` / `.sty` in the bundle. */
  packages: string[];
  /** Babel languages with neither a `.ldf` file nor a `babel-*.ini` locale. */
  languages: string[];
  /** Babel languages that exist only as an `.ini` locale and are loaded without `provide=*`. */
  provide: string[];
}

export const MANIFEST_PATH = fileURLToPath(
  new URL("../compiler/bundle-manifest.json", import.meta.url),
);

let cached: { path: string; manifest: BundleManifest | null } | undefined;

/** Parse a manifest object; anything malformed counts as "no manifest" (fail-open). */
export function parseManifest(value: unknown): BundleManifest | null {
  if (!value || typeof value !== "object") return null;
  const { texlive, files } = value as { texlive?: unknown; files?: unknown };
  if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) return null;
  return { texlive: typeof texlive === "string" ? texlive : "", files: new Set(files) };
}

/** Read the bundle manifest once per path. A missing or unreadable file returns null. */
export function loadManifest(path: string = MANIFEST_PATH): BundleManifest | null {
  if (cached?.path === path) return cached.manifest;
  let manifest: BundleManifest | null = null;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    manifest = null;
  }
  cached = { path, manifest };
  return manifest;
}

export interface TexUse {
  kind: "class" | "package";
  name: string;
  options: string[];
}

/** Remove TeX comments: an unescaped `%` comments out the rest of its line. */
export function stripComments(tex: string): string {
  return tex
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== "%") continue;
        let slashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === "\\"; j--) slashes++;
        if (slashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Classes and packages a document loads through `\documentclass`, `\usepackage`, `\RequirePackage`. */
export function parseTex(tex: string): { uses: TexUse[]; babelProvided: string[] } {
  const source = stripComments(tex);
  const uses: TexUse[] = [];
  const command = /\\(documentclass|usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(command)) {
    const kind = match[1] === "documentclass" ? "class" : "package";
    const options = list(match[2]);
    // Macros or other non-literal names cannot be resolved statically: skip them.
    for (const name of list(match[3])) if (NAME.test(name)) uses.push({ kind, name, options });
  }
  const babelProvided: string[] = [];
  for (const match of source.matchAll(/\\babelprovide\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g))
    for (const name of list(match[1])) if (NAME.test(name)) babelProvided.push(name);
  return { uses, babelProvided };
}

/** Babel package options that are not language names. */
const BABEL_FLAGS = new Set([
  "activeacute",
  "activegrave",
  "base",
  "KeepShorthands",
  "noconfigs",
  "nocase",
  "silent",
  "showlanguages",
  "safe",
  "math",
  "shorthands",
  "strings",
  "config",
  "headfoot",
  "hyphenmap",
  "bidi",
  "layout",
  "import",
  "nil",
  "debug",
  "provide",
  "provide*",
  "provide+",
  "onchar",
  "mapfont",
]);

/**
 * Fallback names-to-locale map for babel languages whose `babel-<name>.tex` loader is not listed
 * in the manifest. Babel itself resolves these through those loaders.
 */
const BABEL_ALIASES: Record<string, string> = {
  english: "en",
  american: "en-US",
  british: "en-GB",
  spanish: "es",
  mexican: "es-MX",
  french: "fr",
  german: "de",
  ngerman: "de",
  italian: "it",
  portuguese: "pt",
  brazilian: "pt-BR",
  catalan: "ca",
  dutch: "nl",
  russian: "ru",
  polish: "pl",
  greek: "el",
};

/** Report what `tex` needs that the bundle lacks. Returns null when nothing is missing. */
export function preflight(tex: string, manifest: BundleManifest): PreflightReport | null {
  const { uses, babelProvided } = parseTex(tex);
  const has = (file: string) => manifest.files.has(file);
  const packages = new Set<string>();
  for (const use of uses)
    if (!has(`${use.name}.${use.kind === "class" ? "cls" : "sty"}`)) packages.add(use.name);

  const languages = new Set<string>();
  const provide = new Set<string>();
  const babel = uses.filter((u) => u.kind === "package" && u.name === "babel");
  if (babel.length && !packages.has("babel")) {
    const ldf = (lang: string) => has(`${lang}.ldf`);
    const ini = (lang: string) => {
      const alias = BABEL_ALIASES[lang];
      return (
        has(`babel-${lang}.ini`) ||
        has(`babel-${lang}.tex`) ||
        (alias !== undefined && has(`babel-${alias}.ini`))
      );
    };
    const options = babel.flatMap((u) => u.options);
    const usesProvide = options.some((o) => /^provide[*+]?\s*=/.test(o));
    const requested = new Set<string>();
    for (const option of options) {
      const [key = "", value] = option.split("=", 2).map((s) => s.trim());
      if (value !== undefined) {
        if (key === "main" && NAME.test(value)) requested.add(value);
      } else if (!BABEL_FLAGS.has(key) && NAME.test(key)) requested.add(key);
    }
    // Class options naming a known language are passed on to babel as well.
    for (const use of uses)
      if (use.kind === "class")
        for (const option of use.options) if (option in BABEL_ALIASES) requested.add(option);
    for (const lang of requested) {
      if (ldf(lang)) continue;
      if (!ini(lang)) languages.add(lang);
      else if (!usesProvide) provide.add(lang);
    }
    for (const lang of babelProvided) if (!ldf(lang) && !ini(lang)) languages.add(lang);
  }
  if (!packages.size && !languages.size && !provide.size) return null;
  return {
    packages: [...packages].sort(),
    languages: [...languages].sort(),
    provide: [...provide].sort(),
  };
}

/** One-line, names-only description of a report, used as the job failure detail. */
export function describeReport(report: PreflightReport): string {
  const lines: string[] = [];
  if (report.packages.length)
    lines.push(`Missing LaTeX packages or classes: ${report.packages.join(", ")}`);
  if (report.languages.length)
    lines.push(`Unsupported babel languages: ${report.languages.join(", ")}`);
  for (const lang of report.provide)
    lines.push(`Babel language ${lang} needs provide=*: \\usepackage[${lang},provide=*]{babel}`);
  return lines.join("\n");
}

/**
 * Packages the writer is encouraged to use. With a manifest, only the ones the bundle actually
 * ships are kept; without one, the conservative fallback list is returned.
 */
const PREFERRED = [
  "amsmath",
  "amssymb",
  "amsthm",
  "mathtools",
  "bm",
  "graphicx",
  "xcolor",
  "booktabs",
  "tabularx",
  "longtable",
  "multirow",
  "array",
  "caption",
  "subcaption",
  "float",
  "wrapfig",
  "geometry",
  "setspace",
  "fancyhdr",
  "enumitem",
  "hyperref",
  "cleveref",
  "url",
  "natbib",
  "csquotes",
  "microtype",
  "fontspec",
  "unicode-math",
  "listings",
  "tikz",
  "pgfplots",
  "siunitx",
  "biblatex",
  "algorithm2e",
  "algorithm",
  "algpseudocode",
  "babel",
];
const FALLBACK = [
  "amsmath",
  "amssymb",
  "amsthm",
  "mathtools",
  "graphicx",
  "xcolor",
  "booktabs",
  "tabularx",
  "multirow",
  "caption",
  "subcaption",
  "float",
  "geometry",
  "enumitem",
  "hyperref",
  "url",
  "natbib",
  "csquotes",
  "fontspec",
  "listings",
  "tikz",
  "babel",
];

export function packageAllowlist(manifest: BundleManifest | null): string[] {
  if (!manifest) return [...FALLBACK];
  return PREFERRED.filter((name) => manifest.files.has(`${name}.sty`));
}

/** Text appended to the writer instructions so the model only reaches for bundled packages. */
export function writerEngineNote(manifest: BundleManifest | null): string {
  return [
    "",
    "Engine packages (guaranteed in this bundle; prefer these and avoid any other package):",
    packageAllowlist(manifest).join(", "),
  ].join("\n");
}
