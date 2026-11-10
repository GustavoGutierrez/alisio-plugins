import { readFile } from "node:fs/promises";
import { PLUGIN_APP_LIMITS } from "@alisio/sdk";
import { JSDOM } from "jsdom";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain Node build module without declarations.
import { buildEmbeddedHtml, NONCE_MARKER } from "../scripts/embedded-html.mjs";

const SOURCES = [
  "index.html",
  "app.js",
  "i18n.js",
  "derive.js",
  "icons.js",
  "markdown.js",
  "copy.js",
  "style.css",
  "pdf.js",
];

describe("embedded HTML builder (SEM-AC-21)", () => {
  it("emits one self-contained page the frame CSP and sandbox accept", async () => {
    const html: string = await buildEmbeddedHtml();
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(PLUGIN_APP_LIMITS.htmlBytes);
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${NONCE_MARKER}"`);
      expect(tag).not.toMatch(/\ssrc\s*=/i);
    }
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/\b(?:src|href|action|srcset|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).toMatch(/--semantic-icon:url\("data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"\)/);
  });
});

describe("frame sources (SEM-AC-22)", () => {
  it("keeps the Notebook's own frame code free of network, eval and WebAssembly", async () => {
    for (const name of SOURCES) {
      const source = await readFile(new URL(`../web/${name}`, import.meta.url), "utf8");
      expect(source, name).not.toMatch(/https?:\/\//);
      expect(source, name).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/);
      expect(source, name).not.toMatch(/\beval\s*\(|new Function\b|WebAssembly/);
      expect(source, name).not.toMatch(/<form\b/i);
    }
    const pdf = await readFile(new URL("../web/pdf.js", import.meta.url), "utf8");
    expect(pdf).toMatch(/isEvalSupported:\s*false/);
    expect(pdf).toMatch(/useWasm:\s*false/);
    expect(pdf).toMatch(/URL\.createObjectURL\(\s*new Blob/);
  });

  it("names the missing permission from the host effect and sends idempotency keys on mutations", async () => {
    const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
    expect(app).toMatch(
      /responseError\(message, WRITE_ACTIONS\.has\(request\.action\) \? "write" : "read"\)/,
    );
    expect(app).toMatch(/\.\.\.\(mutation \? \{ idempotencyKey: id \} : \{\}\)/);
    expect(app).toMatch(/RESPONSE_GUARD_MS = 11 \* 60 \* 1000/);
    expect(app).toMatch(/MAX_IN_FLIGHT = 6/);
  });
});

describe("frame handshake (SEM-AC-23)", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const names = ["window", "document", "location", "history", "setInterval", "btoa", "atob"];
  const saved = Object.fromEntries(names.map((k) => [k, g[k]]));
  const timers: ReturnType<typeof setInterval>[] = [];
  const channels: MessageChannel[] = [];
  afterAll(() => {
    for (const id of timers) clearInterval(id);
    for (const c of channels) {
      c.port1.close();
      c.port2.close();
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  });

  it("accepts only the first connect from window.parent, shapes requests and shows unavailable on not_found", async () => {
    const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
    const { window } = new JSDOM(html, {
      url: "https://alisio.test/frame",
      pretendToBeVisual: true,
    });
    const nativeInterval = globalThis.setInterval;
    Object.assign(g, {
      window,
      document: window.document,
      location: window.location,
      history: window.history,
      setInterval: (fn: () => void, ms: number) => {
        const timer = nativeInterval(fn, Math.min(ms, 30));
        timer.unref();
        timers.push(timer);
        return timer;
      },
    });
    const channel = () => {
      const c = new MessageChannel();
      channels.push(c);
      return c;
    };
    const connect = (c: MessageChannel, source: unknown, locale = "en") =>
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { type: "alisio.app.connect", locale, visible: true },
          source: source as Window | null,
          ports: [c.port2 as unknown as MessagePort],
        }),
      );
    const seen = (c: MessageChannel) => {
      const messages: unknown[] = [];
      c.port1.onmessage = (event) => messages.push(event.data);
      return messages;
    };
    let listening = false;
    const listen = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, ...args: unknown[]) => {
      (listen as (...a: unknown[]) => void)(type, ...args);
      if (type === "message") listening = true;
    }) as typeof window.addEventListener;
    // @ts-expect-error -- plain browser module without declarations.
    const loaded = import("../web/app.js");
    for (let i = 0; !listening && i < 200; i++) await new Promise((r) => setTimeout(r, 5));

    const rogue = channel();
    const rogueSeen = seen(rogue);
    connect(rogue, null);
    connect(rogue, new JSDOM("").window);

    const host = channel();
    const requests: Array<{
      type: string;
      id: string;
      action: string;
      input: unknown;
      idempotencyKey?: string;
    }> = [];
    let unavailable = false;
    host.port1.onmessage = ({ data }) => {
      if (data.type !== "request") return;
      requests.push(data);
      if (unavailable)
        return host.port1.postMessage({ type: "response", id: data.id, error: "not_found" });
      const values: Record<string, unknown> = {
        status: {
          semanticApi: true,
          available: false,
          keywordOnly: true,
          model: { key: "e5-small", label: "e5", bytes: 135_392_016, prepared: false },
          setupJob: null,
          minHost: "0.11.7",
          notebooks: 0,
        },
        "notebooks.list": [],
        "engine.setup": { jobId: "setup-1" },
        "jobs.get": {
          id: "setup-1",
          state: "running",
          progress: 0.25,
          detail: {
            bytes: 33_848_004,
            total: 135_392_016,
            file: "onnx/model_quantized.onnx",
            fileIndex: 4,
            fileCount: 4,
            fileBytes: 16_000_000,
            fileTotal: 118_308_185,
          },
        },
      };
      host.port1.postMessage({
        type: "response",
        id: data.id,
        result: { value: values[data.action] },
      });
    };
    connect(host, window.parent, "es");
    const late = channel();
    const lateSeen = seen(late);
    connect(late, window.parent);
    await loaded;

    for (let i = 0; !window.document.querySelector("#new-notebook") && i < 200; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(window.document.querySelector("#new-notebook")?.textContent).toContain("Nuevo cuaderno");
    expect(window.document.documentElement.lang).toBe("es");
    // The one-time download step is offered with its size.
    expect(window.document.body.textContent).toContain("descarga única de unos 135 MB");
    expect(rogueSeen).toEqual([]);
    expect(lateSeen).toEqual([]);
    expect(requests.slice(0, 2).map((r) => r.action)).toEqual(["status", "notebooks.list"]);
    for (const r of requests) {
      expect(r).toMatchObject({ type: "request" });
      expect(typeof r.id).toBe("string");
      expect(r.idempotencyKey).toBeUndefined();
    }

    // Starting the download is a mutation: it carries an idempotency key.
    (window.document.querySelector('[data-action="setup-start"]') as HTMLButtonElement).click();
    for (let i = 0; !requests.some((r) => r.action === "engine.setup") && i < 200; i++)
      await new Promise((r) => setTimeout(r, 5));
    const setup = requests.find((r) => r.action === "engine.setup");
    expect(setup?.idempotencyKey).toBe(setup?.id);
    // The setup job is polled and its progress bar shows real numbers.
    for (
      let i = 0;
      !window.document.querySelector('[role="progressbar"][aria-valuenow="25"]') && i < 300;
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    expect(
      window.document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"),
    ).toBe("25");
    expect(window.document.body.textContent).toContain("34 de 135 MB");

    unavailable = true;
    for (
      let i = 0;
      !window.document.body.textContent?.includes("no está disponible") && i < 300;
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    expect(window.document.querySelector("h1")?.textContent).toBe("Cuaderno no está disponible");
  });
});
