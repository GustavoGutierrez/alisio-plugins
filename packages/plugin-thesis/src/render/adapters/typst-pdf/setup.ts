import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { typstInstallDir } from "../../../cache.js";
import { type TypstPin, typstPins, typstReleaseBase, typstVersion } from "../../../typst-pins.js";
import { parseTypstVersion } from "./version.js";

const execFileAsync = promisify(execFile);

/** Release downloads redirect from github.com to GitHub's own object storage hosts, nowhere else. */
export const allowedHosts: readonly string[] = [
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];
const maxBytes = 120 * 1024 * 1024;
const maxRedirects = 5;
const downloadTimeoutMs = 120_000;

export interface SetupDeps {
  fetch: typeof fetch;
  run(file: string, args: string[]): Promise<string>;
  platform: string;
  arch: string;
  pins: Record<string, TypstPin>;
  releaseBase: string;
  version: string;
}

const defaultDeps = (): SetupDeps => ({
  fetch: globalThis.fetch,
  async run(file, args) {
    const { stdout } = await execFileAsync(file, args, {
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
    });
    return stdout;
  },
  platform: process.platform,
  arch: process.arch,
  pins: typstPins,
  releaseBase: typstReleaseBase,
  version: typstVersion,
});

export interface SetupResult {
  ok: boolean;
  message: string;
  path?: string;
  version?: string;
  alreadyInstalled?: boolean;
}

function checkRedirect(location: string, from: string): URL {
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    throw new Error("The download redirected to an invalid address");
  }
  if (target.protocol !== "https:" || !allowedHosts.includes(target.hostname)) {
    throw new Error(`The download redirected to a host that is not allowed (${target.hostname})`);
  }
  return target;
}

async function download(
  url: string,
  destination: string,
  deps: SetupDeps,
  signal: AbortSignal | undefined,
): Promise<string> {
  let current = checkRedirect(url, url);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await deps.fetch(current, {
      redirect: "manual",
      signal: AbortSignal.any([
        AbortSignal.timeout(downloadTimeoutMs),
        ...(signal ? [signal] : []),
      ]),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The download redirected without a location");
      current = checkRedirect(location, current.href);
      continue;
    }
    if (response.status !== 200 || !response.body) {
      throw new Error(`The download failed with HTTP ${response.status}`);
    }
    const hash = createHash("sha256");
    const file = createWriteStream(destination, { flags: "wx", mode: 0o600 });
    let size = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("The download is larger than the allowed size");
        hash.update(chunk);
        if (!file.write(chunk)) await new Promise((resolve) => file.once("drain", resolve));
      }
    } finally {
      await new Promise<void>((resolve) => file.end(resolve));
    }
    return hash.digest("hex");
  }
  throw new Error("The download redirected too many times");
}

async function installedVersion(binary: string, deps: SetupDeps): Promise<string | undefined> {
  try {
    const parsed = parseTypstVersion(await deps.run(binary, ["--version"]));
    return parsed?.join(".");
  } catch {
    return undefined;
  }
}

/**
 * `/thesis:setup`: install the pinned Typst into the cache. The only place the plugin downloads an
 * engine; the SHA-256 is verified before anything is extracted, and extraction uses the system
 * `tar` with an argv array (no shell).
 */
export async function setupTypst(options: {
  cacheRoot: string;
  deps?: Partial<SetupDeps>;
  signal?: AbortSignal;
}): Promise<SetupResult> {
  const deps = { ...defaultDeps(), ...options.deps };
  const key = `${deps.platform}-${deps.arch}`;
  const pin = deps.pins[key];
  if (!pin) {
    return {
      ok: false,
      message: `No pinned Typst build exists for ${key}. Install Typst ${deps.version} yourself and set ALISIO_THESIS_TYPST.`,
    };
  }
  const installDir = typstInstallDir(options.cacheRoot, deps.version);
  const binary = join(installDir, pin.executable);
  const existing = await installedVersion(binary, deps);
  if (existing === deps.version) {
    return {
      ok: true,
      alreadyInstalled: true,
      path: binary,
      version: existing,
      message: `Typst ${existing} is already installed in the cache.`,
    };
  }

  const parent = join(options.cacheRoot, "thesis", "typst");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const work = join(parent, `.setup-${randomUUID()}`);
  await mkdir(work, { mode: 0o700 });
  const archive = join(work, pin.asset);
  try {
    let digest: string;
    try {
      digest = await download(`${deps.releaseBase}${pin.asset}`, archive, deps, options.signal);
    } catch (error) {
      return { ok: false, message: `Typst download failed: ${(error as Error).message}` };
    }
    if (digest !== pin.sha256) {
      return {
        ok: false,
        message: `Typst download rejected: its SHA-256 does not match the pinned value (${digest.slice(0, 12)}...). Nothing was extracted.`,
      };
    }
    const staging = join(work, "extract");
    await mkdir(staging, { mode: 0o700 });
    try {
      await deps.run("tar", ["-xf", archive, "-C", staging, "--strip-components=1"]);
    } catch (error) {
      return {
        ok: false,
        message: `Could not extract the Typst archive: ${(error as Error).message}`,
      };
    }
    try {
      await stat(join(staging, pin.executable));
    } catch {
      return { ok: false, message: "The Typst archive did not contain the expected executable." };
    }
    if (deps.platform !== "win32") await chmod(join(staging, pin.executable), 0o755);
    const version = await installedVersion(join(staging, pin.executable), deps);
    if (version !== deps.version) {
      return {
        ok: false,
        message: `The extracted Typst reports ${version ?? "no version"} instead of ${deps.version}.`,
      };
    }
    await rm(installDir, { recursive: true, force: true });
    await rename(staging, installDir);
    return {
      ok: true,
      path: binary,
      version,
      message: `Installed Typst ${version} into the cache (${pin.asset}, checksum verified).`,
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
