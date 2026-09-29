import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { REPO_ROOT } from "./lib/plugins.mjs";

const SCANNER = join(REPO_ROOT, "scripts", "scan-plugins.mjs");

/** The fixture package's entry point throws if anything imports it. */
const PROOF_OF_NO_EXECUTION = 'throw new Error("third-party code must never execute");';

const COVER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">' +
  '<rect width="1600" height="900" fill="#3451b2"/></svg>\n';

/** Run a command asynchronously so the in-process registry server stays live. */
function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function startRegistryServer(state) {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/tarball.tgz") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(state.tarball);
      return;
    }
    if (path.startsWith("/downloads/point/last-month/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ downloads: 42 }));
      return;
    }
    if (path === "/@acme%2Fplugin-search" || path === "/@acme/plugin-search") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(state.packument));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("the third-party pipeline runs end to end without executing package code", async () => {
  const root = mkdtempSync(join(tmpdir(), "alisio-plugins-scan-"));
  const state = { tarball: Buffer.alloc(0), packument: null };
  let server;
  try {
    // 1. A fixture package: cover at the root, a README that tries to abuse the
    //    VitePress pipeline, and an index.js that proves it is never imported.
    const fixture = join(root, "fixture", "package");
    mkdirSync(join(fixture, "assets"), { recursive: true });
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "@acme/plugin-search",
        version: "2.0.0",
        description: "Acme search plugin",
        license: "MIT",
        keywords: ["alisio-plugin", "search", "tools"],
      }),
    );
    writeFileSync(join(fixture, "index.js"), PROOF_OF_NO_EXECUTION);
    writeFileSync(join(fixture, "cover.svg"), COVER_SVG);
    const tarballPath = join(root, "tarball.tgz");
    execFileSync("tar", ["-czf", tarballPath, "-C", join(root, "fixture"), "package"]);
    state.tarball = readFileSync(tarballPath);

    // 2. A local npm registry that serves the packument and the tarball.
    server = await startRegistryServer(state);
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;

    const homeLike = join("/", "home", "alice", "project");
    state.packument = {
      name: "@acme/plugin-search",
      description: "Packument description",
      license: "MIT",
      author: { name: "Ada Lovelace" },
      maintainers: [{ name: "Ada Lovelace" }],
      keywords: ["alisio-plugin", "search", "tools"],
      repository: { type: "git", url: "git+https://github.com/acme/plugin-search.git" },
      homepage: "https://acme.dev/search",
      readme: [
        "# @acme/plugin-search",
        "",
        "![logo](./assets/logo.png)",
        "",
        `Local example: ${homeLike}`,
        "",
        `<!-- ${["@include", ": /etc/passwd"].join("")} -->`,
        "",
        "[bad](javascript:alert(1))",
        "",
        "See [guide](../docs/guide.md).",
        "",
        "## Usage",
        "",
        "[top](#usage) and [dead](#missing).",
      ].join("\n"),
      time: { created: "2025-01-01T00:00:00.000Z", "2.0.0": "2025-02-01T00:00:00.000Z" },
      "dist-tags": { latest: "2.0.0" },
      versions: {
        "2.0.0": {
          name: "@acme/plugin-search",
          version: "2.0.0",
          description: "Packument description",
          license: "MIT",
          author: { name: "Ada Lovelace" },
          repository: { type: "git", url: "git+https://github.com/acme/plugin-search.git" },
          homepage: "https://acme.dev/search",
          keywords: ["alisio-plugin", "search", "tools"],
          dependencies: { "left-pad": "1.3.0" },
          peerDependencies: { "@alisio/sdk": ">=0.1.0" },
          dist: { unpackedSize: 2048, tarball: `${base}/tarball.tgz` },
        },
      },
    };

    // 3. A throwaway scan root: registry in, cache/pages/covers out.
    mkdirSync(join(root, "registry"), { recursive: true });
    writeFileSync(
      join(root, "registry", "plugins.json"),
      `${JSON.stringify({ schemaVersion: 1, plugins: [{ package: "@acme/plugin-search" }] }, null, 2)}\n`,
    );

    const result = await run(process.execPath, [SCANNER, "--force", "--strict"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ALISIO_PLUGIN_SCAN_ROOT: root,
        ALISIO_NPM_REGISTRY: base,
        ALISIO_NPM_DOWNLOADS: `${base}/downloads`,
      },
    });
    assert.equal(result.status, 0, `scan failed:\n${result.stdout}\n${result.stderr}`);
    // Exit 0 also proves the fixture's index.js was never imported.
    assert.ok(!result.stderr.includes("never execute"));

    // 4. The cache carries the third-party fields.
    const cache = JSON.parse(
      readFileSync(join(root, "site", ".vitepress", "data", "plugins.json"), "utf8"),
    );
    assert.equal(cache.plugins.length, 1);
    const entry = cache.plugins[0];
    assert.equal(entry.source, "third-party");
    assert.equal(entry.slug, "acme-plugin-search");
    assert.equal(entry.version, "2.0.0");
    assert.equal(entry.author, "Ada Lovelace");
    assert.equal(entry.publishedAt, "2025-02-01T00:00:00.000Z");
    assert.equal(entry.firstPublishedAt, "2025-01-01T00:00:00.000Z");
    assert.equal(entry.unpackedSize, 2048);
    assert.equal(entry.dependencyCount, 1);
    assert.equal(entry.peerCount, 1);
    assert.equal(entry.downloadsLastMonth, 42);
    assert.deepEqual(entry.categories, ["search", "tools"]);
    assert.equal(entry.cover, "/covers/acme-plugin-search.svg");

    // 5. The README is sanitized and its relative links are rewritten.
    assert.ok(!entry.readme.includes("@include"));
    assert.ok(!entry.readme.includes("javascript:"));
    assert.ok(!entry.readme.includes(homeLike));
    assert.ok(entry.readme.includes("<path>"));
    assert.ok(!entry.readme.includes("[dead]"));
    assert.ok(entry.readme.includes("[top](#usage)"));
    assert.ok(
      entry.readme.includes(
        "https://raw.githubusercontent.com/acme/plugin-search/HEAD/assets/logo.png",
      ),
    );
    assert.ok(
      entry.readme.includes("https://github.com/acme/plugin-search/blob/HEAD/docs/guide.md"),
    );

    // 6. The cover was extracted from the published tarball, and pages exist.
    const cover = join(root, "site", "public", "covers", "acme-plugin-search.svg");
    assert.ok(existsSync(cover));
    assert.ok(readFileSync(cover, "utf8").includes('viewBox="0 0 1600 900"'));
    const page = readFileSync(join(root, "site", "plugins", "acme-plugin-search.md"), "utf8");
    assert.ok(page.includes('<PluginDetail slug="acme-plugin-search" />'));
    assert.ok(page.includes("## Usage"));
    assert.ok(existsSync(join(root, "site", "es", "plugins", "acme-plugin-search.md")));
    assert.ok(existsSync(join(root, "site", "plugins", "index.md")));
    assert.ok(existsSync(join(root, "site", "es", "plugins", "index.md")));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
