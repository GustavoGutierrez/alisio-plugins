/**
 * Shared plugin-catalog model for the documentation site.
 *
 * This module is the single source of truth for three things that must never
 * drift apart: how a plugin is identified (slug, install name), how its cover is
 * resolved, and how its README is turned into a page. Both
 * `scripts/scan-plugins.mjs` (the only network-touching command) and
 * `scripts/docs-check.mjs` (fully offline) import it, so the committed cache and
 * the site pages are validated against the same rules that produced them.
 *
 * SAFETY INVARIANTS
 *   - Third-party code is NEVER imported or executed. Npm registry metadata and
 *     the published tarball's files are data; they are parsed, sanitized and
 *     copied, never evaluated.
 *   - Anything written into the repository is passed through
 *     `neutralizeForPublication`, which reuses the leak guard's own rules, so a
 *     published README cannot smuggle a machine path or a credential shape into
 *     a tracked file.
 *   - README markdown is sanitized against the VitePress pipeline it will be
 *     embedded in: HTML comments (the `@include` directive), raw HTML tags,
 *     `<<<` snippet imports, Vue interpolations and `javascript:` URLs are all
 *     neutralized before the text is committed.
 *
 * URLs are stored site-root-relative (no `/alisio-plugins` base); components
 * prefix them with `withBase` at render time.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FORBIDDEN_RULES } from "../leak-check.mjs";

/** Repository root, derived from this file's location (never hardcoded). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** GitHub Pages base path of this site; mirrors `site/.vitepress/config.ts`. */
export const SITE_BASE = "/alisio-plugins/";

/** Committed cache the site reads at build time. Written by `docs:scan`. */
export const CACHE_PATH = join(REPO_ROOT, "site", ".vitepress", "data", "plugins.json");

/** Registry third parties edit to list a plugin by npm package name. */
export const REGISTRY_PATH = join(REPO_ROOT, "registry", "plugins.json");

/** Committed cover files served by the site. */
export const COVERS_DIR = join(REPO_ROOT, "site", "public", "covers");

/** Branded fallback used when a plugin has no cover or its cover fails to load. */
export const DEFAULT_COVER = "/assets/covers/default-cover.svg";

/** Cover extension search order for the `cover.<ext>` convention. */
export const COVER_EXTENSIONS = ["svg", "png", "jpg", "jpeg", "webp"];

/** Read and parse a JSON file, returning `null` instead of throwing. */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The twelve Alisio categories, read from the shared committed list so the
 * scanner and the site UI cannot drift apart.
 */
const CATEGORIES_PATH = join(REPO_ROOT, "site", ".vitepress", "data", "categories.json");
const CATEGORY_NAMES = readJson(CATEGORIES_PATH)?.categories;
if (!Array.isArray(CATEGORY_NAMES) || CATEGORY_NAMES.length === 0)
  throw new Error(`missing category list: ${CATEGORIES_PATH}`);
export const PLUGIN_CATEGORIES = CATEGORY_NAMES;

