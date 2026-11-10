import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractTarGz } from "../src/engine/tar.js";
import { makeTgz } from "./tar-fixture.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function setup(entries: Parameters<typeof makeTgz>[0]) {
  const dir = await mkdtemp(join(tmpdir(), "sem-tar-"));
  dirs.push(dir);
  const archive = join(dir, "a.tgz");
  await writeFile(archive, makeTgz(entries));
  return { dir, archive, out: join(dir, "out") };
}
const keepJs = (path: string) => (path.endsWith(".js") || path.endsWith(".node") ? path : null);
const signal = new AbortController().signal;
const code = async (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => e.code,
  );

describe("safe tar extraction", () => {
  it("extracts only selected regular files, with sizes and SHA-256", async () => {
    const long = `package/dist/${"deep/".repeat(25)}x.js`;
    const { archive, out } = await setup([
      { name: "package/", type: "5" },
      { name: "package/dist/index.js", data: Buffer.from("module.exports = 1;") },
      { name: "package/README.md", data: Buffer.from("readme") },
      { name: long, data: Buffer.from("// long") },
      { name: "package/bin/a.node", data: Buffer.alloc(3000, 1) },
    ]);
    const files = await extractTarGz(archive, out, keepJs, { signal });
    expect(Object.keys(files).sort()).toEqual(
      ["package/bin/a.node", "package/dist/index.js", long].sort(),
    );
    expect(files["package/bin/a.node"]?.bytes).toBe(3000);
    expect(files["package/dist/index.js"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(out, "package/dist/index.js"), "utf8")).toBe("module.exports = 1;");
    expect((await readdir(join(out, "package"))).sort()).toEqual(["bin", "dist"]);
  });

  it("rejects path traversal, absolute paths and links anywhere in the archive", async () => {
    for (const bad of [
      [{ name: "package/../../evil.js", data: Buffer.from("x") }],
      [{ name: "/etc/evil.js", data: Buffer.from("x") }],
      [{ name: "package\\..\\evil.js", data: Buffer.from("x") }],
      [{ name: "package/link.js", type: "2" as const, linkname: "/etc/passwd" }],
      [{ name: "package/hard.js", type: "1" as const, linkname: "package/a.js" }],
    ]) {
      const { archive, out, dir } = await setup(bad);
      expect(await code(extractTarGz(archive, out, keepJs, { signal }))).toBe("model_corrupt");
      const left = await readdir(dir, { recursive: true });
      expect(
        left.filter(
          (name) =>
            String(name).includes("evil") ||
            String(name).includes("link") ||
            String(name).includes("hard"),
        ),
      ).toEqual([]);
    }
  });

  it("enforces size and entry caps, and rejects a corrupt archive", async () => {
    const { archive, out } = await setup([{ name: "package/big.js", data: Buffer.alloc(5000, 2) }]);
    expect(await code(extractTarGz(archive, out, keepJs, { signal, maxFileBytes: 4000 }))).toBe(
      "model_corrupt",
    );
    const many = await setup(
      Array.from({ length: 12 }, (_, i) => ({ name: `package/f${i}.js`, data: Buffer.from("x") })),
    );
    expect(
      await code(extractTarGz(many.archive, many.out, keepJs, { signal, maxEntries: 10 })),
    ).toBe("model_corrupt");
    const broken = await setup([]);
    await writeFile(broken.archive, Buffer.from("not gzip at all"));
    expect(await code(extractTarGz(broken.archive, broken.out, keepJs, { signal }))).toBe(
      "model_corrupt",
    );
  });

  it("stops on an aborted signal", async () => {
    const { archive, out } = await setup([{ name: "package/a.js", data: Buffer.from("x") }]);
    const controller = new AbortController();
    controller.abort();
    expect(await code(extractTarGz(archive, out, keepJs, { signal: controller.signal }))).toBe(
      "cancelled",
    );
  });
});
