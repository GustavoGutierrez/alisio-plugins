import { afterEach, describe, expect, it } from "vitest";
import { ACTIONS } from "../src/service.js";
import { initialReport, PALETTES, type Report } from "../src/types.js";
import { frameEnv, type Reply, type Request } from "./helpers/frame-env.js";

let env: Awaited<ReturnType<typeof frameEnv>> | undefined;
afterEach(() => {
  env?.close();
  env = undefined;
});

const REPORT: Report = {
  ...initialReport({ name: "Q4 results", language: "en" }),
  blocks: [{ id: "c1", type: "bars", title: "Sales", labels: ["a", "b"], values: [1, 2] }],
};

/** A fake plugin backend for the main flows. */
function backend(overrides: Record<string, (input: Record<string, unknown>) => Reply> = {}) {
  let report = structuredClone(REPORT);
  return (request: Request): Reply => {
    const custom = overrides[request.action];
    if (custom) return custom(request.input);
    switch (request.action) {
      case "context":
        return { value: { locale: "en", palettes: PALETTES } };
      case "models":
        return { value: [{ reference: "acme/fast", label: "Acme · Fast" }] };
      case "reports.list":
        return {
          value: [
            {
              id: report.id,
              name: report.name,
              type: report.type,
              updatedAt: report.updatedAt,
              revision: 1,
            },
          ],
        };
      case "reports.create":
      case "reports.get":
        return { value: report };
      case "report.settings":
        report = { ...report, ...(request.input as Partial<Report>), palette: report.palette };
        return { value: report };
      case "report.render":
        return {
          value: { html: "<!doctype html><main class='document'>R</main>", fitCurrent: false },
        };
      case "report.fit":
        return { value: { scale: 0.62, small: false, overflow: false } };
      default:
        return { value: null };
    }
  };
}

describe("frame handshake", () => {
  it("accepts only the first connect from window.parent and shapes requests", async () => {
    env = await frameEnv();
    const { window, connect, channel, requests, wait, setResponder } = env;
    setResponder(backend());
    const rogue = channel();
    const rogueSeen: unknown[] = [];
    rogue.port1.onmessage = (e) => rogueSeen.push(e.data);
    connect(rogue, null);
    connect(env.host, window.parent);
    const late = channel();
    const lateSeen: unknown[] = [];
    late.port1.onmessage = (e) => lateSeen.push(e.data);
    connect(late, window.parent);
    await wait(() => requests.some((r) => r.action === "reports.list"));
    expect(rogueSeen).toEqual([]);
    expect(lateSeen).toEqual([]);
    expect(requests.map((r) => r.action).slice(0, 3)).toEqual([
      "context",
      "models",
      "reports.list",
    ]);
    for (const r of requests) {
      expect(r).toMatchObject({ type: "request", id: expect.stringMatching(/^r\d+$/) });
      expect(Object.keys(ACTIONS)).toContain(r.action);
    }
  });

  it("follows the connect locale and later locale messages", async () => {
    env = await frameEnv();
    const { $, doc, window, connect, wait, setResponder, post } = env;
    setResponder(backend());
    connect(env.host, window.parent, "es-CO");
    await wait(() => $("reports").textContent?.includes("Q4 results") ?? false);
    expect(doc.documentElement.lang).toBe("es");
    expect($("navCreate").textContent).toContain("Nuevo informe");
    expect(($("type") as unknown as HTMLSelectElement).options[0]?.textContent).toBe("Ejecutivo");
    post({ type: "locale", locale: "en" });
    await wait(() => doc.documentElement.lang === "en");
    expect($("navCreate").textContent).toContain("New report");
  });

  it("shows the unavailable banner on not_found and localized error codes", async () => {
    env = await frameEnv();
    const { $, window, connect, wait, setResponder } = env;
    setResponder((r) => (r.action === "context" ? { hostError: "not_found" } : { value: [] }));
    connect(env.host, window.parent);
    await wait(() => !$("unavailable").classList.contains("hidden"));
    expect($("error").textContent).toBe("not_found");
  });

  it("names the missing permission when the host denies a write", async () => {
    env = await frameEnv();
    const { $, window, connect, wait, setResponder } = env;
    setResponder(
      backend({ "reports.create": () => ({ hostError: "not_permitted", effect: "write" }) }),
    );
    connect(env.host, window.parent);
    await wait(() => $("reports").textContent?.includes("Q4") ?? false);
    $("newTop").click();
    $("createAction").click();
    await wait(() => ($("error").textContent ?? "").length > 0);
    expect($("error").textContent).toMatch(/write access/);
  });
});

