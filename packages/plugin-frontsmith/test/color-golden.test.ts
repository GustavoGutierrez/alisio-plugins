import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderThemeCss } from "../src/application/render/theme-css.js";
import { composeBackground, composite } from "../src/domain/color/compose.js";
import {
  classifyText,
  contrastRatio,
  evaluateContrast,
  minimumRatio,
} from "../src/domain/color/contrast.js";
import { evaluateRoleTable, parsePairGraph } from "../src/domain/color/pairs.js";
import {
  type PaletteCatalog,
  parsePaletteCatalog,
  solvePalette,
} from "../src/domain/color/palette.js";
import { parseColor, toHex } from "../src/domain/color/parse.js";
import { buildTokensJson, parseTokensFile } from "../src/domain/color/tokens-file.js";
import { packageRoot } from "../src/infrastructure/packs/adapter-loader.js";
import { loadPairGraph, loadPaletteCatalog } from "../src/infrastructure/packs/catalog-loader.js";

const fixture = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(new URL(`./fixtures/color/${name}`, import.meta.url), "utf8")) as T;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const ratioOf = (fg: string, bg: string): number =>
  contrastRatio(parseColor(fg) as never, parseColor(bg) as never);
const six = (value: number): string => value.toFixed(6);

describe("contrast golden numbers (6 decimals, no pre-rounding)", () => {
  const table: Array<[string, string, string, "PASS" | "FAIL"]> = [
    ["#777777", "#FFFFFF", "4.478089", "FAIL"],
    ["#767676", "#FFFFFF", "4.542225", "PASS"],
    ["#FFFFFF", "#2563EB", "5.168556", "PASS"],
    ["#FFFFFF", "#60A5FA", "2.542423", "FAIL"],
    ["#0F172A", "#60A5FA", "7.021860", "PASS"],
    ["#808080", "#FFFFFF", "3.949440", "FAIL"],
  ];
  it.each(table)("%s on %s is %s %s", (fg, bg, expected, status) => {
    expect(six(ratioOf(fg, bg))).toBe(expected);
    const result = evaluateContrast({ fg, bg, kind: "normal_text" });
    expect(result.status).toBe(status);
    expect(six(result.ratio as number)).toBe(expected);
  });

  it("gives 21 for black on white, 1 for identical colours and is symmetric", () => {
    expect(ratioOf("#000000", "#FFFFFF")).toBe(21);
    expect(ratioOf("#FFFFFF", "#000000")).toBe(21);
    expect(ratioOf("#123456", "#123456")).toBe(1);
  });

  it("composites black at 50 percent over white to the 8-bit grey #808080", () => {
    const grey = composite(
      parseColor("rgba(0, 0, 0, 0.5)") as never,
      parseColor("#FFFFFF") as never,
    );
    expect(toHex(grey)).toBe("#808080");
    const result = evaluateContrast({
      fg: "rgba(0, 0, 0, 0.5)",
      bg: "#FFFFFF",
      kind: "normal_text",
    });
    expect(result.compositedFg).toBe("#808080");
    expect(six(result.ratio as number)).toBe("3.949440");
    expect(result.status).toBe("FAIL");
  });

  it("never rounds before comparing and reports margins as product margins", () => {
    expect(minimumRatio("normal_text", "AA")).toBe(4.5);
    expect(minimumRatio("large_text", "AA")).toBe(3);
    expect(minimumRatio("non_text", "AA")).toBe(3);
    expect(minimumRatio("normal_text", "AAA")).toBe(7);
    expect(minimumRatio("large_text", "AAA")).toBe(4.5);
    const passes = evaluateContrast({ fg: "#767676", bg: "#FFFFFF", kind: "normal_text" });
    const margin = evaluateContrast({
      fg: "#767676",
      bg: "#FFFFFF",
      kind: "normal_text",
      margin: 0.5,
    });
    expect(passes.status).toBe("PASS");
    expect(margin.status).toBe("FAIL");
    expect(margin.minimum).toBe(5);
  });

  it("classifies large text at 24px, or 18.6667px bold, and unknown as normal", () => {
    expect(classifyText(24, 400)).toBe("large_text");
    expect(classifyText(23.99, 400)).toBe("normal_text");
    expect(classifyText(18.6667, 700)).toBe("large_text");
    expect(classifyText(18.6667, 600)).toBe("normal_text");
    expect(classifyText(undefined, 700)).toBe("normal_text");
    expect(classifyText(30, undefined)).toBe("large_text");
  });

  it("accepts only hex, rgb and rgba and reviews everything else", () => {
    for (const bad of ["hsl(10 50% 50%)", "oklch(60% 0.2 30)", "red", "#12", "var(--x)"])
      expect(parseColor(bad), bad).toBeUndefined();
    const hsl = evaluateContrast({ fg: "hsl(0 0% 0%)", bg: "#FFFFFF", kind: "normal_text" });
    expect(hsl).toMatchObject({ status: "REVIEW", ratio: null });
    expect(hsl.reason).toContain("unsupported color format");
    expect(parseColor("rgb(37 99 235)")).toEqual({ r: 37, g: 99, b: 235, a: 1 });
    expect(parseColor("#2563EB")).toEqual({ r: 37, g: 99, b: 235, a: 1 });
  });

  it("composes background stacks bottom-up and reviews a translucent base", () => {
    const stack = composeBackground(
      ["#FFFFFF", "rgba(0, 0, 0, 0.5)"].map((c) => parseColor(c) as never),
    );
    expect(stack.ok && toHex(stack.color)).toBe("#808080");
    expect(composeBackground([parseColor("rgba(0,0,0,0.5)") as never]).ok).toBe(false);
    const viaStack = evaluateContrast({
      fg: "#FFFFFF",
      bg: "rgba(0, 0, 0, 0.5)",
      backgroundStack: ["#FFFFFF"],
      kind: "normal_text",
    });
    expect(viaStack.status).toBe("FAIL");
    const open = evaluateContrast({
      fg: "#000000",
      bg: "rgba(255,255,255,0.5)",
      kind: "normal_text",
    });
    expect(open.status).toBe("REVIEW");
    expect(open.reason).toContain("not opaque");
  });
});

