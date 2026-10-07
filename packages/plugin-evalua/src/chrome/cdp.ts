import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

/** A dependency-free CDP driver over `--remote-debugging-pipe` (spec AD-6, 10.4). */

export class CdpError extends Error {}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: { message?: string };
}

/** Headless flags that block all network and use a temporary profile (spec 18.1 P0.5). */
export function chromeArgs(profileDir: string): string[] {
  return [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--remote-debugging-pipe",
    "about:blank",
  ];
}

class PipeClient {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<
    string,
    Array<(params: unknown, sessionId?: string) => void>
  >();

  constructor(private readonly child: ChildProcess) {
    const reader = child.stdio[4] as Readable | null;
    reader?.on("data", (chunk: Buffer) => this.onData(chunk));
    child.on("exit", (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new CdpError(`Chrome exited with code ${code}`));
      }
      this.pending.clear();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index = this.buffer.indexOf(0);
    while (index !== -1) {
      const raw = this.buffer.subarray(0, index).toString("utf8");
      this.buffer = this.buffer.subarray(index + 1);
      index = this.buffer.indexOf(0);
      if (raw.trim() === "") continue;
      let message: CdpMessage;
      try {
        message = JSON.parse(raw) as CdpMessage;
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new CdpError(message.error.message ?? "CDP error"));
        else pending.resolve(message.result);
        continue;
      }
      if (message.method !== undefined) {
        for (const listener of this.listeners.get(message.method) ?? []) {
          listener(message.params, message.sessionId);
        }
      }
    }
  }

  on(method: string, listener: (params: unknown, sessionId?: string) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const writable = this.child.stdio[3] as Writable | null;
      if (!writable) {
        this.pending.delete(id);
        reject(new CdpError("Chrome pipe is not writable"));
        return;
      }
      writable.write(`${payload}\u0000`);
    });
  }
}

export interface PrintRequest {
  executable: string;
  html: string;
  timeoutMs?: number;
  /** When given, evaluated in the page before printing; its value is returned as `audit`. */
  auditScript?: string;
  /** When given, Chrome prints it as the page footer, which numbers the pages. */
  footerHtml?: string;
}

export interface PrintResult {
  pdf: Uint8Array;
  engineVersion: string;
  audit?: unknown;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CdpError(`${label} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Renders HTML to a PDF in one Chrome session, with a hard timeout and guaranteed cleanup. */
export async function printHtmlToPdf(request: PrintRequest): Promise<PrintResult> {
  const timeoutMs = request.timeoutMs ?? 120_000;
  const profileDir = await mkdtemp(join(tmpdir(), "evalua-chrome-"));
  const pagePath = join(profileDir, "document.html");
  await writeFile(pagePath, request.html, "utf8");
  const child = spawn(request.executable, chromeArgs(profileDir), {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  const client = new PipeClient(child);
  const cleanup = async (): Promise<void> => {
    if (process.platform === "win32" && child.pid !== undefined) {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
        killer.on("exit", () => resolve());
        killer.on("error", () => resolve());
      });
    } else {
      child.kill("SIGKILL");
    }
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    const version = (await withTimeout(
      client.send("Browser.getVersion"),
      timeoutMs,
      "Browser.getVersion",
    )) as { product?: string };
    const target = (await withTimeout(
      client.send("Target.createTarget", { url: "about:blank" }),
      timeoutMs,
      "Target.createTarget",
    )) as { targetId: string };
    const attached = (await withTimeout(
      client.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }),
      timeoutMs,
      "Target.attachToTarget",
    )) as { sessionId: string };
    const sessionId = attached.sessionId;
    await client.send("Page.enable", {}, sessionId);
    const loaded = new Promise<void>((resolve) => {
      client.on("Page.loadEventFired", (_params, eventSession) => {
        if (eventSession === undefined || eventSession === sessionId) resolve();
      });
    });
    await client.send("Page.navigate", { url: pathToFileURL(pagePath).href }, sessionId);
    await withTimeout(loaded, timeoutMs, "Page.loadEventFired");
    let audit: unknown;
    if (request.auditScript !== undefined) {
      const evaluated = (await withTimeout(
        client.send(
          "Runtime.evaluate",
          { expression: request.auditScript, returnByValue: true },
          sessionId,
        ),
        timeoutMs,
        "Runtime.evaluate",
      )) as { result?: { value?: unknown } };
      audit = evaluated.result?.value;
    }
    const printed = (await withTimeout(
      client.send(
        "Page.printToPDF",
        {
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: request.footerHtml !== undefined,
          headerTemplate: "<div></div>",
          footerTemplate: request.footerHtml ?? "<div></div>",
        },
        sessionId,
      ),
      timeoutMs,
      "Page.printToPDF",
    )) as { data: string };
    return {
      pdf: Buffer.from(printed.data, "base64"),
      engineVersion: version.product ?? "unknown",
      ...(audit === undefined ? {} : { audit }),
    };
  } finally {
    await cleanup();
  }
}
