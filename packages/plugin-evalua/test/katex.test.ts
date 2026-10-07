import { beforeAll, describe, expect, it } from "vitest";
import { buildBlueprint } from "../src/blueprint.js";
import { familyIds } from "../src/families/index.js";
import { type ExamItem, generateExam } from "../src/generate.js";
import { checkKatexItem, katexCss, renderMath } from "../src/katex.js";
import { shippedKnowledgeDir } from "../src/knowledge/package.js";
import { loadKnowledge } from "../src/knowledge/registry.js";
import type { LevelCalibration } from "../src/knowledge/types.js";

let calibration: LevelCalibration;
let items: ExamItem[];

beforeAll(async () => {
  const knowledge = await loadKnowledge({ shippedDir: shippedKnowledgeDir(), families: familyIds });
  const pack = knowledge.packs.find((entry) => entry.id === "basic-math");
  if (!pack) throw new Error("basic-math pack missing");
  calibration = pack.levels.basico;
  const blueprint = buildBlueprint({
    topics: ["basic-math/fractions"],
    level: "basico",
    calibration,
    itemTypes: { single_choice: 3, multiple_choice: 0, open: 0, practice: 0 },
  });
  items = generateExam({
    blueprint,
    topics: knowledge.topics,
    level: "basico",
    calibration,
    seed: "k",
  }).items;
});

describe("KaTeX", () => {
  it("typesets inline and display math", () => {
    const inline = renderMath("\\dfrac{3}{4}", false);
    expect(inline.error).toBeUndefined();
    expect(inline.html).toContain("katex");
    const display = renderMath("x^2 - 5x + 6 = 0", true);
    expect(display.error).toBeUndefined();
    expect(display.html).toContain("katex");
  });

  it("reports a formula KaTeX rejects instead of throwing", () => {
    expect(renderMath("\\frac{1}{", false).error).toBeDefined();
  });

  it("inlines every font with no network reference", () => {
    const css = katexCss();
    expect(css).not.toMatch(/url\(fonts\//);
    expect(css).toContain("data:font/woff2;base64,");
    expect(css).not.toMatch(/https?:\/\//);
  });

  it("passes generated items and flags a bad formula (EVL-ITM-011)", () => {
    for (const item of items) expect(checkKatexItem(item)).toEqual([]);
    const base = items[0];
    if (!base) throw new Error("missing item");
    const bad: ExamItem = { ...base, stem: ["$\\frac{1}{$"] };
    expect(checkKatexItem(bad).map((finding) => finding.id)).toContain("EVL-ITM-011");
  });
});
