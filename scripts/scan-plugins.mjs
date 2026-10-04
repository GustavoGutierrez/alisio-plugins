#!/usr/bin/env node
/**
 * Build the plugin catalog: read every local package plus the third-party
 * registry, gather the minimum display information, and write the committed
 * cache and the generated site pages.
 *
 * USAGE
 *   node scripts/scan-plugins.mjs              refresh stale entries (network)
 *   node scripts/scan-plugins.mjs --offline    never touch the network
 *   node scripts/scan-plugins.mjs --force      refetch every entry (network)
 *   node scripts/scan-plugins.mjs --strict     exit 1 when any entry failed
 *
 * WHY A COMMITTED CACHE. `pnpm docs:build` must work with the network down, so
 * this is the only command that talks to the registry. Everything it learns is
 * written to `site/.vitepress/data/plugins.json`, and the site reads that file
 * at build time.
 *
 * RESILIENCE. One broken package never aborts the scan. Local packages fall
 * back to `package.json` when `dist/index.js` is not built; third-party entries
 * fall back to their cached record; cover extraction and download stats are
 * optional and degrade to the default cover and `null`. Every failure is
 * printed with its cause, and `--strict` turns any failure into a non-zero exit.
 *
 * SAFETY. Third-party code is never imported or executed: only the npm
 * packument (data) and the published tarball's files are read. Tarball entries
 * are checked for absolute paths and `..` traversal before extraction, and
 * every generated file is neutralized against the leak guard's rules.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  countDependencies,
  DEFAULT_COVER,
  firstPerson,
  knownCategories,
  localPackages,
  normalizeRepository,
  prepareReadme,
  pruneCovers,
  publishCover,
  REPO_ROOT,
  readJson,
  readLocalPluginObject,
  readPackageReadme,
  renderDetailPage,
  renderIndexPage,
  resolveCoverFile,
  siteCoverFromRegistry,
  slugFor,
  writeTextFileClean,
} from "./lib/plugins.mjs";

/** How long a third-party cache record stays fresh before a refresh. */
const TTL_MS = 6 * 60 * 60 * 1000;
const USER_AGENT = "alisio-plugins-catalog-scan";
const README_LIMIT = 80_000;

/**
 * Where the scan reads and writes. Defaults to this repository; the env seams
 * exist so the integration test can drive the whole pipeline (including the
 * third-party tarball download) against a throwaway copy.
 */
const SCAN_ROOT = process.env.ALISIO_PLUGIN_SCAN_ROOT
  ? resolve(process.env.ALISIO_PLUGIN_SCAN_ROOT)
  : REPO_ROOT;
const SITE_ROOT = join(SCAN_ROOT, "site");
const PATHS = {
  scanRoot: SCAN_ROOT,
  registry: process.env.ALISIO_PLUGIN_REGISTRY ?? join(SCAN_ROOT, "registry", "plugins.json"),
  cache: process.env.ALISIO_PLUGIN_CACHE ?? join(SITE_ROOT, ".vitepress", "data", "plugins.json"),
  pages: join(SITE_ROOT, "plugins"),
  pagesEs: join(SITE_ROOT, "es", "plugins"),
  covers: process.env.ALISIO_PLUGIN_COVERS ?? join(SITE_ROOT, "public", "covers"),
  public: join(SITE_ROOT, "public"),
  npmRegistry: (process.env.ALISIO_NPM_REGISTRY ?? "https://registry.npmjs.org").replace(
    /\/+$/,
    "",
  ),
  npmDownloads: (process.env.ALISIO_NPM_DOWNLOADS ?? "https://api.npmjs.org/downloads").replace(
    /\/+$/,
    "",
  ),
};

const failures = [];
const notes = [];

/** Record a recoverable failure for one entry. */
function fail(label, message) {
  failures.push(`${label}: ${message}`);
}

/** Record an informational degradation. */
function note(label, message) {
  notes.push(`${label}: ${message}`);
}

