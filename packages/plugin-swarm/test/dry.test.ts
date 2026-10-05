import { describe, expect, it } from "vitest";
import { detectDuplicates } from "../src/gates/dry.js";

const block = (name: string) =>
  [
    `function ${name}(input) {`,
    "  const a = input.a + 1;",
    "  const b = input.b * 2;",
    "  const c = a + b;",
    "  if (c > 10) { return c; }",
    "  return 0;",
    "}",
  ].join("\n");

describe("detectDuplicates", () => {
  it("finds a repeated block across two files", () => {
    const body = block("x").split("\n").slice(1).join("\n");
    const findings = detectDuplicates(
      [
        { path: "src/a.ts", text: `${block("x")}\n` },
        { path: "src/b.ts", text: `// other\n${body}\n` },
      ],
      { window: 5 },
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]).toContain("src/a.ts");
    expect(findings[0]).toContain("src/b.ts");
  });

  it("ignores blank lines, comments and trivial lines", () => {
    const noise = ["", "// c", "}", "{", "});"].join("\n");
    expect(
      detectDuplicates(
        [
          { path: "a.ts", text: noise.repeat(5) },
          { path: "b.ts", text: noise.repeat(5) },
        ],
        { window: 3 },
      ),
    ).toEqual([]);
  });

  it("reports only duplicates that involve a changed file when asked", () => {
    const shared = block("same");
    const files = [
      { path: "src/old1.ts", text: shared },
      { path: "src/old2.ts", text: shared },
      { path: "src/new.ts", text: "const unique = 1;\n" },
    ];
    expect(detectDuplicates(files, { window: 5, only: ["src/new.ts"] })).toEqual([]);
    expect(detectDuplicates(files, { window: 5, only: ["src/old1.ts"] }).length).toBeGreaterThan(0);
  });

  it("finds nothing in distinct code and caps the findings", () => {
    expect(
      detectDuplicates(
        [
          { path: "a.ts", text: block("one") },
          { path: "b.ts", text: "const z = 1;\nconst y = 2;\nconst w = 3;\n" },
        ],
        { window: 5 },
      ),
    ).toEqual([]);
    const big = Array.from({ length: 40 }, (_, i) => `const v${i} = compute(${i}, "x${i}");`).join(
      "\n",
    );
    const many = detectDuplicates(
      [
        { path: "a.ts", text: big },
        { path: "b.ts", text: big },
      ],
      { window: 2, maxFindings: 5 },
    );
    expect(many.length).toBeLessThanOrEqual(5);
  });
});
