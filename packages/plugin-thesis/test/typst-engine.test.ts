import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheRoot, typstInstallDir } from "../src/cache.js";
import {
  compileArgs,
  parseDiagnostics,
  pdfPageCount,
  proxyGuard,
  resolveTypst,
  typstEnv,
} from "../src/render/adapters/typst-pdf/runner.js";
import { allowedHosts, setupTypst } from "../src/render/adapters/typst-pdf/setup.js";
import { parseTypstVersion, typstVersionOk } from "../src/render/adapters/typst-pdf/version.js";
import { pinKey, typstPins, typstReleaseBase, typstVersion } from "../src/typst-pins.js";

const dirs: string[] = [];
const scratch = async () => {
  const dir = await mkdtemp(join(tmpdir(), "thesis-engine-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("pins (spec 16.1)", () => {
  it("pins Typst 0.15.1 with a SHA-256 per platform", () => {
    expect(typstVersion).toBe("0.15.1");
    expect(Object.keys(typstPins).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-x64",
    ]);
    for (const pin of Object.values(typstPins)) expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typstPins["linux-x64"]?.sha256).toBe(
      "a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c",
    );
    expect(typstReleaseBase).toBe("https://github.com/typst/typst/releases/download/v0.15.1/");
    expect(pinKey("linux", "x64")).toBe("linux-x64");
    expect(pinKey("freebsd", "x64")).toBeUndefined();
  });

  it("derives the cache root from the host, ALISIO_CACHE_HOME, XDG and the home directory", () => {
    expect(cacheRoot("/host", {})).toBe("/host");
    expect(cacheRoot(undefined, { ALISIO_CACHE_HOME: "/a", XDG_CACHE_HOME: "/x" })).toBe("/a");
    expect(cacheRoot(undefined, { XDG_CACHE_HOME: "/x" })).toBe(join("/x", "alisio"));
    expect(cacheRoot(undefined, {}, () => "/home/u")).toBe(join("/home/u", ".cache", "alisio"));
    expect(typstInstallDir("/c", "0.15.1")).toBe(join("/c", "thesis", "typst", "0.15.1"));
  });
});

describe("engine resolution (spec 10.6)", () => {
  const deps = (versions: Record<string, string>, executables: string[] = []) => ({
    version: async (binary: string) => {
      const output = versions[binary];
      if (output === undefined) throw new Error("not found");
      return output;
    },
    isExecutable: async (path: string) => executables.includes(path),
    platform: "linux",
    arch: "x64",
  });

  it("parses and compares versions", () => {
    expect(parseTypstVersion("typst 0.15.1 (abc)")).toEqual([0, 15, 1]);
    expect(parseTypstVersion("nope")).toBeUndefined();
    expect(typstVersionOk([0, 15, 0])).toBe(true);
    expect(typstVersionOk([0, 14, 9])).toBe(false);
    expect(typstVersionOk([1, 0, 0])).toBe(true);
  });

  it("prefers ALISIO_THESIS_TYPST, then PATH, then the setup cache", async () => {
    const cached = join("/c", "thesis", "typst", typstVersion, "typst");
    const d = deps(
      { "/env/typst": "typst 0.15.1", "/bin/typst": "typst 0.15.2", [cached]: "typst 0.15.1" },
      ["/bin/typst", cached],
    );
    expect(
      await resolveTypst({ ALISIO_THESIS_TYPST: "/env/typst", PATH: "/bin" }, "/c", d),
    ).toMatchObject({
      available: true,
      source: "ALISIO_THESIS_TYPST",
      path: "/env/typst",
    });
    expect(await resolveTypst({ PATH: "/bin" }, "/c", d)).toMatchObject({
      source: "PATH",
      path: "/bin/typst",
    });
    expect(await resolveTypst({ PATH: "/empty" }, "/c", d)).toMatchObject({
      source: "setup cache",
      path: cached,
    });
  });

  it("does not fall through when an explicit override is wrong or too old", async () => {
    const d = deps({ "/old/typst": "typst 0.14.2", "/bin/typst": "typst 0.15.1" }, ["/bin/typst"]);
    expect(
      await resolveTypst({ ALISIO_THESIS_TYPST: "/old/typst", PATH: "/bin" }, "/c", d),
    ).toMatchObject({
      available: false,
      reason: expect.stringContaining("older than the required 0.15.0"),
    });
    expect(
      await resolveTypst({ ALISIO_THESIS_TYPST: "/missing", PATH: "/bin" }, "/c", d),
    ).toMatchObject({
      available: false,
      reason: expect.stringContaining("could not be run"),
    });
  });

  it("names /thesis:setup when nothing is found", async () => {
    const result = await resolveTypst({ PATH: "" }, "/c", deps({}));
    expect(result).toMatchObject({
      available: false,
      hint: expect.stringContaining("/thesis:setup"),
    });
  });
});

