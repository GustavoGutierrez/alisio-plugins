import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { main, resolveThesisRoot } from "../src/cli.js";
import { defaultState, writeState } from "../src/storage.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function copy(fixture: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thesis-cli-"));
  dirs.push(dir);
  await cp(join(fixtures, fixture), dir, { recursive: true });
  return dir;
}

async function run(args: string[], cwd: string) {
  let out = "";
  let err = "";
  const code = await main(args, { cwd, stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("alisio-thesis check", () => {
  it("exits 0 on the valid fixture and prints a human report", async () => {
    const dir = await copy("workspace-valid");
    const { code, out } = await run(["check", dir], "/");
    expect(code).toBe(0);
    expect(out).toContain("Checks passed");
  });

  it("exits 1 on a broken brief and names the problems with lines", async () => {
    const dir = await copy("workspace-broken");
    const { code, out } = await run(["check", dir], "/");
    expect(code).toBe(1);
    expect(out).toContain("Checks failed");
    expect(out).toMatch(/BRF-003/);
    expect(out).toMatch(/BRF-002 \[G0\] thesis\.yaml:6/);
  });

  it("emits JSON and writes build/check-report.json unless told not to", async () => {
    const dir = await copy("workspace-valid");
    const json = await run(["check", dir, "--json", "--no-write"], "/");
    expect(JSON.parse(json.out)).toMatchObject({ ok: true, counts: { error: 0 } });
    expect(await exists(join(dir, "thesis", "build", "check-report.json"))).toBe(false);
    await run(["check", dir], "/");
    expect(
      JSON.parse(await readFile(join(dir, "thesis", "build", "check-report.json"), "utf8")).ok,
    ).toBe(true);
  });

  it("defaults to the current directory and accepts the thesis folder itself", async () => {
    const dir = await copy("workspace-valid");
    expect((await run(["check"], dir)).code).toBe(0);
    expect((await run(["check", join(dir, "thesis"), "--no-write"], "/")).code).toBe(0);
  });

  it("honours the root recorded in the state file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thesis-cli-"));
    dirs.push(dir);
    await mkdir(join(dir, "work"), { recursive: true });
    await cp(
      join(fixtures, "workspace-valid", "thesis", "thesis.yaml"),
      join(dir, "work", "thesis.yaml"),
    );
    await writeState(dir, defaultState("work"));
    expect(await resolveThesisRoot(dir)).toBe(join(dir, "work"));
    expect((await run(["check", dir, "--no-write"], "/")).code).toBe(0);
  });

  it("filters by gate", async () => {
    const dir = await copy("workspace-broken");
    const { code, out } = await run(["check", dir, "--gate", "G7", "--no-write"], "/");
    expect(code).toBe(0);
    expect(out).toContain("Checks passed");
  });

  it("exits 1 when a chapter leaks a local path", async () => {
    const dir = await copy("workspace-valid");
    await mkdir(join(dir, "thesis", "chapters"), { recursive: true });
    await writeFile(
      join(dir, "thesis", "chapters", "01.md"),
      `Data in ${["", "home", "x", "data.csv"].join("/")}\n`,
    );
    const { code, out } = await run(["check", dir, "--no-write"], "/");
    expect(code).toBe(1);
    expect(out).toContain("HYG-001");
  });

  it("exits 2 on usage and environment errors", async () => {
    const dir = await copy("workspace-valid");
    expect((await run([], dir)).code).toBe(2);
    expect((await run(["frobnicate"], dir)).code).toBe(2);
    expect((await run(["check", join(dir, "missing")], dir)).code).toBe(2);
    expect((await run(["check", "--gate", "G99"], dir)).code).toBe(2);
    expect((await run(["check", "--bogus"], dir)).code).toBe(2);
    expect((await run(["check", "a", "b"], dir)).code).toBe(2);
    const empty = await mkdtemp(join(tmpdir(), "thesis-cli-"));
    dirs.push(empty);
    const none = await run(["check", empty], "/");
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/No thesis folder found/);
  });

  it("reports a missing thesis.yaml inside an existing thesis folder as a failed check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "thesis-cli-"));
    dirs.push(dir);
    await mkdir(join(dir, "thesis"));
    expect((await run(["check", dir, "--no-write"], "/")).code).toBe(1);
  });

  it("prints help and version", async () => {
    expect((await run(["--help"], "/")).code).toBe(0);
    expect((await run(["--version"], "/")).out).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("alisio-thesis doctor", () => {
  it("prints a report and exits 0", async () => {
    const { code, out } = await run(["doctor"], "/");
    expect(code).toBe(0);
    expect(out).toContain("report only");
    const json = await run(["doctor", "--json"], "/");
    expect(JSON.parse(json.out).items.length).toBeGreaterThan(3);
    expect((await run(["doctor", "extra"], "/")).code).toBe(2);
  });
});
