import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain Node build module without declarations.
import { buildEmbeddedHtml, NONCE_MARKER } from "../scripts/embedded-html.mjs";
import { APP_LIMITS } from "../src/app/register.js";
import { frameEnv, REVISION, statusWith } from "./helpers/frame-env.js";

const SOURCES = [
  "index.html",
  "app.js",
  "i18n.js",
  "derive.js",
  "icons.js",
  "copy.js",
  "style.css",
  "pdf-viewer.js",
];

describe("embedded HTML builder (EVL-APP-AC-17)", () => {
  it("emits one self-contained page the frame CSP and sandbox accept", async () => {
    const html: string = await buildEmbeddedHtml();
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(APP_LIMITS.htmlBytes);
    const scripts = html.match(/<script\b[^>]*>/gi) ?? [];
    expect(scripts).toHaveLength(1);
    for (const tag of scripts) {
      expect(tag).toContain(`nonce="${NONCE_MARKER}"`);
      expect(tag).not.toMatch(/\ssrc\s*=/i);
    }
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/\b(?:src|href|action|srcset|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?\s*(?:https?:)?\/\//i);
    // KaTeX fonts travel as data: URIs; no font file is referenced by path.
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).not.toMatch(/url\(fonts\//);
    expect(html).toMatch(/--evalua-icon:url\("data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"\)/);
  }, 60_000);
});

describe("frame sources (EVL-APP-AC-18)", () => {
  it("keeps the frame code free of network, eval and WebAssembly", async () => {
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
    expect(app).toMatch(/RESPONSE_GUARD_MS = 11 \* 60 \* 1000/);
    expect(app).toMatch(/MAX_IN_FLIGHT = 6/);
  });
});

describe("frame handshake (EVL-APP-AC-19)", () => {
  let env: Awaited<ReturnType<typeof frameEnv>>;
  afterAll(() => env?.close());

  it("accepts only the first connect from window.parent, shapes requests and names the denied permission", async () => {
    env = await frameEnv("es");
    const { window, doc, connect, channel, requests, wait, click } = env;
    env.setResponder((request) => {
      if (request.action === "status") return { value: { ...statusWith(), profile: undefined } };
      if (request.action === "profile.save") return { hostError: "not_permitted", effect: "write" };
      return { value: null };
    });
    const rogue = channel();
    const rogueSeen: unknown[] = [];
    rogue.port1.onmessage = (event) => rogueSeen.push(event.data);
    connect(rogue, null);
    const { JSDOM } = await import("jsdom");
    connect(rogue, new JSDOM("").window);
    connect(env.host, window.parent, "es-CO");
    const late = channel();
    const lateSeen: unknown[] = [];
    late.port1.onmessage = (event) => lateSeen.push(event.data);
    connect(late, window.parent);
    await env.loaded;

    // No profile yet: the profile form comes first, in Spanish.
    await wait(() => !!doc.querySelector("#teacherName"));
    expect(doc.documentElement.lang).toBe("es");
    expect(doc.querySelector("h1")?.textContent).toBe("Perfil docente");
    expect(rogueSeen).toEqual([]);
    expect(lateSeen).toEqual([]);
    expect(requests[0]).toMatchObject({ type: "request", action: "status" });
    expect(requests[0]?.idempotencyKey).toBeUndefined();

    (doc.querySelector("#teacherName") as HTMLInputElement).value = "Ana";
    (doc.querySelector("#institution") as HTMLInputElement).value = "Demo";
    click("#save-profile");
    await wait(() => requests.some((r) => r.action === "profile.save"));
    const save = requests.find((r) => r.action === "profile.save");
    expect(save?.idempotencyKey).toBe(save?.id);
    expect(save?.input).toMatchObject({
      teacherName: "Ana",
      institution: "Demo",
      paper: "letter",
      language: "es",
      expectedRevision: REVISION,
    });
    await wait(() => (doc.querySelector("#toast")?.textContent ?? "").includes("guarde archivos"));
  });
});
