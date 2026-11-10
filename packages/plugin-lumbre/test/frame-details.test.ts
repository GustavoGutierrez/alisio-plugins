import { afterAll, describe, expect, it } from "vitest";
import { bootFrame, PROJECT_ID, project, type Request, STATUS } from "./frame-harness.js";

const JOB = "99999999-8888-4777-8666-555555555555";

describe("job details (0.1.1)", () => {
  let frame: Awaited<ReturnType<typeof bootFrame>>;
  afterAll(() => frame?.close());

  it("explains a failed generation with its reason and shows the numbers in Details", async () => {
    frame = await bootFrame((r: Request) => {
      switch (r.action) {
        case "status":
          return { value: STATUS };
        case "projects.list":
          return {
            value: [
              {
                id: PROJECT_ID,
                title: "Panadería",
                stack: "vanilla",
                tailwind: false,
                archived: false,
                updatedAt: 1,
                running: false,
                damaged: false,
              },
            ],
          };
        case "models.list":
          return {
            value: {
              models: [
                {
                  reference: "opencode-go/deepseek-v4.1-flash",
                  name: "DeepSeek",
                  provider: "OpenCode Go",
                },
              ],
              active: null,
              available: true,
            },
          };
        case "projects.get":
          return { value: project() };
        case "preview.snapshot":
          return { value: { kind: "none", html: "", css: [], assets: {}, stale: true } };
        case "chat.send":
          return { value: { jobId: JOB } };
        case "jobs.get":
          return {
            value: {
              id: JOB,
              kind: "generate",
              state: "failed",
              error: "agent_failed",
              stage: { key: "thinking" },
              steps: [],
              progress: null,
              elapsedMs: 4000,
              log: "",
              result: null,
              diagnostics: {
                model: "opencode-go/deepseek-v4.1-flash",
                contextWindow: 128000,
                contextSource: "estimated",
                outputBudget: 32768,
                outputSource: "estimated",
                usageInput: 5200,
                usageOutput: 0,
                planned: false,
                batches: 0,
                continuations: 0,
                retriedWithoutLimit: false,
                reason: "rate_limit",
              },
            },
          };
        default:
          return { error: "invalid_input" };
      }
    }, "en");
    const { doc, connect, host, wait, click } = frame;
    connect(host, frame.window.parent);
    await frame.loaded;
    await wait(() => !!doc.querySelector('[data-action="open-project"]'));
    click('[data-action="open-project"]');
    await wait(() => !!doc.querySelector("#composer"));
    const box = doc.querySelector("#composer") as HTMLTextAreaElement;
    box.value = "A bakery landing";
    box.dispatchEvent(new frame.window.Event("input", { bubbles: true }));
    click('[data-action="send"]');
    await wait(() => !!doc.querySelector(".job-card.error"), 6000);
    expect(doc.querySelector(".job-card.error strong")?.textContent).toBe(
      "The model did not finish. Try again, or choose another model. (the provider's rate limit was reached)",
    );
    click('[data-action="toggle-details"]');
    await wait(() => !!doc.querySelector(".diag"));
    const details = doc.querySelector(".diag")?.textContent ?? "";
    expect(details).toContain("opencode-go/deepseek-v4.1-flash");
    expect(details).toContain("128,000 (estimated)");
    expect(details).toContain("32,768 (estimated)");
    expect(details).toContain("5,200 / 0");
  }, 20_000);
});
