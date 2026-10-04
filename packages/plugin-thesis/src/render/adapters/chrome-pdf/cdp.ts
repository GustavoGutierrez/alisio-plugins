import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isRequestAllowed } from "./network.js";

/**
 * Minimal Chrome DevTools Protocol driver (spec 10.7): no puppeteer. Chrome is started headless
 * with a temporary profile and either `--remote-debugging-pipe` (file descriptors 3 and 4, the
 * default) or `--remote-debugging-port=0` driven through Node's global `WebSocket`. The page is
 * loaded from the build directory with every other request blocked, and printed with
 * `Page.printToPDF`. The browser process is always killed and the profile always removed.
 */

export type CdpTransport = "pipe" | "websocket";

export interface PrintRequest {
  chrome: string;
  /** Absolute path of the HTML file inside `buildDir`. */
  htmlPath: string;
  buildDir: string;
  /** Wait for `window.__thesisReady` (default 120 000 ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  transport?: CdpTransport;
}

export interface PrintResult {
  pdf: Buffer;
  /** Pages counted by the in-page runtime. */
  pages: number;
  /** Browser product, for example `Chrome/131.0.0.0`. */
  product: string;
  blockedRequests: string[];
  consoleErrors: string[];
}

export class CdpError extends Error {
  constructor(
    message: string,
    readonly kind: "launch" | "timeout" | "page" | "protocol" | "aborted" = "protocol",
  ) {
    super(message);
  }
}

export function chromeArgs(profileDir: string, transport: CdpTransport, root: boolean): string[] {
  return [
    "--headless=new",
    transport === "pipe" ? "--remote-debugging-pipe" : "--remote-debugging-port=0",
    ...(transport === "websocket" ? ["--remote-debugging-address=127.0.0.1"] : []),
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
    "--font-render-hinting=none",
    ...(root ? ["--no-sandbox"] : []),
    "about:blank",
  ];
}

interface Transport {
  send(text: string): void;
  onMessage(handler: (text: string) => void): void;
  close(): void;
}

function pipeTransport(child: ChildProcess): Transport {
  const out = child.stdio[3] as NodeJS.WritableStream;
  const input = child.stdio[4] as NodeJS.ReadableStream;
  let buffer = "";
  return {
    send: (text) => void out.write(`${text}\0`),
    onMessage(handler) {
      input.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let index = buffer.indexOf("\0");
        while (index !== -1) {
          const message = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (message) handler(message);
          index = buffer.indexOf("\0");
        }
      });
    },
    close() {
      try {
        out.end();
      } catch {
        // The process is killed right after.
      }
    },
  };
}

async function websocketTransport(profileDir: string, deadline: number): Promise<Transport> {
  // Chrome writes `DevToolsActivePort` (port, then the browser WebSocket path) into the profile.
  let port = "";
  let path = "";
  while (Date.now() < deadline) {
    try {
      const lines = (await readFile(join(profileDir, "DevToolsActivePort"), "utf8")).split("\n");
      if (lines[0] && lines[1]) {
        port = lines[0].trim();
        path = lines[1].trim();
        break;
      }
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!port) throw new CdpError("Chrome did not open its debugging port", "launch");
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new CdpError("WebSocket connection failed", "launch")),
      {
        once: true,
      },
    );
  });
  const handlers: ((text: string) => void)[] = [];
  socket.addEventListener("message", (event) => {
    for (const handler of handlers) handler(String(event.data));
  });
  return {
    send: (text) => socket.send(text),
    onMessage: (handler) => void handlers.push(handler),
    close: () => socket.close(),
  };
}

type Params = Record<string, unknown>;

class Client {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { method: string; resolve: (value: Params) => void; reject: (error: Error) => void }
  >();
  private readonly listeners: {
    method: string;
    handler: (params: Params, session?: string) => void;
  }[] = [];
  private closed: Error | undefined;

