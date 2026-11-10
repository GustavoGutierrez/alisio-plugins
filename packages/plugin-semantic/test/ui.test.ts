import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain browser module without declarations.
import * as derive from "../web/derive.js";
// @ts-expect-error -- plain browser module without declarations.
import { messages } from "../web/i18n.js";

const citations = [
  { n: 1, sourceId: "s1", sourceName: "a.md", ordinal: 0, page: null },
  { n: 2, sourceId: "s2", sourceName: "b.pdf", ordinal: 3, page: 4 },
];

describe("citation chips (SEM-AC-26)", () => {
  it("turns valid [n] markers into chips and keeps other text", () => {
    const parts = derive.citationParts("Alpha [1]. Both [1, 2]. Unknown [7].", citations);
    expect(
      parts.filter((p: { type: string }) => p.type === "cite").map((p: { n: number }) => p.n),
    ).toEqual([1, 1, 2]);
    expect(parts.map((p: { text?: string; n?: number }) => p.text ?? `#${p.n}`).join("")).toBe(
      "Alpha #1. Both #1#2. Unknown [7].",
    );
    expect(parts.find((p: { n?: number }) => p.n === 2)?.citation.page).toBe(4);
  });
});

describe("job and source states (SEM-AC-26)", () => {
  it("derives running, done, failed and cancelled with a percentage", () => {
    expect(derive.jobView({ state: "running", progress: 0.456 })).toMatchObject({
      running: true,
      percent: 46,
    });
    expect(derive.jobView({ state: "done", progress: 1 })).toMatchObject({
      done: true,
      running: false,
      error: null,
    });
    expect(derive.jobView({ state: "failed", error: "no_text" })).toMatchObject({
      failed: true,
      error: "no_text",
    });
    expect(derive.jobView({ state: "cancelled" })).toMatchObject({
      cancelled: true,
      error: "operation_failed",
    });
  });

  it("labels sources and detects a needed rebuild", () => {
    expect(
      derive.sourceStatus({ status: "indexing" }, { state: "running", progress: 0.5 }),
    ).toEqual({ key: "indexing", percent: 50 });
    expect(derive.sourceStatus({ status: "ready_keyword", error: "model_mismatch" }).key).toBe(
      "keyword",
    );
    expect(derive.sourceStatus({ status: "failed", error: "no_text" })).toEqual({
      key: "failed",
      error: "no_text",
    });
    expect(derive.needsRebuild([{ error: null }, { error: "model_mismatch" }])).toBe(true);
    expect(derive.needsRebuild([{ error: null }])).toBe(false);
  });

  it("restricts the question scope only when some sources are unticked", () => {
    const sources = [
      { id: "a", status: "ready" },
      { id: "b", status: "ready_keyword" },
      { id: "c", status: "failed" },
    ];
    expect(derive.scopeIds(sources, new Set(["a", "b"]))).toBeUndefined();
    expect(derive.scopeIds(sources, new Set(["b"]))).toEqual(["b"]);
    expect(derive.selectAllState(sources, new Set(["a", "b"]))).toBe("all");
    expect(derive.selectAllState(sources, new Set(["a"]))).toBe("mixed");
    expect(derive.selectAllState(sources, new Set())).toBe("none");
  });
});

describe("remote-model notice (D14, SEM-AC-26)", () => {
  it("is needed once per notebook, until acknowledged", () => {
    const notebook = { id: "n1", remoteNoticeAck: false };
    expect(derive.needsRemoteNotice(notebook)).toBe(true);
    expect(derive.needsRemoteNotice({ ...notebook, remoteNoticeAck: true })).toBe(false);
    expect(derive.needsRemoteNotice({ id: "n2", remoteNoticeAck: false })).toBe(true);
  });
});

