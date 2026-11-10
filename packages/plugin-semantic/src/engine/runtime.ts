// ONNX Runtime fetched on first use (owner O9): the pinned onnxruntime-node npm tarball is
// downloaded once, verified against the registry's sha512 integrity, and only the current
// platform's CPU binaries plus the JS loader are extracted into the cache. No npm, no install
// scripts, never the CUDA/TensorRT providers.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { SemanticPluginError } from "../errors.js";
import { type Fetcher, failDownload, fetchVerified, type ProgressTracker } from "./download.js";
import { extractTarGz } from "./tar.js";

export const ORT_VERSION = "1.30.0";
const NAPI = "napi-v6";

export interface RuntimePackage {
  name: string;
  version: string;
  url: string;
  /** Size of the tarball. */
  bytes: number;
  /** `dist.integrity` from the npm registry (sha512, base64). */
  integrity: string;
  /** Archive path -> path under the package directory, or null to skip. */
  select(path: string, platform: string, arch: string): string | null;
}

const strip = (path: string) =>
  path.startsWith("package/") ? path.slice("package/".length) : null;
const GPU = /cuda|tensorrt/i;

/** The pinned packages (read from the npm registry on 2026-11-10). */
export const RUNTIME_PACKAGES: RuntimePackage[] = [
  {
    name: "onnxruntime-node",
    version: ORT_VERSION,
    url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ORT_VERSION}.tgz`,
    bytes: 113_507_888,
    integrity:
      "sha512-twhs1C2C/BFkz1yc5OY0KIU2GUq6DURO7hD4bx5Q2Qy3nAMJwRXW8xU3NVczE29VA9lolLOYepoD8fjTGOfIqw==",
    select(path, platform, arch) {
      const rel = strip(path);
      if (!rel) return null;
      if (rel === "package.json") return rel;
      if (/^dist\/[^/]+\.js$/.test(rel)) return rel;
      const bin = `bin/${NAPI}/${platform}/${arch}/`;
      if (rel.startsWith(bin) && !rel.slice(bin.length).includes("/") && !GPU.test(rel)) return rel;
      return null;
    },
  },
  {
    name: "onnxruntime-common",
    version: ORT_VERSION,
    url: `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${ORT_VERSION}.tgz`,
    bytes: 66_795,
    integrity:
      "sha512-7fdVWjAID1dVhH/G8qK3APARunV4VkBFoCQAP7qp4Wkab0mrorvmc+sqiT+mKXOzDqdjN5j+/Z9nb4gzNPWcyA==",
    select(path) {
      const rel = strip(path);
      if (!rel) return null;
      if (rel === "package.json") return rel;
      if (/^dist\/cjs\/.+\.js$/.test(rel) || rel === "dist/cjs/package.json") return rel;
      return null;
    },
  },
];

/** Platforms with a CPU binary in the pinned tarball. */
export const RUNTIME_PLATFORMS = [
  "linux/x64",
  "linux/arm64",
  "darwin/arm64",
  "win32/x64",
  "win32/arm64",
];

export interface RuntimeTarget {
  platform: string;
  arch: string;
}
export const currentTarget = (): RuntimeTarget => ({
  platform: process.platform,
  arch: process.arch,
});
export const runtimeSupported = (target: RuntimeTarget = currentTarget()) =>
  RUNTIME_PLATFORMS.includes(`${target.platform}/${target.arch}`);

/** Directory of the extracted runtime for one platform. */
export const runtimePath = (cacheRoot: string, target: RuntimeTarget = currentTarget()) =>
  join(cacheRoot, `onnxruntime-${ORT_VERSION}-${target.platform}-${target.arch}`);

export const runtimeBytes = (packages: RuntimePackage[] = RUNTIME_PACKAGES) =>
  packages.reduce((sum, p) => sum + p.bytes, 0);

const MARKER = ".verified.json";
interface Marker {
  version: string;
  platform: string;
  arch: string;
  integrity: string[];
  files: Record<string, { bytes: number; sha256: string }>;
}

/** Cheap check: the marker matches the pinned packages and every extracted file has its size. */
export async function isRuntimeReady(
  cacheRoot: string,
  target: RuntimeTarget = currentTarget(),
  packages: RuntimePackage[] = RUNTIME_PACKAGES,
): Promise<boolean> {
  const dir = runtimePath(cacheRoot, target);
  let marker: Marker;
  try {
    marker = JSON.parse(await readFile(join(dir, MARKER), "utf8")) as Marker;
  } catch {
    return false;
  }
  if (
    marker.version !== ORT_VERSION ||
    marker.platform !== target.platform ||
    marker.arch !== target.arch
  )
    return false;
  if (JSON.stringify(marker.integrity) !== JSON.stringify(packages.map((p) => p.integrity)))
    return false;
  const files = Object.entries(marker.files ?? {});
  if (!files.some(([path]) => path.endsWith("onnxruntime_binding.node"))) return false;
  for (const [path, info] of files) {
    const s = await stat(join(dir, path)).catch(() => undefined);
    if (!s?.isFile() || s.size !== info.bytes) return false;
  }
  return true;
}

export interface InstallOptions {
  fetcher?: Fetcher;
  signal: AbortSignal;
  tracker: ProgressTracker;
  target?: RuntimeTarget;
  packages?: RuntimePackage[];
}

/**
 * Downloads, verifies and extracts the runtime atomically (temp directory, then rename). A
 * cancelled or failed install removes its partial tarball and temp directory; a tarball left by a
 * crash is resumed with `Range` and verified as a whole.
 */
export async function installRuntime(
  cacheRoot: string,
  options: InstallOptions,
): Promise<{ installed: boolean }> {
  const target = options.target ?? currentTarget();
  const packages = options.packages ?? RUNTIME_PACKAGES;
  const { signal, tracker } = options;
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as Fetcher);
  if (!runtimeSupported(target)) throw new SemanticPluginError("engine_unavailable");
  if (await isRuntimeReady(cacheRoot, target, packages)) return { installed: false };
  const partialDir = join(cacheRoot, ".partial", "runtime");
  const temp = join(cacheRoot, ".partial", `runtime-${randomUUID()}`);
  await mkdir(partialDir, { recursive: true, mode: 0o700 });
  const files: Marker["files"] = {};
  try {
    for (const pkg of packages) {
      signal.throwIfAborted();
      const archive = join(partialDir, `${pkg.name}-${pkg.version}.tgz`);
      tracker.begin(`${pkg.name}-${pkg.version}.tgz`, pkg.bytes);
      const [algorithm, value] = pkg.integrity.split("-", 2) as [string, string];
      if (algorithm !== "sha512" || !value) throw new SemanticPluginError("model_corrupt");
      try {
        await fetchVerified(
          fetcher,
          pkg.url,
          archive,
          pkg.bytes,
          { algorithm: "sha512", value, encoding: "base64" },
          signal,
          (n) => tracker.update(n),
        );
      } catch (error) {
        await failDownload(archive, error, signal);
      }
      const base = join("node_modules", pkg.name);
      const extracted = await extractTarGz(
        archive,
        join(temp, base),
        (path) => pkg.select(path, target.platform, target.arch),
        { signal },
      );
      for (const [path, info] of Object.entries(extracted)) files[`${base}/${path}`] = info;
      await rm(archive, { force: true });
      tracker.end();
    }
    if (!Object.keys(files).some((path) => path.endsWith("onnxruntime_binding.node")))
      throw new SemanticPluginError("engine_unavailable");
    const marker: Marker = {
      version: ORT_VERSION,
      platform: target.platform,
      arch: target.arch,
      integrity: packages.map((p) => p.integrity),
      files,
    };
    await writeFile(join(temp, MARKER), JSON.stringify(marker), { mode: 0o600 });
    const final = runtimePath(cacheRoot, target);
    await rm(final, { recursive: true, force: true });
    await mkdir(dirname(final), { recursive: true, mode: 0o700 });
    await rename(temp, final);
    return { installed: true };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    if (signal.aborted) {
      await rm(partialDir, { recursive: true, force: true });
      throw new SemanticPluginError("cancelled");
    }
    throw error instanceof SemanticPluginError ? error : new SemanticPluginError("download_failed");
  } finally {
    await rm(partialDir, { recursive: true, force: true }).catch(() => {});
    await rmdir(join(cacheRoot, ".partial")).catch(() => {});
  }
}

/** Loads the cached runtime (CommonJS) from its own directory, never from the plugin's deps. */
export function loadRuntime<T = unknown>(dir: string): T {
  const require = createRequire(join(dir, "loader.cjs"));
  return require("onnxruntime-node") as T;
}
