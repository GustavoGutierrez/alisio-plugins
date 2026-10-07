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
    expect(source.packs()).toEqual([{ value: "basic-math", label: "Matemática básica" }]);
    const suggestions = source.suggestions("Séptimo");
    expect(suggestions.map((entry) => entry.value)).toContain("basic-math/fractions");
    expect(suggestions.every((entry) => entry.value.startsWith("basic-math/"))).toBe(true);
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
    expect(source.resolvePack("porcentaje")).toBe("basic-math");
    expect(source.resolvePack("unknown thing")).toBeUndefined();
  });
});
