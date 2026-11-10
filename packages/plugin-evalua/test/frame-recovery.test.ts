import { afterAll, describe, expect, it } from "vitest";
import { frameEnv, type Reply, statusWith } from "./helpers/frame-env.js";

describe("host not_found recovery (EVL-APP-AC-20)", () => {
  let env: Awaited<ReturnType<typeof frameEnv>>;
  afterAll(() => env?.close());

  it("survives a transient host not_found, recovers from a persistent one, and stops polling on a plugin not_found", async () => {
    env = await frameEnv("en");
    const { window, doc, requests, wait, click, post } = env;
    let mode: "ok" | "once" | "down" = "ok";
    let jobLookups = 0;
    env.setResponder((request): Reply => {
      if (mode === "down") return { hostError: "not_found" };
      if (mode === "once" && request.action === "models.list") {
        mode = "ok";
        return { hostError: "not_found" };
      }
      switch (request.action) {
        case "status":
          return { value: statusWith("generated") };
        case "models.list":
          return { value: { models: [], chosen: null, available: false } };
        case "doctor":
          return { value: { browser: "found", source: "env", kbOk: true, kbErrors: 0 } };
        case "build.start":
          return { value: { jobId: "abcdefghijkl", revision: "r2" } };
        case "jobs.get":
          jobLookups += 1;
          return { error: "not_found" };
        default:
          return { value: null };
      }
    });
    env.connect(env.host, window.parent, "en");
    await env.loaded;
    await wait(() => !!doc.querySelector("#new-exam"));

    // A single host not_found (Alisio reopening the workspace) is confirmed with `status` first.
    mode = "once";
    click('[data-action="open-exam"]');
    await wait(() => requests.filter((r) => r.action === "status").length >= 2, 4000);
    expect(doc.body.textContent).not.toContain("not available");

    // Back on the exam: a build job whose id the plugin no longer knows only stops polling.
    await wait(() => !!doc.querySelector("#build"));
    click("#build");
    await wait(() => jobLookups >= 1, 4000);
    await new Promise((r) => setTimeout(r, 1700));
    expect(jobLookups).toBe(1);
    expect(doc.body.textContent).not.toContain("not available");

    // Two host not_founds in a row: the unavailable screen, with a retry.
    mode = "down";
    click('[data-action="settings"]');
    await wait(
      () => doc.querySelector("h1")?.textContent === "Evalua is not available right now",
      5000,
    );
    mode = "ok";
    click('[data-action="retry"]');
    // The open exam comes back as it was.
    await wait(
      () => !doc.querySelector('[data-action="retry"]') && !!doc.querySelector(".exam-steps"),
      5000,
    );

    // Becoming visible again while unavailable re-checks on its own.
    mode = "down";
    click('[data-action="settings"]');
    await wait(() => !!doc.querySelector('[data-action="retry"]'), 5000);
    mode = "ok";
    post({ type: "visibility", visible: false });
    post({ type: "visibility", visible: true });
    await wait(() => !doc.querySelector('[data-action="retry"]'), 5000);
  }, 30_000);
});
