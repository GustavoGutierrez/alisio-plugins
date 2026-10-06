import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessExec, scrubbedEnv } from "../src/infrastructure/process/process-exec.js";

const runner = new ProcessExec();
const node = (code: string, extra: Partial<Parameters<ProcessExec["run"]>[1]> = {}) =>
  runner.run([process.execPath, "-e", code], {
    cwd: process.cwd(),
    timeoutMs: 10_000,
    maxOutput: 1_000_000,
    ...extra,
  });

afterEach(() => vi.unstubAllEnvs());

describe("ProcessExec", () => {
  it("captures output and the exit code", async () => {
    const result = await node('console.log("out"); console.error("err"); process.exit(3)');
    expect(result).toMatchObject({
      code: 3,
      stdout: "out\n",
      stderr: "err\n",
      timedOut: false,
      truncated: false,
      cancelled: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("kills a process that exceeds its timeout, including children", async () => {
    const started = Date.now();
    const result = await node("setInterval(() => {}, 1000)", { timeoutMs: 150 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("caps output and kills the process", async () => {
    const result = await node(
      'process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000)',
      {
        maxOutput: 1000,
      },
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(1000);
  });

  it("reports a missing command instead of throwing", async () => {
    const result = await runner.run(["definitely-not-a-command-xyz"], {
      cwd: process.cwd(),
      timeoutMs: 1000,
      maxOutput: 1000,
    });
    expect(result.spawnError).toBe("ENOENT");
    expect(result.code).toBeNull();
    const empty = await runner.run([], { cwd: process.cwd(), timeoutMs: 1000, maxOutput: 1000 });
    expect(empty.spawnError).toBe("Empty command");
  });

  it("does not leak the parent environment", async () => {
    vi.stubEnv("FRONTSMITH_TEST_SECRET", "s3cret");
    vi.stubEnv("GITHUB_TOKEN", "t");
    const result = await node(
      "console.log(JSON.stringify([process.env.FRONTSMITH_TEST_SECRET ?? null, process.env.GITHUB_TOKEN ?? null, process.env.CI ?? null, typeof process.env.PATH]))",
    );
    expect(JSON.parse(result.stdout)).toEqual([null, null, "1", "string"]);
  });

  it("lets the caller add explicit variables", async () => {
    const result = await node("console.log(process.env.EXTRA)", { env: { EXTRA: "yes" } });
    expect(result.stdout.trim()).toBe("yes");
  });

  it("stops on an abort signal", async () => {
    const controller = new AbortController();
    const pending = node("setInterval(() => {}, 1000)", { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.cancelled).toBe(true);
    const already = AbortSignal.abort();
    const skipped = await node("console.log(1)", { signal: already });
    expect(skipped.cancelled).toBe(true);
    expect(skipped.stdout).toBe("");
  });
});

describe("scrubbedEnv", () => {
  it("keeps only allowlisted variables and forces CI", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "x");
    const env = scrubbedEnv();
    expect(env.CI).toBe("1");
    expect(env.NODE_ENV).toBe("test");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(
      Object.keys(env).every((k) =>
        [
          "PATH",
          "HOME",
          "TMPDIR",
          "TEMP",
          "TMP",
          "LANG",
          "LC_ALL",
          "CI",
          "NODE_ENV",
          "SYSTEMROOT",
          "COMSPEC",
        ].includes(k),
      ),
    ).toBe(true);
  });
});
