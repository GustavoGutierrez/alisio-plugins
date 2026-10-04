#!/usr/bin/env node
/**
 * Offline gate for the documentation site. `pnpm docs:build` runs the site, so
 * this command must never touch the network: it re-derives everything from the
 * working tree and the committed cache.
 *
 * WHAT IT PROVES
 *   1. Cache integrity — every entry is well formed, its slug matches its
 *      package name, and its categories are known.
 *   2. Local sync — every `packages/*` package has a cache entry whose version,
 *      metadata, cover and README match the working tree.
 *   3. Registry coverage — every third-party registry entry has a cache entry,
 *      and no cache entry is unattributed.
 *   4. Page sync — the generated detail and index pages match what the cache
 *      would render, and no stale page lingers.
 *   5. Covers — every referenced cover exists and no orphan cover is committed.
 *   6. Links — every internal link and `#anchor` in `site/**` resolves to a
 *      page, an asset, or a heading that exists.
 *
 * Exit codes: 0 clean, 1 problems (each printed with file and line where known).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  CACHE_PATH,
  COVERS_DIR,
  countDependencies,
  coverSitePath,
  DEFAULT_COVER,
  firstPerson,
  knownCategories,
  localPackages,
  neutralizeForPublication,
  normalizeRepository,
  PLUGIN_CATEGORIES,
  prepareReadme,
  REGISTRY_PATH,
  REPO_ROOT,
  readJson,
  readLocalPluginObject,
  readPackageReadme,
  renderDetailPage,
  renderIndexPage,
  resolveCoverFile,
  SITE_BASE,
  siteCoverFromRegistry,
  slugFor,
} from "./lib/plugins.mjs";

const SITE_DIR = join(REPO_ROOT, "site");
const PAGES_DIR = join(SITE_DIR, "plugins");
const PAGES_ES_DIR = join(SITE_DIR, "es", "plugins");
/** Mirrors `srcExclude` in site/.vitepress/config.ts; keep both lists in sync. */
const SITE_EXCLUDE = new Set(["README.md", "README.es.md"]);

const problems = [];

function problem(file, line, message) {
  problems.push({ file, line, message });
}

