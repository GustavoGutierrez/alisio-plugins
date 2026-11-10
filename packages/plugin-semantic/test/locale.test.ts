import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain browser module without declarations.
import { messages } from "../web/i18n.js";

/** English fragments that must not appear in a Spanish view (strings whose Spanish differs). */
function englishFragments(): string[] {
  const out = new Set<string>();
  const walk = (en: unknown, es: unknown) => {
    if (typeof en === "string") {
      if (en !== es && en.length >= 4) out.add(en);
    } else if (typeof en === "function") {
      const sentinel = "\u0000";
      const a = String((en as (...x: string[]) => string)(sentinel, sentinel));
      const b =
        typeof es === "function"
          ? String((es as (...x: string[]) => string)(sentinel, sentinel))
          : "";
      for (const part of a.split(sentinel))
        if (part.trim().length >= 6 && !b.includes(part)) out.add(part.trim());
    } else if (en && typeof en === "object")
      for (const [k, v] of Object.entries(en)) walk(v, (es as Record<string, unknown>)?.[k]);
  };
  walk(messages.en, messages.es);
  return [...out];
}

function visibleText(window: JSDOM["window"]) {
  const doc = window.document;
  const attrs = [...doc.querySelectorAll("[aria-label],[title],[placeholder]")].map((el) =>
    ["aria-label", "title", "placeholder"].map((a) => el.getAttribute(a) ?? "").join(" "),
  );
  return `${doc.title}\n${doc.body.textContent}\n${attrs.join("\n")}`;
}

