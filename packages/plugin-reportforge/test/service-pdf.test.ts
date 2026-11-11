import { afterEach, describe, expect, it } from "vitest";
import { printableArea } from "../src/fit.js";
import { renderReport } from "../src/render.js";
import { ACTIONS, createService, pdfName } from "../src/service.js";
import type { Report } from "../src/types.js";
import { fakeHost } from "./helpers/fake-api.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const PDF = new Uint8Array(Buffer.from("%PDF-1.7 report"));
type Printer = (request: {
  executable: string;
  html: string;
  signal: AbortSignal;
  fitHeight?: number;
}) => Promise<Uint8Array>;

async function setup(options: { browser?: string; printer?: Printer } = {}) {
  const host = await fakeHost();
  cleanup = host.cleanup;
  const printed: { executable: string; html: string; fitHeight?: number }[] = [];
  const service = createService({
    api: host.api,
    findBrowser: async () => options.browser,
    printPdf: async (request) => {
      printed.push({
        executable: request.executable,
        html: request.html,
        ...(request.fitHeight === undefined ? {} : { fitHeight: request.fitHeight }),
      });
      return options.printer ? options.printer(request) : PDF;
    },
  });
  const run = <T = Report>(action: string, input: Record<string, unknown> = {}) =>
    service.run(action, input, "session-1") as Promise<T>;
  const settle = async (jobId: string) => {
    for (let i = 0; i < 200; i++) {
      const job = await run<{ status: string; error?: string }>("jobs.get", { jobId });
      if (job.status !== "running") return job;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("job did not settle");
  };
  return { service, run, printed, settle };
}

describe("PDF export", () => {
  it("declares the print action as a process effect and the download as a read", () => {
    expect(ACTIONS["report.pdf"]?.effect).toBe("process");
    expect(ACTIONS["report.pdf.get"]?.effect).toBe("read");
    expect(ACTIONS["report.pdf"]?.inputSchema).toMatchObject({ required: ["id"] });
  });

  it("refuses with browser_not_found when no Chromium-family browser is installed", async () => {
    const { run, printed } = await setup();
    const r = await run("reports.create", { name: "Q4" });
    await expect(run("report.pdf", { id: r.id })).rejects.toThrow("browser_not_found");
    expect(printed).toHaveLength(0);
  });

  it("prints the same HTML as the export in a job and hands the PDF over once", async () => {
    const { run, printed, settle, service } = await setup({ browser: "/usr/bin/chromium" });
    const created = await run("reports.create", { name: "Ventas: Q4/2026" });
    await run("report.settings", { id: created.id, mode: "singlepage", pageSize: "Letter" });
    await run("report.fit", { id: created.id, width: 900, height: 2400 });
    const r = await run("reports.get", { id: created.id });
    const job = await run<{ id: string; status: string; kind: string }>("report.pdf", { id: r.id });
    expect(job).toMatchObject({ status: "running", kind: "pdf", reportId: r.id });
    expect((await settle(job.id)).status).toBe("succeeded");
    expect(printed).toEqual([
      {
        executable: "/usr/bin/chromium",
        html: renderReport(r),
        fitHeight: printableArea("Letter").height,
      },
    ]);
    expect(printed[0]?.html).toContain("size:letter");
    expect(printed[0]?.html).toMatch(/zoom:0\.\d+/);
    const out = await run<{ base64: string; filename: string; bytes: number }>("report.pdf.get", {
      jobId: job.id,
    });
    expect(Buffer.from(out.base64, "base64").toString("latin1")).toBe("%PDF-1.7 report");
    expect(out).toMatchObject({ filename: "Ventas-Q4-2026.pdf", bytes: PDF.length });
    await expect(run("report.pdf.get", { jobId: job.id })).rejects.toThrow("pdf_not_found");
    expect(service.busy()).toBe(false);
  });

  it("names the file after the generated title when there is one", async () => {
    const { run, settle, printed } = await setup({ browser: "chrome" });
    const r = await run("reports.create", { name: "draft" });
    const job = await run<{ id: string }>("report.pdf", { id: r.id });
    await settle(job.id);
    const out = await run<{ filename: string }>("report.pdf.get", { jobId: job.id });
    expect(out.filename).toBe(pdfName(r));
    // Multipage reports are printed as laid out, without a one-page check.
    expect(printed[0]?.fitHeight).toBeUndefined();
  });

  it("cancels a running print through jobs.cancel", async () => {
    const { run, settle, service } = await setup({
      browser: "chrome",
      printer: ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("pdf_cancelled")), {
            once: true,
          }),
        ),
    });
    const r = await run("reports.create", {});
    const job = await run<{ id: string }>("report.pdf", { id: r.id });
    expect(service.busy()).toBe(true);
    await run("jobs.cancel", { jobId: job.id });
    expect(await settle(job.id)).toMatchObject({ status: "cancelled" });
    await expect(run("report.pdf.get", { jobId: job.id })).rejects.toThrow("pdf_not_found");
  });

  it("reports the print failure code and keeps no result", async () => {
    const { run, settle } = await setup({
      browser: "chrome",
      printer: async () => {
        throw new Error("pdf_timeout");
      },
    });
    const r = await run("reports.create", {});
    const job = await run<{ id: string }>("report.pdf", { id: r.id });
    expect(await settle(job.id)).toMatchObject({ status: "failed", error: "pdf_timeout" });
  });

  it("aborts running prints on dispose", async () => {
    let aborted = false;
    const { run, service } = await setup({
      browser: "chrome",
      printer: ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("pdf_cancelled"));
          }),
        ),
    });
    const r = await run("reports.create", {});
    await run("report.pdf", { id: r.id });
    service.dispose();
    expect(aborted).toBe(true);
  });
});

describe("PDF file names", () => {
  const named = (title: string, name = "fallback") => ({ title, name }) as Report;
  it("sanitises the title and never produces a hidden or empty name", () => {
    expect(pdfName(named("Ventas: Q4/2026 <final>"))).toBe("Ventas-Q4-2026-final.pdf");
    expect(pdfName(named("..\\..\\etc/passwd"))).toBe("etc-passwd.pdf");
    expect(pdfName(named("Informe técnico — 2026"))).toBe("Informe-técnico-2026.pdf");
    expect(pdfName(named("   ", "Plan"))).toBe("Plan.pdf");
    expect(pdfName(named("///", "***"))).toBe("report.pdf");
    expect(pdfName(named("x".repeat(300))).length).toBeLessThanOrEqual(94);
  });
});