  constructor(private readonly transport: Transport) {
    transport.onMessage((text) => {
      let message: {
        id?: number;
        method?: string;
        params?: Params;
        result?: Params;
        error?: { message: string };
        sessionId?: string;
      };
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new CdpError(`${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.listeners) {
          if (listener.method === message.method)
            listener.handler(message.params ?? {}, message.sessionId);
        }
      }
    });
  }

  on(method: string, handler: (params: Params, session?: string) => void): void {
    this.listeners.push({ method, handler });
  }

  send(method: string, params: Params = {}, sessionId?: string): Promise<Params> {
    if (this.closed) return Promise.reject(this.closed);
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.transport.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  }

  /** Fail every outstanding call, for example when Chrome exits. */
  fail(error: Error): void {
    this.closed = error;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  close(): void {
    this.transport.close();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Launch Chrome, load the page, wait for the runtime and return the PDF. Always cleans up. */
export async function printToPdf(request: PrintRequest): Promise<PrintResult> {
  const timeoutMs = request.timeoutMs ?? 120_000;
  const transportKind: CdpTransport = request.transport ?? "pipe";
  const profileDir = await mkdtemp(join(tmpdir(), "alisio-thesis-chrome-"));
  const blocked: string[] = [];
  const consoleErrors: string[] = [];
  let child: ChildProcess | undefined;
  let stderr = "";
  let exitResolve: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });

  try {
    if (request.signal?.aborted) throw new CdpError("The build was cancelled", "aborted");
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    try {
      child = spawn(request.chrome, chromeArgs(profileDir, transportKind, isRoot), {
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
        env: request.env ?? process.env,
        windowsHide: true,
      });
    } catch (error) {
      throw new CdpError(`Chrome could not be started: ${(error as Error).message}`, "launch");
    }
    const running = child;
    running.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    running.on("close", () => exitResolve());
    const spawnFailure = new Promise<never>((_, reject) => {
      running.once("error", (error) =>
        reject(new CdpError(`Chrome could not be started: ${error.message}`, "launch")),
      );
    });
    const abort = new Promise<never>((_, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => reject(new CdpError("The build was cancelled", "aborted")),
        { once: true },
      );
    });
    const guard = <T>(work: Promise<T>): Promise<T> => Promise.race([work, spawnFailure, abort]);

    const deadline = Date.now() + timeoutMs;
    const transport =
      transportKind === "pipe"
        ? pipeTransport(running)
        : await guard(websocketTransport(profileDir, Date.now() + 15_000));
    const client = new Client(transport);
    running.on("close", (code) =>
      client.fail(
        new CdpError(
          `Chrome exited unexpectedly (code ${code ?? "unknown"})${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          "launch",
        ),
      ),
    );

    const version = await guard(client.send("Browser.getVersion"));
    const product = String(version.product ?? "Chrome");
    const { targetId } = (await guard(
      client.send("Target.createTarget", { url: "about:blank" }),
    )) as {
      targetId: string;
    };
    const { sessionId } = (await guard(
      client.send("Target.attachToTarget", { targetId, flatten: true }),
    )) as { sessionId: string };
    const call = (method: string, params: Params = {}) =>
      guard(client.send(method, params, sessionId));

    // Network policy: pause every request and release only what stays inside the build directory.
    client.on("Fetch.requestPaused", (params, session) => {
      if (session !== sessionId) return;
      const requestId = String(params.requestId);
      const url = String((params.request as { url?: string } | undefined)?.url ?? "");
      if (isRequestAllowed(url, request.buildDir)) {
        void client.send("Fetch.continueRequest", { requestId }, sessionId).catch(() => {});
      } else {
        blocked.push(url.slice(0, 200));
        void client
          .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId)
          .catch(() => {});
      }
    });
    client.on("Runtime.consoleAPICalled", (params, session) => {
      if (session === sessionId && params.type === "error") {
        const args = (params.args as { value?: unknown; description?: string }[] | undefined) ?? [];
        consoleErrors.push(
          args
            .map((arg) => String(arg.value ?? arg.description ?? ""))
            .join(" ")
            .slice(0, 300),
        );
      }
    });
    client.on("Runtime.exceptionThrown", (params, session) => {
      if (session === sessionId) {
        const details = params.exceptionDetails as
          | { text?: string; exception?: { description?: string } }
          | undefined;
        consoleErrors.push(
          String(details?.exception?.description ?? details?.text ?? "exception").slice(0, 300),
        );
      }
    });

    await call("Page.enable");
    await call("Runtime.enable");
    await call("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await call("Page.navigate", { url: pathToFileURL(request.htmlPath).href });

    let state: { ready?: boolean; error?: string | null; pages?: number } = {};
    while (true) {
      if (Date.now() > deadline) {
        throw new CdpError(
          `The page was not ready after ${Math.round(timeoutMs / 1000)} seconds`,
          "timeout",
        );
      }
      const evaluated = (await call("Runtime.evaluate", {
        expression:
          "({ ready: window.__thesisReady === true, error: window.__thesisError || null, pages: window.__thesisPages || 0 })",
        returnByValue: true,
      })) as { result?: { value?: typeof state } };
      state = evaluated.result?.value ?? {};
      if (state.error) throw new CdpError(`The page failed: ${state.error}`, "page");
      if (state.ready) break;
      await sleep(250);
    }

    const printed = (await call("Page.printToPDF", {
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: false,
      transferMode: "ReturnAsBase64",
    })) as { data?: string };
    if (!printed.data) throw new CdpError("Chrome returned no PDF data");
    const pdf = Buffer.from(printed.data, "base64");
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-")
      throw new CdpError("Chrome did not return a PDF");
    try {
      await client.send("Browser.close");
    } catch {
      // The process is killed below anyway.
    }
    client.close();
    return { pdf, pages: state.pages ?? 0, product, blockedRequests: blocked, consoleErrors };
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (child) await Promise.race([exited, sleep(3000)]);
    await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