function hash(value) {
  return value === null ? null : createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// 1. Cache integrity
// ---------------------------------------------------------------------------

function metadataHash(value) {
  return hash(JSON.stringify(value));
}

function checkIntegrity(entries) {
  for (const entry of entries) {
    const label = entry?.name ?? "<unknown>";
    if (!entry || typeof entry !== "object") {
      problem(CACHE_PATH, 0, "cache contains a non-object entry");
      continue;
    }
    if (slugFor(entry.name) !== entry.slug)
      problem(CACHE_PATH, 0, `${label}: slug "${entry.slug}" does not match the package name`);
    if (!entry.description) problem(CACHE_PATH, 0, `${label}: missing description`);
    if (!entry.version) problem(CACHE_PATH, 0, `${label}: missing version`);
    if (!["local", "third-party"].includes(entry.source))
      problem(CACHE_PATH, 0, `${label}: unknown source "${entry.source}"`);
    const unknown = (entry.categories ?? []).filter(
      (category) => !PLUGIN_CATEGORIES.includes(category),
    );
    if (unknown.length > 0)
      problem(CACHE_PATH, 0, `${label}: unknown category/categories ${unknown.join(", ")}`);
    if (!entry.cover) problem(CACHE_PATH, 0, `${label}: missing cover path`);
  }
}

// ---------------------------------------------------------------------------
// 2. Local packages in sync with the cache
// ---------------------------------------------------------------------------

/** The fields derivable from the working tree alone, with no network. */
async function snapshot(dir, manifest) {
  const { plugin, error } = await readLocalPluginObject(dir);
  return {
    error,
    title: String(plugin?.name ?? manifest.name).trim(),
    description: String(plugin?.description ?? manifest.description ?? "").trim(),
    version: manifest.version,
    categories: knownCategories(plugin?.categories),
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
    license: typeof manifest.license === "string" ? manifest.license : null,
    repository: normalizeRepository(manifest.repository),
    homepage: typeof manifest.homepage === "string" ? manifest.homepage : null,
    bugs: typeof manifest.bugs?.url === "string" ? manifest.bugs.url : null,
    author: firstPerson(manifest.author) ?? "Alisio",
    dependencyCount: countDependencies(manifest.dependencies),
    peerCount: countDependencies(manifest.peerDependencies),
    installName: manifest.name,
    slug: slugFor(manifest.name),
  };
}

async function checkLocalSync(entries, registryByPackage) {
  for (const { dir, manifest } of localPackages()) {
    const name = manifest.name;
    const cached = entries.find((entry) => entry.name === name);
    if (!cached) {
      problem(CACHE_PATH, 0, `${name}: missing from the cache; run \`pnpm docs:scan\``);
      continue;
    }
    const registryEntry = registryByPackage.get(name);
    const expected = await snapshot(dir, manifest);
    if (expected.error && !existsSync(join(dir, "dist", "index.js")))
      problem(
        join(dir, "dist", "index.js"),
        0,
        `${name}: not built (${expected.error}); run \`pnpm build\` before \`pnpm docs:scan\``,
      );

    const compare = [
      ["title", registryEntry?.title?.trim() || expected.title, cached.title],
      ["description", expected.description, cached.description],
      ["version", expected.version, cached.version],
      [
        "categories",
        registryEntry?.categories ? knownCategories(registryEntry.categories) : expected.categories,
        cached.categories,
      ],
      ["keywords", expected.keywords, cached.keywords],
      ["license", expected.license, cached.license],
      ["repository", registryEntry?.repository || expected.repository, cached.repository],
      ["homepage", registryEntry?.homepage || expected.homepage, cached.homepage],
      ["bugs", expected.bugs, cached.bugs],
      ["author", expected.author, cached.author],
      ["dependencyCount", expected.dependencyCount, cached.dependencyCount],
      ["peerCount", expected.peerCount, cached.peerCount],
      ["installName", expected.installName, cached.installName],
      ["slug", expected.slug, cached.slug],
      ["featured", registryEntry?.featured ?? false, cached.featured],
    ];
    for (const [field, want, got] of compare) {
      if (metadataHash(want) !== metadataHash(got))
        problem(
          CACHE_PATH,
          0,
          `${name}: cache "${field}" is stale (cache=${JSON.stringify(got)} local=${JSON.stringify(want)}); run \`pnpm docs:scan\``,
        );
    }

    const fromSite = siteCoverFromRegistry(registryEntry?.cover);
    const fromFile = fromSite
      ? null
      : resolveCoverFile(dir, { declared: registryEntry?.cover, manifest });
    const expectedCover = fromSite ?? (fromFile ? coverSitePath(fromFile, expected.slug) : null);
    const wantCover = expectedCover ?? DEFAULT_COVER;
    if (cached.cover !== wantCover)
      problem(
        CACHE_PATH,
        0,
        `${name}: cache cover "${cached.cover}" does not match "${wantCover}"; run \`pnpm docs:scan\``,
      );

    const directory = relative(REPO_ROOT, dir).split(/[\\/]/).join("/");
    const expectedReadme = prepareReadme(readPackageReadme(dir), {
      repository: expected.repository,
      directory,
      npmUrl: `https://www.npmjs.com/package/${name}`,
    });
    if (hash(expectedReadme) !== hash(cached.readme ?? null))
      problem(CACHE_PATH, 0, `${name}: cached README is stale; run \`pnpm docs:scan\``);
    const expectedReadmeEs = prepareReadme(readPackageReadme(dir, "README.es.md"), {
      repository: expected.repository,
      directory,
      npmUrl: `https://www.npmjs.com/package/${name}`,
    });
    if (hash(expectedReadmeEs) !== hash(cached.readmeEs ?? null))
      problem(CACHE_PATH, 0, `${name}: cached Spanish README is stale; run \`pnpm docs:scan\``);
  }
}

// ---------------------------------------------------------------------------
// 3. Registry coverage
// ---------------------------------------------------------------------------

function checkRegistry(entries, registryEntries) {
  const localNames = new Set(localPackages().map(({ manifest }) => manifest.name));
  for (const registryEntry of registryEntries) {
    if (!registryEntry?.package) {
      problem(REGISTRY_PATH, 0, "an entry is missing its `package` field");
      continue;
    }
    const cached = entries.find((entry) => entry.name === registryEntry.package);
    if (!cached) {
      problem(
        REGISTRY_PATH,
        0,
        `${registryEntry.package}: registered but missing from the cache; run \`pnpm docs:scan\` online`,
      );
      continue;
    }
    if (!localNames.has(registryEntry.package) && cached.source !== "third-party")
      problem(REGISTRY_PATH, 0, `${registryEntry.package}: expected a third-party cache entry`);
  }
  for (const entry of entries) {
    if (entry.source === "third-party" && !registryEntries.some((r) => r?.package === entry.name))
      problem(
        CACHE_PATH,
        0,
        `${entry.name}: cached third-party entry is not registered anymore; run \`pnpm docs:scan\``,
      );
  }
}

// ---------------------------------------------------------------------------
// 4. Generated pages in sync
// ---------------------------------------------------------------------------

function comparePage(path, expected, label) {
  if (!existsSync(path)) {
    problem(path, 0, `${label}: page is missing; run \`pnpm docs:scan\``);
    return;
  }
  const actual = readFileSync(path, "utf8");
  if (actual !== expected) problem(path, 0, `${label}: page is stale; run \`pnpm docs:scan\``);
}

function listMarkdown(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith(".md"));
}

