import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
// @ts-expect-error -- plain build script without declarations
import { buildUi } from "../../scripts/copy-ui.mjs";

export type Request = { type: string; id: string; action: string; input: Record<string, unknown> };
/** What the fake host answers: a plugin result (`value` or `error`), or a host error code. */
export type Reply = { value?: unknown; error?: string } | { hostError: string; effect?: string };

/**
 * Boots ui/index.html in jsdom with its inline script and connects it to a fake host over a real
 * MessageChannel, exactly as Alisio does (alisio.app.connect + transferred port).
 */
export async function frameEnv() {
  // The frame exactly as the build ships it (icon inlined in the brand).
  const html = buildUi(
    await readFile(new URL("../../ui/index.html", import.meta.url), "utf8"),
    await readFile(new URL("../../icon.svg", import.meta.url), "utf8"),
  );
  const dom = new JSDOM(html, {
    url: "https://alisio.test/frame",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // jsdom does not load `srcdoc`: emulate it (content into the frame's document, then `load`).
  Object.defineProperty(window.HTMLIFrameElement.prototype, "srcdoc", {
    configurable: true,
    get(this: HTMLIFrameElement) {
      return this.getAttribute("srcdoc") ?? "";
    },
    set(this: HTMLIFrameElement, value: string) {
      this.setAttribute("srcdoc", value);
      const body = this.contentDocument?.body;
      if (body) body.innerHTML = value.replace(/^<!doctype html>/i, "");
      setTimeout(() => this.dispatchEvent(new window.Event("load")), 0);
    },
  });
  const channels: MessageChannel[] = [];
  const channel = () => {
    const c = new MessageChannel();
    channels.push(c);
    return c;
  };
  const requests: Request[] = [];
  let respond: (request: Request) => Reply | Promise<Reply> = () => ({ value: null });
  const host = channel();
  host.port1.onmessage = async ({ data }) => {
    if (data.type !== "request") return;
    requests.push(data);
    const reply = await respond(data);
    if ("hostError" in reply) {
      host.port1.postMessage({
        type: "response",
        id: data.id,
        error: reply.hostError,
        ...(reply.effect ? { effect: reply.effect } : {}),
      });
    } else host.port1.postMessage({ type: "response", id: data.id, result: reply });
  };
  const connect = (c: MessageChannel, source: unknown, locale = "en") =>
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "alisio.app.connect", locale, visible: true },
        source: source as Window | null,
        ports: [c.port2 as unknown as MessagePort],
      }),
    );
  const doc = window.document;
  const $ = (id: string) => doc.getElementById(id) as HTMLElement & { value: string };
  const wait = async (check: () => boolean, ms = 5000) => {
    for (let i = 0; !check() && i < ms / 10; i++) await new Promise((r) => setTimeout(r, 10));
    if (!check()) throw new Error("condition not met in time");
  };
  const close = () => {
    for (const c of channels) {
      c.port1.close();
      c.port2.close();
    }
    window.close();
  };
  return {
    window,
    doc,
    $,
    host,
    channel,
    connect,
    requests,
    wait,
    close,
    post: (message: unknown) => host.port1.postMessage(message),
    setResponder: (fn: typeof respond) => {
      respond = fn;
    },
  };
}
