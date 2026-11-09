import { readFile } from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";
import { JSDOM } from "jsdom";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain Node build module without declarations.
import { buildEmbeddedHtml, NONCE_MARKER } from "../scripts/embedded-html.mjs";
import { DATA_MARKER, injectData } from "../src/index.js";

const HTML_LIMIT = 8 * 1024 * 1024;

describe("embedded HTML builder", () => {
  it("emits one self-contained page the frame CSP and sandbox accept", async () => {
    const html: string = injectData(await buildEmbeddedHtml());
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(HTML_LIMIT);
    expect(html).not.toContain(DATA_MARKER);
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts.length).toBe(2);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${NONCE_MARKER}"`);
      expect(tag).not.toMatch(/\ssrc\s*=/i);
    }
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/\b(?:src|href|action|srcset|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
  });

  it("keeps the frame code free of network, eval, forms and external URLs", async () => {
    for (const name of ["index.html", "app.js", "style.css"]) {
      const source = await readFile(new URL(`../web/${name}`, import.meta.url), "utf8");
      expect(source, name).not.toMatch(/https?:\/\//);
      expect(source, name).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/);
      expect(source, name).not.toMatch(/\beval\s*\(|new Function\b|WebAssembly/);
      expect(source, name).not.toMatch(/<form\b/i);
    }
  });
});

describe("frame behavior", () => {
  const channels: MessageChannel[] = [];
  afterAll(() => {
    for (const c of channels) {
      c.port1.close();
      c.port2.close();
    }
  });

  const load = async () => {
    const html = injectData(await buildEmbeddedHtml()).replaceAll(NONCE_MARKER, "test");
    const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://frame.test/" });
    return dom.window;
  };
  const connect = (window: Window, source: unknown, locale = "en") => {
    const c = new MessageChannel();
    channels.push(c);
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "alisio.app.connect", locale, visible: true },
        source: source as Window | null,
        ports: [c.port2 as unknown as MessagePort],
      }),
    );
    return c;
  };

  it("renders every service card with plain limits and follows only the parent's locale", async () => {
    const window = await load();
    const cards = window.document.querySelectorAll(".card");
    expect(cards.length).toBeGreaterThan(5);
    expect(cards[0]?.textContent).toContain("Kilo Code");
    expect(cards[0]?.textContent).toContain("200 requests per hour");
    expect(window.document.body.textContent).not.toMatch(/\b(?:RPM|RPD|TPD|TPM|RPS)\b/);
    connect(window, null, "es");
    expect(window.document.getElementById("title")?.textContent).toBe("Free models");
    connect(window, window.parent, "es");
    expect(window.document.getElementById("title")?.textContent).toBe("Modelos gratis");
    expect(window.document.body.textContent).toContain("200 peticiones por hora");
    connect(window, window.parent, "en");
    expect(window.document.getElementById("title")?.textContent).toBe("Modelos gratis");
  });

  it("opens the key steps in a modal, moves focus into it and restores it on close", async () => {
    const window = await load();
    const button = window.document.querySelector<HTMLButtonElement>('button[data-service="groq"]');
    if (!button) throw new Error("missing groq button");
    button.focus();
    button.click();
    const dialog = window.document.getElementById("steps") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute("aria-labelledby")).toBe("steps-title");
    expect(window.document.activeElement?.id).toBe("steps-close");
    expect(window.document.getElementById("steps-title")?.textContent).toContain("Groq");
    expect(window.document.getElementById("steps-list")?.textContent).toContain(
      "https://console.groq.com/keys",
    );
    expect((window.document.getElementById("steps-link") as HTMLInputElement).value).toBe(
      "https://console.groq.com/keys",
    );
    (window.document.getElementById("steps-close") as HTMLButtonElement).click();
    expect(dialog.open).toBe(false);
    expect(window.document.activeElement).toBe(button);
    expect(window.document.querySelector("dialog form")).toBeNull();
  });

  it("switches language on a later locale message, keeping an open modal open and focused", async () => {
    const window = await load();
    const host = connect(window, window.parent, "en");
    // A second connect, even from the parent, is ignored.
    connect(window, window.parent, "es");
    expect(window.document.getElementById("title")?.textContent).toBe("Free models");
    const button = window.document.querySelector<HTMLButtonElement>('button[data-service="groq"]');
    button?.click();
    const dialog = window.document.getElementById("steps") as HTMLDialogElement;
    host.port1.postMessage({ type: "locale", locale: "es-CO" });
    for (let i = 0; i < 50; i++) {
      if (window.document.getElementById("title")?.textContent === "Modelos gratis") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(window.document.getElementById("title")?.textContent).toBe("Modelos gratis");
    expect(dialog.open).toBe(true);
    expect(window.document.getElementById("steps-title")?.textContent).toContain("Obtén");
    expect(window.document.activeElement?.id).toBe("steps-close");
    (window.document.getElementById("steps-close") as HTMLButtonElement).click();
    expect(window.document.activeElement?.getAttribute("data-service")).toBe("groq");
    host.port1.postMessage({ type: "locale", locale: "fr" });
    for (let i = 0; i < 50; i++) {
      if (window.document.getElementById("title")?.textContent === "Free models") break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(window.document.getElementById("title")?.textContent).toBe("Free models");
  });

  it("shows an unavailable state when the data is missing", async () => {
    const html = (await buildEmbeddedHtml()).replaceAll(NONCE_MARKER, "test");
    const { window } = new JSDOM(html, { runScripts: "dangerously" });
    expect(window.document.querySelectorAll(".card").length).toBe(0);
    expect(window.document.getElementById("intro")?.textContent).toMatch(/unavailable/);
  });
});