/** Slug used in URLs. Documented in `registry/README.md`. */
export function slugFor(packageName) {
  let name = String(packageName ?? "").trim();
  if (name.startsWith("@alisio/plugin-")) {
    name = name.slice("@alisio/plugin-".length);
  } else if (name.startsWith("@")) {
    const [scope = "", rest = ""] = name.slice(1).split("/");
    name = rest ? `${scope}-${rest}` : scope;
  }
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalize a `repository` field (string or object) to an https URL or null. */
export function normalizeRepository(value) {
  const raw = typeof value === "string" ? value : value?.url;
  if (!raw || typeof raw !== "string") return null;
  let url = raw.trim().replace(/^git\+/, "");
  const scp = /^git@([^:]+):(.+)$/.exec(url);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  url = url.replace(/^ssh:\/\/git@/, "https://").replace(/^git:\/\//, "https://");
  url = url.replace(/\.git$/, "").replace(/\/$/, "");
  return /^https?:\/\/[^\s]+$/.test(url) ? url : null;
}

/** `{ owner, repo }` when the repository URL is on github.com, else null. */
export function githubRepoParts(repositoryUrl) {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/.exec(repositoryUrl ?? "");
  return match ? { owner: match[1], repo: match[2] } : null;
}

/** The twelve known categories present in `values`, preserving order. */
export function knownCategories(values) {
  if (!Array.isArray(values)) return [];
  return PLUGIN_CATEGORIES.filter((category) => values.includes(category));
}

/** True when a victim path stays inside `root` after resolution. */
export function isInside(root, candidate) {
  const target = resolve(root, candidate);
  const rel = relative(resolve(root), target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve a cover file inside a package directory.
 *
 * Precedence: registry-declared path > `package.json` `alisio.cover` > the
 * `cover.svg|png|jpg|jpeg|webp` convention at the package root. Declared paths
 * must stay inside the package; an escaping or absolute path is ignored.
 */
export function resolveCoverFile(rootDir, { declared, manifest } = {}) {
  const fromManifest = manifest?.alisio?.cover;
  for (const candidate of [declared, fromManifest]) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    if (isAbsolute(candidate)) continue;
    const abs = resolve(rootDir, candidate.trim());
    if (isInside(rootDir, candidate) && existsSync(abs)) return abs;
  }
  for (const extension of COVER_EXTENSIONS) {
    const abs = join(rootDir, `cover.${extension}`);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/**
 * A registry `cover` that starts with `/` points at a file already committed
 * under `site/public`; return the site path when that file exists.
 */
export function siteCoverFromRegistry(declared, publicDir = join(REPO_ROOT, "site", "public")) {
  if (typeof declared !== "string" || !declared.startsWith("/")) return null;
  const rel = declared.replace(/^\/+/, "");
  return isInside(publicDir, rel) && existsSync(join(publicDir, rel)) ? declared : null;
}

/** The site path a cover copy at `slug.<ext>` is served from. */
export function coverSitePath(sourcePath, slug) {
  const extension = extname(sourcePath).slice(1).toLowerCase();
  return COVER_EXTENSIONS.includes(extension) ? `/covers/${slug}.${extension}` : null;
}

/**
 * Copy a cover into `site/public/covers/<slug>.<ext>`, removing any stale copy
 * of the same slug with a different extension. Text covers are neutralized; the
 * binary guard mirrors the leak scanner's own NUL-byte test.
 */
export function publishCover(sourcePath, slug, coversDir = COVERS_DIR) {
  const sitePath = coverSitePath(sourcePath, slug);
  if (!sitePath) return null;
  mkdirSync(coversDir, { recursive: true });
  removeCoversFor(slug, coversDir);
  const target = join(coversDir, `${slug}${extname(sourcePath).toLowerCase()}`);
  const buffer = readFileSync(sourcePath);
  if (buffer.includes(0)) writeFileAtomic(target, buffer);
  else writeFileAtomic(target, neutralizeForPublication(buffer.toString("utf8")));
  return sitePath;
}

/** Delete every `site/public/covers/<slug>.<ext>` copy. */
export function removeCoversFor(slug, coversDir = COVERS_DIR) {
  if (!existsSync(coversDir)) return;
  for (const name of readdirSync(coversDir)) {
    if (COVER_EXTENSIONS.some((extension) => name === `${slug}.${extension}`))
      rmSync(join(coversDir, name), { force: true });
  }
}

/** Delete cover files that no plugin references anymore. */
export function pruneCovers(referencedSitePaths, coversDir = COVERS_DIR) {
  if (!existsSync(coversDir)) return [];
  const keep = new Set(
    [...referencedSitePaths].map((sitePath) => sitePath?.replace("/covers/", "")).filter(Boolean),
  );
  const removed = [];
  for (const name of readdirSync(coversDir)) {
    const extension = name.split(".").pop()?.toLowerCase() ?? "";
    if (!COVER_EXTENSIONS.includes(extension)) continue;
    if (!keep.has(name)) {
      rmSync(join(coversDir, name), { force: true });
      removed.push(name);
    }
  }
  return removed;
}

/** Atomic UTF-8 write: temp file in the same directory, then rename. */
export function writeFileAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, content, typeof content === "string" ? "utf8" : undefined);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * Replace leak-guard shapes with inert placeholders. Generated files are
 * published artifacts, so a third-party README must not be able to leak a
 * machine path or a credential-shaped string through them. Uses the guard's own
 * rules so the two cannot diverge.
 */
export function neutralizeForPublication(text) {
  let value = text;
  for (const rule of FORBIDDEN_RULES)
    value = value.replace(rule.regex, rule.secret ? "<redacted>" : "<path>");
  return value;
}

/** Write a text file with publication neutralization applied. */
export function writeTextFileClean(path, content) {
  writeFileAtomic(path, neutralizeForPublication(content));
}

const FENCE = /^\s*(`{3,}|~{3,})/;

/** Apply `transform` to every line run outside fenced code blocks. */
export function mapOutsideFences(markdown, transform) {
  const lines = markdown.split(/\r\n|\r|\n/);
  const out = [];
  let chunk = [];
  let fence = null;
  const flushText = () => {
    if (chunk.length === 0) return;
    out.push(transform(chunk.join("\n")));
    chunk = [];
  };
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (match) {
      const char = match[1][0];
      if (fence === null) {
        flushText();
        fence = char;
        chunk.push(line);
      } else if (char === fence) {
        chunk.push(line);
        out.push(chunk.join("\n"));
        chunk = [];
        fence = null;
      } else {
        chunk.push(line);
      }
      continue;
    }
    chunk.push(line);
  }
  if (fence === null) flushText();
  else out.push(chunk.join("\n"));
  return out.join("\n");
}

const AUTOLINK = /^<(?:[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>$/;

/**
 * Neutralize the parts of untrusted markdown that the VitePress pipeline would
 * interpret as code or templates:
 *   - HTML comments, which carry the `<!-- @include: path -->` directive.
 *   - raw HTML tags, which Vue compiles (directives, `v-html`, event handlers).
 *   - `<<< path` snippet imports, which read build-machine files.
 *   - `{{ }}` interpolations, which Vue evaluates even inside code fences.
 *   - `javascript:`/`data:` URLs in markdown links.
 * Autolinks (`<https://…>`, `<user@example.com>`) are preserved.
 */
export function sanitizeReadme(markdown) {
  let text = mapOutsideFences(markdown, (segment) =>
    segment
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<\/?[A-Za-z][^>]*>/g, (tag) => (AUTOLINK.test(tag) ? tag : ""))
      .replace(/^( {0,3})<<< ?/gm, "$1\\<<< ")
      .replace(/\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, "](#)"),
  );
  text = text.replace(/\{\{/g, "{\u200b{").replace(/\}\}/g, "}\u200b}");
  return text;
}

/** VitePress/@mdit-vue heading slug; copied so the scanner and check agree. */
export function slugifyHeading(text) {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\p{Cc}]/gu, "")
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'<>,.?/]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase();
}

/** Heading slugs a markdown document will produce, with `-N` deduplication. */
export function headingSlugs(markdown) {
  const slugs = new Set();
  const seen = new Map();
  let fence = null;
  for (const line of markdown.split(/\r\n|\r|\n/)) {
    const marker = FENCE.exec(line);
    if (marker) {
      const char = marker[1][0];
      if (fence === null) fence = char;
      else if (char === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) continue;
    const explicit = /\{#([^}\s]+)\}\s*$/.exec(heading[2]);
    let slug = explicit
      ? explicit[1]
      : slugifyHeading(heading[2].replace(/\{#([^}\s]+)\}\s*$/, ""));
    if (!explicit) {
      const count = seen.get(slug) ?? 0;
      seen.set(slug, count + 1);
      if (count > 0) slug = `${slug}-${count}`;
    }
    slugs.add(slug.toLowerCase());
  }
  return slugs;
}

/** Remove the leading `# Title` line, if present. */
export function stripLeadingHeading(markdown) {
  const lines = markdown.split(/\r\n|\r|\n/);
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  if (index < lines.length && /^#\s+\S/.test(lines[index])) lines.splice(index, 1);
  return lines.join("\n").replace(/^\n+/, "");
}

/** In-page `#anchor` links that no longer resolve are unwrapped to plain text. */
export function pruneReadmeAnchors(markdown) {
  const slugs = headingSlugs(markdown);
  return mapOutsideFences(markdown, (segment) =>
    segment.replace(/(!?)\[([^\]]*)\]\(#([^)\s]+)\)/g, (full, image, label, anchor) => {
      let decoded = anchor;
      try {
        decoded = decodeURIComponent(anchor);
      } catch {
        decoded = anchor;
      }
      if (slugs.has(decoded.trim().toLowerCase())) return full;
      return image ? "" : label;
    }),
  );
}

/**
 * Rewrite relative README links/images so they work when the README is embedded
 * in the site. GitHub `blob` URLs are used for links and `raw` URLs for images;
 * when the repository is unknown the npm package page is used as a fallback.
 * `javascript:`/`data:` targets are already neutralized by `sanitizeReadme`.
 */
export function rewriteReadmeLinks(markdown, { repository, directory = "", npmUrl } = {}) {
  const parts = githubRepoParts(repository);
  const baseDir = String(directory ?? "")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  return mapOutsideFences(markdown, (segment) =>
    segment.replace(/(!?)\[([^\]]*)\]\((<[^>]*>|[^)\s]+)\)/g, (full, bang, label, rawTarget) => {
      let target = rawTarget.replace(/^<|>$/g, "").trim();
      if (target === "" || target.startsWith("#")) return full;
      if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(target) || /^[a-z][a-z0-9+.-]+:/i.test(target))
        return full;
      const isImage = bang === "!";
      target = target.replace(/^\.\//, "");
      const segments = target.split("#")[0].split("/");
      const stack = baseDir ? baseDir.split("/") : [];
      for (const segment of segments) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") stack.pop();
        else stack.push(segment);
      }
      const path = stack.join("/");
      if (!path) return full;
      const anchor = target.includes("#") ? `#${target.slice(target.indexOf("#") + 1)}` : "";
      if (parts) {
        const host = isImage ? "https://raw.githubusercontent.com" : "https://github.com";
        const kind = isImage ? "" : "blob/";
        return `${bang}[${label}](${host}/${parts.owner}/${parts.repo}/${kind}HEAD/${path}${anchor})`;
      }
      return `${bang}[${label}](${npmUrl ?? repository ?? "."}${anchor})`;
    }),
  );
}

/** Full preparation pipeline for a README before it is cached and rendered. */
export function prepareReadme(raw, options = {}) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const sanitized = sanitizeReadme(raw);
  const linked = rewriteReadmeLinks(sanitized, options);
  const body = pruneReadmeAnchors(stripLeadingHeading(linked));
  const trimmed = body.trim();
  return trimmed === "" ? null : trimmed;
}

/** Localized strings used by the generated index pages. */
const INDEX_TEXT = {
  en: {
    title: "Plugin index",
    description: "Every plugin published in this catalog, in A\u2013Z order.",
    heading: "# Plugin index",
    hint: "Install any plugin with `alisio install npm:<package>`. See the [catalog home](/).",
  },
  es: {
    title: "\u00cdndice de plugins",
    description: "Todos los plugins publicados en este cat\u00e1logo, en orden A\u2013Z.",
    heading: "# \u00cdndice de plugins",
    hint: "Instala cualquier plugin con `alisio install npm:<package>`. Consulta la [portada del cat\u00e1logo](/es/).",
  },
};

function frontmatter(fields) {
  return ["---", ...fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`), "---"].join(
    "\n",
  );
}

/** Markdown for a single plugin detail page. */
export function renderDetailPage(entry, locale = "en") {
  const readme = entry.readme ? stripLeadingHeading(entry.readme) : "";
  const fallback =
    locale === "es"
      ? `## README\n\nEste plugin no publica un README. Consulta la [p\u00e1gina del paquete en npm](${entry.npmUrl}).`
      : `## README\n\nThis plugin does not publish a README. See the [npm package](${entry.npmUrl}).`;
  const head = frontmatter([
    ["title", entry.title],
    ["description", entry.description],
    ["pageClass", "plugin-detail"],
  ]);
  return `${head}\n\n<PluginDetail slug="${entry.slug}" />\n\n${readme || fallback}\n`;
}

/** Markdown for the static, no-JS plugin index page. */
export function renderIndexPage(entries, locale = "en") {
  const text = INDEX_TEXT[locale] ?? INDEX_TEXT.en;
  const sorted = [...entries].sort((a, b) => a.title.localeCompare(b.title, locale));
  const items = sorted.map((entry) => {
    const categories = entry.categories.map((category) => `\`${category}\``).join(", ");
    const suffix = categories ? ` (${categories})` : "";
    return `- [${entry.title}](./${entry.slug}) \u2014 ${oneLine(entry.description)}${suffix}`;
  });
  const head = frontmatter([
    ["title", text.title],
    ["description", text.description],
  ]);
  return `${head}\n\n${text.heading}\n\n${text.hint}\n\n${items.join("\n")}\n`;
}

/** Collapse a description to a single safe line for list embedding. */
function oneLine(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

/** Read a local package's README. */
export function readPackageReadme(dir) {
  const path = join(dir, "README.md");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Every publishable package under `packages/`, discovered without registration. */
export function localPackages(root = REPO_ROOT) {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .filter((dir) => existsSync(join(dir, "package.json")))
    .map((dir) => ({ dir, manifest: readJson(join(dir, "package.json")) }))
    .filter(
      ({ manifest }) =>
        manifest &&
        manifest.private !== true &&
        Array.isArray(manifest.keywords) &&
        manifest.keywords.includes("alisio-plugin"),
    );
}

const pluginObjectCache = new Map();

/**
 * Read a LOCAL package's built plugin object from `dist/index.js`. Local code is
 * trusted; third-party code is never imported. Returns `{ plugin, error }` so a
 * broken build degrades to `package.json` without aborting the scan.
 */
export async function readLocalPluginObject(dir) {
  const entry = join(dir, "dist", "index.js");
  if (!existsSync(entry)) return { plugin: null, error: "dist/index.js is not built" };
  if (pluginObjectCache.has(entry)) return pluginObjectCache.get(entry);
  let result = { plugin: null, error: null };
  try {
    const module = await import(pathToFileURL(entry).href);
    const candidate =
      module.default ??
      Object.values(module).find(
        (value) => value && typeof value === "object" && typeof value.id === "string",
      );
    if (candidate && typeof candidate === "object" && typeof candidate.id === "string")
      result = { plugin: candidate, error: null };
    else result = { plugin: null, error: "dist/index.js has no plugin default export" };
  } catch (error) {
    result = { plugin: null, error: error instanceof Error ? error.message : String(error) };
  }
  pluginObjectCache.set(entry, result);
  return result;
}

/** Format an npm `author`/`maintainers` value as a display string. */
export function formatPerson(value) {
  if (!value) return null;
  if (typeof value === "string") return value.trim() || null;
  const name = String(value.name ?? "").trim();
  return name || null;
}

/** Keep the first author/maintainer display name. */
export function firstPerson(...values) {
  for (const value of values) {
    const formatted = formatPerson(value);
    if (formatted) return formatted;
  }
  return null;
}

/** Count keys of a dependency map. */
export function countDependencies(value) {
  return value && typeof value === "object" ? Object.keys(value).length : 0;
}
