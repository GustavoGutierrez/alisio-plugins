import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UsageMeter } from "../src/app/budget.js";
import { tempDir } from "./helpers.js";

describe("UsageMeter", () => {
  it("never reports exceeded without a limit", async () => {
    const meter = await UsageMeter.open({ file: join(await tempDir(), "usage.json") });
    await meter.record(10_000_000);
    expect(meter.exceeded).toBe(false);
    expect(meter.total).toBe(10_000_000);
  });

  it("reports the crossing once and stays exceeded", async () => {
    const meter = await UsageMeter.open({ file: join(await tempDir(), "usage.json"), limit: 100 });
    expect(await meter.record(60)).toBe(false);
    expect(await meter.record(60)).toBe(true);
    expect(meter.exceeded).toBe(true);
    expect(await meter.record(10)).toBe(false);
    expect(meter.exceeded).toBe(true);
  });

  it("persists the total and the raised allowance across reopen", async () => {
    const file = join(await tempDir(), "usage.json");
    const meter = await UsageMeter.open({ file, limit: 100 });
    await meter.record(120);
    await meter.raise(200);
    expect(meter.exceeded).toBe(false);
    expect(meter.limit).toBe(300);
    const reopened = await UsageMeter.open({ file, limit: 100 });
    expect(reopened.total).toBe(120);
    expect(reopened.limit).toBe(300);
    expect(reopened.exceeded).toBe(false);
  });

  it("ignores invalid amounts and survives a corrupt file", async () => {
    const dir = await tempDir();
    const file = join(dir, "usage.json");
    const meter = await UsageMeter.open({ file, limit: 10 });
    await meter.record(-5);
    await meter.record(Number.NaN);
    expect(meter.total).toBe(0);
    await expect(meter.raise(0)).rejects.toThrow(/positive/i);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{bad");
    const fresh = await UsageMeter.open({ file, limit: 10 });
    expect(fresh.total).toBe(0);
  });
});