describe("one-time model download step", () => {
  const status = {
    semanticApi: true,
    model: { key: "e5-small", bytes: 135_392_016, prepared: false },
  };
  it("offers the download with its size only while the model is missing", () => {
    expect(derive.setupView(status, undefined)).toEqual({ state: "offer", totalMb: "135" });
    expect(
      derive.setupView({ ...status, model: { ...status.model, prepared: true } }, undefined),
    ).toEqual({ state: "hidden" });
    expect(derive.setupView({ semanticApi: false, model: status.model }, undefined)).toEqual({
      state: "hidden",
    });
  });

  it("shows overall and per-file progress while downloading", () => {
    const job = {
      state: "running",
      progress: 0.5,
      detail: {
        file: "onnx/model_quantized.onnx",
        fileIndex: 4,
        fileCount: 4,
        fileBytes: 50_000_000,
        fileTotal: 118_308_185,
        bytes: 67_696_008,
        total: 135_392_016,
      },
    };
    expect(derive.setupView(status, job)).toEqual({
      state: "downloading",
      percent: 50,
      doneMb: "68",
      totalMb: "135",
      file: "onnx/model_quantized.onnx",
      fileIndex: 4,
      fileCount: 4,
      filePercent: 42,
    });
    expect(
      derive.setupView(status, {
        state: "done",
        progress: 1,
        result: { downloaded: true, activation: "activated" },
      }),
    ).toEqual({
      state: "done",
      downloaded: true,
      activation: "activated",
    });
    expect(derive.setupView(status, { state: "cancelled", error: "cancelled" })).toEqual({
      state: "cancelled",
      error: "cancelled",
    });
  });

  it("words the one-time download in both languages", () => {
    expect(messages.en.setupNotice("135")).toBe(
      "Semantic search needs a one-time download of about 135 MB. After that it works offline.",
    );
    expect(messages.es.setupNotice("135")).toBe(
      "La búsqueda semántica necesita una descarga única de unos 135 MB. Después funciona sin conexión.",
    );
    expect(messages.en.setupDone).toMatch(/not.*again/i);
    expect(messages.es.setupDone).toMatch(/no se volverán a descargar/i);
  });
});

describe("transport errors (SEM-AC-23)", () => {
  it("names the missing permission from the host effect, else from the action", () => {
    expect(derive.responseError({ error: "not_permitted", effect: "write" }, "read")).toBe(
      "not_permitted_write",
    );
    expect(derive.responseError({ error: "not_permitted" }, "write")).toBe("not_permitted_write");
    expect(derive.responseError({ error: "not_found" }, "read")).toBe("not_found");
    expect(derive.responseError({ result: { error: "no_text" } }, "write")).toBe("no_text");
    expect(derive.responseError({ result: { value: 1 } }, "write")).toBeNull();
  });

  it("has a localized message for every plugin error code", async () => {
    const { ERROR_CODES } = await import("../src/errors.js");
    for (const locale of ["en", "es"] as const)
      for (const code of [
        ...ERROR_CODES,
        "not_permitted_write",
        "timeout",
        "too_large",
        "too_many_requests",
        "network",
      ])
        expect(messages[locale].errors[code], `${locale}.${code}`).toBeTruthy();
  });
});

describe("presentations and workbooks in the frame (O10)", () => {
  it("labels passages as page, slide or sheet in both languages", () => {
    expect(derive.placeLabel({ page: 3, pageKind: "page" })).toEqual(["page", 3]);
    expect(derive.placeLabel({ page: 2, pageKind: "slide" })).toEqual(["slide", 2]);
    expect(derive.placeLabel({ page: 1, pageKind: "sheet", pageName: "Ventas" })).toEqual([
      "sheet",
      "Ventas",
    ]);
    expect(derive.placeLabel({ page: null, pageKind: null })).toBeNull();
    expect(messages.en.slide(2)).toBe("Slide 2");
    expect(messages.es.slide(2)).toBe("Diapositiva 2");
    expect(messages.en.sheet("Sales")).toBe("Sheet: Sales");
    expect(messages.es.sheet("Ventas")).toBe("Hoja: Ventas");
  });

  it("offers only supported files in the picker and the file chooser", () => {
    const entries = [
      { name: "deck.pptx", kind: "file" },
      { name: "book.XLSX", kind: "file" },
      { name: "macro.xlsm", kind: "file" },
      { name: "photo.png", kind: "file" },
      { name: "docs", kind: "dir" },
    ];
    expect(derive.pickerEntries(entries).map((e: { name: string }) => e.name)).toEqual([
      "deck.pptx",
      "book.XLSX",
      "docs",
    ]);
    expect(derive.SOURCE_EXTENSIONS).toEqual(
      expect.arrayContaining([".pptx", ".xlsx", ".docx", ".pdf"]),
    );
    expect(derive.SOURCE_EXTENSIONS).not.toContain(".xlsm");
    for (const locale of ["en", "es"] as const)
      expect(messages[locale].noSources).toMatch(/\.pptx.*\.xlsx/);
  });
});

describe("assistant disclaimer (0.1.1)", () => {
  it("is worded in both languages", () => {
    expect(messages.en.disclaimer).toBe(
      "The assistant can make mistakes, so check its answers against the cited sources.",
    );
    expect(messages.es.disclaimer).toBe(
      "El asistente puede cometer errores; comprueba sus respuestas con las fuentes citadas.",
    );
  });
});
