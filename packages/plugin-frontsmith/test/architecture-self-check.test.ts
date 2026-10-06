import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runArchitectureCheck } from "../src/application/checks/architecture-check.js";
import { parseArchitectureConfig } from "../src/domain/architecture/config.js";
import { DefaultFileAnalyzer } from "../src/infrastructure/analysis/file-analyzer.js";
import { DefaultImportGraphBuilder } from "../src/infrastructure/analysis/graph-builder.js";
import { NodeWorkspaceFs } from "../src/infrastructure/fs/workspace-fs.js";
import { packageRoot } from "../src/infrastructure/packs/adapter-loader.js";

describe("architecture self-check", () => {
  it("reports zero violations over src with the self-check configuration (B-14)", async () => {
    const raw = JSON.parse(
      await readFile(new URL("./fixtures/architecture/self-check.json", import.meta.url), "utf8"),
    );
    const parsed = parseArchitectureConfig(raw);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    const result = await runArchitectureCheck(
      { fs: new NodeWorkspaceFs(packageRoot()), config: parsed.config, paths: ["src/**"] },
      { analyzer: new DefaultFileAnalyzer(), graphBuilder: new DefaultImportGraphBuilder() },
    );
    expect(result.violations.map((v) => `${v.ruleId} ${v.file}:${v.line} ${v.detail}`)).toEqual([]);
    expect(result.verdict).toBe("PASS");
    expect(result.filesChecked).toBeGreaterThan(100);
  });
});
