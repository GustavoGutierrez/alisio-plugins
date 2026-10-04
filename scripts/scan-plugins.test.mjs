import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import {
  COVER_EXTENSIONS,
  coverSitePath,
  githubRepoParts,
  headingSlugs,
  isInside,
  knownCategories,
  localPackages,
  neutralizeForPublication,
  normalizeRepository,
  PLUGIN_CATEGORIES,
  prepareReadme,
  pruneReadmeAnchors,
  renderDetailPage,
  renderIndexPage,
  resolveCoverFile,
  sanitizeReadme,
  slugFor,
} from "./lib/plugins.mjs";
import { assertSafeTarball, fromCache, packumentFields } from "./scan-plugins.mjs";

/** Temporary directory removed after `body` runs. */
function withTempDir(body) {
  const dir = mkdtempSync(join(tmpdir(), "alisio-plugins-test-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("slugFor derives readable, stable slugs", () => {
  assert.equal(slugFor("@alisio/plugin-wayfinder"), "wayfinder");
  assert.equal(slugFor("@acme/alisio-plugin-notes"), "acme-alisio-plugin-notes");
  assert.equal(slugFor("@scope/name"), "scope-name");
  assert.equal(slugFor("plain-plugin"), "plain-plugin");
  assert.equal(slugFor("UPPER_Case Name"), "upper-case-name");
  assert.equal(slugFor("@alisio/plugin-OpenCode-Go"), "opencode-go");
});

test("normalizeRepository normalizes the shapes npm publishes", () => {
  assert.equal(normalizeRepository("git+https://github.com/a/b.git"), "https://github.com/a/b");
  assert.equal(normalizeRepository("git@github.com:a/b.git"), "https://github.com/a/b");
  assert.equal(normalizeRepository({ url: "https://github.com/a/b/" }), "https://github.com/a/b");
  assert.equal(normalizeRepository("not a url"), null);
  assert.equal(normalizeRepository(undefined), null);
});

test("githubRepoParts only matches github.com", () => {
  assert.deepEqual(githubRepoParts("https://github.com/a/b/tree/main"), { owner: "a", repo: "b" });
  assert.equal(githubRepoParts("https://gitlab.com/a/b"), null);
});

test("knownCategories keeps known values in canonical order", () => {
  assert.deepEqual(knownCategories(["ui", "bogus", "model-provider", "tools"]), [
    "model-provider",
    "tools",
    "ui",
  ]);
  assert.deepEqual(knownCategories(undefined), []);
  assert.equal(PLUGIN_CATEGORIES.length, 12);
  assert.deepEqual(knownCategories(["decisions", "ui"]), ["ui", "decisions"]);
});

test("isInside rejects paths that escape the root", () => {
  assert.equal(isInside("/a/b", "c/d"), true);
  assert.equal(isInside("/a/b", "../c"), false);
  assert.equal(isInside("/a/b", "/etc/passwd"), false);
});

test("resolveCoverFile follows the documented precedence", () =>
  withTempDir((dir) => {
    mkdirSync(join(dir, "art"), { recursive: true });
    writeFileSync(join(dir, "cover.svg"), "<svg/>");
    writeFileSync(join(dir, "cover.png"), "png");
    writeFileSync(join(dir, "art", "custom.png"), "png");
    writeFileSync(join(dir, "art", "declared.png"), "png");
    const manifest = { alisio: { cover: "art/custom.png" } };

    // 1. The registry-declared path wins over everything.
    assert.equal(
      resolveCoverFile(dir, { declared: "art/declared.png", manifest }),
      join(dir, "art", "declared.png"),
    );
    // 2. Then `alisio.cover` from package.json.
    assert.equal(resolveCoverFile(dir, { manifest }), join(dir, "art", "custom.png"));
    // 3. Then the convention, in documented extension order.
    assert.equal(resolveCoverFile(dir, {}), join(dir, "cover.svg"));
    assert.deepEqual(COVER_EXTENSIONS.slice(0, 3), ["svg", "png", "jpg"]);
    // Declared paths that escape the package are ignored.
    assert.equal(resolveCoverFile(dir, { declared: "../secret.png" }), join(dir, "cover.svg"));
    rmSync(join(dir, "cover.svg"), { force: true });
    assert.equal(resolveCoverFile(dir, {}), join(dir, "cover.png"));
  }));

test("coverSitePath derives the served path and rejects unknown extensions", () => {
  assert.equal(coverSitePath(join("/x", "cover.svg"), "wayfinder"), "/covers/wayfinder.svg");
  assert.equal(coverSitePath(join("/x", "cover.webp"), "wayfinder"), "/covers/wayfinder.webp");
  assert.equal(coverSitePath(join("/x", "cover.gif"), "wayfinder"), null);
});

test("sanitizeReadme neutralizes the VitePress pipeline", () => {
  const include = `<!-- ${["@include", ": /etc/passwd"].join("")} -->`;
  const source = [
    "# Title",
    include,
    "<script>alert(1)</script>",
    '<img src="x" onerror="alert(2)">',
    "<<< @/secret.txt",
    "{{ constructor.constructor('x')() }}",
    "[bad](javascript:alert(3))",
    "Keep <https://example.com> and <user@example.com>.",
    "",
    "```html",
    "<div>{{ keep }}</div>",
    "```",
  ].join("\n");
  const clean = sanitizeReadme(source);
  assert.ok(!clean.includes("@include"));
  assert.ok(!clean.includes("<script>"));
  assert.ok(!clean.includes("onerror"));
  assert.ok(!/^\s*<<</m.test(clean));
  assert.ok(!clean.includes("{{"));
  assert.ok(!clean.includes("javascript:"));
  assert.ok(clean.includes("<https://example.com>"));
  assert.ok(clean.includes("<user@example.com>"));
  // Code fences keep their tags (markdown-it escapes them before Vue sees them).
  assert.ok(clean.includes("<div>"));
});

test("pruneReadmeAnchors unwraps dead anchors and keeps resolvable ones", () => {
  const markdown = ["## Usage", "", "[ok](#usage) and [dead](#missing)."].join("\n");
  const pruned = pruneReadmeAnchors(markdown);
  assert.ok(pruned.includes("[ok](#usage)"));
  assert.ok(pruned.includes("dead"));
  assert.ok(!pruned.includes("[dead]"));
});

test("headingSlugs deduplicates repeated headings", () => {
  const slugs = headingSlugs("# A\n\n## Setup\n\n## Setup");
  assert.equal(slugs.has("setup"), true);
  assert.equal(slugs.has("setup-1"), true);
});

test("prepareReadme strips the leading H1 and resolves relative links", () => {
  const markdown = [
    "# @alisio/plugin-wayfinder",
    "",
    "![diagram](./assets/flow.svg)",
    "",
    "See [CONTRIBUTING](../CONTRIBUTING.md) and [docs](https://example.com) and [top](#usage).",
    "",
    "## Usage",
  ].join("\n");
  const readme = prepareReadme(markdown, {
    repository: "https://github.com/GustavoGutierrez/alisio-plugins",
    directory: "packages/wayfinder",
    npmUrl: "https://www.npmjs.com/package/@alisio/plugin-wayfinder",
  });
  assert.ok(readme.startsWith("![diagram]"));
  assert.ok(
    readme.includes(
      "https://raw.githubusercontent.com/GustavoGutierrez/alisio-plugins/HEAD/packages/wayfinder/assets/flow.svg",
    ),
  );
  assert.ok(
    readme.includes(
      "https://github.com/GustavoGutierrez/alisio-plugins/blob/HEAD/packages/CONTRIBUTING.md",
    ),
  );
  assert.ok(readme.includes("[docs](https://example.com)"));
  assert.ok(readme.includes("[top](#usage)"));
  assert.equal(prepareReadme("   \n\n"), null);
});

test("prepareReadme falls back to the npm page without a repository", () => {
  const readme = prepareReadme("[x](./docs/a.md)", {
    repository: null,
    directory: "",
    npmUrl: "https://www.npmjs.com/package/pkg",
  });
  assert.ok(readme.includes("(https://www.npmjs.com/package/pkg"));
});

test("neutralizeForPublication redacts machine paths and credentials", () => {
  const homePath = `${["", "home", "alice", "project"].join("/")}`;
  const token = `npm_${"a".repeat(40)}`;
  const text = `path ${homePath} and token ${token}`;
  const clean = neutralizeForPublication(text);
  assert.ok(!clean.includes(homePath));
  assert.ok(!clean.includes(token));
  assert.ok(clean.includes("<path>"));
  assert.ok(clean.includes("<redacted>"));
  // The generated file must be clean when scanned by the same rules.
  assert.ok(!neutralizeForPublication(text).includes("npm_"));
});

test("renderDetailPage emits localized frontmatter and the component tag", () => {
  const entry = {
    slug: "wayfinder",
    title: 'Way "finder"',
    description: "A plugin",
    npmUrl: "https://www.npmjs.com/package/@alisio/plugin-wayfinder",
    readme: "## Usage\n\nHello",
  };
  const page = renderDetailPage(entry, "en");
  assert.ok(page.startsWith("---\n"));
  assert.ok(page.includes('title: "Way \\"finder\\""'));
  assert.ok(page.includes('<PluginDetail slug="wayfinder" />'));
  assert.ok(page.includes("## Usage"));
  const es = renderDetailPage({ ...entry, readme: null }, "es");
  assert.ok(es.includes("## README"));
  assert.ok(es.includes("no publica un README"));
});

test("renderDetailPage prefers readmeEs on the Spanish page only", () => {
  const entry = {
    slug: "thesis",
    title: "Thesis",
    description: "A plugin",
    npmUrl: "https://www.npmjs.com/package/@alisio/plugin-thesis",
    readme: "## Usage\n\nHello",
    readmeEs: "## Uso\n\nHola",
  };
  assert.ok(renderDetailPage(entry, "es").includes("## Uso"));
  assert.ok(!renderDetailPage(entry, "es").includes("## Usage"));
  assert.ok(renderDetailPage(entry, "en").includes("## Usage"));
});

test("renderIndexPage lists plugins A-Z with relative links", () => {
  const entries = [
    { slug: "zeta", title: "Zeta", description: "Z", categories: ["tools"] },
    { slug: "alpha", title: "Alpha", description: "A\nB", categories: [] },
  ];
  const page = renderIndexPage(entries, "en");
  assert.ok(page.includes("# Plugin index"));
  const alpha = page.indexOf("(./alpha)");
  const zeta = page.indexOf("(./zeta)");
  assert.ok(alpha > 0 && zeta > alpha);
  assert.ok(page.includes("A B"));
});

test("packumentFields extracts display metadata from a packument", () => {
  const packument = {
    name: "@acme/plugin",
    description: "fallback",
    license: "MIT",
    author: { name: "Ada" },
    maintainers: [{ name: "Ada" }, { name: "Grace" }],
    repository: { type: "git", url: "git+https://github.com/acme/plugin.git", directory: "pkg" },
    homepage: "https://acme.dev",
    keywords: ["alisio-plugin", "tools"],
    readme: "# Readme",
    time: { created: "2024-01-01T00:00:00.000Z", "1.2.3": "2024-06-01T00:00:00.000Z" },
    "dist-tags": { latest: "1.2.3" },
    versions: {
      "1.2.3": {
        description: "A plugin",
        repository: { url: "git+https://github.com/acme/plugin.git", directory: "pkg" },
        dependencies: { a: "1", b: "2" },
        peerDependencies: { c: "3" },
        dist: { unpackedSize: 1234, tarball: "https://example.com/p.tgz" },
      },
    },
  };
  const fields = packumentFields(packument, {});
  assert.equal(fields.version, "1.2.3");
  assert.equal(fields.description, "A plugin");
  assert.equal(fields.repository, "https://github.com/acme/plugin");
  assert.equal(fields.publishedAt, "2024-06-01T00:00:00.000Z");
  assert.equal(fields.firstPublishedAt, "2024-01-01T00:00:00.000Z");
  assert.equal(fields.unpackedSize, 1234);
  assert.equal(fields.dependencyCount, 2);
  assert.equal(fields.peerCount, 1);
  assert.equal(fields.author, "Ada");
  assert.deepEqual(fields.maintainers, ["Ada", "Grace"]);
  assert.equal(fields.tarball, "https://example.com/p.tgz");
});

test("fromCache applies registry overrides without dropping cached data", () => {
  const cached = {
    name: "@acme/plugin",
    slug: "acme-plugin",
    title: "@acme/plugin",
    categories: [],
    featured: false,
    cover: "/covers/acme-plugin.svg",
    readme: "# Cached",
    version: "1.0.0",
  };
  const merged = fromCache(cached, {
    package: "@acme/plugin",
    title: "Acme",
    categories: ["tools", "bogus"],
    featured: true,
    homepage: "https://acme.dev",
  });
  assert.equal(merged.title, "Acme");
  assert.deepEqual(merged.categories, ["tools"]);
  assert.equal(merged.featured, true);
  assert.equal(merged.homepage, "https://acme.dev");
  assert.equal(merged.version, "1.0.0");
  assert.equal(merged.readme, "# Cached");
});

/** Build a minimal ustar block for one entry name. */
function tarHeader(name, size = 0) {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, "utf8");
  block.write("0000644\0", 100, 8);
  block.write("0000000\0", 108, 8);
  block.write("0000000\0", 116, 8);
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  block.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
    136,
    12,
  );
  block.write("        ", 148, 8);
  block.write("0", 156, 1);
  block.write("ustar\0", 257, 6);
  block.write("00", 263, 2);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

