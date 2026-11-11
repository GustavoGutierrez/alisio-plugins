import { afterEach, describe, expect, it } from "vitest";
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
const PDF_BASE64 = Buffer.from("%PDF-1.7 fake").toString("base64");

function backend(overrides: Record<string, (input: Record<string, unknown>) => Reply> = {}) {
  return (request: Request): Reply => {
    const custom = overrides[request.action];
    if (custom) return custom(request.input);
    switch (request.action) {
      case "context":
        return { value: { locale: "en", palettes: PALETTES } };
      case "models":
        return { value: [] };
      case "reports.list":
        return {
          value: [
            {
              id: REPORT.id,
              name: REPORT.name,
              type: REPORT.type,
              updatedAt: REPORT.updatedAt,
              revision: 1,
            },
          ],
        };
      case "reports.get":
        return { value: REPORT };
      case "report.render":
        return {
          value: { html: "<!doctype html><main class='document'>R</main>", fitCurrent: false },
        };
      case "report.pdf":
        return { value: { id: "pdf-1", reportId: REPORT.id, kind: "pdf", status: "running" } };
      case "jobs.get":
        return { value: { id: "pdf-1", kind: "pdf", status: "succeeded" } };
      case "report.pdf.get":
        return { value: { base64: PDF_BASE64, filename: "Q4-results.pdf", bytes: 13 } };
      default:
        return { value: null };
    }
  };
}

async function open(respond: ReturnType<typeof backend>, locale = "en") {
  env = await frameEnv();
  const { $, window, connect, wait, setResponder } = env;
  setResponder(respond);
  // Capture downloads and any attempt to print the preview frame.
  const blobs: Blob[] = [];
  const downloads: string[] = [];
  const printed: string[] = [];
  window.URL.createObjectURL = (blob: Blob) => {
    blobs.push(blob);
    return `blob:frame/${blobs.length}`;
  };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  };
  connect(env.host, window.parent, locale);
  await wait(() => $("reports").querySelector("button") !== null);
  ($("reports").querySelector("button") as HTMLButtonElement).click();
  await wait(() => !$("edit").classList.contains("hidden"));
  const preview = $("frame") as unknown as HTMLIFrameElement;
  if (preview.contentWindow) {
    (preview.contentWindow as unknown as { print: () => void }).print = () => printed.push("print");
  }
  return { ...env, blobs, downloads, printed };
}

describe("PDF download", () => {
  it("prints in the plugin, downloads the PDF and never opens the frame's print dialog", async () => {
    const { $, wait, requests, blobs, downloads, printed } = await open(backend());
    expect($("printPdf").textContent).toBe("↓ PDF");
    $("printPdf").click();
    await wait(() => downloads.length > 0);
    const pdf = requests.find((r) => r.action === "report.pdf");
    expect(pdf?.input).toEqual({ id: REPORT.id });
    expect(requests.some((r) => r.action === "jobs.get" && r.input.jobId === "pdf-1")).toBe(true);
    expect(requests.find((r) => r.action === "report.pdf.get")?.input).toEqual({ jobId: "pdf-1" });
    expect(downloads).toEqual(["Q4-results.pdf"]);
    expect(blobs[0]?.type).toBe("application/pdf");
    const blob = blobs[0];
    if (!blob) throw new Error("no download");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Buffer.from(bytes).toString("latin1")).toBe("%PDF-1.7 fake");
    expect(printed).toEqual([]);
    await wait(() => /PDF downloaded/.test($("jobState").textContent ?? ""));
    expect(($("printPdf") as unknown as HTMLButtonElement).disabled).toBe(false);
  });

  it("says no browser was found and points to the HTML download", async () => {
    const { $, wait, downloads } = await open(
      backend({ "report.pdf": () => ({ error: "browser_not_found" }) }),
      "es",
    );
    $("printPdf").click();
    await wait(() => ($("error").textContent ?? "").length > 0);
    expect($("error").textContent).toBe(
      "No se encontró un navegador para crear el PDF (Chrome, Edge, Brave, Chromium…). Usa ↓ HTML y guárdalo como PDF desde tu navegador.",
    );
    expect(downloads).toEqual([]);
    expect($("exportHtml").textContent).toBe("↓ HTML");
  });

  it("asks to allow running programs when the session denies the process effect", async () => {
    for (const [locale, pattern] of [
      ["en", /allow running programs/i],
      ["es", /ejecutar programas/i],
    ] as const) {
      const { $, wait } = await open(
        backend({ "report.pdf": () => ({ hostError: "not_permitted", effect: "process" }) }),
        locale,
      );
      $("printPdf").click();
      await wait(() => ($("error").textContent ?? "").length > 0);
      expect($("error").textContent).toMatch(pattern);
      env?.close();
      env = undefined;
    }
  });

  it("reports a failed print with its message", async () => {
    const { $, wait, downloads } = await open(
      backend({
        "jobs.get": () => ({
          value: { id: "pdf-1", kind: "pdf", status: "failed", error: "pdf_timeout" },
        }),
      }),
    );
    $("printPdf").click();
    await wait(() => ($("error").textContent ?? "").length > 0);
    expect($("error").textContent).toMatch(/took too long/i);
    expect(downloads).toEqual([]);
  });

  it("the shipped frame no longer calls print() on the preview", async () => {
    const { readFile } = await import("node:fs/promises");
    const html = await readFile(new URL("../ui/index.html", import.meta.url), "utf8");
    expect(html).not.toMatch(/\.print\(/);
    expect(html).not.toContain("allow-modals");
  });
});
