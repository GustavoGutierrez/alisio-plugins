import { cp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/interface/cli/main.js";
import { type TempWorkspace, tempWorkspace } from "./helpers/workspace.js";

let ws: TempWorkspace | undefined;
afterEach(async () => {
  await ws?.cleanup();
  ws = undefined;
});

const fixture = (name: string) => new URL(`./fixtures/projects/${name}`, import.meta.url).pathname;

function io(cwd = process.cwd()) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { cwd, stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) },
  };
}

describe("alisio-frontsmith detect", () => {
  it("prints the StackProfile as JSON and exits 0", async () => {
    ws = await tempWorkspace();
    await cp(fixture("react-fsd"), ws.root, { recursive: true });
    const run = io();
    expect(await runCli(["detect", ws.root, "--json"], run.io)).toBe(0);
    const profile = JSON.parse(run.out.join(""));
    expect(profile).toMatchObject({ framework: "react", meta: "none", packageManager: "pnpm" });
    expect(run.err).toEqual([]);
  });

  it("defaults to the current directory and prints readable text without --json", async () => {
    ws = await tempWorkspace();
    await cp(fixture("vue-basic"), ws.root, { recursive: true });
    const run = io(ws.root);
    expect(await runCli(["detect"], run.io)).toBe(0);
    const text = run.out.join("");
    expect(text).toContain("framework: vue");
    expect(text).toContain("packageManager: npm");
  });

  it("exits 2 with usage for unknown commands, bad options and missing directories", async () => {
    for (const argv of [[], ["nope"], ["detect", "--bogus"], ["detect", "/definitely/not/here"]]) {
      const run = io();
      expect(await runCli(argv, run.io)).toBe(2);
      expect(run.err.join("")).toMatch(/Usage|Unknown|not a directory|does not exist/i);
    }
  });

  it("prints help with exit 0", async () => {
    const run = io();
    expect(await runCli(["--help"], run.io)).toBe(0);
    expect(run.out.join("")).toContain("alisio-frontsmith detect");
  });
});
