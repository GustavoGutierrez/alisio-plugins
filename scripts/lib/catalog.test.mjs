import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  absoluteSiteUrl,
  buildCatalog,
  DEFAULT_SITE_URL,
  resolveSiteUrl,
  writeCatalog,
} from "./catalog.mjs";

const SITE = "https://example.test/alisio-plugins/";
const CATEGORIES = ["model-provider", "search", "tools", "ui"];

/** A cache entry shaped like `site/.vitepress/data/plugins.json`. */
function entry(overrides = {}) {
  return {
    name: "@alisio/plugin-web-search",
    slug: "web-search",
    title: "Web Search",
    pluginId: "web-search",
    description: "Search the web",
    version: "1.2.0",
    publishedAt: "2026-01-02T00:00:00.000Z",
    firstPublishedAt: "2025-01-01T00:00:00.000Z",
    author: "Alisio",
    maintainers: [],
    license: "MIT",
    repository: "https://github.com/acme/repo",
    homepage: "https://github.com/acme/repo#readme",
    bugs: "https://github.com/acme/repo/issues",
    npmUrl: "https://www.npmjs.com/package/@alisio/plugin-web-search",
    categories: ["search", "tools"],
    keywords: ["alisio-plugin", "search", "web", "duckduckgo", "web", "tools"],
    unpackedSize: 1234,
    dependencyCount: 0,
    peerCount: 1,
    installName: "@alisio/plugin-web-search",
    cover: "/covers/web-search.svg",
    icon: null,
    sdk: "^0.9.0",
    readme: "# heavy readme",
    readmeEs: "# readme pesado",
    downloadsLastMonth: 10,
    featured: false,
    source: "local",
    ...overrides,
  };
}

test("buildCatalog projects cache entries into the public catalog shape", () => {
  const catalog = buildCatalog(
    { schemaVersion: 1, plugins: [entry({ icon: "/icons/web-search.png", featured: true })] },
    { siteUrl: SITE, categories: CATEGORIES },
  );
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.site, SITE);
  assert.deepEqual(catalog.plugins, [
    {
      id: "web-search",
      slug: "web-search",
      name: "Web Search",
      package: "@alisio/plugin-web-search",
      version: "1.2.0",
      description: "Search the web",
      categories: ["search", "tools"],
      tags: ["web", "duckduckgo"],
      cover: "https://example.test/alisio-plugins/covers/web-search.svg",
      icon: "https://example.test/alisio-plugins/icons/web-search.png",
      sdk: "^0.9.0",
      author: "Alisio",
      license: "MIT",
      homepage: "https://github.com/acme/repo#readme",
      npmUrl: "https://www.npmjs.com/package/@alisio/plugin-web-search",
      repository: "https://github.com/acme/repo",
      publishedAt: "2026-01-02T00:00:00.000Z",
      featured: true,
      source: "local",
    },
  ]);
});

test("buildCatalog never carries heavy or internal fields", () => {
  const catalog = buildCatalog({ plugins: [entry()] }, { siteUrl: SITE, categories: CATEGORIES });
  const keys = Object.keys(catalog.plugins[0]);
  for (const heavy of ["readme", "readmeEs", "downloadsLastMonth", "maintainers", "fetchedAt"])
    assert.ok(!keys.includes(heavy), `${heavy} must not be published`);
});

test("buildCatalog sorts by slug and counts known categories in list order", () => {
  const catalog = buildCatalog(
    {
      plugins: [
        entry({ slug: "zeta", name: "@alisio/plugin-zeta", categories: ["tools"] }),
        entry({ slug: "alpha", name: "@alisio/plugin-alpha", categories: ["model-provider"] }),
        entry({ slug: "mid", name: "@alisio/plugin-mid", categories: ["tools", "unknown"] }),
      ],
    },
    { siteUrl: SITE, categories: CATEGORIES },
  );
  assert.deepEqual(
    catalog.plugins.map((plugin) => plugin.slug),
    ["alpha", "mid", "zeta"],
  );
  assert.deepEqual(catalog.plugins[1].categories, ["tools"]);
  assert.deepEqual(catalog.categories, [
    { id: "model-provider", count: 1 },
    { id: "tools", count: 2 },
  ]);
});

test("generatedAt is the newest publishedAt, never the wall clock", () => {
  const plugins = [
    entry({ slug: "a", publishedAt: "2026-03-01T00:00:00.000Z" }),
    entry({ slug: "b", publishedAt: "2026-05-01T00:00:00.000Z" }),
    entry({ slug: "c", publishedAt: null }),
    entry({ slug: "d", publishedAt: "not a date" }),
  ];
  const options = { siteUrl: SITE, categories: CATEGORIES };
  const first = buildCatalog({ plugins }, options);
  assert.equal(first.generatedAt, "2026-05-01T00:00:00.000Z");
  assert.equal(first.plugins.find((plugin) => plugin.slug === "d").publishedAt, null);
  assert.deepEqual(buildCatalog({ plugins }, options), first);
  assert.equal(
    buildCatalog({ plugins: [entry({ publishedAt: null })] }, options).generatedAt,
    null,
  );
});