describe("running Typst safely", () => {
  it("builds an argv with the root, vendored packages, an empty cache and no shell metacharacters", () => {
    const args = compileArgs({
      binary: "typst",
      buildDir: "/b",
      packageCache: "/tmp/c",
      packagePath: "/pkg/typst-packages",
      input: "main.typ",
      output: "thesis.pdf",
      fontPaths: ["/fonts"],
      ignoreSystemFonts: true,
      pdfa: true,
    });
    expect(args).toEqual([
      "compile",
      "--root",
      "/b",
      "--package-path",
      "/pkg/typst-packages",
      "--package-cache-path",
      "/tmp/c",
      "--diagnostic-format",
      "short",
      "--font-path",
      "/fonts",
      "--ignore-system-fonts",
      "--pdf-standard",
      "a-2b",
      "main.typ",
      "thesis.pdf",
    ]);
  });

  it("points every proxy variable at a closed port and drops Typst and NO_PROXY overrides", () => {
    const env = typstEnv({
      HTTPS_PROXY: "http://real:3128",
      NO_PROXY: "*",
      TYPST_PACKAGE_PATH: "/x",
      PATH: "/bin",
      HOME: "/h",
    });
    for (const key of ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])
      expect(env[key]).toBe(proxyGuard);
    expect(proxyGuard).toBe("http://127.0.0.1:9");
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.TYPST_PACKAGE_PATH).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  it("parses short diagnostics into BLD-001 errors and BLD-003 warnings", () => {
    const findings = parseDiagnostics(
      "main.typ:7:0: error: cannot reference equation without numbering\n  hint: add numbering\nmain.typ:9:2: warning: unknown font family: arial\nerror: file not found\n",
    );
    expect(findings).toMatchObject([
      {
        code: "BLD-001",
        severity: "error",
        file: "build/main.typ",
        line: 7,
        hint: "add numbering",
      },
      { code: "BLD-003", severity: "warning", line: 9 },
      { code: "BLD-001", severity: "error", message: "file not found" },
    ]);
  });

  it("reads the page count from the PDF page tree", () => {
    const pdf = Buffer.from(
      "<</Type/Outlines/Count 3>>\n<</Type/Pages/Count 12/Kids[1 0 R]>>\n<</Count 4/Type/Pages>>",
    );
    expect(pdfPageCount(pdf)).toBe(12);
    expect(pdfPageCount(Buffer.from("nothing"))).toBeUndefined();
  });
});

const tarOk = (() => {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    execFileSync("xz", ["--version"], { stdio: "ignore" });
    return process.platform !== "win32";
  } catch {
    return false;
  }
})();

describe("/thesis:setup", () => {
  const key = pinKey(process.platform, process.arch) ?? "linux-x64";

  async function fakeRelease() {
    const dir = await scratch();
    const inner = join(dir, "pkg", "typst-fake");
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, "typst"), '#!/bin/sh\necho "typst 0.15.1 (fake)"\n');
    await chmod(join(inner, "typst"), 0o755);
    const archive = join(dir, "fake.tar.xz");
    execFileSync("tar", ["-cJf", archive, "-C", join(dir, "pkg"), "typst-fake"]);
    const bytes = await readFile(archive);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { dir, bytes, sha256 };
  }
  const response = (status: number, body?: Uint8Array, headers: Record<string, string> = {}) =>
    new Response(body ? new Blob([body]) : null, { status, headers });
  const common = (sha256: string, fetchImpl: typeof fetch) => ({
    fetch: fetchImpl,
    platform: process.platform,
    arch: process.arch,
    pins: { [key]: { asset: "fake.tar.xz", sha256, executable: "typst" as const } },
    releaseBase: "https://github.com/typst/typst/releases/download/v0.15.1/",
  });

  it.skipIf(!tarOk)(
    "downloads through allowed redirects, verifies the checksum, extracts and checks --version",
    async () => {
      const release = await fakeRelease();
      const seen: string[] = [];
      const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
        const url = String(input);
        seen.push(url);
        expect(init?.redirect).toBe("manual");
        if (url.startsWith("https://github.com/")) {
          return response(302, undefined, {
            location: "https://release-assets.githubusercontent.com/x/fake.tar.xz",
          });
        }
        return response(200, release.bytes);
      }) as typeof fetch;
      const root = await scratch();
      const result = await setupTypst({ cacheRoot: root, deps: common(release.sha256, fetchImpl) });
      expect(result).toMatchObject({ ok: true, version: "0.15.1" });
      expect(result.path).toBe(join(typstInstallDir(root, "0.15.1"), "typst"));
      expect(seen).toHaveLength(2);
      // A second run finds the installed binary and downloads nothing.
      const again = await setupTypst({
        cacheRoot: root,
        deps: common(release.sha256, (async () => {
          throw new Error("no network");
        }) as typeof fetch),
      });
      expect(again).toMatchObject({ ok: true, alreadyInstalled: true });
    },
  );

  it.skipIf(!tarOk)("refuses a checksum mismatch before extracting anything", async () => {
    const release = await fakeRelease();
    const root = await scratch();
    const result = await setupTypst({
      cacheRoot: root,
      deps: common("0".repeat(64), (async () => response(200, release.bytes)) as typeof fetch),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/SHA-256 does not match/);
    expect(result.message).toMatch(/Nothing was extracted/);
    await expect(readFile(join(typstInstallDir(root, "0.15.1"), "typst"))).rejects.toThrow();
  });

  it("refuses redirects to hosts outside GitHub and non-https redirects", async () => {
    expect(allowedHosts).toEqual([
      "github.com",
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
    ]);
    for (const location of [
      "https://evil.example/fake.tar.xz",
      "http://github.com/fake.tar.xz",
      "https://github.com.evil.example/x",
    ]) {
      const root = await scratch();
      const result = await setupTypst({
        cacheRoot: root,
        deps: common("0".repeat(64), (async () =>
          response(302, undefined, { location })) as typeof fetch),
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/redirected to a host that is not allowed/);
    }
  });

  it("reports HTTP failures and unsupported platforms", async () => {
    const root = await scratch();
    const failed = await setupTypst({
      cacheRoot: root,
      deps: common("0".repeat(64), (async () => response(404)) as typeof fetch),
    });
    expect(failed.message).toMatch(/HTTP 404/);
    const unsupported = await setupTypst({
      cacheRoot: root,
      deps: { platform: "freebsd", arch: "x64" },
    });
    expect(unsupported).toMatchObject({
      ok: false,
      message: expect.stringContaining("No pinned Typst build"),
    });
  });
});