test("assertSafeTarball rejects traversal and accepts safe archives", () =>
  withTempDir((dir) => {
    const unsafe = join(dir, "unsafe.tgz");
    writeFileSync(
      unsafe,
      gzipSync(Buffer.concat([tarHeader("../escape.txt"), Buffer.alloc(1024)])),
    );
    assert.throws(() => assertSafeTarball(unsafe), /unsafe tarball entry/);

    const safe = join(dir, "safe.tgz");
    writeFileSync(
      safe,
      gzipSync(Buffer.concat([tarHeader("package/cover.svg"), Buffer.alloc(1024)])),
    );
    assert.doesNotThrow(() => assertSafeTarball(safe));
  }));

test("localPackages discovers every publishable package", () => {
  const names = localPackages().map(({ manifest }) => manifest.name);
  for (const name of [
    "@alisio/plugin-wayfinder",
    "@alisio/plugin-deepseek",
    "@alisio/plugin-opencode",
    "@alisio/plugin-opencode-go",
    "@alisio/plugin-context7",
    "@alisio/plugin-atlassian",
    "@alisio/plugin-telemetry",
    "@alisio/plugin-google-chat",
    "@alisio/plugin-brave-search",
  ])
    assert.ok(names.includes(name), `missing ${name}`);
});

test("the committed covers use the documented 16:9 viewBox", () => {
  const dirs = localPackages().map(({ dir }) => dir);
  for (const dir of dirs) {
    const cover = resolveCoverFile(dir, {});
    assert.ok(cover, `no cover for ${dir}`);
    // A raster cover (webp) is allowed; only SVG covers carry the documented viewBox.
    assert.ok(/cover\.(svg|webp)$/.test(cover), `unexpected cover ${cover}`);
    if (!cover.endsWith(".svg")) continue;
    const svg = readFileSync(cover, "utf8").slice(0, 400);
    assert.ok(svg.includes('viewBox="0 0 1600 900"'), `wrong viewBox in ${cover}`);
    assert.ok(svg.includes('width="1600"') && svg.includes('height="900"'));
  }
});