describe("pair graph golden (70 checks)", () => {
  it("reproduces 70 checks, 70 PASS, minimum text 5.168556 and minimum non-text 4.343923", async () => {
    const graph = await loadPairGraph();
    const golden = await fixture<{
      roles: Record<"light" | "dark", Record<string, string>>;
      accents: Parameters<typeof evaluateRoleTable>[2];
    }>("role-table.json");
    const checks = evaluateRoleTable(graph, golden.roles, golden.accents);
    expect(checks).toHaveLength(70);
    expect(checks.filter((c) => c.status === "PASS")).toHaveLength(70);
    expect(checks.filter((c) => c.kind === "non_text")).toHaveLength(12);
    expect(checks.filter((c) => c.kind === "normal_text")).toHaveLength(58);
    const text = Math.min(...checks.filter((c) => c.kind === "normal_text").map((c) => c.ratio));
    const nonText = Math.min(...checks.filter((c) => c.kind === "non_text").map((c) => c.ratio));
    expect(six(text)).toBe("5.168556");
    expect(six(nonText)).toBe("4.343923");
  });

  it("ships the role table of the golden as the default blue template", async () => {
    const catalog = await loadPaletteCatalog();
    const golden = await fixture<{ roles: unknown; accents: unknown }>("role-table.json");
    expect(catalog.roleTemplates.blue).toEqual(golden.roles);
    expect(catalog.accents).toEqual(golden.accents);
    expect(catalog.accents.map((a) => a.id)).toEqual([
      "blue",
      "teal",
      "green",
      "amber",
      "orange",
      "red",
      "pink",
      "violet",
      "graphite",
    ]);
  });

  it("flags a failing edge and never counts it as evidence", async () => {
    const graph = await loadPairGraph();
    const golden = await fixture<{ roles: Record<"light" | "dark", Record<string, string>> }>(
      "role-table.json",
    );
    const broken = {
      ...golden.roles,
      light: { ...golden.roles.light, "action-fg": "#94A3B8" },
    };
    const checks = evaluateRoleTable(graph, broken, []);
    expect(
      checks.filter((c) => c.status === "FAIL").map((c) => `${c.theme} ${c.fg} ${c.bg}`),
    ).toEqual([
      "light action-fg action-bg",
      "light action-fg action-hover",
      "light action-fg action-active",
    ]);
  });

  it("validates the pair graph document", () => {
    expect(parsePairGraph({ schemaVersion: 1, namespace: "--color-", edges: [] }).ok).toBe(true);
    for (const bad of [
      [],
      { schemaVersion: 2, namespace: "--color-", edges: [] },
      { schemaVersion: 1, namespace: "x", edges: [] },
      {
        schemaVersion: 1,
        namespace: "--color-",
        edges: [{ fg: [], bg: ["a"], kind: "normal_text" }],
      },
      { schemaVersion: 1, namespace: "--color-", edges: [{ fg: ["a"], bg: ["b"], kind: "huge" }] },
    ])
      expect(parsePairGraph(bad).ok, JSON.stringify(bad)).toBe(false);
  });
});

