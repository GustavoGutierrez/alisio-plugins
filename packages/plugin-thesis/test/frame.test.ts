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
  "pdf-viewer.js",
];

describe("embedded HTML builder (THA-AC-19)", () => {
  it("emits one self-contained page the frame CSP and sandbox accept", async () => {
    const html: string = await buildEmbeddedHtml();
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(PLUGIN_APP_LIMITS.htmlBytes);
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length).toBe(1);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${NONCE_MARKER}"`);
      expect(tag).not.toMatch(/\ssrc\s*=/i);
    }
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/\b(?:src|href|action|srcset|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).toMatch(/--thesis-icon:url\("data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"\)/);
    // The Thesis identity colors are part of the page.
    for (const color of ["#0b3fae", "#3fa9ff", "#cfe6ff", "#ffd166"]) expect(html).toContain(color);
  });
});

describe("frame sources (THA-AC-20)", () => {
  it("keep the frame free of network, eval, WebAssembly and forms", async () => {
    for (const name of SOURCES) {
      const source = await readFile(new URL(`../web/${name}`, import.meta.url), "utf8");
      expect(source, name).not.toMatch(/https?:\/\//);
      expect(source, name).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/);
      expect(source, name).not.toMatch(/\beval\s*\(|new Function\b|WebAssembly/);
      expect(source, name).not.toMatch(/<form\b/i);
    }
    const viewer = await readFile(new URL("../web/pdf-viewer.js", import.meta.url), "utf8");
    expect(viewer).toMatch(/isEvalSupported:\s*false/);
    expect(viewer).toMatch(/useWasm:\s*false/);
    expect(viewer).toMatch(/URL\.createObjectURL\(\s*new Blob/);
    const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
    expect(app).toMatch(/responseError\(message, effectOf\(request\.action\)\)/);
    expect(app).toMatch(/\.\.\.\(mutation \? \{ idempotencyKey: id \} : \{\}\)/);
    expect(app).toMatch(/RESPONSE_GUARD_MS = 11 \* 60 \* 1000/);
    expect(app).toMatch(/MAX_IN_FLIGHT = 6/);
    expect(app).toMatch(/APPROVAL_HINT_MS = 3000/);
  });
});

describe("frame handshake and recovery (THA-AC-21)", () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const names = ["window", "document", "location", "history", "setInterval"];
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

  it("accepts only the first parent connect, shapes requests, names permissions and confirms not_found", async () => {
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
    const doc = window.document;
    const wait = async (check: () => boolean, ms = 5000) => {
      for (let i = 0; !check() && i < ms / 10; i++) await new Promise((r) => setTimeout(r, 10));
      expect(check()).toBe(true);
    };
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
    const requests: { type: string; id: string; action: string; idempotencyKey?: string }[] = [];
    let mode: "ok" | "notFoundOnce" | "down" | "denyWrite" = "ok";
    host.port1.onmessage = ({ data }) => {
      if (data.type !== "request") return;
      requests.push(data);
      const reply = (message: Record<string, unknown>) =>
        host.port1.postMessage({ type: "response", id: data.id, ...message });
      if (mode === "down") return reply({ error: "not_found" });
      if (mode === "notFoundOnce") {
        mode = "ok";
        return reply({ error: "not_found" });
      }
      if (mode === "denyWrite" && data.action === "project.init")
        return reply({ error: "not_permitted", effect: "write" });
      const values: Record<string, unknown> = {
        status: {
          initialized: false,
          nextStep: { action: "project.init", phase: null, reasonKey: "start" },
          revision: "none",
          job: null,
          lock: null,
          minHost: "0.11.6",
        },
        "models.list": { models: [], active: "openai/gpt", chosen: null, chosenAvailable: true },
      };
      reply({ result: { value: values[data.action] ?? {} } });
    };
    connect(host, window.parent, "es-CO");
    const late = channel();
    const lateSeen = seen(late);
    connect(late, window.parent);
    await loaded;

    await wait(() => doc.body.textContent?.includes("Empezar una tesis") ?? false);
    expect(doc.documentElement.lang).toBe("es");
    expect(doc.body.textContent).toContain("El Estudio de tesis puede cometer errores");
    expect(rogueSeen).toEqual([]);
    expect(lateSeen).toEqual([]);
    expect(requests.slice(0, 2).map((r) => r.action)).toEqual(["models.list", "status"]);
    for (const r of requests) {
      expect(r.type).toBe("request");
      expect(typeof r.id).toBe("string");
      expect(r.idempotencyKey).toBeUndefined();
    }

    // A denied write names the missing permission (from the host's effect).
    mode = "denyWrite";
    (doc.querySelector('[data-action="init"]') as HTMLButtonElement).click();
    await wait(() => requests.some((r) => r.action === "project.init"));
    const init = requests.find((r) => r.action === "project.init");
    expect(init?.idempotencyKey).toBe(init?.id);
    await wait(() => doc.querySelector("#toast")?.textContent?.includes("guarde cambios") ?? false);
    mode = "ok";

    // Live locale switch keeps the screen.
    host.port1.postMessage({ type: "locale", locale: "en" });
    await wait(() => doc.body.textContent?.includes("Start a thesis") ?? false);
    expect(doc.documentElement.lang).toBe("en");

    // One host not_found never latches: it is confirmed with status first.
    mode = "notFoundOnce";
    const before = requests.length;
    host.port1.postMessage({ type: "visibility", visible: true });
    await wait(() =>
      requests
        .slice(before)
        .some((r, i, list) => r.action === "status" && i > 0 && list.length > 1),
    );
    await new Promise((r) => setTimeout(r, 1800));
    expect(doc.querySelector("h1")?.textContent).not.toBe("Thesis Studio is not available");
    expect(doc.body.textContent).toContain("Start a thesis");

    // A persistent host not_found shows the unavailable screen, with a retry.
    mode = "down";
    host.port1.postMessage({ type: "visibility", visible: true });
    await wait(() => doc.querySelector("h1")?.textContent === "Thesis Studio is not available");
    mode = "ok";
    (doc.querySelector('[data-action="retry"]') as HTMLButtonElement).click();
    await wait(() => doc.body.textContent?.includes("Start a thesis") ?? false);
  });
});