test("buildCatalog skips malformed entries instead of crashing", () => {
  const catalog = buildCatalog(
    {
      plugins: [
        null,
        "string",
        42,
        entry({ slug: "Bad Slug" }),
        entry({ slug: "no-package", installName: "" }),
        entry({ slug: "no-version", version: undefined }),
        entry({ slug: "ok", categories: "tools", keywords: "x" }),
      ],
    },
    { siteUrl: SITE, categories: CATEGORIES },
  );
  assert.deepEqual(
    catalog.plugins.map((plugin) => plugin.slug),
    ["ok"],
  );
  assert.deepEqual(catalog.plugins[0].categories, []);
  assert.deepEqual(catalog.plugins[0].tags, []);
  assert.deepEqual(buildCatalog(null, { siteUrl: SITE, categories: CATEGORIES }).plugins, []);
  assert.deepEqual(buildCatalog({ plugins: "nope" }, { siteUrl: SITE }).plugins, []);
});

test("buildCatalog drops duplicate slugs, keeping the first", () => {
  const catalog = buildCatalog(
    { plugins: [entry({ version: "1.0.0" }), entry({ version: "2.0.0" })] },
    { siteUrl: SITE, categories: CATEGORIES },
  );
  assert.equal(catalog.plugins.length, 1);
  assert.equal(catalog.plugins[0].version, "1.0.0");
});

test("optional fields degrade to null and unsafe links are dropped", () => {
  const catalog = buildCatalog(
    {
      plugins: [
        entry({
          pluginId: undefined,
          title: "",
          cover: "//evil.test/x.svg",
          icon: "/../../etc/passwd",
          sdk: 3,
          author: null,
          license: undefined,
          homepage: "javascript:alert(1)",
          npmUrl: "ftp://example.test",
          repository: "not a url",
          featured: "yes",
          source: 7,
        }),
      ],
    },
    { siteUrl: SITE, categories: CATEGORIES },
  );
  const plugin = catalog.plugins[0];
  assert.equal(plugin.id, null);
  assert.equal(plugin.name, "@alisio/plugin-web-search");
  for (const field of [
    "cover",
    "icon",
    "sdk",
    "author",
    "license",
    "homepage",
    "npmUrl",
    "repository",
    "source",
  ])
    assert.equal(plugin[field], null, field);
  assert.equal(plugin.featured, false);
});

test("absoluteSiteUrl joins site paths safely", () => {
  assert.equal(
    absoluteSiteUrl("/covers/a.svg", SITE),
    "https://example.test/alisio-plugins/covers/a.svg",
  );
  assert.equal(
    absoluteSiteUrl("/assets/covers/default-cover.svg", "https://example.test/alisio-plugins"),
    "https://example.test/alisio-plugins/assets/covers/default-cover.svg",
  );
  for (const bad of [
    null,
    "",
    "covers/a.svg",
    "//evil.test/a.svg",
    "/covers/../../x.svg",
    "/covers\\a.svg",
    "https://evil.test/a.svg",
    "/covers/a.svg?x=1",
    "/covers/a b.svg",
  ])
    assert.equal(absoluteSiteUrl(bad, SITE), null, String(bad));
});

test("buildCatalog requires an absolute http(s) site URL", () => {
  assert.throws(() => buildCatalog({ plugins: [] }, { siteUrl: "relative/" }), /siteUrl/);
  assert.throws(() => buildCatalog({ plugins: [] }, { siteUrl: "file:///x/" }), /siteUrl/);
  assert.equal(
    buildCatalog({ plugins: [] }, { siteUrl: "https://example.test/base" }).site,
    "https://example.test/base/",
  );
});

test("writeCatalog writes minified JSON atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "alisio-catalog-test-"));
  try {
    const target = join(dir, "nested", "catalog.json");
    const catalog = buildCatalog({ plugins: [entry()] }, { siteUrl: SITE, categories: CATEGORIES });
    writeCatalog(target, catalog);
    const text = readFileSync(target, "utf8");
    assert.equal(text, JSON.stringify(catalog));
    assert.ok(!text.includes("\n"));
    assert.deepEqual(JSON.parse(text), catalog);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cover URLs are the site URL plus the cover path without its leading slash", () => {
  const cache = { plugins: [entry({ slug: "deepseek", cover: "/covers/deepseek.svg" })] };
  assert.equal(
    buildCatalog(cache, { siteUrl: DEFAULT_SITE_URL }).plugins[0].cover,
    "https://gustavogutierrez.github.io/alisio-plugins/covers/deepseek.svg",
  );
  assert.equal(
    buildCatalog(cache, { siteUrl: "https://plugins.alisio.dev/" }).plugins[0].cover,
    "https://plugins.alisio.dev/covers/deepseek.svg",
  );
});

test("resolveSiteUrl defaults, normalizes one trailing slash, and rejects bad values", () => {
  assert.equal(DEFAULT_SITE_URL, "https://gustavogutierrez.github.io/alisio-plugins/");
  assert.equal(resolveSiteUrl(undefined), DEFAULT_SITE_URL);
  assert.equal(resolveSiteUrl("  "), DEFAULT_SITE_URL);
  assert.equal(resolveSiteUrl("https://plugins.alisio.dev"), "https://plugins.alisio.dev/");
  assert.equal(resolveSiteUrl("https://example.test/docs///"), "https://example.test/docs/");
  for (const bad of [
    "http://example.test/",
    "example.test",
    "ftp://x/",
    "https://x/?a=1",
    "https://x/#h",
  ])
    assert.throws(() => resolveSiteUrl(bad), /ALISIO_SITE_URL/, bad);
});