describe("palette solver golden (72 of 72)", () => {
  type Golden = Record<"blue" | "teal", Record<"light" | "dark", Record<string, string>>>;

  it("reproduces blue and teal, light and dark, with the exact HEX table", async () => {
    const catalog = await loadPaletteCatalog();
    const golden = await fixture<Golden & { expectedPairs: number; pairsPerPalette: number }>(
      "palette-golden.json",
    );
    let passed = 0;
    let total = 0;
    for (const family of ["blue", "teal"] as const) {
      const result = solvePalette(catalog, { family, themes: ["light", "dark"] }, sha256);
      if (!result.ok) throw new Error(result.reason);
      for (const theme of result.themes) {
        expect(Object.keys(theme.tokens)).toHaveLength(11);
        expect(theme.pairs).toHaveLength(golden.pairsPerPalette);
        expect(theme.tokens, `${family} ${theme.theme}`).toEqual(golden[family][theme.theme]);
        total += theme.pairs.length;
        passed += theme.pairs.filter((p) => p.pass).length;
      }
    }
    expect([passed, total]).toEqual([72, golden.expectedPairs]);
  });

  it("is deterministic and hashes inputs and tokens only", async () => {
    const catalog = await loadPaletteCatalog();
    const a = solvePalette(catalog, { family: "blue", themes: ["light", "dark"] }, sha256);
    const b = solvePalette(catalog, { family: "blue", themes: ["light", "dark"] }, sha256);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    if (!a.ok) throw new Error(a.reason);
    expect(a.catalogVersion).toBe(catalog.catalogVersion);
    expect(a.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    const teal = solvePalette(catalog, { family: "teal", themes: ["light", "dark"] }, sha256);
    if (!teal.ok) throw new Error(teal.reason);
    expect(teal.outputSha256).not.toBe(a.outputSha256);
    const light = solvePalette(catalog, { family: "blue", themes: ["light"] }, sha256);
    if (!light.ok) throw new Error(light.reason);
    expect(light.inputsSha256).not.toBe(a.inputsSha256);
  });

  it("returns UNSAT naming a locked colour that violates a pair", async () => {
    const catalog = await loadPaletteCatalog();
    const result = solvePalette(
      catalog,
      { family: "blue", themes: ["light"], locked: { action: "#BFDBFE" } },
      sha256,
    );
    expect(result).toEqual({ ok: false, kind: "unsat", reason: expect.any(String) });
    if (result.ok) throw new Error("expected UNSAT");
    expect(result.reason).toBe("UNSAT: locked action violates action/canvas");
    const canvas = solvePalette(
      catalog,
      { family: "blue", themes: ["light"], locked: { canvas: "#1E293B" } },
      sha256,
    );
    if (canvas.ok) throw new Error("expected UNSAT");
    expect(canvas.reason).toBe("UNSAT: locked canvas violates text/canvas");
  });

  it("honours a locked colour that satisfies every pair", async () => {
    const catalog = await loadPaletteCatalog();
    const result = solvePalette(
      catalog,
      { family: "blue", themes: ["light"], locked: { actionHover: "#1E40AF" } },
      sha256,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.themes[0]?.tokens.actionHover).toBe("#1E40AF");
    expect(result.themes[0]?.pairs.every((p) => p.pass)).toBe(true);
  });

  it("rejects uncurated families, unknown locked roles and bad colours without guessing", async () => {
    const catalog = await loadPaletteCatalog();
    const family = solvePalette(catalog, { family: "green", themes: ["light"] }, sha256);
    expect(family).toMatchObject({ ok: false, kind: "invalid" });
    const role = solvePalette(
      catalog,
      { family: "blue", themes: ["light"], locked: { nope: "#000000" } },
      sha256,
    );
    expect(role).toMatchObject({ ok: false, kind: "invalid" });
    const color = solvePalette(
      catalog,
      { family: "blue", themes: ["light"], locked: { action: "blue" } },
      sha256,
    );
    expect(color).toMatchObject({ ok: false, kind: "invalid" });
    expect(solvePalette(catalog, { family: "blue", themes: [] }, sha256)).toMatchObject({
      ok: false,
      kind: "invalid",
    });
  });

  it("backtracks over earlier roles instead of failing on a greedy choice", () => {
    const catalog: PaletteCatalog = {
      schemaVersion: 1,
      catalogVersion: "test",
      families: ["mono"],
      scales: { mono: ["#EEEEEE", "#111111"], tail: ["#FFFFFF"] },
      accents: [],
      roleTemplates: {},
      neutral: {},
      profiles: {
        tiny: {
          id: "tiny",
          roles: ["canvas", "first", "second"],
          tokenNames: { canvas: "--c", first: "--f", second: "--s" },
          fixed: { light: { canvas: "#FFFFFF" }, dark: { canvas: "#000000" } },
          choose: [
            { role: "first", scale: "$family", target: { light: 0, dark: 0 }, against: [] },
            {
              role: "second",
              scale: "tail",
              target: { light: 0, dark: 0 },
              against: [{ role: "first", min: 5 }],
            },
          ],
          pairs: [{ fg: "second", bg: "first", min: 5, kind: "normal_text" }],
        },
      },
    };
    const result = solvePalette(
      catalog,
      { family: "mono", themes: ["light"], profile: "tiny" },
      sha256,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.themes[0]?.tokens).toMatchObject({ first: "#111111", second: "#FFFFFF" });
  });

  it("reports UNSAT when no candidate satisfies a constraint, never relaxing contrast", () => {
    const catalog: PaletteCatalog = {
      schemaVersion: 1,
      catalogVersion: "test",
      families: ["mono"],
      scales: { mono: ["#EEEEEE", "#DDDDDD"] },
      accents: [],
      roleTemplates: {},
      neutral: {},
      profiles: {
        tiny: {
          id: "tiny",
          roles: ["canvas", "first"],
          tokenNames: { canvas: "--c", first: "--f" },
          fixed: { light: { canvas: "#FFFFFF" }, dark: { canvas: "#000000" } },
          choose: [
            {
              role: "first",
              scale: "$family",
              target: { light: 0, dark: 0 },
              against: [{ role: "canvas", min: 4.5 }],
            },
          ],
          pairs: [],
        },
      },
    };
    const result = solvePalette(
      catalog,
      { family: "mono", themes: ["light"], profile: "tiny" },
      sha256,
    );
    expect(result).toMatchObject({ ok: false, kind: "unsat" });
    if (!result.ok)
      expect(result.reason).toBe("UNSAT: no candidate for first in light (canvas >= 4.5)");
  });

  it("validates the palette catalog document", async () => {
    const raw = JSON.parse(await readFile(`${packageRoot()}/catalog/palettes.json`, "utf8"));
    expect(parsePaletteCatalog(raw).ok).toBe(true);
    for (const bad of [
      [],
      { ...raw, schemaVersion: 2 },
      { ...raw, families: ["nope"] },
      { ...raw, scales: { ...raw.scales, blue: ["red"] } },
      { ...raw, accents: [{ id: "x" }] },
    ])
      expect(parsePaletteCatalog(bad).ok).toBe(false);
  });
});

describe("tokens.json and theme CSS", () => {
  it("emits DTCG-shaped tokens with the required pairs and a stable hash block", async () => {
    const catalog = await loadPaletteCatalog();
    const result = solvePalette(catalog, { family: "blue", themes: ["light", "dark"] }, sha256);
    if (!result.ok) throw new Error(result.reason);
    const profile = catalog.profiles["work-app"];
    if (!profile) throw new Error("profile missing");
    const json = buildTokensJson(result, profile) as Record<string, unknown>;
    expect(json["--color-bg-canvas"]).toEqual({
      $type: "color",
      $value: { light: "#F8FAFC", dark: "#0F172A" },
    });
    const parsed = parseTokensFile(json);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(Object.keys(parsed.values)).toHaveLength(11);
    expect(parsed.pairs).toHaveLength(profile.pairs.length);
    expect(parsed.pairs?.[0]).toEqual({
      fg: "--color-text-primary",
      bg: "--color-bg-canvas",
      kind: "normal_text",
    });
    const extensions = (json.$extensions as { frontsmith: Record<string, unknown> }).frontsmith;
    expect(extensions).toMatchObject({
      family: "blue",
      catalogVersion: catalog.catalogVersion,
      inputsSha256: result.inputsSha256,
      outputSha256: result.outputSha256,
    });
  });

  it("renders light as :root and data-theme light, dark as data-theme dark", async () => {
    const catalog = await loadPaletteCatalog();
    const result = solvePalette(catalog, { family: "blue", themes: ["light", "dark"] }, sha256);
    if (!result.ok) throw new Error(result.reason);
    const css = renderThemeCss(result, catalog.profiles["work-app"] as never);
    expect(css).toContain(':root, [data-theme="light"] {');
    expect(css).toContain('[data-theme="dark"] {');
    expect(css).toContain("color-scheme: light;");
    expect(css).toContain("color-scheme: dark;");
    expect(css).toContain("--color-bg-canvas: #F8FAFC;");
    expect(css).toContain("--color-action-bg: #60A5FA;");
    expect(css.endsWith("\n")).toBe(true);
    const lightOnly = solvePalette(catalog, { family: "blue", themes: ["light"] }, sha256);
    if (!lightOnly.ok) throw new Error(lightOnly.reason);
    expect(renderThemeCss(lightOnly, catalog.profiles["work-app"] as never)).not.toContain("dark");
  });

  it("rejects malformed tokens files", () => {
    for (const bad of [
      [],
      { "--a": { $type: "color" } },
      { "--a": { $type: "color", $value: 5 } },
      { "--a": { $type: "color", $value: { light: 5 } } },
      { a: { $type: "color", $value: { light: "#fff" } } },
      {
        "--a": { $type: "color", $value: { light: "#fff" } },
        $extensions: { frontsmith: { requiredPairs: [{ fg: "--a", bg: "--b", kind: "x" }] } },
      },
    ])
      expect(parseTokensFile(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(parseTokensFile({ "--a": { $type: "color", $value: "#fff" } })).toMatchObject({
      ok: true,
      values: { "--a": { light: "#fff" } },
    });
  });
});

describe("no pointer to the research documents", () => {
  it("keeps the catalogs and presets free of source references", async () => {
    for (const file of ["palettes.json", "pair-graph.json"])
      expect(await readFile(`${packageRoot()}/catalog/${file}`, "utf8")).not.toMatch(
        /\b(?:METH|FID)\s*§|frontend-agent-engineering|fidelidad-ui/,
      );
  });
});

const specPath = new URL("../../../specs/alisio-plugin-frontsmith-v1.md", import.meta.url);
describe.skipIf(!existsSync(specPath))("spec Appendix B agrees with the committed fixtures", () => {
  it("embeds the same role table and palette golden", async () => {
    const spec = await readFile(specPath, "utf8");
    const appendix = spec.split("## Appendix B")[1] ?? "";
    expect(appendix.length).toBeGreaterThan(0);
    const roles = await fixture<{ roles: Record<"light" | "dark", Record<string, string>> }>(
      "role-table.json",
    );
    for (const [token, value] of Object.entries(roles.roles.light))
      expect(appendix, token).toContain(`| ${token} | ${value} | ${roles.roles.dark[token]} |`);
    const palette =
      await fixture<Record<"blue" | "teal", Record<"light" | "dark", Record<string, string>>>>(
        "palette-golden.json",
      );
    for (const [role, value] of Object.entries(palette.blue.light))
      expect(appendix, role).toContain(`| ${role} | ${value} | ${palette.blue.dark[role]} |`);
    for (const [fg, bg, ratio] of [
      ["#777777", "#FFFFFF", "4.478089"],
      ["#767676", "#FFFFFF", "4.542225"],
      ["#FFFFFF", "#2563EB", "5.168556"],
      ["#FFFFFF", "#60A5FA", "2.542423"],
      ["#0F172A", "#60A5FA", "7.021860"],
      ["#808080", "#FFFFFF", "3.949440"],
    ])
      expect(appendix).toContain(`| ${fg} | ${bg} | ${ratio} |`);
  });
});
