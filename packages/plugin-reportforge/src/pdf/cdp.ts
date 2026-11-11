/**
 * A dependency-free Chrome DevTools Protocol driver that prints one HTML document to PDF with a
 * local Chromium-family browser. The browser runs headless with a throwaway profile over
 * `--remote-debugging-pipe` (no port is opened); the page is injected with
 * `Page.setDocumentContent` (no file, no URL) and is offline: host names do not resolve, the
 * network is emulated offline and every request except an inline `data:` URL is failed. A hard
 * timeout and the caller's abort signal both kill the process; the profile is always removed.
 *
 * Adapted from plugin-evalua (`src/chrome/cdp.ts`) and plugin-thesis
 * (`src/render/adapters/chrome-pdf/cdp.ts`), same repository, MIT license; reimplemented here
 * because plugins stay self-contained.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

/** Error codes (the message is the code, safe to show the frame). */
export type PdfErrorCode =
  | "pdf_cancelled"
  | "pdf_timeout"
  | "pdf_browser_failed"
  | "pdf_invalid"
  | "pdf_too_large";

export class PdfError extends Error {
  constructor(readonly code: PdfErrorCode) {
    super(code);
    this.name = "PdfError";
  }
}

export const DEFAULT_PDF_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_PDF_BYTES = 40 * 1024 * 1024;

export interface PdfRequest {
  executable: string;
  html: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  /**
   * One-page reports: the printable height in CSS pixels. Before printing, the zoom of
   * `.document` is re-checked in this browser with print media and lowered if the content would
   * spill onto a second sheet (the stored zoom was measured by the studio's own browser engine).
   */
  fitHeight?: number;
}

/** Never zoom below this (matches `MIN_SCALE` in `fit.ts`): past it a multipage PDF is better. */
const MIN_FIT_SCALE = 0.2;

/** Lowers the zoom of `.document` until its printed height fits `maxHeight` CSS pixels. */
export function fitScript(maxHeight: number): string {
  return `(() => {
  const doc = document.querySelector(".document");
  if (!doc) return null;
  let scale = parseFloat(getComputedStyle(doc).zoom) || 1;
  for (let i = 0; i < 5; i++) {
    const height = doc.getBoundingClientRect().height;
    if (!(height > ${maxHeight})) break;
    scale = Math.max(${MIN_FIT_SCALE}, Math.floor(scale * (${maxHeight} / height) * 0.995 * 1000) / 1000);
    doc.style.zoom = String(scale);
    if (scale <= ${MIN_FIT_SCALE}) break;
  }
  return scale;
})()`;
}

type SpawnLike = (
  file: string,
  args: string[],
  options: Parameters<typeof nodeSpawn>[2],
) => ChildProcess;

export interface PdfDeps {
  spawn?: SpawnLike;
  platform?: NodeJS.Platform;
  /** Parent directory of the temporary profile (default: the OS temp directory). */
  tmpRoot?: string;
}

/** Headless flags: temporary profile, no extensions or background traffic, no host resolution. */
export function chromeArgs(profileDir: string, root: boolean): string[] {
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--mute-audio",
    "--hide-scrollbars",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    ...(root ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

/** The page may load inline `data:` resources only. */
export function isAllowedRequest(url: string): boolean {
  try {
    return new URL(url).protocol === "data:";
  } catch {
    return false;
  }
}

type Params = Record<string, unknown>;

class PipeClient {
  private buffer = "";
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: Params) => void; reject: (error: Error) => void }
  >();
  private readonly listeners: { method: string; handler: (p: Params, s?: string) => void }[] = [];
  private failure: Error | undefined;

  constructor(
    private readonly input: Writable,
    output: Readable,
  ) {
    output.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      for (let i = this.buffer.indexOf("\0"); i !== -1; i = this.buffer.indexOf("\0")) {
        const raw = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        if (raw.trim()) this.dispatch(raw);
      }
    });
  }

  private dispatch(raw: string): void {
    let message: {
      id?: number;
      method?: string;
      params?: Params;
      result?: Params;
      error?: { message?: string };
      sessionId?: string;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new PdfError("pdf_browser_failed"));
      else entry.resolve(message.result ?? {});
    } else if (message.method) {
      for (const listener of this.listeners) {
        if (listener.method === message.method)
          listener.handler(message.params ?? {}, message.sessionId);
      }
    }
  }

  on(method: string, handler: (params: Params, sessionId?: string) => void): void {
    this.listeners.push({ method, handler });
  }

  send(method: string, params: Params = {}, sessionId?: string): Promise<Params> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.input.write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  }

  fail(error: Error): void {
    this.failure = error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the injected document (and its fonts) to finish loading, capped at a few seconds. */
const READY_SCRIPT = `(async () => {
  const loaded = document.readyState === "complete"
    ? Promise.resolve()
    : new Promise((resolve) => addEventListener("load", resolve, { once: true }));
  await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (document.fonts && document.fonts.ready) {
    await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  return true;
})()`;

async function killTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  spawn: SpawnLike,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      try {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      } catch {
        resolve();
      }
    });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return;
  }
  child.kill("SIGKILL");
}

