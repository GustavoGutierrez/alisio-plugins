import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DownloadProgress, ProgressTracker } from "../src/engine/download.js";
import {
  installRuntime,
  isRuntimeReady,
  loadRuntime,
  RUNTIME_PACKAGES,
  runtimeBytes,
  runtimePath,
  runtimeSupported,
} from "../src/engine/runtime.js";
import { fakeFetcher } from "./model-fixture.js";
import { fakeRuntime } from "./runtime-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});
async function cache() {
  const root = await mkdtemp(join(tmpdir(), "sem-rt-"));
  roots.push(root);
  return root;
}
const target = { platform: "linux", arch: "x64" };
const tracker = (packages: { bytes: number }[], events?: DownloadProgress[]) =>
  new ProgressTracker(runtimeBytes(packages as never), packages.length, (p) => events?.push(p));
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => e.code,
  );

describe("ONNX Runtime on first use (O9)", () => {
  it("pins the real tarballs by version and sha512 integrity over HTTPS", () => {
    for (const pkg of RUNTIME_PACKAGES) {
      expect(pkg.url).toMatch(
        /^https:\/\/registry\.npmjs\.org\/onnxruntime-(node|common)\/-\/onnxruntime-(node|common)-1\.30\.0\.tgz$/,
      );
      expect(pkg.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    }
    expect(runtimeSupported({ platform: "linux", arch: "x64" })).toBe(true);
    expect(runtimeSupported({ platform: "darwin", arch: "x64" })).toBe(false);
  });

  it("extracts only this platform's CPU files and the loaders, then loads them from the cache", async () => {
    const root = await cache();
    const { packages, served } = fakeRuntime();
    const events: DownloadProgress[] = [];
    const result = await installRuntime(root, {
      fetcher: fakeFetcher(served, { chunk: 500 }).fetcher,
      signal: new AbortController().signal,
      tracker: tracker(packages, events),
      target,
      packages,
    });
    expect(result.installed).toBe(true);
    expect(await isRuntimeReady(root, target, packages)).toBe(true);
    const dir = runtimePath(root, target);
    const files = (await readdir(dir, { recursive: true }))
      .map(String)
      .filter((f) => /\.(js|json|node|1)$/.test(f))
      .sort();
    expect(files).toEqual(
      [
        ".verified.json",
        "node_modules/onnxruntime-common/dist/cjs/index.js",
        "node_modules/onnxruntime-common/dist/cjs/package.json",
        "node_modules/onnxruntime-common/package.json",
        "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1",
        "node_modules/onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
        "node_modules/onnxruntime-node/dist/index.js",
        "node_modules/onnxruntime-node/package.json",
      ].sort(),
    );
    expect(loadRuntime<{ fake: boolean; common: { common: boolean } }>(dir)).toEqual({
      fake: true,
      common: { common: true },
    });
    // Monotonic overall progress with known totals, from 0 to 1.
    expect(events[0]?.fraction).toBe(0);
    expect(events.at(-1)?.fraction).toBe(1);
    for (let i = 1; i < events.length; i++)
      expect(events[i]!.bytes).toBeGreaterThanOrEqual(events[i - 1]!.bytes);
    expect((await readdir(root)).sort()).toEqual([`onnxruntime-1.30.0-linux-x64`]);
    // Ready: nothing is downloaded again.
    const again = fakeFetcher(served);
    expect(
      (
        await installRuntime(root, {
          fetcher: again.fetcher,
          signal: new AbortController().signal,
          tracker: tracker(packages),
          target,
          packages,
        })
      ).installed,
    ).toBe(false);
    expect(again.log).toEqual([]);
  });

  it("rejects a tarball whose integrity does not match and installs nothing", async () => {
    const root = await cache();
    const { packages, served } = fakeRuntime();
    const tampered = {
      ...served,
      "ort-node.tgz": Buffer.from(served["ort-node.tgz"]).fill(7, 100, 120),
    };
    expect(
      await code(
        installRuntime(root, {
          fetcher: fakeFetcher(tampered).fetcher,
          signal: new AbortController().signal,
          tracker: tracker(packages),
          target,
          packages,
        }),
      ),
    ).toBe("model_corrupt");
    expect(await isRuntimeReady(root, target, packages)).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects path traversal inside a verified tarball and leaves nothing behind", async () => {
    const root = await cache();
    const { packages, served } = fakeRuntime([
      { name: "package/../../escape.js", data: Buffer.from("x") },
    ]);
    expect(
      await code(
        installRuntime(root, {
          fetcher: fakeFetcher(served).fetcher,
          signal: new AbortController().signal,
          tracker: tracker(packages),
          target,
          packages,
        }),
      ),
    ).toBe("model_corrupt");
    expect(await readdir(root)).toEqual([]);
    expect((await readdir(join(root, ".."))).includes("escape.js")).toBe(false);
  });

  it("cancels cleanly: no partial tarball, no temp directory", async () => {
    const root = await cache();
    const { packages, served } = fakeRuntime();
    const controller = new AbortController();
    const run = installRuntime(root, {
      fetcher: fakeFetcher(served, { chunk: 100 }).fetcher,
      signal: controller.signal,
      tracker: new ProgressTracker(runtimeBytes(packages), 2, (p) => {
        if (p.fileIndex === 1 && p.fileBytes > 200) controller.abort();
      }),
      target,
      packages,
    });
    expect(await code(run)).toBe("cancelled");
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses a platform without a binary in the pinned tarball", async () => {
    const root = await cache();
    const { packages, served } = fakeRuntime();
    expect(
      await code(
        installRuntime(root, {
          fetcher: fakeFetcher(served).fetcher,
          signal: new AbortController().signal,
          tracker: tracker(packages),
          target: { platform: "darwin", arch: "x64" },
          packages,
        }),
      ),
    ).toBe("engine_unavailable");
  });
});
