import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { REASON_CODES } from "../src/generate.js";
import { ACTIONS } from "../src/service.js";
import { initialReport, PALETTES, type Report } from "../src/types.js";
import { frameEnv, type Reply, type Request } from "./helpers/frame-env.js";

let env: Awaited<ReturnType<typeof frameEnv>> | undefined;
afterEach(() => {
  env?.close();
  env = undefined;
});

type Handler = (input: Record<string, unknown>) => Reply;

/** A stateful fake backend: reports can change model and be deleted. */
function backend(overrides: Record<string, Handler> = {}, start: Partial<Report> = {}) {
  let reports: Report[] = [
    { ...initialReport({ name: "Q4 results", language: "en" }), ...start },
    initialReport({ name: "Other", language: "en" }),
  ];
  const find = (id: unknown) => reports.find((r) => r.id === id) as Report;
  return {
    get reports() {
      return reports;
    },
    respond: (request: Request): Reply => {
      const custom = overrides[request.action];
      if (custom) return custom(request.input);
      switch (request.action) {
        case "context":
          return { value: { locale: "en", palettes: PALETTES } };
        case "models":
          return { value: [{ reference: "acme/fast", label: "Acme · Fast" }] };
        case "reports.list":
          return {
            value: reports.map((r) => ({
              id: r.id,
              name: r.name,
              type: r.type,
              updatedAt: r.updatedAt,
              revision: r.revision,
            })),
          };
        case "reports.get":
          return { value: find(request.input.id) };
        case "report.setModel": {
          const r = find(request.input.id);
          r.model = String(request.input.model);
          return { value: r };
        }
        case "reports.delete":
          reports = reports.filter((r) => r.id !== request.input.id);
          return { value: { id: request.input.id, deleted: true } };
        case "report.render":
          return {
            value: { html: "<!doctype html><main class='document'>R</main>", fitCurrent: false },
          };
        default:
          return { value: null };
      }
    },
  };
}

async function openFirst(b: ReturnType<typeof backend>, locale = "en") {
  env = await frameEnv();
  const { $, window, connect, wait, setResponder } = env;
  setResponder(b.respond);
  connect(env.host, window.parent, locale);
  await wait(() => $("reports").querySelector("button") !== null);
  ($("reports").querySelector("button") as HTMLButtonElement).click();
  await wait(() => !$("edit").classList.contains("hidden"));
  return env;
}

const select = (el: HTMLElement) => el as unknown as HTMLSelectElement;

describe("model choice in the open report", () => {
  it("shows the current model, persists a change and uses it for the next generation", async () => {
    const b = backend({
      "report.generate": () => ({ value: { id: "job-1", status: "running" } }),
      "jobs.get": () => ({ value: { id: "job-1", status: "succeeded" } }),
    });
    const { $, window, wait, requests } = await openFirst(b);
    const editModel = select($("editModel"));
    expect(editModel.value).toBe("");
    expect([...editModel.options].map((o) => o.textContent)).toEqual([
      "Alisio default model",
      "Acme · Fast",
    ]);
    editModel.value = "acme/fast";
    editModel.dispatchEvent(new window.Event("change"));
    await wait(() => requests.some((r) => r.action === "report.setModel"));
    expect(requests.find((r) => r.action === "report.setModel")?.input).toEqual({
      id: b.reports[0]?.id,
      model: "acme/fast",
    });
    await wait(() => b.reports[0]?.model === "acme/fast");
    $("generate").click();
    await wait(() => requests.some((r) => r.action === "report.generate"));
    const setIndex = requests.findIndex((r) => r.action === "report.setModel");
    const genIndex = requests.findIndex((r) => r.action === "report.generate");
    expect(setIndex).toBeLessThan(genIndex);
    await wait(() => select($("editModel")).value === "acme/fast");
  });

  it("says when the stored model no longer exists and falls back to the default", async () => {
    const b = backend({}, { model: "gone/model" });
    const { $ } = await openFirst(b, "es");
    expect(select($("editModel")).value).toBe("");
    expect($("modelNote").textContent).toContain("gone/model");
    expect($("modelNote").textContent).toContain("Modelo predeterminado de Alisio");
  });

  it("shows a clear note when the model list fails or is empty", async () => {
    const failing = backend({ models: () => ({ error: "models_unavailable" }) });
    const first = await openFirst(failing);
    expect([...select(first.$("editModel")).options].map((o) => o.textContent)).toEqual([
      "Alisio default model",
    ]);
    expect(first.$("modelNote").textContent).toMatch(/could not list/i);
    expect(first.$("modelsNote").textContent).toMatch(/could not list/i);
    first.close();
    env = undefined;
    const empty = await openFirst(backend({ models: () => ({ value: [] }) }), "es");
    expect(empty.$("modelNote").textContent).toMatch(/no hay modelos/i);
  });
});

