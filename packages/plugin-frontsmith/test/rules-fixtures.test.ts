import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { engineValidators } from "../src/application/engines/index.js";
import { loadShippedPacks } from "../src/infrastructure/packs/loader.js";
import { fixturesRoot, runFixture } from "./helpers/rule-fixture.js";

const packs = await loadShippedPacks(engineValidators);
const rules = packs.flatMap((pack) => pack.rules.map((rule) => ({ pack, rule })));
const executable = rules.filter(({ rule }) => rule.kind !== "advisory");

describe("shipped rule fixtures (PCK-008)", () => {
  it("covers every non-advisory rule with a pass and a fail fixture file", async () => {
    expect(executable).toHaveLength(91);
    for (const { rule } of executable) {
      expect(rule.fixtures?.fail.length, `${rule.id} fail`).toBeGreaterThan(0);
      expect(rule.fixtures?.pass.length, `${rule.id} pass`).toBeGreaterThan(0);
      for (const file of [...(rule.fixtures?.fail ?? []), ...(rule.fixtures?.pass ?? [])])
        await expect(
          access(join(fixturesRoot, file)),
          `${rule.id}: ${file}`,
        ).resolves.toBeUndefined();
    }
  });

  it("gives advisory rules no fixtures", () => {
    for (const { rule } of rules.filter(({ rule: r }) => r.kind === "advisory"))
      expect(rule.fixtures).toBeUndefined();
  });

  describe.each(executable.map(({ pack, rule }) => [rule.id, pack.packId, rule] as const))(
    "%s",
    (_id, packId, rule) => {
      it("reports at least one finding of its own id for every fail fixture", async () => {
        for (const file of rule.fixtures?.fail ?? []) {
          const result = await runFixture(rule, packId, file);
          // nit findings resolve to PASS with a note (spec 10.1), so they count by rule id alone.
          const own = result.findings.filter((finding) => finding.ruleId === rule.id);
          expect(own.length, `${file}: ${JSON.stringify(result.checks)}`).toBeGreaterThan(0);
        }
      });

      it("reports nothing for every pass fixture and the check really ran", async () => {
        for (const file of rule.fixtures?.pass ?? []) {
          const result = await runFixture(rule, packId, file);
          expect(
            result.findings.filter((finding) => finding.ruleId === rule.id),
            `${file}: ${JSON.stringify(result.findings)}`,
          ).toEqual([]);
          expect(
            result.checks.find((check) => check.ruleId === rule.id)?.status,
            `${file}: ${JSON.stringify(result.checks)}`,
          ).toBe("PASS");
        }
      });
    },
  );
});

describe("FS-TOK-008 unsupported colour formats (spec 12.1)", () => {
  it("surface as a REVIEW finding and a REVIEW check, never a FAIL", async () => {
    const found = rules.find(({ rule }) => rule.id === "FS-TOK-008");
    if (!found) throw new Error("FS-TOK-008 is not shipped");
    const result = await runFixture(
      found.rule,
      found.pack.packId,
      "fs-tok-008/review-unsupported.json",
    );
    const own = result.findings.filter((finding) => finding.ruleId === "FS-TOK-008");
    expect(own.map((finding) => finding.status)).toEqual(["REVIEW"]);
    expect(own[0]?.message).toContain("unsupported color format");
    expect(result.checks.find((check) => check.ruleId === "FS-TOK-008")?.status).toBe("REVIEW");
    expect(result.verdict).toBe("REVIEW");
  });
});