function checkPages(entries) {
  const expectedEn = new Set(["index.md"]);
  const expectedEs = new Set(["index.md"]);
  for (const entry of entries) {
    expectedEn.add(`${entry.slug}.md`);
    expectedEs.add(`${entry.slug}.md`);
    comparePage(
      join(PAGES_DIR, `${entry.slug}.md`),
      neutralizeForPublication(renderDetailPage(entry, "en")),
      entry.name,
    );
    comparePage(
      join(PAGES_ES_DIR, `${entry.slug}.md`),
      neutralizeForPublication(renderDetailPage(entry, "es")),
      entry.name,
    );
  }
  comparePage(
    join(PAGES_DIR, "index.md"),
    neutralizeForPublication(renderIndexPage(entries, "en")),
    "index",
  );
  comparePage(
    join(PAGES_ES_DIR, "index.md"),
    neutralizeForPublication(renderIndexPage(entries, "es")),
    "index",
  );
  for (const file of listMarkdown(PAGES_DIR)) {
    if (!expectedEn.has(file)) problem(join(PAGES_DIR, file), 0, `stale page: ${file}`);
  }
  for (const file of listMarkdown(PAGES_ES_DIR)) {
    if (!expectedEs.has(file)) problem(join(PAGES_ES_DIR, file), 0, `stale page: ${file}`);
  }
}

// ---------------------------------------------------------------------------
// 5. Covers
// ---------------------------------------------------------------------------

function checkCovers(entries) {
  const referenced = new Set();
  for (const entry of entries) {
    if (!entry.cover?.startsWith("/covers/")) continue;
    referenced.add(entry.cover.replace("/covers/", ""));
    const path = join(SITE_DIR, "public", entry.cover);
    if (!existsSync(path))
      problem(path, 0, `${entry.name}: referenced cover is missing; run \`pnpm docs:scan\``);
  }
  const defaultPath = join(SITE_DIR, "public", DEFAULT_COVER);
  if (!existsSync(defaultPath)) problem(defaultPath, 0, "the default cover is missing");
  if (!existsSync(COVERS_DIR)) return;
  for (const file of readdirSync(COVERS_DIR)) {
    if (!referenced.has(file))
      problem(join(COVERS_DIR, file), 0, `orphan cover: ${file}; run \`pnpm docs:scan\``);
  }
}

