import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { afterAll, describe, expect, it } from "vitest";

describe("frame recovery, models and answers (0.1.1)", () => {
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

  it("survives a transient host not_found, recovers from a persistent one, blocks asking without a model, and renders Markdown answers with chips", async () => {
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
    const wait = async (check: () => boolean, ms = 4000) => {
      for (let i = 0; !check() && i < ms / 10; i++) await new Promise((r) => setTimeout(r, 10));
      expect(check()).toBe(true);
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

    const nb = {
      id: "abcdefghijkl",
      title: "Recetas",
      createdAt: 1,
      updatedAt: 1,
      remoteNoticeAck: true,
      model: null,
      guide: null,
      excluded: [],
    };
    const citation = {
      n: 1,
      sourceId: "srcaaaaaaaaa",
      sourceName: "recetas.md",
      ordinal: 0,
      page: null,
    };
    let mode: "ok" | "hostNotFoundOnce" | "hostDown" = "ok";
    let modelState: unknown = { models: [], active: null, available: false };
    const requests: string[] = [];
    const values = (action: string): unknown => {
      switch (action) {
        case "status":
          return {
            semanticApi: true,
            available: true,
            keywordOnly: false,
            model: { key: "e5-small", bytes: 1, prepared: true },
            setupJob: null,
            minHost: "0.11.7",
            notebooks: 1,
          };
        case "notebooks.list":
          return [{ ...nb, sourceCount: 1 }];
        case "notebooks.get":
          return {
            ...nb,
            sources: [
              {
                id: "srcaaaaaaaaa",
                name: "recetas.md",
                status: "ready",
                error: null,
                chunkCount: 1,
                summary: null,
              },
            ],
          };
        case "chat.history":
          return [
            { id: 1, role: "user", text: "¿Cómo aprende?", citations: [] },
            {
              id: 2,
              role: "assistant",
              text: "- **Pre-entrenamiento**: mostrarle al aprendiz miles de recetas generales de todo el mundo [1].",
              citations: [citation],
              grounded: true,
              keywordOnly: false,
            },
          ];
        case "models.list":
          return modelState;
        case "sources.passage":
          return {
            sourceId: "srcaaaaaaaaa",
            sourceName: "recetas.md",
            ordinal: 0,
            text: "Receta base.",
            page: 2,
            pageKind: "slide",
          };
        case "jobs.get":
          return undefined;
        default:
          return { ok: true };
      }
    };
    const host = new MessageChannel();
    channels.push(host);
    host.port1.onmessage = ({ data }) => {
      if (data.type !== "request") return;
      requests.push(data.action);
      if (mode === "hostDown" || (mode === "hostNotFoundOnce" && data.action !== "status")) {
        if (mode === "hostNotFoundOnce") mode = "ok";
        return host.port1.postMessage({ type: "response", id: data.id, error: "not_found" });
      }
      if (data.action === "jobs.get")
        return host.port1.postMessage({
          type: "response",
          id: data.id,
          result: { error: "not_found" },
        });
      host.port1.postMessage({
        type: "response",
        id: data.id,
        result: { value: values(data.action) },
      });
    };
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "alisio.app.connect", locale: "es", visible: true },
        source: window.parent,
        ports: [host.port2 as unknown as MessagePort],
      }),
    );
    await loaded;
    await wait(() => !!doc.querySelector('[data-action="open"]'));
    (doc.querySelector('[data-action="open"]') as HTMLButtonElement).click();
    await wait(() => !!doc.querySelector("#question"));

    // Owner's example: list item, bold label, citation chip (not a bare "1").
    const li = doc.querySelector(".msg.assistant .md ul li");
    expect(li?.querySelector("strong")?.textContent).toBe("Pre-entrenamiento");
    expect(li?.querySelector("button.cite")?.textContent).toBe("1");
    expect(li?.textContent).not.toContain("**");
    // Every generated block has the shared copy control; the disclaimer sits under the composer.
    const answerBlock = doc.querySelector(".msg.assistant.copyable");
    expect(
      answerBlock?.querySelector("[data-action='copy-text']")?.getAttribute("aria-label"),
    ).toBe("Copiar texto");
    expect(
      answerBlock?.querySelector("[data-action='copy-formatted']")?.getAttribute("aria-label"),
    ).toBe("Copiar con formato");
    expect(doc.querySelector(".composer .disclaimer")?.textContent).toBe(
      "El asistente puede cometer errores; comprueba sus respuestas con las fuentes citadas.",
    );
    (doc.querySelector(".msg.assistant button.cite") as HTMLButtonElement).click();
    await wait(() => !!doc.querySelector(".passage.copyable [data-copy='passage']"));
    expect(doc.querySelector(".passage")?.textContent).toContain("Diapositiva 2");

    // No model configured: a blocking notice, the question box and send disabled.
    expect(doc.querySelector(".block-state")?.textContent).toContain(
      "primero conecta un modelo en Alisio (/connect)",
    );
    expect((doc.querySelector("#question") as HTMLTextAreaElement).disabled).toBe(true);
    expect((doc.querySelector('[data-action="send"]') as HTMLButtonElement).disabled).toBe(true);
    expect((doc.querySelector('[data-action="guide"]') as HTMLButtonElement).disabled).toBe(true);

    // A model gets connected while the app is hidden: re-checked when it is shown again.
    modelState = {
      models: [
        { reference: "acme/fast", name: "Fast", provider: "Acme" },
        { reference: "acme/smart", name: "Smart", provider: "Acme" },
      ],
      active: "acme/fast",
      available: true,
    };
    host.port1.postMessage({ type: "visibility", visible: false });
    host.port1.postMessage({ type: "visibility", visible: true });
    await wait(() => !!doc.querySelector("#model-select"));
    const select = doc.querySelector("#model-select") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["", "acme/fast", "acme/smart"]);
    expect(select.options[0]?.textContent).toBe("Modelo actual de Alisio (acme/fast)");
    expect((doc.querySelector("#question") as HTMLTextAreaElement).disabled).toBe(false);
    // Composer: one round Send button inside the box, disabled while empty; clear chat in the header.
    const send = () => doc.querySelector(".composer-box [data-action='send']") as HTMLButtonElement;
    expect(send().getAttribute("aria-label")).toBe("Enviar");
    expect(send().disabled).toBe(true);
    const box = doc.querySelector("#question") as HTMLTextAreaElement;
    box.value = "¿Qué andén?";
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(send().disabled).toBe(false);
    expect(doc.querySelector(".composer [data-action='clear-chat']")).toBeNull();
    expect(doc.querySelector("#chat-head [data-action='clear-chat']")?.getAttribute("title")).toBe(
      "Limpiar chat",
    );
    expect(doc.querySelector("#composer-hint")?.textContent).toBe(
      "Enter para enviar, Shift+Enter para nueva línea",
    );
    select.value = "acme/smart";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await wait(() => requests.includes("notebooks.setModel"));

    // A plugin-level not_found (unknown job) never shows the unavailable screen.
    host.port1.postMessage({ type: "visibility", visible: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(doc.querySelector(".unavailable")).toBeNull();

    // One host not_found (e.g. a poll right after the window is shown): verified, app stays usable.
    mode = "hostNotFoundOnce";
    host.port1.postMessage({ type: "visibility", visible: true });
    await wait(() => requests.filter((a) => a === "status").length >= 3);
    await new Promise((r) => setTimeout(r, 1800));
    expect(doc.querySelector(".unavailable")).toBeNull();
    expect(doc.querySelector("#question")).not.toBeNull();

    // Persistent host not_found: unavailable screen with a working retry.
    mode = "hostDown";
    host.port1.postMessage({ type: "visibility", visible: true });
    await wait(() => !!doc.querySelector(".unavailable"), 6000);
    expect(doc.querySelector(".unavailable h1")?.textContent).toBe("Cuaderno no está disponible");
    mode = "ok";
    (doc.querySelector('[data-action="retry"]') as HTMLButtonElement).click();
    await wait(() => !doc.querySelector(".unavailable") && !!doc.querySelector("#question"), 6000);
  }, 20_000);
});
