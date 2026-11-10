import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { stack } from "../src/presets.js";
import { buildSnapshot, sourceSnapshot } from "../src/snapshot.js";
import { zip } from "../src/zip.js";

/** Minimal reader: walks the central directory and inflates each entry. */
function unzip(buf: Buffer) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const localName = buf.readUInt16LE(local + 26);
    const localExtra = buf.readUInt16LE(local + 28);
    const comp = buf.readUInt32LE(local + 18);
    const start = local + 30 + localName + localExtra;
    const data = inflateRawSync(buf.subarray(start, start + comp));
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out[name] = data.toString("utf8");
    at += 46 + nameLen;
  }
  return out;
}

describe("zip (LMB-AC-11)", () => {
  it("writes a valid archive with UTF-8 names under one folder", () => {
    const buf = zip([
      { name: "café/index.html", data: Buffer.from("<h1>Hola</h1>") },
      { name: "café/src/app.js", data: Buffer.from("x".repeat(10_000)) },
    ]);
    expect(unzip(buf)).toEqual({
      "café/index.html": "<h1>Hola</h1>",
      "café/src/app.js": "x".repeat(10_000),
    });
  });
});

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

describe("thumbnail snapshots", () => {
  it("takes plain HTML, its stylesheets and SVG images from the sources", () => {
    const snap = sourceSnapshot(
      {
        "index.html":
          '<html><head><link rel="stylesheet" href="styles.css"></head><body><img src="logo.svg"><h1>Bakery downtown</h1></body></html>',
        "styles.css": "h1{color:red}",
        "logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
      },
      "rev-1",
    );
    expect(snap.kind).toBe("static");
    expect(snap.css).toEqual(["h1{color:red}"]);
    expect(snap.assets["logo.svg"]).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(snap.revision).toBe("rev-1");
  });

  it("reads a build's HTML and CSS, and marks script-rendered pages", async () => {
    const work = await mkdtemp(join(tmpdir(), "lmb-snap-"));
    roots.push(work);
    await mkdir(join(work, "dist", "assets"), { recursive: true });
    await writeFile(
      join(work, "dist", "index.html"),
      '<html><head><link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head><body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>',
    );
    await writeFile(join(work, "dist", "assets", "index-abc.css"), ".x{color:blue}");
    const snap = await buildSnapshot(work, stack("react"), "rev-2");
    expect(snap.kind).toBe("script");
    expect(snap.css).toEqual([".x{color:blue}"]);

    await mkdir(join(work, ".next", "server", "app"), { recursive: true });
    await mkdir(join(work, ".next", "static", "css"), { recursive: true });
    await writeFile(
      join(work, ".next", "server", "app", "index.html"),
      '<html><head><link rel="stylesheet" href="/_next/static/css/a.css"/><link rel="stylesheet" href="/../../etc/passwd"/></head><body><main><h1>Next page with text</h1></main></body></html>',
    );
    await writeFile(join(work, ".next", "static", "css", "a.css"), "h1{font-size:3rem}");
    const next = await buildSnapshot(work, stack("next"), "rev-3");
    expect(next.kind).toBe("static");
    expect(next.css).toEqual(["h1{font-size:3rem}"]);
  });

  it("reports none when a build left no page", async () => {
    const work = await mkdtemp(join(tmpdir(), "lmb-snap-"));
    roots.push(work);
    expect((await buildSnapshot(work, stack("astro"), "r")).kind).toBe("none");
  });
});
