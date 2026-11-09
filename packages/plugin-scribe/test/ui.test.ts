import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginAPI } from "@alisio/sdk";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { Service } from "../src/service.js";
import { Store } from "../src/store.js";
import { ScribeError } from "../src/types.js";
// @ts-expect-error -- plain browser module without declarations.
import { messages } from "../web/i18n.js";
import { fakeApi, proposalText } from "./helpers.js";

const until = async (fn: () => unknown) => {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("UI timeout");
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("embedded UI", () => {
  it("has identical, complete ES/EN dictionaries", () => {
    const dictionaries = messages as Record<"es" | "en", Record<string, string>>;
    expect(Object.keys(dictionaries.es).sort()).toEqual(Object.keys(dictionaries.en).sort());
    for (const dict of Object.values(dictionaries))
      for (const value of Object.values(dict)) expect(value.trim()).not.toBe("");
  });

  it("creates, reviews and applies a proposal, saves, and follows the host locale", async () => {
    const root = await mkdtemp(join(tmpdir(), "scribe-ui-"));
    const store = new Store(root);
    await store.init();
    const api = fakeApi();
    api.sessions.run = async () => ({
      status: "completed",
      text: proposalText("Validated proposal"),
      usage: { input: 1, output: 1 },
    });
    const service = new Service(api as unknown as PluginAPI, store, "test", { locale: "es" });
    const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, {
      url: "https://alisio.test/api/sessions/test/apps/alisio.scribe/studio/frame",
      pretendToBeVisual: true,
    });
    const { window } = dom;
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = Object.fromEntries(
      [
        "window",
        "document",
        "location",
        "history",
        "sessionStorage",
        "FileReader",
        "confirm",
        "fetch",
        "setInterval",
      ].map((k) => [k, g[k]]),
    );
    const nativeInterval = globalThis.setInterval;
    const intervals: ReturnType<typeof setInterval>[] = [];
    Object.assign(g, {
      window,
      document: window.document,
      location: window.location,
      history: window.history,
      sessionStorage: window.sessionStorage,
      FileReader: window.FileReader,
      confirm: () => true,
      fetch: () => {
        throw new Error("Embedded UI must never fetch directly");
      },
      setInterval: (fn: () => void, ms: number) => {
        const timer = nativeInterval(fn, Math.min(ms, 40));
        timer.unref();
        intervals.push(timer);
        return timer;
      },
    });
    window.HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    window.HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
    const channel = new MessageChannel();
    cleanups.push(async () => {
      for (const id of intervals) clearInterval(id);
      channel.port1.close();
      channel.port2.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete g[k];
        else g[k] = v;
      }
      window.close();
      service.dispose();
      await rm(root, { recursive: true, force: true });
    });
    channel.port1.onmessage = async (event) => {
      const m = event.data as {
        type: string;
        id: string;
        action: string;
        input: Record<string, unknown>;
        idempotencyKey?: string;
      };
      if (m.type !== "request") return;
      try {
        const value = await service.invoke(m.action, m.input, m.idempotencyKey);
        channel.port1.postMessage({ type: "response", id: m.id, result: { value } });
      } catch (error) {
        const code = error instanceof ScribeError ? error.code : "operation_failed";
        channel.port1.postMessage({ type: "response", id: m.id, result: { error: code } });
      }
    };
    let listening = false;
    const listen = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, ...args: unknown[]) => {
      (listen as (...a: unknown[]) => void)(type, ...args);
      if (type === "message") listening = true;
    }) as typeof window.addEventListener;
    // @ts-expect-error -- plain browser module without declarations.
    const loaded = import("../web/app.js");
    await until(() => listening);
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "alisio.app.connect", locale: "es" },
        source: window,
        ports: [channel.port2 as unknown as MessagePort],
      }),
    );
    await loaded;
    const $ = <T extends Element = HTMLElement>(selector: string) =>
      window.document.querySelector(selector) as T | null;
    const click = (selector: string) => $<HTMLElement>(selector)?.click();
    const input = (selector: string, value: string) => {
      const el = $<HTMLInputElement>(selector);
      if (!el) throw new Error(`missing ${selector}`);
      el.value = value;
      el.dispatchEvent(new window.Event("input", { bubbles: true }));
    };
    expect(window.document.documentElement.lang).toBe("es");
    input("#brief", "Un artículo de física");
    click("#create");
    await until(() => ($<HTMLTextAreaElement>("#prompt")?.value.length ?? 0) > 0);
    click("#send");
    await until(() => $("[data-review]"));
    click("[data-review]");
    click("#apply");
    await until(() => !$<HTMLDialogElement>("#dialog")?.open);
    click("#tab-source");
    expect($<HTMLTextAreaElement>("#source")?.value).toMatch(/Validated proposal/);
    input("#source", "\\begin{document}Manual edit\\end{document}");
    click("#save");
    await until(() => $("#save-status")?.textContent === "Guardado");
    channel.port1.postMessage({ type: "locale", locale: "en" });
    await until(() => window.document.documentElement.lang === "en");
    expect($("#send")?.textContent).toMatch(/Prepare proposal/);
    expect($("#ui-language")).toBeNull();
    click("#settings");
    expect($<HTMLSelectElement>("#setting-language")?.value).toBe("es");
    click("#dialog-close");
    channel.port1.postMessage({ type: "locale", locale: "es" });
    await until(() => window.document.documentElement.lang === "es");
    expect($<HTMLTextAreaElement>("#source")?.value).toBe(
      "\\begin{document}Manual edit\\end{document}",
    );
  });
});
