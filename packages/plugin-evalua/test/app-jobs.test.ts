import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppJobs, jobId } from "../src/app/jobs.js";
import { readPrefs } from "../src/app/prefs.js";
import type { PdfPrinter } from "../src/build.js";
import { APP_BUILD_BUSY } from "../src/coordinator.js";
import { densityLadder } from "../src/layout/presets.js";
import { readState } from "../src/storage.js";
import { appHarness, fakePrinter } from "./helpers/app-harness.js";
import { cleanup } from "./helpers/harness.js";

afterEach(cleanup);

/** A printer the test releases one print at a time. */
function gatedPrinter() {
  const waiting: Array<() => void> = [];
  let prints = 0;
  const printer: PdfPrinter = async (html) => {
    prints += 1;
    await new Promise<void>((resolve) => waiting.push(resolve));
    return fakePrinter(html);
  };
  return {
    printer,
    prints: () => prints,
    async release(count = 1) {
      for (let i = 0; i < count; i++) {
        for (let tries = 0; waiting.length === 0 && tries < 400; tries++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        waiting.shift()?.();
      }
    },
  };
}

describe("job runner", () => {
  it("makes 12-character base32 ids and allows one job per kind", async () => {
    expect(jobId()).toMatch(/^[a-z2-7]{12}$/);
    const jobs = new AppJobs();
    let finish: () => void = () => undefined;
    const id = jobs.start("build", () => new Promise<void>((resolve) => (finish = resolve)));
    expect(() => jobs.start("build", async () => undefined)).toThrow("busy");
    expect(jobs.busy()).toBe(true);
    finish();
    await jobs.idle();
    expect(jobs.get(id)).toMatchObject({ kind: "build", state: "done" });
    expect(jobs.busy()).toBe(false);
  });
});

describe("chat while an app build runs (EVL-APP-AC-05)", () => {
  it("answers busy to chat build, generate, approve and set-prompts and leaves the job alone", async () => {
    const gate = gatedPrinter();
    const h = await appHarness({ printer: gate.printer });
    await h.approvedExam();
    await h.call("exam.generate");
    const { jobId: id } = (await h.call("build.start")).value;
    await gate.release(1);
    expect(await h.chat.run("build")).toBe(APP_BUILD_BUSY);
    expect(await h.chat.run("generate")).toBe(APP_BUILD_BUSY);
    expect(await h.chat.run("approve", "b")).toBe(APP_BUILD_BUSY);
    expect(await h.chat.tool("evalua_build")).toEqual({ text: APP_BUILD_BUSY, isError: true });
    expect(await h.chat.tool("evalua_generate")).toEqual({ text: APP_BUILD_BUSY, isError: true });
    expect(await h.chat.tool("evalua_exam", { action: "set-prompts", prompts: {} })).toEqual({
      text: APP_BUILD_BUSY,
      isError: true,
    });
    // Status and app reads still work; app mutations are refused while the build runs.
    expect((await h.chat.tool("evalua_exam", { action: "status" })).isError).toBe(false);
    expect((await h.call("exam.generate")).error).toBe("busy");
    expect((await h.call("status")).value.jobs.build.id).toBe(id);
    await gate.release(densityLadder.length + 4);
    expect((await h.settle(id)).state).toBe("done");
    const chatBuild = h.chat.run("build");
    await gate.release(densityLadder.length + 4);
    expect(await chatBuild).toMatch(/^Built 10 items/);
  });
});

describe("build job (EVL-APP-AC-14)", () => {
  it("reports every print step, then marks the exam built and stores the last build", async () => {
    const gate = gatedPrinter();
    const h = await appHarness({ printer: gate.printer });
    const examId = await h.approvedExam();
    await h.call("exam.generate");
    const { jobId: id } = (await h.call("build.start")).value;
    const total = densityLadder.length + 4;
    const seen: string[] = [];
    for (let step = 1; step <= total; step++) {
      await gate.release(1);
      for (let tries = 0; tries < 400; tries++) {
        const job = (await h.call("jobs.get", { jobId: id })).value;
        if (job.step >= step || job.state !== "running") {
          seen.push(`${job.phase} ${job.step}/${job.total}`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    expect(seen).toEqual([
      ...densityLadder.map((_, i) => `fit ${i + 1}/${total}`),
      ...[1, 2, 3, 4].map((i) => `print ${densityLadder.length + i}/${total}`),
    ]);
    const job = await h.settle(id);
    expect(job).toMatchObject({ state: "done", result: { pdf: true, browser: true } });
    expect((await readState(h.workspace))?.exams[examId]?.phase).toBe("built");
    expect((await readPrefs(h.workspace)).lastBuild[examId]).toMatchObject({ pdf: true });
  });

  it("cancels after the print in progress and keeps the exam unbuilt", async () => {
    const gate = gatedPrinter();
    const h = await appHarness({ printer: gate.printer });
    const examId = await h.approvedExam();
    await h.call("exam.generate");
    const { jobId: id } = (await h.call("build.start")).value;
    await gate.release(1);
    for (let tries = 0; gate.prints() < 2 && tries < 400; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect((await h.call("jobs.cancel", { jobId: id })).value).toEqual({ state: "running" });
    await gate.release(1);
    const job = await h.settle(id);
    expect(job.state).toBe("cancelled");
    expect(gate.prints()).toBe(2);
    expect((await readState(h.workspace))?.exams[examId]?.phase).toBe("generated");
    expect((await h.call("jobs.cancel", { jobId: "aaaaaaaaaaaa" })).error).toBe("not_found");
  });

  it("writes HTML only without a browser and reports EVL-LAY-000 with pdf false", async () => {
    const h = await appHarness({ printer: null });
    const examId = await h.approvedExam();
    await h.call("exam.generate");
    const job = await h.settle((await h.call("build.start")).value.jobId);
    expect(job.state).toBe("done");
    expect(job.result.pdf).toBe(false);
    expect(job.result.browser).toBe(false);
    expect(job.result.findings.map((f: { id: string }) => f.id)).toContain("EVL-LAY-000");
    const folder = (await h.call("status")).value.exams[0].folder;
    const files = await readdir(join(h.workspace, "evalua", "exams", folder));
    expect(files.filter((name) => name.endsWith(".pdf"))).toEqual([]);
    expect(files.filter((name) => name.endsWith(".html"))).toHaveLength(4);
    expect((await h.call("status")).value.exams[0]).toMatchObject({
      id: examId,
      phase: "built",
      docs: { html: true, pdf: false },
    });
  });
});