describe("delete a report", () => {
  it("asks for confirmation naming the report, then deletes and refreshes the list", async () => {
    const b = backend();
    const { $, wait, requests } = await openFirst(b);
    $("deleteReport").click();
    expect($("confirmBox").classList.contains("hidden")).toBe(false);
    expect($("confirmText").textContent).toContain("Q4 results");
    $("confirmDelete").click();
    await wait(() => !$("home").classList.contains("hidden"));
    expect(requests.filter((r) => r.action === "reports.delete")).toHaveLength(1);
    await wait(() => !($("reports").textContent ?? "").includes("Q4 results"));
    expect($("reports").textContent).toContain("Other");
    expect($("confirmBox").classList.contains("hidden")).toBe(true);
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const b = backend();
    env = await frameEnv();
    const { $, window, connect, wait, requests, setResponder } = env;
    setResponder(b.respond);
    connect(env.host, window.parent);
    await wait(() => $("reports").querySelector("[data-delete]") !== null);
    ($("reports").querySelector("[data-delete]") as HTMLButtonElement).click();
    expect($("confirmText").textContent).toContain("Q4 results");
    $("confirmCancel").click();
    expect($("confirmBox").classList.contains("hidden")).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(requests.some((r) => r.action === "reports.delete")).toBe(false);
    expect($("reports").textContent).toContain("Q4 results");
  });
});

describe("generation outcomes", () => {
  const failWith = (code: string) =>
    backend({
      "report.generate": () => ({ value: { id: "job-1", status: "running" } }),
      "jobs.get": () => ({ value: { id: "job-1", status: "failed", error: code } }),
    });

  it.each([
    ["en", "generation_truncated", /cut off \(too long\).*more compact/],
    ["es", "generation_truncated", /quedó incompleta \(demasiado larga\).*más compacto/],
    ["en", "generation_unreadable", /did not contain a readable report/],
    ["es", "generation_unreadable", /no contenía un informe legible/],
    ["en", "generation_invalid_structure", /without enough valid components/],
    ["es", "generation_invalid_structure", /sin suficientes componentes válidos/],
    ["en", "generation_incomplete", /did not finish/],
    ["es", "generation_incomplete", /no terminó/],
    ["en", "generation_model_error", /provider returned an error/],
    ["es", "generation_model_error", /proveedor del modelo/],
  ])("shows a specific %s message for %s", async (locale, code, pattern) => {
    const { $, wait } = await openFirst(failWith(code), locale);
    $("generate").click();
    await wait(() => ($("error").textContent ?? "").length > 0, 8000);
    expect($("error").textContent).toMatch(pattern);
    expect($("error").textContent).not.toContain(code);
  });

  it("covers every reason code in both languages", async () => {
    const html = await readFile(new URL("../ui/index.html", import.meta.url), "utf8");
    for (const code of [...Object.values(REASON_CODES), "unknown_model", "models_unavailable"]) {
      expect(html.match(new RegExp(`\\b${code}:`, "g"))?.length).toBe(2);
    }
    expect(Object.keys(ACTIONS)).toEqual(
      expect.arrayContaining(["report.setModel", "reports.delete"]),
    );
  });

  it("notes dropped components and a model fallback after success", async () => {
    const b = backend({
      "report.generate": () => ({ value: { id: "job-1", status: "running" } }),
      "jobs.get": () => ({
        value: { id: "job-1", status: "succeeded", dropped: 2, modelFallback: true },
      }),
    });
    const { $, wait } = await openFirst(b);
    $("generate").click();
    await wait(() => ($("jobState").textContent ?? "").includes("2"), 8000);
    expect($("jobState").textContent).toMatch(/2 invalid components were left out/);
    expect($("jobState").textContent).toMatch(/Alisio default model was used/);
  });
});
