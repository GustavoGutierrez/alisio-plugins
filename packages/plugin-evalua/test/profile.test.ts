import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyLogo,
  detectImageKind,
  parseProfile,
  readProfile,
  stringifyProfile,
  validateProfile,
  writeProfile,
} from "../src/profile.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WEBP"),
  Buffer.alloc(16),
]);

const dirs: string[] = [];
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "evalua-prof-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("profile validation", () => {
  const base = { teacherName: "Ana Perez", institution: "Instituto Demo" };

  it("applies defaults", () => {
    expect(validateProfile(base)).toEqual({
      schemaVersion: 1,
      teacherName: "Ana Perez",
      institution: "Instituto Demo",
      subject: "Matemáticas",
      language: "es",
      paper: "letter",
    });
  });

  it("rejects missing, empty, control-char and overlong fields", () => {
    expect(() => validateProfile({ institution: "x" })).toThrow(/teacherName/);
    expect(() => validateProfile({ ...base, teacherName: "  " })).toThrow(/teacherName/);
    expect(() => validateProfile({ ...base, institution: "a\nb" })).toThrow(/institution/);
    expect(() => validateProfile({ ...base, subject: "x".repeat(200) })).toThrow(/subject/);
  });

  it("rejects bad paper, language, logo path and schemaVersion", () => {
    expect(() => validateProfile({ ...base, paper: "legal" })).toThrow(/paper/);
    expect(() => validateProfile({ ...base, language: "Spanish!" })).toThrow(/language/);
    expect(() => validateProfile({ ...base, logo: "../x.png" })).toThrow(/logo/);
    expect(() => validateProfile({ ...base, logo: "assets/logo.svg" })).toThrow(/logo/);
    expect(() => validateProfile({ ...base, schemaVersion: 2 })).toThrow(/schemaVersion/);
  });

  it("round-trips through YAML and rejects aliases and non-mappings", () => {
    const profile = validateProfile({ ...base, logo: "assets/logo.png" });
    expect(parseProfile(stringifyProfile(profile))).toEqual(profile);
    expect(() => parseProfile("- a\n- b\n")).toThrow(/mapping/);
    expect(() => parseProfile("a: &x 1\nb: *x\n")).toThrow();
    expect(() => parseProfile(`teacherName: ${"x".repeat(70_000)}`)).toThrow(/too large/);
  });
});

describe("profile files", () => {
  it("reads undefined when missing, writes and reads back", async () => {
    const root = await scratch();
    expect(await readProfile(root)).toBeUndefined();
    const profile = validateProfile({ teacherName: "Ana", institution: "Demo" });
    await writeProfile(root, profile);
    expect(await readProfile(root)).toEqual(profile);
    expect((await stat(join(root, "teacher.yaml"))).mode & 0o777).toBe(0o644);
  });

  it("reports an actionable error for an invalid file", async () => {
    const root = await scratch();
    await writeFile(join(root, "teacher.yaml"), "teacherName: 3\n");
    await expect(readProfile(root)).rejects.toThrow(/teacher\.yaml/);
  });
});

describe("logo", () => {
  it("detects raster kinds by magic bytes and flags SVG", () => {
    expect(detectImageKind(PNG)).toBe("png");
    expect(detectImageKind(JPEG)).toBe("jpg");
    expect(detectImageKind(WEBP)).toBe("webp");
    expect(detectImageKind(Buffer.from('<?xml version="1.0"?><svg/>'))).toBe("svg");
    expect(detectImageKind(Buffer.from("  <svg xmlns='x'/>"))).toBe("svg");
    expect(detectImageKind(Buffer.from("hello world"))).toBeUndefined();
  });

  it("copies a valid logo into assets/ using the detected extension", async () => {
    const root = await scratch();
    const source = join(await scratch(), "my picture.bin");
    await writeFile(source, PNG);
    const relative = await copyLogo(root, source);
    expect(relative).toBe("assets/logo.png");
    expect((await readFile(join(root, relative))).equals(PNG)).toBe(true);
  });

  it("replaces a previous logo of another format", async () => {
    const root = await scratch();
    const dir = await scratch();
    await writeFile(join(dir, "a"), PNG);
    await writeFile(join(dir, "b"), JPEG);
    await copyLogo(root, join(dir, "a"));
    expect(await copyLogo(root, join(dir, "b"))).toBe("assets/logo.jpg");
    await expect(stat(join(root, "assets", "logo.png"))).rejects.toThrow();
  });

  it("rejects SVG, wrong magic bytes, oversize, directories and missing files", async () => {
    const root = await scratch();
    const dir = await scratch();
    await writeFile(join(dir, "x.png"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await expect(copyLogo(root, join(dir, "x.png"))).rejects.toThrow(/SVG/);
    await writeFile(join(dir, "y.png"), "not an image at all");
    await expect(copyLogo(root, join(dir, "y.png"))).rejects.toThrow(/PNG, JPEG or WebP/);
    await writeFile(join(dir, "big.png"), Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
    await expect(copyLogo(root, join(dir, "big.png"))).rejects.toThrow(/2 MB/);
    await mkdir(join(dir, "folder"));
    await expect(copyLogo(root, join(dir, "folder"))).rejects.toThrow(/regular file/);
    await expect(copyLogo(root, join(dir, "missing.png"))).rejects.toThrow(/not found/i);
  });

  it("refuses to write the logo through a symlinked assets directory", async () => {
    const root = await scratch();
    const outside = await scratch();
    await symlink(outside, join(root, "assets"));
    const dir = await scratch();
    await writeFile(join(dir, "a.png"), PNG);
    await expect(copyLogo(root, join(dir, "a.png"))).rejects.toThrow(/escapes/);
  });
});
