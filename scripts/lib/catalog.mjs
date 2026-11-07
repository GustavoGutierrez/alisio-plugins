/**
 * Public, machine-readable plugin catalog (`<site>/catalog.json`).
 *
 * The Alisio desktop app fetches this file to list, search, filter and install
 * plugins without the CLI. It is a lean projection of the committed cache
 * (`site/.vitepress/data/plugins.json`): heavy fields such as READMEs are left
 * out, site paths become absolute URLs, and malformed entries are skipped
 * instead of failing the build.
 *
 * The output is deterministic: `generatedAt` is the newest `publishedAt` in the
 * cache, never the wall clock, so an unchanged cache yields identical bytes.
 *
 * This module only depends on Node built-ins so the VitePress config can import
 * it without pulling in the scanner.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CATALOG_SCHEMA_VERSION = 1;

/**
 * The public site root. This is the ONLY place it is defined: the VitePress
 * sitemap and `catalog.json` both read it through `resolveSiteUrl`. Override it
 * with the `ALISIO_SITE_URL` environment variable when the domain changes.
 */
export const DEFAULT_SITE_URL = "https://gustavogutierrez.github.io/alisio-plugins/";

/**
 * Resolve the site root from an override (normally `process.env.ALISIO_SITE_URL`),
 * falling back to `DEFAULT_SITE_URL`. The value must be an absolute https URL
 * without query or fragment; it is normalized to exactly one trailing slash.
 * Throws so a misconfigured build fails loudly.
 */
export function resolveSiteUrl(override) {
  const raw = typeof override === "string" ? override.trim() : "";
  if (raw === "") return DEFAULT_SITE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (url?.protocol !== "https:" || /[?#]/.test(raw))
    throw new Error(
      `ALISIO_SITE_URL must be an absolute https URL without query or fragment, got "${raw}"`,
    );
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A site-root path: one leading slash, plain segments, no traversal or query. */
const SITE_PATH = /^\/(?!\/)[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const RESERVED_TAG = "alisio-plugin";

function stringOrNull(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function httpUrlOrNull(value) {
  const text = stringOrNull(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? text : null;
  } catch {
    return null;
  }
}

function isoDateOrNull(value) {
  const text = stringOrNull(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

/** Validate an absolute http(s) site URL and make sure it ends with `/`. */
function normalizeSiteUrl(siteUrl) {
  let url;
  try {
    url = new URL(String(siteUrl ?? ""));
  } catch {
    throw new Error(`buildCatalog: siteUrl must be an absolute http(s) URL, got "${siteUrl}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`buildCatalog: siteUrl must be an absolute http(s) URL, got "${siteUrl}"`);
  url.search = "";
  url.hash = "";
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.href;
}

/**
 * Turn a site-root path such as `/covers/x.svg` into an absolute URL under
 * `siteUrl`. Anything that is not a plain site path (protocol-relative, a full
 * URL, traversal, backslashes, query strings) returns `null`.
 */
export function absoluteSiteUrl(sitePath, siteUrl) {
  if (typeof sitePath !== "string" || !SITE_PATH.test(sitePath)) return null;
  if (sitePath.split("/").some((segment) => segment === "." || segment === "..")) return null;
  const base = normalizeSiteUrl(siteUrl);
  const href = new URL(sitePath.slice(1), base).href;
  return href.startsWith(base) ? href : null;
}

function projectEntry(entry, siteUrl, known) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const slug = typeof entry.slug === "string" ? entry.slug : "";
  const packageName = stringOrNull(entry.installName);
  const version = stringOrNull(entry.version);
  if (!SLUG.test(slug) || !packageName || !version) return null;

  const categories = Array.isArray(entry.categories)
    ? known.filter((category) => entry.categories.includes(category))
    : [];
  const excluded = new Set([RESERVED_TAG, ...known]);
  const tags = [];
  if (Array.isArray(entry.keywords)) {
    for (const keyword of entry.keywords) {
      const tag = stringOrNull(keyword);
      if (!tag || excluded.has(tag) || tags.includes(tag)) continue;
      tags.push(tag);
    }
  }

  return {
    id: stringOrNull(entry.pluginId),
    slug,
    name: stringOrNull(entry.title) ?? stringOrNull(entry.name) ?? packageName,
    package: packageName,
    version,
    description: typeof entry.description === "string" ? entry.description.trim() : "",
    categories,
    tags,
    cover: absoluteSiteUrl(entry.cover, siteUrl),
    icon: absoluteSiteUrl(entry.icon, siteUrl),
    sdk: stringOrNull(entry.sdk),
    author: stringOrNull(entry.author),
    license: stringOrNull(entry.license),
    homepage: httpUrlOrNull(entry.homepage),
    npmUrl: httpUrlOrNull(entry.npmUrl),
    repository: httpUrlOrNull(entry.repository),
    publishedAt: isoDateOrNull(entry.publishedAt),
    featured: entry.featured === true,
    source: stringOrNull(entry.source),
  };
}

/**
 * Build the public catalog object from the committed cache.
 *
 * @param {unknown} cache Parsed `plugins.json` (`{ schemaVersion, plugins }`).
 * @param {{ siteUrl: string, categories?: string[] }} options `siteUrl` is the
 *   absolute site root (for example `https://host/alisio-plugins/`);
 *   `categories` is the known category list in display order.
 */
export function buildCatalog(cache, { siteUrl, categories = [] } = {}) {
  const site = normalizeSiteUrl(siteUrl);
  const known = Array.isArray(categories)
    ? categories.filter((category) => typeof category === "string")
    : [];
  const source = Array.isArray(cache?.plugins) ? cache.plugins : [];

  const plugins = [];
  const seen = new Set();
  for (const entry of source) {
    const plugin = projectEntry(entry, site, known);
    if (!plugin || seen.has(plugin.slug)) continue;
    seen.add(plugin.slug);
    plugins.push(plugin);
  }
  plugins.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const counts = known
    .map((id) => ({
      id,
      count: plugins.filter((plugin) => plugin.categories.includes(id)).length,
    }))
    .filter((category) => category.count > 0);

  let generatedAt = null;
  for (const plugin of plugins) {
    if (
      plugin.publishedAt &&
      (!generatedAt || Date.parse(plugin.publishedAt) > Date.parse(generatedAt))
    )
      generatedAt = plugin.publishedAt;
  }

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt,
    site,
    categories: counts,
    plugins,
  };
}

/** Write the catalog as minified JSON: temp file in the same directory, then rename. */
export function writeCatalog(path, catalog) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, JSON.stringify(catalog), "utf8");
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
