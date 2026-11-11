/**
 * The studio's actions, independent of the host transport so they can be unit-tested. Each
 * workspace gets its own store (directory named by a hash of the workspace path). Long work
 * (generation) runs as a background job the frame polls, because an app call times out at 30 s.
 */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { PluginAPI } from "@alisio/sdk";
import { extractDocument } from "./extract.js";
import { fitScale, printableArea } from "./fit.js";
import { type GeneratedReport, generateWithAlisio } from "./generate.js";
import { printPdf as printWithBrowser } from "./pdf/cdp.js";
import { findBrowser as detectBrowser } from "./pdf/detect.js";
import { fitIsCurrent, renderReport } from "./render.js";
import { importPublicUrl, MAX_FILE_BYTES, sourceText, type UrlImportOptions } from "./sources.js";
import { Store } from "./store.js";
import { initialReport, PALETTES, type Report, type Source } from "./types.js";

export const MAX_SOURCES = 30;
export const SOURCE_BUDGET = 3_000_000;
const MAX_JOBS = 50;

export type JobStatus = "running" | "succeeded" | "failed" | "cancelled";
export interface Job {
  id: string;
  reportId: string;
  /** `pdf` for a PDF print; absent for a generation. */
  kind?: "pdf";
  status: JobStatus;
  error?: string;
  /** Invalid components the model returned and ReportForge left out. */
  dropped?: number;
  /** The report's model no longer exists; the Alisio default wrote it. */
  modelFallback?: boolean;
}

/** Longest wait for a cancelled generation to stop before its report is deleted anyway. */
const CANCEL_WAIT_MS = 10_000;

export type HostApi = Pick<PluginAPI, "models" | "sessions" | "paths" | "options">;

export interface ServiceDeps {
  api: HostApi;
  /** Replaces the model call (tests). */
  generate?: (
    sessionId: string,
    r: Report,
    instruction: string,
    signal: AbortSignal,
  ) => Promise<GeneratedReport>;
  urlOptions?: UrlImportOptions;
  /** Finds the local browser that prints PDFs (tests); `undefined` when none is installed. */
  findBrowser?: () => Promise<string | undefined>;
  /** Replaces the browser print (tests). */
  printPdf?: (request: PdfJobRequest) => Promise<Uint8Array>;
}

export interface PdfJobRequest {
  executable: string;
  html: string;
  signal: AbortSignal;
  /** One-page reports: the printable height the print browser re-checks the zoom against. */
  fitHeight?: number;
}

/** Printed PDFs kept for the frame to download; the oldest is dropped beyond this. */
const MAX_PDF_RESULTS = 3;

const str = (value: unknown, max = 4000) => (typeof value === "string" ? value.slice(0, max) : "");

/** A download-safe base name: letters, digits, dots, dashes and underscores; never hidden. */
function fileBase(name: string): string {
  return name
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 90)
    .replace(/[-.]+$/g, "");
}

export function exportName(name: string): string {
  return `${fileBase(name) || "report"}.html`;
}

/** The PDF download name: the report's title (or its name when untitled), sanitised. */
export function pdfName(r: Pick<Report, "title" | "name">): string {
  return `${fileBase(r.title ?? "") || fileBase(r.name ?? "") || "report"}.pdf`;
}

type ModelEntry = Awaited<ReturnType<HostApi["models"]["list"]>>[number];

/** A readable label: provider (and profile, when not the default) · model name. */
export function modelLabel(m: ModelEntry): string {
  const provider = m.providerName || m.provider || "";
  const profile = m.profile && m.profile !== "default" ? ` (${m.profile})` : "";
  const name = m.model?.name || m.model?.id || m.reference;
  return provider ? `${provider}${profile} · ${name}` : name;
}

