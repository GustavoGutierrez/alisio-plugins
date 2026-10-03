import { describe, expect, it } from "vitest";
import { discoverPython, PYTHON_PROBE } from "../src/runtime/python.js";
import type { Runner, RunResult } from "../src/runtime/runner.js";

function runnerFor(table: Record<string, Partial<RunResult> | "missing">): {
  runner: Runner;
  calls: string[];
} {
  const calls: string[] = [];
  const runner: Runner = {
    async run(file, args) {
      const key = [file, ...args.filter((a) => a !== "-c" && a !== PYTHON_PROBE)].join(" ");
      calls.push(key);
      const entry = table[key];
      if (!entry || entry === "missing")
        return { code: null, stdout: "", stderr: "spawn failed", aborted: false };
      return { code: 0, stdout: "", stderr: "", aborted: false, ...entry };
    },
  };
  return { runner, calls };
}

const ok = (major: number, minor: number, bits = 64) => ({
  stdout: `${major} ${minor} 1 ${bits} ok\n`,
});

describe("discoverPython", () => {
  it("prefers ALISIO_LAYA_PYTHON and stops there when it works", async () => {
    const { runner, calls } = runnerFor({ "/opt/py/bin/python": ok(3, 12) });
    const result = await discoverPython({
      env: { ALISIO_LAYA_PYTHON: "/opt/py/bin/python" },
      platform: "linux",
      runner,
    });
    expect(result).toMatchObject({ ok: true, command: "/opt/py/bin/python", version: "3.12.1" });
    expect(calls).toEqual(["/opt/py/bin/python"]);
  });

  it("walks python3.13 ... python3, python in order and picks the first valid", async () => {
    const { runner, calls } = runnerFor({ python3: ok(3, 11) });
    const result = await discoverPython({ env: {}, platform: "linux", runner });
    expect(result).toMatchObject({ ok: true, command: "python3" });
    expect(calls).toEqual(["python3.13", "python3.12", "python3.11", "python3.10", "python3"]);
  });

  it("uses the py launcher on Windows", async () => {
    const { runner } = runnerFor({ "py -3": ok(3, 12) });
    const result = await discoverPython({ env: {}, platform: "win32", runner });
    expect(result).toMatchObject({ ok: true, command: "py", args: ["-3"] });
  });

  it("rejects Python older than 3.10 with an actionable message", async () => {
    const { runner } = runnerFor({ python3: ok(3, 9) });
    const result = await discoverPython({ env: {}, platform: "linux", runner });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/3\.10/);
  });

  it("rejects 32-bit interpreters", async () => {
    const { runner } = runnerFor({ python3: ok(3, 12, 32) });
    const result = await discoverPython({ env: {}, platform: "linux", runner });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/64-bit/);
  });

  it("surfaces the missing python3-venv remedy exactly", async () => {
    const { runner } = runnerFor({ python3: { code: 3, stdout: "3 12 1 64 novenv\n" } });
    const result = await discoverPython({ env: {}, platform: "linux", runner });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/python3-venv/);
  });

  it("reports that Python is missing when nothing runs", async () => {
    const { runner } = runnerFor({});
    const result = await discoverPython({ env: {}, platform: "linux", runner });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not found/i);
  });

  it("ignores garbage probe output", async () => {
    const { runner } = runnerFor({ python3: { stdout: "hello" } });
    const result = await discoverPython({ env: {}, platform: "linux", runner });
    expect(result.ok).toBe(false);
  });

  it("never passes user data into the probe script", () => {
    expect(PYTHON_PROBE).not.toMatch(/\$\{/);
  });
});
