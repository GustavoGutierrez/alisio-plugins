import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { PLUGIN_APP_LIMITS } from "@alisio/sdk";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain Node build module without declarations.
import { buildEmbeddedHtml, MODULES, NONCE_MARKER } from "../scripts/embedded-html.mjs";
import { bootFrame, PROJECT_ID, project, type Request, STATUS } from "./frame-harness.js";

const SOURCES = ["index.html", "app.js", "style.css", ...(MODULES as string[])];

describe("embedded HTML builder", () => {
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
    expect(html).toMatch(/--lumbre-icon:url\("data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"\)/);
    // The inlined modules share one scope: the script must compile (no duplicate declarations).
    const js = /<script nonce="__ALISIO_NONCE__">([\s\S]*)<\/script>/.exec(html)?.[1] ?? "";
    expect(() => new Script(js)).not.toThrow();
  });

  it("keeps the frame's own code free of network, eval and WebAssembly", async () => {
    for (const name of SOURCES) {
      const source = await readFile(new URL(`../web/${name}`, import.meta.url), "utf8");
      expect(source, name).not.toMatch(/https?:\/\//);
      expect(source, name).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/);
      expect(source, name).not.toMatch(/\beval\s*\(|new Function\b|WebAssembly/);
      expect(source, name).not.toMatch(/<form\b/i);
      expect(source, name).not.toMatch(/srcdoc\s*=|<iframe/i);
    }
    const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
    expect(app).toMatch(/RESPONSE_GUARD_MS = 11 \* 60 \* 1000/);
    expect(app).toMatch(/MAX_IN_FLIGHT = 6/);
    expect(app).toMatch(/\.\.\.\(mutation \? \{ idempotencyKey: id \} : \{\}\)/);
  });
});

describe("frame handshake and feedback (LMB-AC-12, LMB-AC-14, LMB-AC-15)", () => {
  let frame: Awaited<ReturnType<typeof bootFrame>>;
  afterAll(() => frame?.close());

  it("connects once, follows the locale, shapes requests, names denied effects and keeps the approval notice until the response", async () => {
    let state = project();
    let holdNextCreate = true;
    frame = await bootFrame((r: Request) => {
      switch (r.action) {
        case "status":
          return { value: STATUS };
        case "projects.list":
          return { value: [] };
        case "models.list":
          return {
            value: {
              models: [{ reference: "acme/fast", name: "Fast", provider: "Acme" }],
              active: "acme/fast",
              available: true,
            },
          };
        case "projects.create":
          if (holdNextCreate) {
            holdNextCreate = false;
            return "hold";
          }
          return { value: state };
        case "projects.get":
          return { value: state };
        case "preview.snapshot":
          return {
            value: {
              kind: "static",
              html: "<h1>Pan fresco</h1>",
              css: ["h1{color:#c4562b}"],
              assets: {},
              stale: false,
            },
          };
        case "server.start":
          return { hostError: "not_permitted", effect: "process" };
        default:
          return { error: "invalid_input" };
      }
    }, "es");
    const { doc, connect, channel, host, wait, click, requests } = frame;
    const rogue = channel();
    const seen: unknown[] = [];
    rogue.port1.onmessage = (e) => seen.push(e.data);
    connect(rogue, null);
    connect(host, frame.window.parent);
    const late = channel();
    late.port1.onmessage = (e) => seen.push(e.data);
    connect(late, frame.window.parent);
    await frame.loaded;

    await wait(() => !!doc.querySelector(".hero h1"));
    expect(doc.querySelector(".hero h1")?.textContent).toBe("¿Qué quieres construir?");
    expect(doc.documentElement.lang).toBe("es");
    expect(seen).toEqual([]);
    expect(requests.slice(0, 3).map((r) => r.action)).toEqual([
      "status",
      "projects.list",
      "models.list",
    ]);
    for (const r of requests) expect(r.idempotencyKey).toBeUndefined();

    // Locale messages re-render without a reload.
    host.port1.postMessage({ type: "locale", locale: "en" });
    await wait(() => doc.querySelector(".hero h1")?.textContent === "What do you want to build?");

    // A mutation carries an idempotency key; after 3 s without a response the approval notice
    // appears and stays until the response arrives.
    (doc.querySelector("#title") as HTMLInputElement).value = "Panadería";
    (doc.querySelector("#title") as HTMLInputElement).dispatchEvent(
      new frame.window.Event("input", { bubbles: true }),
    );
    click('[data-action="create"]');
    await wait(() => frame.held.size === 1);
    const create = [...frame.held.values()][0] as Request;
    expect(create.action).toBe("projects.create");
    expect(create.idempotencyKey).toBe(create.id);
    expect(create.input).toMatchObject({
      title: "Panadería",
      stack: "vanilla",
      tailwind: false,
      model: null,
    });
    const approval = doc.querySelector("#approval") as HTMLElement;
    expect(approval.hidden).toBe(true);
    await wait(() => !approval.hidden, 4500);
    expect(approval.textContent).toBe("Waiting for your approval in Alisio…");
    await new Promise((r) => setTimeout(r, 400));
    expect(approval.hidden).toBe(false);
    frame.release(create.id, { value: state });
    await wait(() => approval.hidden);

    // The studio: chat, disclaimer, thumbnail in a shadow root.
    await wait(() => !!doc.querySelector(".studio"));
    expect(doc.querySelector(".disclaimer")?.textContent).toBe(
      "Lumbre can make mistakes; review the code before using it.",
    );
    await wait(() => !!doc.querySelector("#thumb")?.shadowRoot?.querySelector("h1"));
    expect(doc.querySelector("#thumb")?.shadowRoot?.querySelector("h1")?.textContent).toBe(
      "Pan fresco",
    );

    // A denied process action names the missing permission from `message.effect`.
    click('[data-action="start-server"]');
    await wait(() => !(doc.querySelector("#toast") as HTMLElement).hidden);
    expect(doc.querySelector("#toast")?.textContent).toMatch(/run processes/);
    state = project({ chat: [{ id: "m", role: "assistant", text: "**Listo**", at: 2 }] });
    void PROJECT_ID;
  }, 20_000);
});