export function createService(deps: ServiceDeps) {
  const { api } = deps;
  const stores = new Map<string, Promise<Store>>();
  const running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  const jobs = new Map<string, Job>();
  const printing = new Map<string, AbortController>();
  const pdfs = new Map<string, { data: Uint8Array; filename: string }>();
  const findBrowser = deps.findBrowser ?? (async () => (await detectBrowser()).path);
  const printPdf = deps.printPdf ?? ((request: PdfJobRequest) => printWithBrowser(request));
  const generate =
    deps.generate ??
    ((sessionId: string, r: Report, instruction: string, signal: AbortSignal) =>
      generateWithAlisio(api, sessionId, r, instruction, signal));

  function storeFor(sessionId: string): Promise<Store> {
    const root = api.paths?.state;
    if (!root) throw new Error("paths_unavailable");
    const workspace = api.sessions.workspace(sessionId);
    const dir = join(
      root,
      "reports",
      createHash("sha256").update(workspace).digest("hex").slice(0, 32),
    );
    let pending = stores.get(dir);
    if (!pending) {
      pending = (async () => {
        const store = new Store(dir);
        await store.init();
        return store;
      })();
      pending.catch(() => stores.delete(dir));
      stores.set(dir, pending);
    }
    return pending;
  }

  async function listModels(): Promise<ModelEntry[]> {
    try {
      const list = await api.models.list();
      return Array.isArray(list) ? list.filter((m) => typeof m?.reference === "string") : [];
    } catch {
      throw new Error("models_unavailable");
    }
  }

  function addSource(r: Report, source: Source): void {
    if (r.sources.length >= MAX_SOURCES) throw new Error("too_many_sources");
    const size = r.sources.reduce((n, s) => n + s.text.length, 0) + source.text.length;
    if (size > SOURCE_BUDGET) throw new Error("source_budget_exceeded");
    r.sources.push(source);
  }

  function bump(r: Report, summary: string): void {
    r.revision++;
    r.history.push({
      revision: r.revision,
      summary: summary.slice(0, 150),
      at: new Date().toISOString(),
    });
    r.history = r.history.slice(-100);
  }

  function rememberJob(job: Job): void {
    jobs.set(job.id, job);
    for (const [id, old] of jobs) {
      if (jobs.size <= MAX_JOBS) break;
      if (old.status !== "running") jobs.delete(id);
    }
  }

  async function startGeneration(
    store: Store,
    r: Report,
    sessionId: string,
    prompt: string,
  ): Promise<Job> {
    if (running.has(r.id)) throw new Error("report_busy");
    const controller = new AbortController();
    const job: Job = { id: randomUUID(), reportId: r.id, status: "running" };
    rememberJob(job);
    const done = (async () => {
      try {
        const result = await generate(sessionId, r, prompt || r.goal, controller.signal);
        // A cancelled (or deleted) report never gets a late write.
        controller.signal.throwIfAborted();
        const latest = await store.get(r.id);
        controller.signal.throwIfAborted();
        if (latest.revision !== r.revision) throw new Error("revision_conflict");
        latest.title = result.title;
        latest.subtitle = result.subtitle;
        latest.eyebrow = result.eyebrow;
        latest.summary = result.summary;
        latest.blocks = result.blocks;
        bump(latest, prompt || "Generated");
        await store.put(latest);
        if (result.dropped) job.dropped = result.dropped;
        if (result.modelFallback) job.modelFallback = true;
        job.status = "succeeded";
      } catch (error) {
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.error = error instanceof Error ? error.message.slice(0, 200) : "operation_failed";
      } finally {
        running.delete(r.id);
      }
    })();
    running.set(r.id, { controller, done });
    return job;
  }

  /** Prints the report as rendered for export, in the background (an app call ends at 30 s). */
  async function startPdf(r: Report): Promise<Job> {
    const executable = await findBrowser();
    if (!executable) throw new Error("browser_not_found");
    const html = renderReport(r);
    const filename = pdfName(r);
    const fitHeight = r.mode === "singlepage" ? printableArea(r.pageSize).height : undefined;
    const controller = new AbortController();
    const job: Job = { id: randomUUID(), reportId: r.id, kind: "pdf", status: "running" };
    rememberJob(job);
    printing.set(job.id, controller);
    void (async () => {
      try {
        const data = await printPdf({
          executable,
          html,
          signal: controller.signal,
          ...(fitHeight === undefined ? {} : { fitHeight }),
        });
        controller.signal.throwIfAborted();
        pdfs.set(job.id, { data, filename });
        for (const old of pdfs.keys()) {
          if (pdfs.size <= MAX_PDF_RESULTS) break;
          pdfs.delete(old);
        }
        job.status = "succeeded";
      } catch (error) {
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        const code = error instanceof Error ? error.message : "";
        job.error = /^[a-z][a-z0-9_]{0,60}$/.test(code) ? code : "pdf_failed";
      } finally {
        printing.delete(job.id);
      }
    })();
    return { ...job };
  }

  async function run(
    action: string,
    input: Record<string, unknown>,
    sessionId: string,
  ): Promise<unknown> {
    switch (action) {
      case "context":
        return { locale: api.options?.locale === "en" ? "en" : "es", palettes: PALETTES };
      case "models":
        return (await listModels()).map((m) => ({ reference: m.reference, label: modelLabel(m) }));
      case "jobs.get": {
        const job = jobs.get(str(input.jobId, 64));
        if (!job) throw new Error("job_not_found");
        return { ...job };
      }
      case "jobs.cancel": {
        const job = jobs.get(str(input.jobId, 64));
        if (!job) throw new Error("job_not_found");
        if (job.kind === "pdf") printing.get(job.id)?.abort();
        else running.get(job.reportId)?.controller.abort();
        return { ...job };
      }
      case "report.pdf.get": {
        // One download per print: the bytes are released once handed to the frame.
        const jobId = str(input.jobId, 64);
        const pdf = pdfs.get(jobId);
        if (!pdf) throw new Error("pdf_not_found");
        pdfs.delete(jobId);
        return {
          base64: Buffer.from(pdf.data).toString("base64"),
          filename: pdf.filename,
          bytes: pdf.data.byteLength,
        };
      }
    }
    const store = await storeFor(sessionId);
    if (action === "reports.list") return store.list();
    if (action === "reports.create") return store.put(initialReport(input));
    if (action === "reports.delete") {
      const id = str(input.id, 64);
      store.check(id);
      const task = running.get(id);
      if (task) {
        // The user confirmed the deletion: stop the generation instead of refusing with `busy`.
        task.controller.abort();
        await Promise.race([
          task.done,
          new Promise((resolve) => setTimeout(resolve, CANCEL_WAIT_MS)),
        ]);
      }
      await store.remove(id);
      return { id, deleted: true };
    }
    const r = await store.get(str(input.id, 64));
    switch (action) {
      case "reports.get":
        return r;
      case "report.render":
        return {
          html: renderReport(r, { measure: input.measure === true }),
          fitCurrent: fitIsCurrent(r),
        };
      case "report.export":
        return { html: renderReport(r), filename: exportName(r.name) };
      case "report.pdf":
        return startPdf(r);
      case "report.settings": {
        if (typeof input.paletteId === "string") {
          const palette = PALETTES.find((p) => p.id === input.paletteId);
          if (!palette) throw new Error("invalid_palette");
          r.palette = { ...palette };
        }
        if (input.columns === 1 || input.columns === 2 || input.columns === 3)
          r.columns = input.columns;
        if (input.mode === "singlepage" || input.mode === "multipage") r.mode = input.mode;
        if (input.pageSize === "A4" || input.pageSize === "Letter") r.pageSize = input.pageSize;
        if (input.language === "es" || input.language === "en") r.language = input.language;
        return store.put(r);
      }
      case "report.setModel": {
        const model = str(input.model, 256);
        if (model && !(await listModels()).some((m) => m.reference === model)) {
          throw new Error("unknown_model");
        }
        r.model = model;
        return store.put(r);
      }
      case "report.fit": {
        const width = Number(input.width);
        const height = Number(input.height);
        const result = fitScale(r.pageSize, width, height);
        r.fit = {
          scale: result.scale,
          width: Math.round(width),
          height: Math.round(height),
          pageSize: r.pageSize,
          revision: r.revision,
          columns: r.columns,
        };
        await store.put(r);
        return result;
      }
      case "report.block.settings": {
        const block = r.blocks.find((b) => b.id === str(input.blockId, 64));
        if (!block) throw new Error("block_not_found");
        if (input.span === 1 || input.span === 2 || input.span === 3) block.span = input.span;
        if (block.type === "bars" || block.type === "line" || block.type === "donut") {
          if (typeof input.height === "number" && Number.isFinite(input.height)) {
            block.height = Math.min(480, Math.max(120, Math.round(input.height)));
          }
          if (Array.isArray(input.labels) && Array.isArray(input.values)) {
            const { labels, values } = input as { labels: unknown[]; values: unknown[] };
            if (
              labels.length !== values.length ||
              labels.length === 0 ||
              labels.length > 35 ||
              labels.some((x) => typeof x !== "string" || x.length > 80) ||
              values.some((x) => typeof x !== "number" || !Number.isFinite(x))
            ) {
              throw new Error("invalid_chart_data");
            }
            block.labels = labels as string[];
            block.values = values as number[];
          }
        }
        if (typeof input.title === "string" && "title" in block)
          block.title = input.title.slice(0, 200);
        bump(r, "Block edit");
        return store.put(r);
      }
      case "source.add": {
        const name = str(input.name, 300) || "source";
        const base64 = str(input.base64, Math.ceil(MAX_FILE_BYTES / 3) * 4 + 8);
        let source: Source;
        if (/\.(xlsx|docx|pdf)$/i.test(name)) {
          const data = Buffer.from(base64, "base64");
          const extracted = await extractDocument(name, str(input.mime, 200), new Uint8Array(data));
          source = {
            id: randomUUID(),
            name: name.slice(0, 150),
            kind: "file",
            mime: extracted.mime,
            text: extracted.text,
            importedAt: new Date().toISOString(),
          };
        } else {
          source = sourceText(name, str(input.mime, 200) || "text/plain", base64);
        }
        addSource(r, source);
        return store.put(r);
      }
      case "source.remove": {
        const before = r.sources.length;
        r.sources = r.sources.filter((s) => s.id !== str(input.sourceId, 64));
        if (r.sources.length === before) throw new Error("source_not_found");
        return store.put(r);
      }
      case "source.url": {
        if (r.sources.length >= MAX_SOURCES) throw new Error("too_many_sources");
        addSource(r, await importPublicUrl(str(input.url, 2048), deps.urlOptions));
        return store.put(r);
      }
      case "report.generate":
      case "report.revise":
        return startGeneration(store, r, sessionId, str(input.prompt, 3000));
      default:
        throw new Error("unknown_action");
    }
  }

  return {
    run,
    busy: () => running.size > 0 || printing.size > 0,
    dispose(): void {
      for (const task of running.values()) task.controller.abort();
      for (const controller of printing.values()) controller.abort();
      running.clear();
      printing.clear();
      pdfs.clear();
      jobs.clear();
      stores.clear();
    },
    async listReports(sessionId: string) {
      return (await storeFor(sessionId)).list();
    },
  };
}