// ---------------------------------------------------------------------------
// 6. Internal links and anchors
// ---------------------------------------------------------------------------

const CONTROL = /[\p{Cc}]/gu;
const COMBINING = /[\u0300-\u036f]/g;
const SPECIAL = /[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'<>,.?/]+/g;
const HEADING = /^(#{1,6})\s+(.*)$/;
const EXPLICIT_ID = /\{#([^}\s]+)\}\s*$/;
const LINK = /(!?)\[([^\]]*)\]\((<[^>]*>|[^)\s]+)/g;
const FENCE = /^\s*(`{3,}|~{3,})/;

function slugify(text) {
  return text
    .normalize("NFKD")
    .replace(COMBINING, "")
    .replace(CONTROL, "")
    .replace(SPECIAL, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1")
    .toLowerCase();
}

function parsePage(file) {
  const headings = [];
  const links = [];
  let fence = null;
  let fences = 0;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = FENCE.exec(line);
    if (marker) {
      const char = marker[1][0];
      if (fence === null) {
        fence = char;
        fences += 1;
      } else if (char === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      const explicit = EXPLICIT_ID.exec(heading[2]);
      headings.push({
        level: heading[1].length,
        id: explicit ? explicit[1] : slugify(heading[2].replace(EXPLICIT_ID, "")),
      });
    }
    for (const match of line.matchAll(LINK)) {
      links.push({
        raw: match[3].replace(/^<|>$/g, ""),
        line: index + 1,
        image: match[1] === "!",
      });
    }
  }
  return { headings, links, fences };
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "public") continue;
      out.push(...markdownFiles(full));
    } else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function sitePage(path) {
  const clean = path
    .replace(new RegExp(`^${SITE_BASE}`), "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (clean === "") return join(SITE_DIR, "index.md");
  if (clean.endsWith(".md"))
    return existsSync(join(SITE_DIR, clean)) ? join(SITE_DIR, clean) : null;
  if (existsSync(join(SITE_DIR, `${clean}.md`))) return join(SITE_DIR, `${clean}.md`);
  if (existsSync(join(SITE_DIR, clean, "index.md"))) return join(SITE_DIR, clean, "index.md");
  return existsSync(join(SITE_DIR, clean)) ? join(SITE_DIR, clean) : null;
}

function assetExists(path, from) {
  if (path.startsWith("/")) {
    const rel = path.replace(new RegExp(`^${SITE_BASE}`), "/").replace(/^\/+/, "");
    return existsSync(join(SITE_DIR, "public", rel)) || existsSync(join(SITE_DIR, rel));
  }
  return existsSync(resolve(dirname(from), decodeURIComponent(path)));
}

function resolveRelative(file, path) {
  const candidate = resolve(dirname(file), decodeURIComponent(path));
  if (existsSync(candidate)) return candidate;
  if (existsSync(`${candidate}.md`)) return `${candidate}.md`;
  if (existsSync(join(candidate, "index.md"))) return join(candidate, "index.md");
  return candidate;
}

function anchorKey(value) {
  return decodeURIComponent(value).trim().toLowerCase();
}

function countLevels(page) {
  const counts = new Map();
  for (const heading of page.headings)
    counts.set(heading.level, (counts.get(heading.level) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, count]) => `h${level}=${count}`)
    .join(" ");
}

function checkLinks() {
  const files = markdownFiles(SITE_DIR);
  const cache = new Map();
  const page = (file) => {
    if (!cache.has(file)) cache.set(file, parsePage(file));
    return cache.get(file);
  };
  let linkCount = 0;
  let anchorCount = 0;
  let imageCount = 0;

  for (const file of files) {
    const current = page(file);
    for (const link of current.links) {
      const raw = link.raw;
      const external = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//");
      if (link.image) {
        imageCount += 1;
        if (external) continue;
        const [path] = raw.split("#");
        if (path && !assetExists(path, file)) problem(file, link.line, `image not found: ${raw}`);
        continue;
      }
      if (external) continue;
      linkCount += 1;
      const hashIndex = raw.indexOf("#");
      const path = hashIndex === -1 ? raw : raw.slice(0, hashIndex);
      const anchor = hashIndex === -1 ? "" : raw.slice(hashIndex + 1);
      const target =
        path === "" ? file : path.startsWith("/") ? sitePage(path) : resolveRelative(file, path);
      if (target === null || !existsSync(target)) {
        problem(file, link.line, `link not found: ${raw}`);
        continue;
      }
      if (anchor === "") continue;
      anchorCount += 1;
      if (!target.endsWith(".md")) continue;
      const ids = new Set(page(target).headings.map((heading) => anchorKey(heading.id)));
      if (!ids.has(anchorKey(anchor)))
        problem(
          file,
          link.line,
          `anchor not found: ${raw} (${relative(REPO_ROOT, target)} has no such heading)`,
        );
    }
  }

  for (const file of files) {
    const name = relative(SITE_DIR, file).split(/[\\/]/).join("/");
    if (name.startsWith("es/")) {
      const en = join(SITE_DIR, name.slice(3));
      if (!existsSync(en) && !SITE_EXCLUDE.has(name.slice(3)))
        problem(file, 1, `parity: site/${name} has no site/${name.slice(3)}`);
      continue;
    }
    if (SITE_EXCLUDE.has(name)) continue;
    const es = join(SITE_DIR, "es", name);
    if (!existsSync(es)) continue;
    const enPage = page(file);
    const esPage = page(es);
    if (countLevels(enPage) !== countLevels(esPage))
      problem(
        file,
        1,
        `parity: headings differ from site/es/${name} (${countLevels(enPage)} vs ${countLevels(esPage)})`,
      );
    if (enPage.fences !== esPage.fences)
      problem(
        file,
        1,
        `parity: code fences differ from site/es/${name} (${enPage.fences} vs ${esPage.fences})`,
      );
  }

  return { pages: files.length, links: linkCount, anchors: anchorCount, images: imageCount };
}

async function main() {
  const cache = readJson(CACHE_PATH);
  if (!cache || !Array.isArray(cache.plugins)) {
    problem(CACHE_PATH, 0, "cache is missing or invalid; run `pnpm docs:scan`");
    return report();
  }
  const registry = readJson(REGISTRY_PATH) ?? { plugins: [] };
  const registryEntries = Array.isArray(registry.plugins) ? registry.plugins : [];
  const registryByPackage = new Map(
    registryEntries.filter((entry) => entry?.package).map((entry) => [entry.package, entry]),
  );

  const entries = cache.plugins;
  checkIntegrity(entries);
  await checkLocalSync(entries, registryByPackage);
  checkRegistry(entries, registryEntries);
  checkPages(entries);
  checkCovers(entries);
  const stats = checkLinks();
  return report(entries.length, stats);
}

function report(plugins = 0, stats = null) {
  for (const item of problems) {
    const where = item.file.startsWith(REPO_ROOT) ? relative(REPO_ROOT, item.file) : item.file;
    console.log(`FAIL ${where}:${item.line} ${item.message}`);
  }
  if (problems.length > 0) {
    console.log(`docs:check: ${problems.length} problem(s).`);
    return 1;
  }
  const counts = stats ?? { pages: 0, links: 0, anchors: 0, images: 0 };
  console.log(
    `docs:check: OK — ${plugins} plugin(s), ${counts.pages} pages, ` +
      `${counts.links} links (${counts.anchors} anchors), ${counts.images} images.`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  },
);
