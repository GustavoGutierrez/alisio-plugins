import { readFile } from "node:fs/promises";
import { PLUGIN_APP_LIMITS } from "@alisio/sdk";
import { JSDOM } from "jsdom";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain Node build module without declarations.
import { buildEmbeddedHtml, NONCE_MARKER } from "../scripts/embedded-html.mjs";

const SOURCES = ["index.html", "app.js", "i18n.js", "style.css", "pdf-viewer.js"];

describe("embedded HTML builder", () => {
  it("emits one self-contained page the frame CSP and sandbox accept", async () => {
    const html: string = await buildEmbeddedHtml();
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(PLUGIN_APP_LIMITS.htmlBytes);
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${NONCE_MARKER}"`);
      expect(tag).not.toMatch(/\ssrc\s*=/i);
    }
    // The sandbox has no allow-forms, and the CSP is default-src 'none' (no external resources).
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/\b(?:src|href|action|srcset|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
  });

  it("keeps Scribe's own frame code free of network, eval and WebAssembly", async () => {
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
  });
});

describe("frame handshake", () => {
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

  it("accepts only the first connect from window.parent and shows an unavailable state on not_found", async () => {
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
    const connect = (c: MessageChannel, source: unknown) =>
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { type: "alisio.app.connect", locale: "en", visible: true },
          source: source as Window | null,
          ports: [c.port2 as unknown as MessagePort],
        }),
      );
    const seen = (c: MessageChannel) => {
      const messages: Array<{ type: string; id: string; action: string }> = [];
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

    // Another window (or none) is not the host: its port is ignored.
    const rogue = channel();
    const rogueSeen = seen(rogue);
    connect(rogue, null);
    connect(rogue, new JSDOM("").window);

    const host = channel();
    let unavailable = false;
    host.port1.onmessage = ({ data }) => {
      if (data.type !== "request") return;
      if (unavailable)
        return host.port1.postMessage({ type: "response", id: data.id, error: "not_found" });
      const values: Record<string, unknown> = {
        context: { locale: "en", capabilities: { write: true, process: true } },
        "documents.list": [],
        models: [],
        "jobs.list": [],
      };
      host.port1.postMessage({
        type: "response",
        id: data.id,
        result: { value: values[data.action] },
      });
    };
    connect(host, window.parent);
    const late = channel();
    const lateSeen = seen(late);
    connect(late, window.parent);
    await loaded;

    expect(window.document.querySelector("#brief")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(rogueSeen).toEqual([]);
    expect(lateSeen).toEqual([]);

    // The plugin was disabled: the next poll answers not_found and the studio says so.
    unavailable = true;
    for (let i = 0; !window.document.body.textContent?.includes("unavailable") && i < 200; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(window.document.querySelector("h1")?.textContent).toBe("Scribe is unavailable");
  });
});

describe("permission messages", () => {
  it("names the missing permission in both locales", async () => {
    const { messages } = await import("../web/i18n.js");
    for (const locale of ["en", "es"] as const) {
      expect(messages[locale].not_permitted_write).toMatch(/--allow-write/);
      expect(messages[locale].not_permitted_process).toMatch(/--allow-process/);
    }
    const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
    expect(app).toMatch(/"pdf\.compile" \? "not_permitted_process" : "not_permitted_write"/);
  });
});