describe("frame language follows Alisio", () => {
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

  it("renders Spanish from the first connect, switches on locale messages and keeps state", async () => {
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
    const wait = async (check: () => boolean) => {
      for (let i = 0; !check() && i < 300; i++) await new Promise((r) => setTimeout(r, 10));
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
      title: "Viaje",
      createdAt: 1,
      updatedAt: 1,
      remoteNoticeAck: false,
    };
    const citation = {
      n: 1,
      sourceId: "srcaaaaaaaaa",
      sourceName: "notas.md",
      ordinal: 0,
      page: null,
      charStart: 0,
      charEnd: 9,
    };
    const values: Record<string, unknown> = {
      status: {
        semanticApi: true,
        available: false,
        keywordOnly: true,
        model: { key: "e5-small", label: "e5", bytes: 135_392_016, prepared: false },
        setupJob: null,
        minHost: "0.11.7",
        notebooks: 1,
      },
      "notebooks.list": [{ ...nb, sourceCount: 3 }],
      "notebooks.get": {
        ...nb,
        sources: [
          { id: "srcaaaaaaaaa", name: "notas.md", status: "ready", error: null, chunkCount: 1 },
          {
            id: "srcbbbbbbbbb",
            name: "plan.pdf",
            status: "ready_keyword",
            error: "model_mismatch",
            chunkCount: 2,
          },
          {
            id: "srccccccccc2",
            name: "foto.docx",
            status: "failed",
            error: "zip_invalid",
            chunkCount: 0,
          },
          { id: "srcddddddddd", name: "lento.txt", status: "indexing", error: null, chunkCount: 0 },
        ],
      },
      "chat.history": [
        { id: 1, role: "user", text: "¿Cuándo sale el tren?", citations: [] },
        {
          id: 2,
          role: "assistant",
          text: "A las 21:40 [1].",
          citations: [citation],
          grounded: true,
          keywordOnly: true,
        },
        {
          id: 3,
          role: "assistant",
          text: "Sin citas.",
          citations: [],
          grounded: false,
          keywordOnly: false,
        },
      ],
      "engine.setup": { jobId: "setup-1" },
      "jobs.get": {
        id: "setup-1",
        state: "running",
        progress: 0.25,
        detail: {
          bytes: 33_848_004,
          total: 135_392_016,
          file: "tokenizer.json",
          fileIndex: 3,
          fileCount: 4,
          fileBytes: 1,
          fileTotal: 2,
        },
      },
    };
    const host = new MessageChannel();
    channels.push(host);
    host.port1.onmessage = ({ data }) => {
      if (data.type === "request")
        host.port1.postMessage({
          type: "response",
          id: data.id,
          result: { value: values[data.action] },
        });
    };
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: "alisio.app.connect", locale: "es-CO", visible: true },
        source: window.parent,
        ports: [host.port2 as unknown as MessagePort],
      }),
    );
    await loaded;
    const doc = window.document;
    const english = englishFragments();
    expect(english.length).toBeGreaterThan(50);
    const noEnglish = () => {
      const text = visibleText(window);
      // Whole-word match: English "Cancel" must not match Spanish "Cancelar".
      const quote = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return english.filter((fragment) =>
        new RegExp(`(?<![\\p{L}])${quote(fragment)}(?![\\p{L}])`, "u").test(text),
      );
    };

    // Home in Spanish, including the one-time download notice and plurals.
    await wait(() => !!doc.querySelector("#new-notebook"));
    expect(doc.documentElement.lang).toBe("es");
    expect(doc.title).toBe("Cuaderno");
    expect(doc.body.textContent).toContain("descarga única de unos 135 MB");
    expect(doc.body.textContent).toContain("3 fuentes");
    expect(noEnglish()).toEqual([]);

    // Notebook view in Spanish: source states, error codes, badges, warnings, empty guide.
    (doc.querySelector('[data-action="open"]') as HTMLButtonElement).click();
    await wait(() => !!doc.querySelector("#question"));
    expect(doc.body.textContent).toContain("Lista (palabras clave)");
    expect(doc.body.textContent).toContain("El archivo de Word está dañado o es demasiado grande.");
    expect(doc.body.textContent).toContain("Esta respuesta no cita tus fuentes");
    expect(noEnglish()).toEqual([]);

    // Running download progress, a typed draft with focus and an open dialog survive a switch.
    (doc.querySelector('[data-action="setup-start"]') as HTMLButtonElement).click();
    await wait(
      () => doc.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "25",
    );
    const box = doc.querySelector("#question") as HTMLTextAreaElement;
    box.value = "borrador sin enviar";
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
    box.focus();
    host.port1.postMessage({ type: "locale", locale: "en-US" });
    await wait(() => doc.documentElement.lang === "en");
    expect(doc.title).toBe("Notebook");
    expect(doc.querySelector(".nb-name")?.textContent).toBe("Viaje");
    expect((doc.querySelector("#question") as HTMLTextAreaElement).value).toBe(
      "borrador sin enviar",
    );
    expect(doc.activeElement?.id).toBe("question");
    expect(doc.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("25");
    expect(doc.body.textContent).toContain("Sources");
    expect(doc.body.textContent).toContain("34 of 135 MB");
    expect(doc.body.textContent).toContain("Ready (keyword search)");

    (doc.querySelector('[data-action="rename"]') as HTMLButtonElement).click();
    await wait(() => !!doc.querySelector("#dialog-input"));
    const input = doc.querySelector("#dialog-input") as HTMLInputElement;
    input.value = "Nombre a medias";
    expect(doc.querySelector("#dialog")?.textContent).toContain("Notebook name");
    host.port1.postMessage({ type: "locale", locale: "es" });
    await wait(() => doc.documentElement.lang === "es");
    expect(doc.querySelector("#dialog")?.textContent).toContain("Nombre del cuaderno");
    expect((doc.querySelector("#dialog-input") as HTMLInputElement).value).toBe("Nombre a medias");
    expect(doc.body.textContent).toContain("34 de 135 MB");
    expect(noEnglish()).toEqual([]);

    // Anything that is not es* is English.
    host.port1.postMessage({ type: "locale", locale: "fr" });
    await wait(() => doc.documentElement.lang === "en");
  });
});
