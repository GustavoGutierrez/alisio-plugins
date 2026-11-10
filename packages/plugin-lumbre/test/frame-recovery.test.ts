import { afterAll, describe, expect, it } from "vitest";
import { bootFrame, type Request, STATUS } from "./frame-harness.js";

describe("frame recovery (LMB-AC-12)", () => {
  let frame: Awaited<ReturnType<typeof bootFrame>>;
  afterAll(() => frame?.close());

  it("survives one host not_found, shows Try again on a persistent one, and recovers", async () => {
    let mode: "ok" | "once" | "down" = "ok";
    let created = 0;
    frame = await bootFrame((r: Request) => {
      if (mode === "down") return { hostError: "not_found" };
      if (mode === "once" && r.action !== "status") {
        mode = "ok";
        return { hostError: "not_found" };
      }
      if (r.action === "status") return { value: STATUS };
      if (r.action === "models.list")
        return { value: { models: [], active: null, available: false } };
      if (r.action === "projects.list") return { value: [] };
      if (r.action === "projects.update") created++;
      // A plugin-level not_found (an unknown item) must never mean "app gone".
      return { error: "not_found" };
    });
    const { doc, connect, host, wait, click, requests } = frame;
    connect(host, frame.window.parent);
    await frame.loaded;
    await wait(() => !!doc.querySelector(".hero h1"));
    // No model connected: building is blocked with an explanation.
    expect(doc.querySelector(".banner.warn")?.textContent).toMatch(/No model connected/);
    expect((doc.querySelector('[data-action="create"]') as HTMLButtonElement).disabled).toBe(true);

    // A transient host not_found is verified once and never latches.
    mode = "once";
    host.port1.postMessage({ type: "visibility", visible: false });
    host.port1.postMessage({ type: "visibility", visible: true });
    await wait(() => requests.filter((r) => r.action === "status").length >= 2, 4000);
    expect(doc.querySelector(".unavailable")).toBeNull();

    // A persistent one shows the unavailable screen, whose button verifies again.
    mode = "down";
    host.port1.postMessage({ type: "visibility", visible: false });
    host.port1.postMessage({ type: "visibility", visible: true });
    await wait(() => !!doc.querySelector(".unavailable"), 5000);
    expect(doc.querySelector(".unavailable h1")?.textContent).toBe("Lumbre is not available");
    mode = "ok";
    click('[data-action="retry"]');
    await wait(() => !!doc.querySelector(".hero h1"), 4000);
    expect(created).toBe(0);
  }, 20_000);
});
