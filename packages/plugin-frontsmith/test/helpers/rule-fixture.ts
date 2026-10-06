import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { runRuleFixture } from "../../src/application/checks/rule-fixtures.js";
import type { RulesCheckResult } from "../../src/application/checks/rules-check.js";
import type { RuleDef } from "../../src/domain/rules/model.js";
import { DefaultFileAnalyzer } from "../../src/infrastructure/analysis/file-analyzer.js";
import { DefaultImportGraphBuilder } from "../../src/infrastructure/analysis/graph-builder.js";
import { loadAriaCatalog } from "../../src/infrastructure/packs/catalog-loader.js";

export const fixturesRoot = new URL("../fixtures/rules/", import.meta.url).pathname;

export async function runFixture(
  rule: RuleDef,
  packId: string,
  fixtureFile: string,
): Promise<RulesCheckResult> {
  return runRuleFixture(
    {
      rule,
      packId,
      ext: extname(fixtureFile).slice(1),
      text: await readFile(join(fixturesRoot, fixtureFile), "utf8"),
    },
    {
      aria: await loadAriaCatalog(),
      deps: { analyzer: new DefaultFileAnalyzer(), graphBuilder: new DefaultImportGraphBuilder() },
      today: "2026-06-01",
    },
  );
}