export type Service = ReturnType<typeof createService>;

const id = { type: "string", maxLength: 64 } as const;
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

/** Action effects and input schemas, as registered with the host. */
export const ACTIONS: Record<
  string,
  { effect: "read" | "write" | "process"; inputSchema: Record<string, unknown> }
> = {
  context: { effect: "read", inputSchema: object({}) },
  models: { effect: "read", inputSchema: object({}) },
  "reports.list": { effect: "read", inputSchema: object({}) },
  "reports.get": { effect: "read", inputSchema: object({ id }, ["id"]) },
  "report.render": {
    effect: "read",
    inputSchema: object({ id, measure: { type: "boolean" } }, ["id"]),
  },
  "report.export": { effect: "read", inputSchema: object({ id }, ["id"]) },
  // Runs a local browser to print the PDF, so the session must allow running programs.
  "report.pdf": { effect: "process", inputSchema: object({ id }, ["id"]) },
  "report.pdf.get": { effect: "read", inputSchema: object({ jobId: id }, ["jobId"]) },
  "jobs.get": { effect: "read", inputSchema: object({ jobId: id }, ["jobId"]) },
  "jobs.cancel": { effect: "write", inputSchema: object({ jobId: id }, ["jobId"]) },
  "reports.create": {
    effect: "write",
    inputSchema: object({
      name: { type: "string", maxLength: 300 },
      type: { type: "string", maxLength: 40 },
      language: { type: "string", maxLength: 8 },
      model: { type: "string", maxLength: 256 },
      creativity: { type: "string", maxLength: 20 },
      goal: { type: "string", maxLength: 6000 },
      context: { type: "string", maxLength: 14000 },
      audience: { type: "string", maxLength: 400 },
      paletteId: { type: "string", maxLength: 40 },
    }),
  },
  "report.settings": {
    effect: "write",
    inputSchema: object(
      {
        id,
        paletteId: { type: "string", maxLength: 40 },
        columns: { type: "integer", minimum: 1, maximum: 3 },
        mode: { type: "string", enum: ["multipage", "singlepage"] },
        pageSize: { type: "string", enum: ["A4", "Letter"] },
        language: { type: "string", enum: ["es", "en"] },
      },
      ["id"],
    ),
  },
  "report.setModel": {
    effect: "write",
    inputSchema: object({ id, model: { type: "string", maxLength: 256 } }, ["id", "model"]),
  },
  "reports.delete": { effect: "write", inputSchema: object({ id }, ["id"]) },
  "report.fit": {
    effect: "write",
    inputSchema: object(
      {
        id,
        width: { type: "number", exclusiveMinimum: 0 },
        height: { type: "number", exclusiveMinimum: 0 },
      },
      ["id", "width", "height"],
    ),
  },
  "report.block.settings": {
    effect: "write",
    inputSchema: object(
      {
        id,
        blockId: id,
        span: { type: "integer", minimum: 1, maximum: 3 },
        height: { type: "number" },
        title: { type: "string", maxLength: 400 },
        labels: { type: "array", maxItems: 35, items: { type: "string", maxLength: 80 } },
        values: { type: "array", maxItems: 35, items: { type: "number" } },
      },
      ["id", "blockId"],
    ),
  },
  "source.add": {
    effect: "write",
    inputSchema: object(
      {
        id,
        name: { type: "string", maxLength: 300 },
        mime: { type: "string", maxLength: 200 },
        base64: { type: "string", maxLength: Math.ceil(MAX_FILE_BYTES / 3) * 4 + 8 },
      },
      ["id", "name", "base64"],
    ),
  },
  "source.remove": {
    effect: "write",
    inputSchema: object({ id, sourceId: id }, ["id", "sourceId"]),
  },
  "source.url": {
    effect: "write",
    inputSchema: object({ id, url: { type: "string", maxLength: 2048 } }, ["id", "url"]),
  },
  "report.generate": {
    effect: "write",
    inputSchema: object({ id, prompt: { type: "string", maxLength: 3000 } }, ["id"]),
  },
  "report.revise": {
    effect: "write",
    inputSchema: object({ id, prompt: { type: "string", maxLength: 3000 } }, ["id"]),
  },
};
