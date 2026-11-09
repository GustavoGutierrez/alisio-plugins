#!/usr/bin/env node
// Release maintainer tool: vendors the static (musl) Tectonic binary for linux-x64 into
// compiler/linux-x64/tectonic. node-tectonic's linux-x64 binary needs glibc 2.39; this build runs on
// any x86_64 Linux. Users never run this script; the binary ships in the npm tarball.
//
//   node scripts/vendor-tectonic.mjs                 # download the pinned release asset
//   node scripts/vendor-tectonic.mjs --from <tar.gz> # use an already downloaded copy
//
// The tarball digest is checked before anything is extracted, and the binary digest before it is
// moved into place (atomic rename). Node built-ins only.
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const VERSION = "0.16.9";
const ASSET = `tectonic-${VERSION}-x86_64-unknown-linux-musl.tar.gz`;
const URL_ = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/${ASSET}`;
const TARBALL_SHA256 = "60b13a0826ae7ad9ce34b4a2df06bff2cfcfa6dda8a915477c0cbb84e1a4a902";
const BINARY_SHA256 = "397efac4cabf7dfa02f238fe23681215b535ea665e99ba27d123b8bc655b88cb";
const MAX_TARBALL = 64 * 1024 * 1024;
const TARGET = fileURLToPath(new URL("../compiler/linux-x64/tectonic", import.meta.url));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function download() {
  const response = await fetch(URL_, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_TARBALL) throw new Error("Download exceeds the expected size");
  return bytes;
}

/** Contents of the regular file whose basename is `name` in a ustar archive. */
function extract(tar, name) {
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const prefix = field(345, 155);
    const path = (prefix ? `${prefix}/` : "") + field(0, 100);
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1) || "0";
    const body = offset + 512;
    if (!Number.isFinite(size) || size < 0 || body + size > tar.length)
      throw new Error("Corrupt archive");
    if (type === "0" && path.replace(/^\.\//, "") === name)
      return Buffer.from(tar.subarray(body, body + size));
    offset = body + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${name} not found in the archive`);
}

const from = process.argv.indexOf("--from");
const tarball = from > 0 ? await readFile(process.argv[from + 1]) : await download();
if (sha256(tarball) !== TARBALL_SHA256) throw new Error(`Unexpected ${ASSET} digest`);
const binary = extract(gunzipSync(tarball), "tectonic");
if (sha256(binary) !== BINARY_SHA256) throw new Error("Unexpected tectonic binary digest");

await mkdir(dirname(TARGET), { recursive: true });
const temp = `${TARGET}.${randomUUID()}.tmp`;
try {
  await writeFile(temp, binary, { mode: 0o755 });
  await chmod(temp, 0o755);
  await rename(temp, TARGET);
} finally {
  await rm(temp, { force: true });
}
console.log(`Vendored Tectonic ${VERSION} (linux-x64, static musl) at compiler/linux-x64/tectonic`);