describe("studio flows", () => {
  it("creates a report with the brief and opens the editor", async () => {
    env = await frameEnv();
    const { $, window, connect, wait, requests, setResponder } = env;
    setResponder(backend());
    connect(env.host, window.parent);
    await wait(() => ($("model") as unknown as HTMLSelectElement).options.length === 2);
    $("newTop").click();
    $("name").value = "Q4 results";
    $("goal").value = "Decide budget";
    $("createAction").click();
    await wait(() => !$("edit").classList.contains("hidden"));
    const create = requests.find((r) => r.action === "reports.create");
    expect(create?.input).toMatchObject({
      name: "Q4 results",
      goal: "Decide budget",
      type: "executive",
      paletteId: "midnight",
    });
    expect($("docTitle").textContent).toBe("Q4 results");
    await wait(() => requests.some((r) => r.action === "report.render"));
  });

  it("measures and fits a single-page report before rendering it", async () => {
    env = await frameEnv();
    const { $, window, connect, wait, requests, setResponder } = env;
    setResponder(backend());
    connect(env.host, window.parent);
    await wait(() => $("reports").querySelector("button") !== null);
    ($("reports").querySelector("button") as HTMLButtonElement).click();
    await wait(() => !$("edit").classList.contains("hidden"));
    // jsdom has no layout engine: give the measuring frame a size like a browser would.
    const measure = $("measure") as unknown as HTMLIFrameElement;
    const frameWindow = measure.contentWindow as unknown as typeof window;
    const proto = frameWindow.HTMLElement.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 1663 });
    Object.defineProperty(proto, "scrollWidth", { configurable: true, get: () => 702 });
    ($("mode") as unknown as HTMLSelectElement).value = "singlepage";
    $("mode").dispatchEvent(new window.Event("change"));
    await wait(() => requests.some((r) => r.action === "report.fit"), 8000);
    const measureRender = requests.find(
      (r) => r.action === "report.render" && r.input.measure === true,
    );
    expect(measureRender).toBeDefined();
    expect(requests.find((r) => r.action === "report.fit")?.input).toMatchObject({
      width: 702,
      height: 1663,
    });
    await wait(() => ($("fitNote").textContent ?? "").includes("62%"));
    expect(measure.srcdoc).toContain("class='document'");
  });

  it("polls a generation job until it succeeds and offers cancel meanwhile", async () => {
    env = await frameEnv();
    const { $, window, connect, wait, requests, setResponder } = env;
    let polls = 0;
    setResponder(
      backend({
        "report.generate": () => ({
          value: { id: "job-1", reportId: REPORT.id, status: "running" },
        }),
        "jobs.get": () => ({
          value: { id: "job-1", status: ++polls < 2 ? "running" : "succeeded" },
        }),
      }),
    );
    connect(env.host, window.parent);
    await wait(() => $("reports").querySelector("button") !== null);
    ($("reports").querySelector("button") as HTMLButtonElement).click();
    await wait(() => !$("edit").classList.contains("hidden"));
    $("generate").click();
    await wait(() => !$("cancelJob").classList.contains("hidden"));
    expect(($("generate") as unknown as HTMLButtonElement).disabled).toBe(true);
    await wait(() => $("jobState").textContent === "Report updated.", 8000);
    await wait(() => !($("generate") as unknown as HTMLButtonElement).disabled);
    expect(requests.filter((r) => r.action === "jobs.get").length).toBeGreaterThanOrEqual(2);
    expect($("cancelJob").classList.contains("hidden")).toBe(true);
  });

  it("shows a plugin error code as a readable message", async () => {
    env = await frameEnv();
    const { $, window, connect, wait, setResponder } = env;
    setResponder(backend({ "source.url": () => ({ error: "private_address_blocked" }) }));
    connect(env.host, window.parent);
    await wait(() => $("reports").querySelector("button") !== null);
    ($("reports").querySelector("button") as HTMLButtonElement).click();
    await wait(() => !$("edit").classList.contains("hidden"));
    $("sourceUrl").value = "https://intranet.example";
    $("addUrl").click();
    await wait(() => ($("error").textContent ?? "").length > 0);
    expect($("error").textContent).toBe(
      "That address points to a private network and was blocked.",
    );
  });
});