function parseArgs(argv) {
  const options = { offline: false, force: false, strict: false, help: false };
  for (const argument of argv) {
    if (argument === "--offline") options.offline = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function npmUrlFor(name) {
  return `https://www.npmjs.com/package/${name}`;
}

function packumentUrl(name) {
  const encoded = name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1))}`
    : encodeURIComponent(name);
  return `${PATHS.npmRegistry}/${encoded}`;
}

/** Fetch and parse JSON with a hard timeout. */
async function fetchJson(url, timeoutMs = 15_000) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

/** Download a tarball to disk, bounded in size. */
async function downloadTarball(url, destination, maximum = 25 * 1024 * 1024) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maximum) throw new Error(`tarball is larger than ${maximum} bytes`);
  writeFileSync(destination, buffer);
}

/** Reject absolute paths and `..` traversal before extracting a tarball. */
export function assertSafeTarball(archive) {
  const listing = execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const name of listing.split("\n")) {
    if (!name) continue;
    const normalized = name.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.split("/").includes(".."))
      throw new Error(`unsafe tarball entry: ${normalized}`);
  }
}

export function extractTarball(archive, destination) {
  assertSafeTarball(archive);
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", destination], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** Best-effort monthly download count; never required. */
async function fetchDownloads(name) {
  try {
    const data = await fetchJson(`${PATHS.npmDownloads}/point/last-month/${name}`, 10_000);
    return Number.isFinite(data?.downloads) ? data.downloads : null;
  } catch {
    return null;
  }
}

/** Reduce a packument to the display fields the catalog needs. */
export function packumentFields(packument, registryEntry) {
  const latest = packument?.["dist-tags"]?.latest ?? null;
  const versionData = latest ? packument?.versions?.[latest] : null;
  const time = packument?.time ?? {};
  return {
    version: latest,
    description: String(versionData?.description ?? packument?.description ?? "").trim(),
    license:
      typeof versionData?.license === "string"
        ? versionData.license
        : typeof packument?.license === "string"
          ? packument.license
          : null,
    author: firstPerson(versionData?.author, packument?.author),
    maintainers: (packument?.maintainers ?? [])
      .map((person) => firstPerson(person))
      .filter((person) => typeof person === "string"),
    repository:
      normalizeRepository(versionData?.repository) ??
      normalizeRepository(packument?.repository) ??
      registryEntry?.repository ??
      null,
    homepage:
      (typeof versionData?.homepage === "string" ? versionData.homepage : null) ??
      (typeof packument?.homepage === "string" ? packument.homepage : null) ??
      registryEntry?.homepage ??
      null,
    bugs: typeof versionData?.bugs?.url === "string" ? versionData.bugs.url : null,
    keywords: Array.isArray(packument?.keywords) ? packument.keywords : [],
    publishedAt: typeof time[latest] === "string" ? time[latest] : null,
    firstPublishedAt: typeof time.created === "string" ? time.created : null,
    unpackedSize: Number.isFinite(versionData?.dist?.unpackedSize)
      ? versionData.dist.unpackedSize
      : null,
    dependencyCount: countDependencies(versionData?.dependencies),
    peerCount: countDependencies(versionData?.peerDependencies),
    directory: versionData?.repository?.directory ?? packument?.repository?.directory ?? "",
    tarball: typeof versionData?.dist?.tarball === "string" ? versionData.dist.tarball : null,
    readme: typeof packument?.readme === "string" ? packument.readme : null,
  };
}

/** Project a cached record, applying registry overrides. */
export function fromCache(cached, registryEntry) {
  return {
    ...cached,
    title: registryEntry?.title?.trim() || cached.title,
    npmUrl: registryEntry?.npmUrl || cached.npmUrl,
    repository: registryEntry?.repository || cached.repository,
    homepage: registryEntry?.homepage || cached.homepage,
    categories: registryEntry?.categories
      ? knownCategories(registryEntry.categories)
      : cached.categories,
    featured: registryEntry?.featured ?? cached.featured ?? false,
    cover: cached.cover ?? null,
    readme: cached.readme ?? null,
  };
}

/** `{ readmeEs }` when the package ships a README.es.md, otherwise nothing. */
function optionalSpanishReadme(dir, options) {
  const readmeEs = prepareReadme(readPackageReadme(dir, "README.es.md"), options);
  return readmeEs ? { readmeEs } : {};
}

/** Build the entry for one local package. Only optional npm metadata needs the network. */
async function localEntry(dir, manifest, previousByName, registryEntry, options) {
  const name = manifest.name;
  const slug = slugFor(name);
  const { plugin, error } = await readLocalPluginObject(dir);
  if (error) note(name, `${error}; using package.json metadata`);
  const directory = relative(PATHS.scanRoot, dir).split(sep).join("/");
  const repository = normalizeRepository(manifest.repository) ?? null;
  const npmUrl = npmUrlFor(name);
  const previous = previousByName.get(name);
  const sameVersion = previous?.version === manifest.version;
  let publishedAt = sameVersion ? (previous?.publishedAt ?? null) : null;
  let firstPublishedAt = sameVersion ? (previous?.firstPublishedAt ?? null) : null;
  let unpackedSize = sameVersion ? (previous?.unpackedSize ?? null) : null;
  let downloadsLastMonth = sameVersion ? (previous?.downloadsLastMonth ?? null) : null;

  let cover = siteCoverFromRegistry(registryEntry?.cover, PATHS.public);
  if (!cover) {
    const file = resolveCoverFile(dir, { declared: registryEntry?.cover, manifest });
    if (file) cover = publishCover(file, slug, PATHS.covers);
  }
  if (!cover) note(name, "no cover found; using the default cover");

  // Local metadata is authoritative; npm only adds publish recency and size.
  if (!options.offline && publishedAt === null) {
    try {
      const packument = await fetchJson(packumentUrl(name));
      const time = packument?.time ?? {};
      publishedAt = time[manifest.version] ?? time[packument?.["dist-tags"]?.latest] ?? null;
      firstPublishedAt = typeof time.created === "string" ? time.created : null;
      unpackedSize = Number.isFinite(packument?.versions?.[manifest.version]?.dist?.unpackedSize)
        ? packument.versions[manifest.version].dist.unpackedSize
        : null;
      downloadsLastMonth = await fetchDownloads(name);
    } catch (fetchError) {
      note(name, `npm metadata unavailable (${messageOf(fetchError)})`);
    }
  }

  return {
    name,
    slug,
    title: registryEntry?.title?.trim() || String(plugin?.name ?? name).trim(),
    pluginId: plugin?.id ?? null,
    description: String(plugin?.description ?? manifest.description ?? "").trim(),
    version: manifest.version,
    publishedAt,
    firstPublishedAt,
    author: firstPerson(manifest.author) ?? "Alisio",
    maintainers: [],
    license: typeof manifest.license === "string" ? manifest.license : null,
    repository,
    homepage: typeof manifest.homepage === "string" ? manifest.homepage : null,
    bugs: typeof manifest.bugs?.url === "string" ? manifest.bugs.url : null,
    npmUrl,
    categories: knownCategories(plugin?.categories),
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
    unpackedSize,
    dependencyCount: countDependencies(manifest.dependencies),
    peerCount: countDependencies(manifest.peerDependencies),
    installName: name,
    cover,
    readme: prepareReadme(readPackageReadme(dir), { repository, directory, npmUrl }),
    ...optionalSpanishReadme(dir, { repository, directory, npmUrl }),
    downloadsLastMonth,
    featured: registryEntry?.featured ?? false,
    source: "local",
  };
}

/** Build the entry for one third-party registry package. */
async function thirdPartyEntry(registryEntry, previousByName, options) {
  const name = registryEntry.package;
  const slug = slugFor(name);
  const cached = previousByName.get(name);
  const fresh =
    cached &&
    !options.force &&
    Number.isFinite(Date.parse(cached.fetchedAt ?? "")) &&
    Date.now() - Date.parse(cached.fetchedAt) < TTL_MS;

  if (options.offline || fresh) {
    if (!cached) {
      fail(name, "not in the cache and the scan is offline; run `pnpm docs:scan` online");
      return null;
    }
    return fromCache(cached, registryEntry);
  }

  let packument;
  try {
    packument = await fetchJson(packumentUrl(name));
  } catch (error) {
    if (cached) {
      fail(name, `registry fetch failed (${messageOf(error)}); using the cached record`);
      return fromCache(cached, registryEntry);
    }
    fail(name, `registry fetch failed: ${messageOf(error)}`);
    return null;
  }

  const fields = packumentFields(packument, registryEntry);
  if (!fields.version) {
    fail(name, "the packument has no published version");
    return null;
  }

  const repository = fields.repository ?? registryEntry?.repository ?? null;
  let cover = siteCoverFromRegistry(registryEntry?.cover, PATHS.public) ?? cached?.cover ?? null;
  if (!cover && fields.tarball) {
    try {
      cover = await coverFromTarball(fields.tarball, registryEntry, slug);
      if (!cover) note(name, "no cover in the published tarball; using the default cover");
    } catch (error) {
      note(name, `cover extraction failed (${messageOf(error)}); using the default cover`);
    }
  }
  if (!cover) note(name, "no cover declared or detected; using the default cover");

  const readme = prepareReadme(fields.readme, {
    repository,
    directory: fields.directory,
    npmUrl: registryEntry?.npmUrl ?? npmUrlFor(name),
  });
  if (readme && readme.length > README_LIMIT)
    note(name, `README truncated to ${README_LIMIT} characters`);

  return {
    name,
    slug,
    title: registryEntry?.title?.trim() || name,
    pluginId: null,
    description: fields.description || `${name} plugin`,
    version: fields.version,
    publishedAt: fields.publishedAt,
    firstPublishedAt: fields.firstPublishedAt,
    author: fields.author ?? fields.maintainers[0] ?? "Unknown",
    maintainers: fields.maintainers,
    license: fields.license,
    repository,
    homepage: fields.homepage,
    bugs: fields.bugs,
    npmUrl: registryEntry?.npmUrl ?? npmUrlFor(name),
    categories: registryEntry?.categories
      ? knownCategories(registryEntry.categories)
      : knownCategories(fields.keywords),
    keywords: fields.keywords,
    unpackedSize: fields.unpackedSize,
    dependencyCount: fields.dependencyCount,
    peerCount: fields.peerCount,
    installName: name,
    cover,
    readme: readme ? readme.slice(0, README_LIMIT) : null,
    downloadsLastMonth: await fetchDownloads(name),
    featured: registryEntry?.featured ?? false,
    source: "third-party",
    fetchedAt: new Date().toISOString(),
  };
}

/** Download a tarball and extract its cover by the documented precedence. */
async function coverFromTarball(tarballUrl, registryEntry, slug) {
  const temp = mkdtempSync(join(tmpdir(), "alisio-plugin-cover-"));
  try {
    const archive = join(temp, "package.tgz");
    await downloadTarball(tarballUrl, archive);
    const unpacked = join(temp, "unpacked");
    extractTarball(archive, unpacked);
    const packageDir = join(unpacked, "package");
    const manifest = readJson(join(packageDir, "package.json")) ?? {};
    const file = resolveCoverFile(packageDir, { declared: registryEntry?.cover, manifest });
    return file ? publishCover(file, slug, PATHS.covers) : null;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Write the generated pages and delete stale ones. */
function writePages(entries) {
  const expected = new Set(entries.map((entry) => `${entry.slug}.md`));
  expected.add("index.md");
  const body = renderIndexPage(entries, "en");
  const bodyEs = renderIndexPage(entries, "es");
  for (const entry of entries) {
    writeTextFileClean(join(PATHS.pages, `${entry.slug}.md`), renderDetailPage(entry, "en"));
    writeTextFileClean(join(PATHS.pagesEs, `${entry.slug}.md`), renderDetailPage(entry, "es"));
  }
  writeTextFileClean(join(PATHS.pages, "index.md"), body);
  writeTextFileClean(join(PATHS.pagesEs, "index.md"), bodyEs);
  for (const dir of [PATHS.pages, PATHS.pagesEs]) {
    if (!existsDirectory(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md") || expected.has(file)) continue;
      rmSync(join(dir, file), { force: true });
    }
  }
}

function existsDirectory(path) {
  try {
    return readdirSync(path) !== null;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      [
        "Usage: node scripts/scan-plugins.mjs [--offline] [--force] [--strict]",
        "",
        "  --offline  never touch the network; keep third-party records from the cache",
        "  --force    refetch every entry, ignoring the freshness window",
        "  --strict   exit 1 when any entry failed",
      ].join("\n"),
    );
    return 0;
  }

  const registry = readJson(PATHS.registry) ?? { schemaVersion: 1, plugins: [] };
  const previous = readJson(PATHS.cache) ?? { schemaVersion: 1, plugins: [] };
  const previousByName = new Map((previous.plugins ?? []).map((entry) => [entry.name, entry]));
  const registryEntries = Array.isArray(registry.plugins) ? registry.plugins : [];
  const registryByPackage = new Map(
    registryEntries.filter((entry) => entry?.package).map((entry) => [entry.package, entry]),
  );

  const entries = [];
  const localManifests = localPackages(PATHS.scanRoot);
  const localNames = new Set(localManifests.map(({ manifest }) => manifest.name));

  // Local packages are automatic, but a registry entry may still override them.
  for (const { dir, manifest } of localManifests) {
    try {
      entries.push(
        await localEntry(
          dir,
          manifest,
          previousByName,
          registryByPackage.get(manifest.name),
          options,
        ),
      );
    } catch (error) {
      fail(manifest.name, `local scan failed: ${messageOf(error)}`);
    }
  }

  // Third-party packages are opt-in through the registry.
  for (const registryEntry of registryEntries) {
    if (!registryEntry?.package) {
      fail("<registry>", "an entry is missing its `package` field");
      continue;
    }
    if (localNames.has(registryEntry.package)) continue;
    try {
      const entry = await thirdPartyEntry(registryEntry, previousByName, options);
      if (entry) entries.push(entry);
    } catch (error) {
      fail(registryEntry.package, `scan failed: ${messageOf(error)}`);
    }
  }

  if (entries.length === 0) {
    fail("<catalog>", "no plugins were discovered; the catalog would be empty");
  }

  entries.sort((a, b) => a.slug.localeCompare(b.slug));
  const seenSlugs = new Set();
  for (const entry of entries) {
    if (seenSlugs.has(entry.slug)) {
      fail(entry.name, `slug collision on "${entry.slug}"; rename one package`);
    }
    seenSlugs.add(entry.slug);
    entry.cover = entry.cover ?? DEFAULT_COVER;
  }

  const cache = {
    schemaVersion: 1,
    plugins: entries.map((entry) => ({ ...entry, cover: entry.cover ?? DEFAULT_COVER })),
  };
  writeTextFileClean(PATHS.cache, `${JSON.stringify(cache, null, 2)}\n`);
  mkdirSync(PATHS.covers, { recursive: true });
  const removed = pruneCovers(
    entries.map((entry) => entry.cover),
    PATHS.covers,
  );
  if (removed.length > 0) note("<covers>", `removed unreferenced cover(s): ${removed.join(", ")}`);
  writePages(cache.plugins);

  const localCount = entries.filter((entry) => entry.source === "local").length;
  const thirdCount = entries.length - localCount;
  console.log(
    `docs:scan: ${entries.length} plugin(s) (${localCount} local, ${thirdCount} third-party)` +
      `${options.offline ? " [offline]" : ""}`,
  );
  for (const entry of entries)
    console.log(`  ${entry.slug.padEnd(22)} ${entry.version ?? "?".padEnd(10)} ${entry.name}`);
  for (const line of notes) console.warn(`WARN ${line}`);
  for (const line of failures) console.error(`FAIL ${line}`);

  if (failures.length > 0) {
    console.error(`docs:scan: ${failures.length} failure(s).`);
    return options.strict ? 1 : 0;
  }
  console.log("docs:scan: OK");
  return 0;
}

mainOnlyIfInvoked();

function mainOnlyIfInvoked() {
  const invoked = process.argv[1] ?? "";
  if (!invoked || import.meta.url !== pathToFileURL(invoked).href) return;
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exit(1);
    },
  );
}
