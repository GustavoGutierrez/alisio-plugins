import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GeneratedReport } from "../src/generate.js";
import { createService, exportName } from "../src/service.js";
import type { Report } from "../src/types.js";
import { fakeHost, VALID_ANSWER } from "./helpers/fake-api.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const b64 = (text: string) => Buffer.from(text).toString("base64");
const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
};

async function setup(generate?: (signal: AbortSignal) => Promise<GeneratedReport>) {
  const host = await fakeHost();
  cleanup = host.cleanup;
  const service = createService({
    api: host.api,
    ...(generate ? { generate: (_s, _r, _i, signal) => generate(signal) } : {}),
  });
  const run = <T = Report>(action: string, input: Record<string, unknown> = {}) =>
    service.run(action, input, "session-1") as Promise<T>;
  return { host, service, run };
}

describe("report service", () => {
  it("creates, lists and reads reports in a per-workspace store", async () => {
    const { host, run } = await setup();
    const created = await run("reports.create", {
      name: "Q4",
      language: "en",
      type: "financial",
      paletteId: "forest",
    });
    expect(created).toMatchObject({ name: "Q4", type: "financial", language: "en", revision: 1 });
    expect(created.palette.id).toBe("forest");
    expect(await run("reports.list")).toEqual([
      expect.objectContaining({ id: created.id, name: "Q4", type: "financial" }),
    ]);
    expect((await run("reports.get", { id: created.id })).id).toBe(created.id);
    const dirs = await readdir(join(host.state, "reports"));
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses ids that are not report ids", async () => {
    const { run } = await setup();
    await expect(run("reports.get", { id: "../../etc/passwd" })).rejects.toThrow("invalid_id");
    await expect(run("reports.get", { id: crypto.randomUUID() })).rejects.toThrow(
      "report_not_found",
    );
  });

  it("clips and validates untrusted creation input", async () => {
    const { run } = await setup();
    const r = await run("reports.create", {
      name: "x".repeat(500),
      type: "evil",
      creativity: 7,
      paletteId: "nope",
    });
    expect(r.name).toHaveLength(120);
    expect(r.type).toBe("executive");
    expect(r.creativity).toBe("balanced");
    expect(r.palette.id).toBe("midnight");
  });

  it("changes settings without a model call", async () => {
    const { host, run } = await setup();
    const r = await run("reports.create", {});
    const updated = await run("report.settings", {
      id: r.id,
      paletteId: "plum",
      columns: 3,
      mode: "singlepage",
      pageSize: "Letter",
    });
    expect(updated).toMatchObject({ columns: 3, mode: "singlepage", pageSize: "Letter" });
    expect(updated.palette.id).toBe("plum");
    expect(host.created).toHaveLength(0);
    await expect(run("report.settings", { id: r.id, paletteId: "nope" })).rejects.toThrow(
      "invalid_palette",
    );
  });

  it("stores a fit for the current revision and renders it", async () => {
    const { run } = await setup();
    const r = await run("reports.create", {});
    await run("report.settings", { id: r.id, mode: "singlepage" });
    const fit = await run<{ scale: number; small: boolean }>("report.fit", {
      id: r.id,
      width: 702,
      height: 2062,
    });
    expect(fit).toMatchObject({ scale: 0.5, small: true });
    const rendered = await run<{ html: string; fitCurrent: boolean }>("report.render", {
      id: r.id,
    });
    expect(rendered.fitCurrent).toBe(true);
    expect(rendered.html).toContain(".document{zoom:0.5}");
    const measuring = await run<{ html: string }>("report.render", { id: r.id, measure: true });
    expect(measuring.html).not.toContain("zoom:");
    await expect(run("report.fit", { id: r.id, width: 0, height: 10 })).rejects.toThrow(
      "invalid_measurement",
    );
  });

  it("exports self-contained HTML with a safe file name", async () => {
    const { run } = await setup();
    const r = await run("reports.create", { name: "Ventas: Q4/2026 <final>" });
    const out = await run<{ html: string; filename: string }>("report.export", { id: r.id });
    expect(out.filename).toBe("Ventas-Q4-2026-final.html");
    expect(out.html).toMatch(/^<!doctype html>/);
    expect(exportName("///")).toBe("report.html");
  });

  it("adds and removes text sources within the limits", async () => {
    const { run } = await setup();
    const r = await run("reports.create", {});
    const withCsv = await run("source.add", {
      id: r.id,
      name: "sales.csv",
      mime: "text/csv",
      base64: b64("q,rev\nQ1,1"),
    });
    expect(withCsv.sources).toHaveLength(1);
    expect(withCsv.sources[0]).toMatchObject({
      name: "sales.csv",
      kind: "csv",
      text: "q,rev\nQ1,1",
    });
    await expect(
      run("source.add", { id: r.id, name: "x.bin", mime: "application/zip", base64: "AA==" }),
    ).rejects.toThrow("unsupported_file_type");
    await expect(
      run("source.add", { id: r.id, name: "bad.docx", base64: b64("not a zip") }),
    ).rejects.toThrow();
    const removed = await run("source.remove", { id: r.id, sourceId: withCsv.sources[0]?.id });
    expect(removed.sources).toHaveLength(0);
    await expect(run("source.remove", { id: r.id, sourceId: "nope" })).rejects.toThrow(
      "source_not_found",
    );
  });

  it("edits a chart block and bumps the revision", async () => {
    const { run, service } = await setup(async () => ({
      title: "T",
      subtitle: "",
      eyebrow: "",
      summary: "",
      blocks: [{ id: "c1", type: "bars", title: "Sales", labels: ["a"], values: [1] }],
    }));
    const r = await run("reports.create", {});
    await run("report.generate", { id: r.id });
    await until(async () => !service.busy());
    const edited = await run("report.block.settings", {
      id: r.id,
      blockId: "c1",
      span: 2,
      height: 999,
      labels: ["x", "y"],
      values: [3, 4],
    });
    expect(edited.blocks[0]).toMatchObject({
      span: 2,
      height: 480,
      labels: ["x", "y"],
      values: [3, 4],
    });
    expect(edited.revision).toBe(3);
    await expect(
      run("report.block.settings", { id: r.id, blockId: "c1", labels: ["x"], values: [1, 2] }),
    ).rejects.toThrow("invalid_chart_data");
    await expect(run("report.block.settings", { id: r.id, blockId: "zz" })).rejects.toThrow(
      "block_not_found",
    );
  });

  it("generates in the background and applies the validated result", async () => {
    const { run, service } = await setup(async () => ({
      ...VALID_ANSWER,
      blocks: VALID_ANSWER.blocks as never,
    }));
    const r = await run("reports.create", {});
    const job = await run<{ id: string; status: string }>("report.generate", { id: r.id });
    expect(job.status).toBe("running");
    await until(
      async () =>
        (await run<{ status: string }>("jobs.get", { jobId: job.id })).status !== "running",
    );
    expect((await run<{ status: string }>("jobs.get", { jobId: job.id })).status).toBe("succeeded");
    const done = await run("reports.get", { id: r.id });
    expect(done).toMatchObject({ title: "Quarterly results", revision: 2 });
    expect(service.busy()).toBe(false);
  });

  it("reports a failed generation with its code and refuses a second concurrent job", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { run } = await setup(async () => {
      await gate;
      throw new Error("generation_malformed");
    });
    const r = await run("reports.create", {});
    const job = await run<{ id: string }>("report.generate", { id: r.id });
    await expect(run("report.revise", { id: r.id, prompt: "more" })).rejects.toThrow("report_busy");
    release();
    await until(
      async () =>
        (await run<{ status: string }>("jobs.get", { jobId: job.id })).status === "failed",
    );
    expect(await run("jobs.get", { jobId: job.id })).toMatchObject({
      error: "generation_malformed",
    });
  });

  it("cancels a running job", async () => {
    const { run, service } = await setup(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const r = await run("reports.create", {});
    const job = await run<{ id: string }>("report.generate", { id: r.id });
    expect(service.busy()).toBe(true);
    await run("jobs.cancel", { jobId: job.id });
    await until(
      async () =>
        (await run<{ status: string }>("jobs.get", { jobId: job.id })).status === "cancelled",
    );
    expect(service.busy()).toBe(false);
  });

  it("lists models as plain references", async () => {
    const { run } = await setup();
    expect(await run("models")).toEqual([{ reference: "acme/fast", label: "Acme · Fast" }]);
  });

  it("rejects an unknown action", async () => {
    const { run } = await setup();
    const r = await run("reports.create", {});
    await expect(run("report.delete-everything", { id: r.id })).rejects.toThrow("unknown_action");
  });
});
