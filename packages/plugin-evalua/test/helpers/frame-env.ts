import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

type Request = {
  type: string;
  id: string;
  action: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
};
/** What the fake host answers to a request: a plugin result, or a host error (with effect). */
export type Reply = { value?: unknown; error?: string } | { hostError: string; effect?: string };

/**
 * Loads web/app.js in jsdom (one import per test file: the module keeps its frame state) and
 * connects it to a fake host over a real MessageChannel.
 */
export async function frameEnv(locale = "en") {
  const g = globalThis as unknown as Record<string, unknown>;
  const html = await readFile(new URL("../../web/index.html", import.meta.url), "utf8");
  const { window } = new JSDOM(html, { url: "https://alisio.test/frame", pretendToBeVisual: true });
  const proto = window.HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  proto.showModal = function (this: { open: boolean }) {
    this.open = true;
  };
  proto.close = function (this: { open: boolean }) {
    this.open = false;
  };
  const names = ["window", "document", "location", "DOMParser", "CSS", "atob", "btoa"];
  const saved = Object.fromEntries(names.map((k) => [k, g[k]]));
  Object.assign(g, {
    window,
    document: window.document,
    location: window.location,
    DOMParser: window.DOMParser,
    CSS: { escape: (value: string) => value.replace(/["\\]/g, "\\$&") },
  });
  const channels: MessageChannel[] = [];
  const channel = () => {
    const c = new MessageChannel();
    channels.push(c);
    return c;
  };
  const requests: Request[] = [];
  let respond: (request: Request) => Reply | Promise<Reply> = () => ({ value: null });
  let listening = false;
  const listen = window.addEventListener.bind(window);
  window.addEventListener = ((type: string, ...args: unknown[]) => {
    (listen as (...a: unknown[]) => void)(type, ...args);
    if (type === "message") listening = true;
  }) as typeof window.addEventListener;
  // @ts-expect-error -- plain browser module without declarations.
  const loaded = import("../../web/app.js");
  for (let i = 0; !listening && i < 400; i++) await new Promise((r) => setTimeout(r, 5));

  const connect = (c: MessageChannel, source: unknown, connectLocale = locale) =>
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "alisio.app.connect", locale: connectLocale, visible: true },
        source: source as Window | null,
        ports: [c.port2 as unknown as MessagePort],
      }),
    );
  const host = channel();
  host.port1.onmessage = async ({ data }) => {
    if (data.type !== "request") return;
    requests.push(data);
    const reply = await respond(data);
    if ("hostError" in reply)
      host.port1.postMessage({
        type: "response",
        id: data.id,
        error: reply.hostError,
        ...(reply.effect ? { effect: reply.effect } : {}),
      });
    else host.port1.postMessage({ type: "response", id: data.id, result: reply });
  };
  const doc = window.document;
  const wait = async (check: () => boolean, ms = 5000) => {
    for (let i = 0; !check() && i < ms / 10; i++) await new Promise((r) => setTimeout(r, 10));
    if (!check()) throw new Error("condition not met in time");
  };
  const click = (selector: string) => {
    const el = doc.querySelector(selector) as HTMLElement | null;
    if (!el) throw new Error(`no ${selector}`);
    el.click();
  };
  const post = (message: unknown) => host.port1.postMessage(message);
  const close = () => {
    for (const c of channels) {
      c.port1.close();
      c.port2.close();
    }
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete g[k];
      else g[k] = v;
    }
  };
  return {
    window,
    doc,
    host,
    channel,
    connect,
    requests,
    loaded,
    wait,
    click,
    post,
    close,
    setResponder: (fn: typeof respond) => {
      respond = fn;
    },
  };
}

export const REVISION = "r1";

/** A status with a profile and, optionally, one active exam in a phase. */
export function statusWith(phase?: string, extra: Record<string, unknown> = {}) {
  return {
    revision: REVISION,
    initialized: true,
    profile: {
      teacherName: "Ana",
      institution: "Demo",
      subject: "Matemáticas",
      paper: "letter",
      language: "es",
      hasLogo: false,
    },
    exams: phase
      ? [
          {
            id: "e01",
            number: 1,
            folder: "01-fracciones-septimo",
            title: "EVALUACIÓN DE MATEMÁTICAS - GRADO SÉPTIMO",
            theme: "FRACCIONES",
            grade: "Séptimo",
            level: "basico",
            questionCount: 10,
            phase,
            gates: {},
            active: true,
            docs: { html: false, pdf: false },
          },
        ]
      : [],
    activeExamId: phase ? "e01" : null,
    lastBuild: null,
    locales: ["es"],
    jobs: { build: null, wording: null },
    ...extra,
  };
}

export const CATALOG = {
  topics: [
    {
      id: "basic-math/fractions",
      name: { es: "Fracciones" },
      pack: "basic-math",
      grades: ["Sexto", "Séptimo"],
      levels: ["basico", "intermedio"],
      supports: { single_choice: true, multiple_choice: false, open: false, practice: true },
    },
    {
      id: "algebra/linear-equations",
      name: { es: "Ecuaciones lineales" },
      pack: "algebra",
      grades: ["Octavo"],
      levels: ["basico"],
      supports: { single_choice: true, multiple_choice: false, open: false, practice: true },
    },
  ],
  packs: [
    { id: "basic-math", name: { es: "Matemática básica", en: "Basic math" } },
    { id: "algebra", name: { es: "Álgebra" } },
  ],
};
