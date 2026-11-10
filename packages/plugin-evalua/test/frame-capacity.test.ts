import { afterAll, describe, expect, it } from "vitest";
import { frameEnv, type Reply, statusWith } from "./helpers/frame-env.js";

const FACTORING = {
  id: "algebra/factoring",
  name: { es: "Factorización" },
  pack: "algebra",
  grades: ["Octavo"],
  levels: ["basico"],
  supports: { single_choice: true, multiple_choice: false, open: false, practice: true },
};
const SHORTFALL = {
  topic: "algebra/factoring",
  name: { es: "Factorización" },
  type: "single_choice",
  requested: 15,
  available: 12,
};

describe("capacity in the frame", () => {
  let env: Awaited<ReturnType<typeof frameEnv>>;
  afterAll(() => env?.close());

  it("explains a blocked generation in plain words and offers only the topic's types", async () => {
    env = await frameEnv("es");
    const { window, doc, requests, wait, click } = env;
    env.setResponder((request): Reply => {
      switch (request.action) {
        case "status":
          return { value: statusWith("approved-a") };
        case "models.list":
          return { value: { models: [], chosen: null, available: false } };
        case "wording.get":
          return { value: { examId: "e01", phase: "approved-a", families: [], draft: null } };
        case "items.get":
          return { value: { total: 0, items: [] } };
        case "exam.generate":
          return {
            value: {
              findings: [
                ...Array.from({ length: 3 }, () => ({
                  id: "EVL-ITM-009",
                  subject: "algebra/factoring single_choice",
                  message: "slot could not be filled within 50 attempts",
                })),
                {
                  id: "EVL-EXM-002",
                  subject: "exam",
                  message: "the exam has 12 items, not the consecutive 1..15",
                },
              ],
              capacity: [SHORTFALL],
              revision: "r2",
            },
          };
        case "catalog.list":
          return {
            value: { topics: [FACTORING], packs: [{ id: "algebra", name: { es: "Álgebra" } }] },
          };
        case "draft.create":
          return {
            value: {
              errors: [
                { field: "count", code: "capacity", capacity: [{ ...SHORTFALL, requested: 20 }] },
              ],
              revision: "r2",
            },
          };
        default:
          return { value: null };
      }
    });
    env.connect(env.host, window.parent, "es");
    await env.loaded;
    await wait(() => !!doc.querySelector('[data-action="open-exam"]'));

    // Step 2 "Preguntas": the blocked generation names the topic, the type and the maximum.
    click('[data-action="open-exam"]');
    await wait(() => !!doc.querySelector('[data-tab="questions"]'));
    click('[data-tab="questions"]');
    await wait(() => !!doc.querySelector("#generate"));
    click("#generate");
    await wait(() => !!doc.querySelector(".banner.warn li.capacity"));
    const banner = doc.querySelector(".banner.warn") as HTMLElement;
    expect(banner.querySelector("li.capacity")?.textContent).toBe(
      "El tema «Factorización» tiene solo 12 preguntas distintas de tipo «Selección única». Baja la cantidad o elige otro tema.",
    );
    // The raw codes stay available, but only as a small technical detail.
    expect(banner.querySelectorAll(":scope ul:not(.small) > li")).toHaveLength(1);
    expect(banner.querySelector("details.technical")?.textContent).toContain("EVL-ITM-009");
    expect(banner.querySelector("details.technical")?.textContent).toContain("EVL-EXM-002");

    // The wizard offers only the item types the chosen topic supports.
    click('[data-action="home"]');
    await wait(() => !!doc.querySelector("#new-exam"));
    click("#new-exam");
    await wait(() => !!doc.querySelector('input[name="topic"]'));
    (doc.querySelector('input[name="grade"][value="Octavo"]') as HTMLInputElement).checked = true;
    (doc.querySelector('input[name="topic"]') as HTMLInputElement).checked = true;
    (doc.querySelector('input[name="level"][value="basico"]') as HTMLInputElement).checked = true;
    click("#wizard-next");
    await wait(() => !!doc.querySelector('input[name="types"]'));
    const offered = [...doc.querySelectorAll('input[name="types"]')].map(
      (input) => (input as HTMLInputElement).value,
    );
    expect(offered).toEqual(["single_choice", "practice"]);

    // A plan that cannot be filled comes back as a friendly error on the question count.
    (doc.querySelector('input[name="types"][value="single_choice"]') as HTMLInputElement).checked =
      true;
    click("#wizard-next");
    await wait(() => !!doc.querySelector("#wizard-review"));
    click("#wizard-review");
    await wait(() => !!doc.querySelector("#err-count"));
    expect(requests.find((r) => r.action === "draft.create")?.input).toMatchObject({
      answers: { topic: "algebra/factoring", types: ["single_choice"] },
    });
    expect(doc.querySelector("#err-count")?.textContent).toContain(
      "El tema «Factorización» tiene solo 12 preguntas distintas de tipo «Selección única».",
    );
  }, 30_000);
});
