import { afterAll, describe, expect, it } from "vitest";
import { bootFrame, PROJECT_ID, project, type Request, STATUS } from "./frame-harness.js";

const J1 = "11111111-1111-4111-8111-111111111111";
const J2 = "22222222-2222-4222-8222-222222222222";
const J3 = "33333333-3333-4333-8333-333333333333";
const PLAN = "44444444-4444-4444-8444-444444444444";

describe("agent mode in the frame (AGT-AC-10)", () => {
  let frame: Awaited<ReturnType<typeof bootFrame>>;
  afterAll(() => frame?.close());

  it("approves a plan, shows the live activity, checks the draft, reviews, and continues a paused build", async () => {
    let polls = 0;
    let state = project({
      chat: [
        { id: "u1", role: "user", text: "Una panadería", at: 1 },
        {
          id: PLAN,
          role: "assistant",
          text: "## Plan\n- Hero\n- Menú",
          at: 2,
          plan: {
            status: "pending",
            design: {
              direction: "Organic, sun-warmed",
              palette: [
                { name: "Masa", hex: "#f2e3c6" },
                { name: "Horno", hex: "#9a3b1e" },
              ],
              type: [{ role: "display", font: "Georgia serif" }],
              layout: "Left-aligned hero.",
              wireframe: "| headline [img] |",
              principles: ["One warm accent."],
            },
          },
        },
      ],
    });
    const agentJob = (state: string, extra: Record<string, unknown> = {}) => ({
      id: J1,
      kind: "agent",
      state,
      error: null,
      stage: { key: "agentStep", args: { kind: "write", file: "index.html" } },
      steps: [],
      progress: null,
      elapsedMs: 5000,
      log: "",
      result: null,
      diagnostics: null,
      agent: {
        counts: { read: 1, write: 2, edit: 1, delete: 0, tools: 5 },
        timeline: [
          { at: 1, kind: "thinking" },
          { at: 2, kind: "progress", text: "Escribiendo el menú" },
          { at: 3, kind: "write", path: "index.html" },
        ],
      },
      ...extra,
    });
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
          return { value: { models: [], active: "acme/fast", available: true } };
        case "projects.get":
          return { value: state };
        case "preview.snapshot":
          return { value: { kind: "none", html: "", css: [], assets: {}, stale: true } };
        case "proposal.get":
          return {
            value: {
              id: "p1",
              base: "x",
              summary: "Bakery",
              files: { "index.html": "<h1>Pan</h1>" },
              deletes: [],
              dependencies: {},
              ignored: [],
              fixAttempt: 0,
              before: { "index.html": null },
            },
          };
        case "chat.send":
          return { value: { jobId: J1 } };
        case "agent.check":
          return { value: { jobId: J2 } };
        case "agent.continue":
          return { value: { jobId: J3 } };
        case "jobs.get": {
          if (r.input.jobId === J1)
            return {
              value:
                ++polls < 3
                  ? agentJob("running")
                  : agentJob("done", { result: { needsCheck: true } }),
            };
          if (r.input.jobId === J2) {
            state = project({ proposal: { id: "p1", summary: "Bakery", fixAttempt: 0 } });
            return {
              value: {
                ...agentJob("done", { id: J2, kind: "agentCheck", result: { proposalId: "p1" } }),
              },
            };
          }
          return { value: agentJob("running", { id: J3 }) };
        }
        default:
          return { error: "invalid_input" };
      }
    }, "es");
    const { doc, connect, host, wait, click, requests } = frame;
    connect(host, frame.window.parent);
    await frame.loaded;
    await wait(() => !!doc.querySelector('[data-action="open-project"]'));
    click('[data-action="open-project"]');
    await wait(() => !!doc.querySelector(".plan-card"));
    const card = doc.querySelector(".plan-card") as HTMLElement;
    expect(card.querySelectorAll(".swatch").length).toBe(2);
    expect((card.querySelector(".swatch") as HTMLElement).style.background).toBe(
      "rgb(242, 227, 198)",
    );
    expect(card.querySelector(".wireframe")?.textContent).toBe("| headline [img] |");
    expect(card.textContent).toContain("Construir este plan");
    // The mode toggle exists, in Spanish.
    expect(doc.querySelector(".mode-toggle")?.textContent).toContain("Planificar");

    click('[data-action="build-plan"]');
    await wait(() => requests.some((r) => r.action === "chat.send"));
    const send = requests.find((r) => r.action === "chat.send") as Request;
    expect(send.input).toMatchObject({
      mode: "build",
      planId: PLAN,
      text: "Construye el plan aprobado.",
    });
    expect(send.idempotencyKey).toBe(send.id);
    await wait(() => !!doc.querySelector(".job-card.activity"), 5000);
    const activity = doc.querySelector(".job-card.activity") as HTMLElement;
    expect(activity.querySelector(".job-stage")?.textContent).toBe("Escribió index.html");
    expect(activity.querySelector(".counts-line")?.textContent).toBe(
      "2 escritos, 1 editados, 0 eliminados, 1 leídos",
    );
    expect([...activity.querySelectorAll(".timeline li")].map((li) => li.textContent)).toEqual([
      "Empezó",
      "Escribiendo el menú",
      "Escribió index.html",
    ]);
    // Done with a draft to check: the frame starts the check (a process action) by itself.
    await wait(() => requests.some((r) => r.action === "agent.check"), 6000);
    await wait(
      () => doc.querySelector('[role="tab"][aria-selected="true"]')?.id === "tab-changes",
      6000,
    );

    // A paused build: Continue with a goal.
    state = project({
      agent: {
        phase: "paused",
        pausedReason: "turns",
        counts: { read: 0, write: 3, edit: 0, delete: 0, tools: 3 },
        timeline: [{ at: 1, kind: "write", path: "a.html" }],
        changed: 3,
      },
    });
    host.port1.postMessage({ type: "visibility", visible: false });
    host.port1.postMessage({ type: "visibility", visible: true });
    await wait(() => !!doc.querySelector(".job-card.paused"), 5000);
    expect(doc.querySelector(".job-card.paused")?.textContent).toContain(
      "Usó los pasos de esta ronda",
    );
    const goal = doc.querySelector("#goal") as HTMLTextAreaElement;
    goal.value = "Agrega el horario";
    click('[data-action="agent-continue"]');
    await wait(() => requests.some((r) => r.action === "agent.continue"));
    expect(requests.find((r) => r.action === "agent.continue")?.input).toEqual({
      projectId: PROJECT_ID,
      goal: "Agrega el horario",
    });
  }, 20_000);
});
