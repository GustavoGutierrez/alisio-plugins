import { afterAll, describe, expect, it } from "vitest";
import { familyIds } from "../src/families/index.js";
// @ts-expect-error -- plain browser module without declarations.
import { errorText, FAMILY_LABELS, messages, pickLocale, setLocale } from "../web/i18n.js";
import { CATALOG, frameEnv, statusWith } from "./helpers/frame-env.js";

/** Every key path of a message table, with function arity for sentence builders. */
function shape(value: unknown, at = ""): string[] {
  if (typeof value === "function") return [`${at}()${value.length}`];
  if (Array.isArray(value)) return [`${at}[${value.length}]`];
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, entry]) => shape(entry, `${at}.${key}`));
  return [at];
}

describe("UI language (EVL-APP-AC-21)", () => {
  it("maps es-CO to Spanish and en or fr to English", () => {
    expect(pickLocale("es-CO")).toBe("es");
    expect(pickLocale("es")).toBe("es");
    expect(pickLocale("en")).toBe("en");
    expect(pickLocale("fr")).toBe("en");
    expect(pickLocale(undefined)).toBe("en");
  });

  it("has the same strings in English and Spanish and a label for every exercise family", () => {
    expect(shape(messages.es).sort()).toEqual(shape(messages.en).sort());
    for (const id of familyIds) {
      expect(FAMILY_LABELS[id], id).toBeDefined();
      expect(FAMILY_LABELS[id].es, id).toBeTruthy();
      expect(FAMILY_LABELS[id].en, id).toBeTruthy();
    }
    expect(messages.en.questionsN(1)).toBe("1 question");
    expect(messages.es.questionsN(2)).toBe("2 preguntas");
  });

  it("explains each reason a wording draft failed, in both languages", () => {
    setLocale("es");
    expect(errorText("model_failed", "model_error")).toMatch(/No se pudo contactar al modelo/);
    expect(errorText("model_failed", "unreadable")).toMatch(/formato que Evalúa no pudo leer/);
    expect(errorText("model_failed", "rejected")).toContain("({expr})");
    expect(errorText("model_failed")).toBe(messages.es.errors.model_failed);
    expect(errorText("model_failed", "unknown")).toBe(messages.es.errors.model_failed);
    setLocale("en");
    expect(errorText("model_failed", "model_error")).toMatch(/could not reach the AI model/i);
    expect(messages.es.nothingToDraft).toMatch(/banco/);
    expect(messages.en.nothingToDraft).toMatch(/bank/);
  });

  describe("live switch", () => {
    let env: Awaited<ReturnType<typeof frameEnv>>;
    afterAll(() => env?.close());

    it("follows Alisio's locale mid-wizard and keeps the answers", async () => {
      env = await frameEnv("fr");
      const { window, doc, wait, click, post } = env;
      env.setResponder((request) => {
        if (request.action === "status") return { value: statusWith() };
        if (request.action === "catalog.list") return { value: CATALOG };
        return { value: null };
      });
      env.connect(env.host, window.parent, "fr");
      await env.loaded;
      await wait(() => !!doc.querySelector("#new-exam"));
      expect(doc.documentElement.lang).toBe("en");
      click("#new-exam");
      await wait(() => !!doc.querySelector('input[name="grade"]'));
      const grade = doc.querySelector('input[name="grade"][value="Séptimo"]') as HTMLInputElement;
      grade.checked = true;
      grade.dispatchEvent(new window.Event("change", { bubbles: true }));
      await wait(() => !!doc.querySelector('input[name="topic"][value="basic-math/fractions"]'));
      const topic = doc.querySelector(
        'input[name="topic"][value="basic-math/fractions"]',
      ) as HTMLInputElement;
      topic.checked = true;
      topic.dispatchEvent(new window.Event("change", { bubbles: true }));
      expect(doc.querySelector("h1")?.textContent).toBe("Topic and level");

      post({ type: "locale", locale: "es-CO" });
      await wait(() => doc.querySelector("h1")?.textContent === "Tema y nivel");
      expect(doc.documentElement.lang).toBe("es");
      const view =
        (
          window as unknown as { evaluaView: () => { form: Record<string, unknown> } }
        ).evaluaView?.() ??
        (
          globalThis as unknown as { evaluaView: () => { form: Record<string, unknown> } }
        ).evaluaView();
      expect(view.form).toMatchObject({ grade: "Séptimo", topic: "basic-math/fractions" });
      expect(
        (doc.querySelector('input[name="topic"][value="basic-math/fractions"]') as HTMLInputElement)
          .checked,
      ).toBe(true);
      expect(doc.querySelector(".summary-sheet")?.textContent).toContain("Fracciones");

      post({ type: "locale", locale: "en" });
      await wait(() => doc.querySelector("h1")?.textContent === "Topic and level");
      expect(
        (doc.querySelector('input[name="grade"][value="Séptimo"]') as HTMLInputElement).checked,
      ).toBe(true);
    });
  });
});
