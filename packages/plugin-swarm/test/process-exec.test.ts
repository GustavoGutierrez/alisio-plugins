import { describe, expect, it } from "vitest";
import { createExec, ProcessTracker, scrubbedGateEnv } from "../src/adapters/process-exec.js";
import { tempDir } from "./helpers.js";

const node = (code: string) => [process.execPath, "-e", code];

describe("createExec", () => {
  it("captures output and the exit code without a shell", async () => {
    const cwd = await tempDir();
    const result = await createExec()(node("console.log('hi'); process.exit(3)"), {
      cwd,
      timeoutMs: 10_000,
      maxOutput: 10_000,
    });
    expect(result).toMatchObject({ code: 3, timedOut: false, truncated: false });
    expect(result.stdout.trim()).toBe("hi");
  });

  it("does not interpret shell syntax in arguments", async () => {
    const cwd = await tempDir();
    const result = await createExec()(
      node("console.log(process.argv[1])").concat(["a; echo pwned"]),
      {
        cwd,
        timeoutMs: 10_000,
        maxOutput: 10_000,
      },
    );
    expect(result.stdout.trim()).toBe("a; echo pwned");
  });

  it("kills a process that outlives its timeout", async () => {
    const cwd = await tempDir();
    const started = Date.now();
    const result = await createExec()(node("setInterval(() => {}, 1000)"), {
      cwd,
      timeoutMs: 300,
      maxOutput: 10_000,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("caps the output and stops a runaway process", async () => {
    const cwd = await tempDir();
    const result = await createExec()(node("for (;;) process.stdout.write('x'.repeat(10000))"), {
      cwd,
      timeoutMs: 10_000,
      maxOutput: 5000,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(5000);
  });

  it("reports a missing command instead of throwing", async () => {
    const cwd = await tempDir();
    const result = await createExec()(["definitely-not-a-command-xyz"], {
      cwd,
      timeoutMs: 5000,
      maxOutput: 1000,
    });
    expect(result.code).toBeNull();
    expect(result.spawnError).toMatch(/ENOENT|not found/i);
  });

  it("never passes secrets from the parent environment", async () => {
    const cwd = await tempDir();
    process.env.SWARM_TEST_SECRET = "s3cret";
    try {
      const result = await createExec()(
        node("console.log(String(process.env.SWARM_TEST_SECRET))"),
        { cwd, timeoutMs: 10_000, maxOutput: 1000 },
      );
      expect(result.stdout.trim()).toBe("undefined");
    } finally {
      delete process.env.SWARM_TEST_SECRET;
    }
    expect(Object.keys(scrubbedGateEnv()).every((k) => !/TOKEN|SECRET|KEY/i.test(k))).toBe(true);
  });

  it("cancels every tracked process", async () => {
    const cwd = await tempDir();
    const tracker = new ProcessTracker();
    const pending = createExec(tracker)(node("setInterval(() => {}, 1000)"), {
      cwd,
      timeoutMs: 20_000,
      maxOutput: 1000,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tracker.size).toBe(1);
    tracker.killAll();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(tracker.size).toBe(0);
  });
});
