import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryPath } from "node-tectonic";
import { type BundleManifest, describeReport, loadManifest, preflight } from "./preflight.js";
import { type Document, ScribeError } from "./types.js";

export function assetFingerprint(d: Pick<Document, "assets">) {
  return createHash("sha256")
    .update(JSON.stringify(d.assets.map((a) => [a.path, a.base64])))
    .digest("hex");
}

/**
 * Variable names (compared case-insensitively, as Windows does) forwarded to Tectonic; everything
 * else in `process.env` is dropped.
 */
const ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  // Tectonic resolves its format/bundle cache from these.
  "XDG_CACHE_HOME",
  "TECTONIC_CACHE_DIR",
  "SOURCE_DATE_EPOCH",
  // Windows needs these for process startup and the per-user cache directory.
  "SYSTEMROOT",
  "WINDIR",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
]);

/**
 * Minimal environment for the Tectonic child: the allowlisted names above plus `LC_*` locale
 * variables, with untrusted mode forced on. Credentials and host configuration never reach it.
 */
export function tectonicEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (ENV_NAMES.has(upper) || /^LC_[A-Z_]+$/.test(upper)) env[name] = value;
  }
  env.TECTONIC_UNTRUSTED_MODE = "1";
  return env;
}

/**
 * Static (musl) Tectonic 0.16.9 shipped with the package for linux-x64, written by
 * `scripts/vendor-tectonic.mjs`. node-tectonic's linux-x64 build is linked against glibc 2.39, which
 * Ubuntu 22.04 and Debian 12 lack; the static build runs on any x86_64 Linux.
 */
export const VENDORED_LINUX_X64 = fileURLToPath(
  new URL("../compiler/linux-x64/tectonic", import.meta.url),
);

/** True when `path` is a regular file that is (or could be made) executable. */
function usableBinary(path: string): boolean {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size === 0) return false;
    if ((info.mode & 0o111) === 0) chmodSync(path, 0o755);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tectonic executable for this machine: the vendored static binary on linux-x64 when it is present,
 * otherwise the platform binary of node-tectonic (linux-arm64 is already a static musl build there).
 */
export function enginePath(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  vendored: string = VENDORED_LINUX_X64,
  fallback: () => string = binaryPath,
): string {
  if (platform === "linux" && arch === "x64" && usableBinary(vendored)) return vendored;
  return fallback();
}

const TIMEOUT_MS = 180_000;
const MAX_LOG = 256_000;
const MAX_PDF = 64 * 1024 * 1024;

/** Managed native engine: installed with the plugin, no system TeX or container required.
 * Untrusted mode is defense in depth, not an OS sandbox. Session process permission still applies.
 * When the bundle manifest is present, documents needing packages the bundle lacks fail fast with
 * `latex_package_missing` instead of a long engine run.
 */
export async function compilePdf(
  document: Pick<Document, "assets" | "revisions">,
  outputRoot: string,
  signal: AbortSignal,
  manifest: BundleManifest | null = loadManifest(),
) {
  signal.throwIfAborted();
  const revision = document.revisions?.at(-1);
  if (!revision) throw new ScribeError("invalid_input");
  const report = manifest ? preflight(revision.tex, manifest) : null;
  if (report) throw new ScribeError("latex_package_missing", describeReport(report));
  const dir = await mkdtemp(join(tmpdir(), "scribe-"));
  try {
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "main.tex"), revision.tex);
    await writeFile(join(dir, "references.bib"), revision.bib);
    for (const asset of document.assets) {
      if (!/^assets\/[a-f0-9-]{36}\.[a-z]+$/.test(asset.path))
        throw new ScribeError("invalid_input");
      await writeFile(join(dir, asset.path), Buffer.from(asset.base64, "base64"));
    }
    let log = "";
    let executable: string;
    try {
      executable = enginePath();
    } catch {
      throw new ScribeError("compiler_unavailable");
    }
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const bundle = fileURLToPath(new URL("../compiler/bundle.zip", import.meta.url));
      const child = spawn(
        executable,
        ["--bundle", bundle, "--untrusted", "--keep-logs", "--outdir", dir, join(dir, "main.tex")],
        {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          env: tectonicEnv(),
        },
      );
      let stopped = false;
      const stop = () => {
        stopped = true;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(stop, TIMEOUT_MS);
      signal.addEventListener("abort", stop, { once: true });
      const collect = (chunk: Buffer) => {
        log += chunk.toString();
        if (log.length > MAX_LOG) stop();
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      };
      child.once("error", () => {
        cleanup();
        reject(new ScribeError("compiler_unavailable"));
      });
      child.once("close", (code) => {
        cleanup();
        if (stopped) reject(new ScribeError(signal.aborted ? "cancelled" : "compile_limit"));
        else if (code !== 0)
          reject(
            new ScribeError(
              /download|network|resolve|connect|HTTP/i.test(log)
                ? "compiler_network"
                : "compile_failed",
              log.slice(-6000),
            ),
          );
        else resolve();
      });
    });
    signal.throwIfAborted();
    const path = join(dir, "main.pdf");
    if ((await stat(path)).size > MAX_PDF) throw new ScribeError("compile_limit");
    const pdf = await readFile(path);
    if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new ScribeError("invalid_pdf");
    const filename = `pdf-${randomUUID()}.pdf`;
    // Temp file in the destination directory, then rename: readers never see a partial PDF.
    const temp = join(outputRoot, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, pdf, { mode: 0o600 });
      await rename(temp, join(outputRoot, filename));
    } finally {
      await rm(temp, { force: true });
    }
    return {
      filename,
      revision: revision.id,
      assetFingerprint: assetFingerprint(document),
      at: new Date().toISOString(),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
