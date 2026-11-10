import { afterEach, describe, expect, it } from "vitest";
import type { PdfPrinter } from "../src/build.js";
import { appHarness, fakePrinter } from "./helpers/app-harness.js";
import { cleanup, scratchDir } from "./helpers/harness.js";

afterEach(cleanup);

describe("activations (EVL-APP-AC-16)", () => {
  it("keeps each activation's app, jobs and tools independent; dispose is idempotent", async () => {
    let release: () => void = () => undefined;
    const slow: PdfPrinter = async (html) => {
      await new Promise<void>((resolve) => (release = resolve));
      return fakePrinter(html);
    };
    const first = await appHarness({ workspace: await scratchDir(), printer: slow });
    const second = await appHarness({ workspace: await scratchDir() });
    await first.approvedExam();
    await first.call("exam.generate");
    const { jobId } = (await first.call("build.start")).value;
    expect(first.app?.busy?.()).toBe(true);
    expect(second.app?.busy?.()).toBe(false);

    // Alisio evicts an idle workspace: only that activation is released.
    second.app?.dispose?.();
    second.app?.dispose?.();
    expect(first.app?.busy?.()).toBe(true);
    expect((await first.call("jobs.get", { jobId })).value.state).toBe("running");
    expect((await first.chat.tool("evalua_status")).isError).toBe(false);
    expect((await second.chat.tool("evalua_status")).isError).toBe(false);

    first.app?.dispose?.();
    release();
    for (let i = 0; i < 400 && first.app?.busy?.(); i++) {
      release();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(first.app?.busy?.()).toBe(false);
    expect((await first.call("jobs.get", { jobId })).value.state).toBe("cancelled");
    first.app?.dispose?.();
  });

  it("keeps no module-level state in the app sources", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const dir = new URL("../src/app/", import.meta.url);
    for (const name of await readdir(dir)) {
      const source = await readFile(new URL(name, dir), "utf8");
      // Top-level `let` or a top-level mutable collection would be shared by every activation.
      expect(source, name).not.toMatch(/^let\s/m);
      expect(source, name).not.toMatch(/^(?:export\s+)?const\s+\w+\s*=\s*new\s+(Map|Set|Array)\b/m);
    }
  });
});