/** Prints `html` to PDF bytes. Always kills the browser and removes its profile. */
export async function printPdf(request: PdfRequest, deps: PdfDeps = {}): Promise<Uint8Array> {
  const spawn = deps.spawn ?? (nodeSpawn as SpawnLike);
  const platform = deps.platform ?? process.platform;
  const timeoutMs = request.timeoutMs ?? DEFAULT_PDF_TIMEOUT_MS;
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_PDF_BYTES;
  if (request.signal?.aborted) throw new PdfError("pdf_cancelled");

  const profileDir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), "alisio-reportforge-chrome-"));
  let child: ChildProcess | undefined;
  let closed: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    try {
      child = spawn(request.executable, chromeArgs(profileDir, isRoot), {
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      throw new PdfError("pdf_browser_failed");
    }
    const running = child;
    const input = running.stdio[3] as Writable | null;
    const output = running.stdio[4] as Readable | null;
    if (!input || !output) throw new PdfError("pdf_browser_failed");
    // Drain stderr so a chatty browser never blocks on a full pipe.
    running.stderr?.on("data", () => {});
    input.on("error", () => {});
    closed = new Promise<void>((resolve) => running.once("close", () => resolve()));
    const client = new PipeClient(input, output);

    const stop = new Promise<never>((_, reject) => {
      const fail = (code: PdfErrorCode) => {
        const error = new PdfError(code);
        client.fail(error);
        reject(error);
      };
      running.once("error", () => fail("pdf_browser_failed"));
      running.once("close", () => fail("pdf_browser_failed"));
      timer = setTimeout(() => fail("pdf_timeout"), timeoutMs);
      onAbort = () => fail("pdf_cancelled");
      request.signal?.addEventListener("abort", onAbort, { once: true });
    });
    stop.catch(() => {});
    const guard = <T>(work: Promise<T>): Promise<T> => Promise.race([work, stop]);

    await guard(client.send("Browser.getVersion"));
    const { targetId } = (await guard(
      client.send("Target.createTarget", { url: "about:blank" }),
    )) as { targetId: string };
    const { sessionId } = (await guard(
      client.send("Target.attachToTarget", { targetId, flatten: true }),
    )) as { sessionId: string };
    const call = (method: string, params: Params = {}) =>
      guard(client.send(method, params, sessionId));

    client.on("Fetch.requestPaused", (params, session) => {
      if (session !== undefined && session !== sessionId) return;
      const requestId = String(params.requestId);
      const url = String((params.request as { url?: unknown } | undefined)?.url ?? "");
      const next = isAllowedRequest(url)
        ? client.send("Fetch.continueRequest", { requestId }, sessionId)
        : client.send(
            "Fetch.failRequest",
            { requestId, errorReason: "BlockedByClient" },
            sessionId,
          );
      next.catch(() => {});
    });

    await call("Page.enable");
    await call("Network.enable");
    await call("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    const tree = (await call("Page.getFrameTree")) as { frameTree?: { frame?: { id?: string } } };
    const frameId = tree.frameTree?.frame?.id;
    if (!frameId) throw new PdfError("pdf_browser_failed");
    await call("Page.setDocumentContent", { frameId, html: request.html });
    await call("Runtime.evaluate", {
      expression: READY_SCRIPT,
      awaitPromise: true,
      returnByValue: true,
    });
    if (
      request.fitHeight !== undefined &&
      Number.isFinite(request.fitHeight) &&
      request.fitHeight > 0
    ) {
      await call("Emulation.setEmulatedMedia", { media: "print" });
      await call("Runtime.evaluate", {
        expression: fitScript(Math.floor(request.fitHeight)),
        returnByValue: true,
      });
    }
    const printed = (await call("Page.printToPDF", {
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      transferMode: "ReturnAsBase64",
    })) as { data?: unknown };
    if (typeof printed.data !== "string" || printed.data === "") throw new PdfError("pdf_invalid");
    // Check the size before decoding (base64 is 4/3 of the bytes).
    if (Math.floor((printed.data.length * 3) / 4) > maxBytes + 2)
      throw new PdfError("pdf_too_large");
    const pdf = Buffer.from(printed.data, "base64");
    if (pdf.length > maxBytes) throw new PdfError("pdf_too_large");
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new PdfError("pdf_invalid");
    return new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) request.signal?.removeEventListener("abort", onAbort);
    if (child) {
      await killTree(child, platform, spawn);
      await Promise.race([closed, sleep(3000)]);
    }
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
