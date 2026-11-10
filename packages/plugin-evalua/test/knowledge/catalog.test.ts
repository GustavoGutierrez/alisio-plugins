import { describe, expect, it } from "vitest";
import { familyIds } from "../../src/families/index.js";
import { createTopicCatalog } from "../../src/knowledge/catalog.js";
import { shippedKnowledgeDir } from "../../src/knowledge/package.js";
import { loadKnowledge } from "../../src/knowledge/registry.js";

async function catalog() {
  const knowledge = await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds });
  return createTopicCatalog(knowledge);
}

describe("topic catalog", () => {
  it("lists packs and topics from the knowledge base", async () => {
    const source = await catalog();
    expect(source.packs().map((entry) => entry.value)).toEqual([
      "algebra",
      "basic-math",
      "primary-math",
    ]);
    const suggestions = source.suggestions("Séptimo");
    expect(suggestions.map((entry) => entry.value)).toContain("basic-math/fractions");
    expect(suggestions.map((entry) => entry.value)).toContain("algebra/algebraic-expressions");
  });

  it("filters suggestions by grade", async () => {
    const source = await catalog();
    const sexto = source.suggestions("Sexto").map((entry) => entry.value);
    expect(sexto).toContain("basic-math/natural-numbers");
    expect(sexto).not.toContain("basic-math/percentages");
  });

  it("resolves a pack from a full id, a bare id or a keyword", async () => {
    const source = await catalog();
    expect(source.resolvePack("basic-math/fractions")).toBe("basic-math");
    expect(source.resolvePack("fractions")).toBe("basic-math");
    expect(source.resolvePack("algebraic-expressions")).toBe("algebra");
    expect(source.resolvePack("porcentaje")).toBe("basic-math");
    expect(source.resolvePack("unknown thing")).toBeUndefined();
  });

  it("resolves a free-text description to a knowledge-base topic", async () => {
    const source = await catalog();
    expect(source.resolveTopic?.("figuras geométricas y sus medidas")).toBe("basic-math/geometry");
    expect(source.resolveTopic?.("basic-math/geometry")).toBe("basic-math/geometry");
    expect(source.resolveTopic?.("algo que no existe en la base")).toBeUndefined();
  });

  it("looks a topic up by full id and lists every topic with its pack, grades and levels (app D1)", async () => {
    const source = await catalog();
    const fractions = source.topic?.("basic-math/fractions");
    expect(fractions).toMatchObject({
      id: "basic-math/fractions",
      name: { es: "Fracciones" },
      pack: "basic-math",
      packName: { es: "Matemática básica", en: "Basic math" },
      grades: ["Sexto", "Séptimo"],
      supports: { single_choice: true, practice: true },
    });
    expect(fractions?.levels).toEqual(["basico", "intermedio", "avanzado", "genio"]);
    expect(source.topic?.("fractions")).toBeUndefined();
    expect(source.topic?.("basic-math/nope")).toBeUndefined();
    const all = source.topics?.() ?? [];
    expect(all.map((entry) => entry.id)).toContain("algebra/algebraic-expressions");
    expect(all).toHaveLength(23);
  });
});
