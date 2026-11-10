import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { expect } from "vitest";

export interface Request {
  type: string;
  id: string;
  action: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
}
export type Reply =
  | { value: unknown }
  | { error: string; effect?: string }
  | { hostError: string; effect?: string }
  | "hold";

/** Boots web/app.js in jsdom with a fake host on a MessageChannel. */
export async function bootFrame(respond: (r: Request) => Reply | Promise<Reply>, locale = "en") {
  const g = globalThis as unknown as Record<string, unknown>;
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const { window } = new JSDOM(html, { url: "https://alisio.test/frame", pretendToBeVisual: true });
  Object.assign(g, {
    window,
    document: window.document,
    location: window.location,
    history: window.history,
    DOMParser: window.DOMParser,
    atob: window.atob,
  });
  const channels: MessageChannel[] = [];
  const channel = () => {
    const c = new MessageChannel();
    channels.push(c);
    return c;
  };
  const connect = (c: MessageChannel, source: unknown, loc = locale) =>
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "alisio.app.connect", locale: loc, visible: true },
        source: source as Window | null,
        ports: [c.port2 as unknown as MessagePort],
      }),
    );
  let listening = false;
  const listen = window.addEventListener.bind(window);
  window.addEventListener = ((type: string, ...args: unknown[]) => {
    (listen as (...a: unknown[]) => void)(type, ...args);
    if (type === "message") listening = true;
  }) as typeof window.addEventListener;
  // @ts-expect-error -- plain browser module without declarations.
  const loaded = import("../web/app.js");
  for (let i = 0; !listening && i < 200; i++) await new Promise((r) => setTimeout(r, 5));

  const requests: Request[] = [];
  const held = new Map<string, Request>();
  const host = channel();
  const reply = (r: Request, out: Reply) => {
    if (out === "hold") return held.set(r.id, r);
    if ("hostError" in out)
      return host.port1.postMessage({
        type: "response",
        id: r.id,
        error: out.hostError,
        ...(out.effect ? { effect: out.effect } : {}),
      });
    if ("error" in out)
      return host.port1.postMessage({ type: "response", id: r.id, result: { error: out.error } });
    host.port1.postMessage({ type: "response", id: r.id, result: { value: out.value } });
  };
  host.port1.onmessage = async ({ data }) => {
    if (data.type !== "request") return;
    requests.push(data);
    reply(data, await respond(data));
  };
  const doc = window.document;
  const wait = async (check: () => boolean, ms = 5000) => {
    for (let i = 0; !check() && i < ms / 10; i++) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  };
  const click = (selector: string) => {
    const el = doc.querySelector(selector) as HTMLElement | null;
    if (!el) throw new Error(`missing ${selector}`);
    el.click();
  };
  return {
    window,
    doc,
    host,
    channel,
    connect,
    loaded,
    requests,
    held,
    release: (id: string, out: Reply) => {
      const r = held.get(id);
      if (!r) throw new Error("not held");
      held.delete(id);
      reply(r, out);
    },
    wait,
    click,
    close: () => {
      for (const c of channels) {
        c.port1.close();
        c.port2.close();
      }
    },
  };
}

export const STATUS = {
  version: "0.0.0",
  minHost: "0.11.6",
  maxFixAttempts: 2,
  stacks: [
    {
      id: "vanilla",
      label: { en: "HTML, CSS and JavaScript", es: "HTML, CSS y JavaScript" },
      description: { en: "Simple.", es: "Simple." },
      tailwindOptional: true,
      allowlist: {},
      minNode: "22.12.0",
      nodeOk: true,
    },
    {
      id: "next",
      label: { en: "Next.js (full stack)", es: "Next.js (full stack)" },
      description: { en: "Pages and API routes.", es: "Páginas y rutas de API." },
      tailwindOptional: false,
      allowlist: {},
      minNode: "22.12.0",
      nodeOk: true,
    },
  ],
};
export const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
export const REV = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const project = (extra: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  title: "Panadería",
  stack: "vanilla",
  tailwind: false,
  model: null,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  head: REV,
  revisions: [{ id: REV, at: 1, summary: "Starter project", kind: "initial" }],
  extras: {},
  files: [{ path: "index.html", owned: false }],
  needsBuild: false,
  proposal: null,
  server: { state: "stopped", url: null, port: null, startedAt: null, stoppedReason: null },
  job: null,
  chat: [],
  ...extra,
});
