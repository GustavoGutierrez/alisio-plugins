import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerFrontsmith } from "../src/index.js";
import { runCli } from "../src/interface/cli/main.js";
import { createHarness } from "./helpers/harness.js";
import { type TempWorkspace, tempWorkspace } from "./helpers/workspace.js";

let ws: TempWorkspace | undefined;
afterEach(async () => {
  await ws?.cleanup();
  ws = undefined;
});

const fixture = (name: string) => new URL(`./fixtures/projects/${name}`, import.meta.url).pathname;
const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content.find((p) => p.type === "text")?.text ?? "";

async function project(
  name = "react-fsd",
): Promise<{ ws: TempWorkspace; harness: ReturnType<typeof createHarness> }> {
  ws = await tempWorkspace();
  await cp(fixture(name), ws.root, { recursive: true });
  const root = ws.root;
  const harness = createHarness(() => root);
  registerFrontsmith(harness.api);
  return { ws, harness };
}

describe("fs_rules_check", () => {
  it("is registered as a read tool and returns test-results first, then a table", async () => {
    const { ws: w, harness } = await project();
    const tool = harness.tools.get("fs_rules_check");
    expect(tool?.effect).toBe("read");
    await w.write(
      "src/shared/ui/bad.tsx",
      'export function Bad() {\n  return <img src="a.png" />;\n}\n',
    );
    const result = await harness.callTool("fs_rules_check", {}, w.root);
    expect(result.isError).toBeUndefined();
    expect(result.content.map((p) => (p.type === "ui" ? p.block.kind : p.type))).toEqual([
      "text",
      "test-results",
      "table",
    ]);
    expect(textOf(result)).toMatch(/Verdict: FAIL/);
    expect(textOf(result)).toContain("FS-A11Y-001");
    const block = result.content[1];
    expect(
      block?.type === "ui" && block.block.kind === "test-results"
        ? block.block.suites.map((s) => s.name)
        : [],
    ).toContain("fs-a11y");
  });

  it("narrows by paths, packs, categories and severity and validates its input", async () => {
    const { ws: w, harness } = await project();
    await w.write(
      "src/shared/ui/bad.tsx",
      'export function Bad() {\n  return <img src="a.png" />;\n}\n',
    );
    const narrowed = await harness.callTool(
      "fs_rules_check",
      { packs: ["fs-css"], minSeverity: "major" },
      w.root,
    );
    expect(textOf(narrowed)).not.toContain("FS-A11Y-001");
    for (const bad of [
      { paths: "src" },
      { paths: ["../x"] },
      { paths: ["/abs"] },
      { paths: ["!x"] },
      { packs: ["Bad Pack"] },
      { categories: ["misc"] },
      { minSeverity: "huge" },
      { nope: 1 },
    ]) {
      const result = await harness.callTool("fs_rules_check", bad as never, w.root);
      expect(result.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(harness.tools.get("fs_rules_check")?.paths?.({ paths: ["src/**"] })).toEqual(["src/**"]);
  });

  it("reports BLOCKED with the diagnostics when the config is invalid, and never runs rules", async () => {
    const { ws: w, harness } = await project();
    await w.write(".frontsmith/config.json", JSON.stringify({ schemaVersion: 1, nope: true }));
    const result = await harness.callTool("fs_rules_check", {}, w.root);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/BLOCKED/);
    expect(textOf(result)).toContain("CFG-001");
  });
});

describe("fs_rules_list and /frontsmith:rules", () => {
  it("lists active rules as a table and explains one rule with its trail", async () => {
    const { ws: w, harness } = await project();
    const list = await harness.callTool("fs_rules_list", { pack: "fs-a11y" }, w.root);
    const block = list.content[1];
    expect(block?.type === "ui" && block.block.kind === "table" ? block.block.rows.length : 0).toBe(
      14,
    );
    const explained = await harness.callTool("fs_rules_list", { ruleId: "FS-CSS-001" }, w.root);
    expect(textOf(explained)).toContain("Resolution trail");
    expect(
      (await harness.callTool("fs_rules_list", { ruleId: "FS-NOPE-001" }, w.root)).isError,
    ).toBe(true);
    expect((await harness.callTool("fs_rules_list", { pack: "Bad" }, w.root)).isError).toBe(true);
  });

  it("registers the rules command and answers list, explain and usage", async () => {
    const { ws: w, harness } = await project();
    expect(harness.commands.has("rules")).toBe(true);
    const list = await harness.callCommand("rules", "list fs-css", "s1");
    expect(list).toContain("FS-CSS-001");
    expect(list).not.toContain("FS-A11Y-001");
    const explain = await harness.callCommand("rules", "explain FS-TOK-001", "s1");
    expect(explain).toContain("### Resolution trail");
    expect(explain).toContain("shipped:fs-tokens");
    for (const usage of ["", "bogus", "list a b", "explain", "test", "promote"])
      expect(await harness.callCommand("rules", usage, "s1"), usage).toContain("Usage:");
    expect(await harness.callCommand("rules", "explain FS-NOPE-001", "s1")).toContain(
      "Unknown rule",
    );
    await expect(harness.callCommand("rules", "list")).rejects.toThrow(/session/);
    void w;
  });

  it("explains inactive rules (wrong stack) and rules disabled by config", async () => {
    const { ws: w, harness } = await project();
    expect(await harness.callCommand("rules", "explain FS-VUE-001", "s1")).toMatch(/inactive/);
    await w.write(
      ".frontsmith/config.json",
      JSON.stringify({ schemaVersion: 1, rules: { "FS-CSS-001": { enabled: false } } }),
    );
    expect(await harness.callCommand("rules", "explain FS-CSS-001", "s1")).toMatch(
      /State: disabled/,
    );
  });

  it("tests a workspace pack with its own fixtures and promotes a candidate", async () => {
    const { ws: w, harness } = await project();
    const pack = {
      schemaVersion: 1,
      packId: "acme",
      version: "1.0.0",
      title: "ACME",
      description: "House rules",
      extends: ["fs-css"],
      appliesWhen: {},
      rules: [
        {
          id: "ACME-CSS-001",
          title: "No red",
          severity: "minor",
          kind: "deterministic",
          category: "layout",
          engine: "css-declaration",
          params: { property: "^color$", value: "^red$" },
          files: ["**/*.css"],
          appliesWhen: {},
          message: "no red",
          fix: "use a token",
          rationale: "house style",
          source: "ACME style guide",
          suppressible: true,
          tags: [],
          fixtures: { pass: ["fixtures/pass.css"], fail: ["fixtures/fail.css"] },
        },
      ],
      overrides: [],
    };
    await w.write(".frontsmith/packs/acme/pack.json", JSON.stringify(pack));
    await w.write(".frontsmith/packs/acme/fixtures/fail.css", ".a { color: red; }\n");
    await w.write(".frontsmith/packs/acme/fixtures/pass.css", ".a { color: blue; }\n");
    const report = await harness.callCommand("rules", "test acme", "s1");
    expect(report).toContain("all fixtures behave");
    await w.write(".frontsmith/packs/acme/fixtures/pass.css", ".a { color: red; }\n");
    expect(await harness.callCommand("rules", "test acme", "s1")).toContain("1 fixture problem");
    expect(await harness.callCommand("rules", "test nope", "s1")).toContain("No workspace pack");

    expect(await harness.callCommand("rules", "promote CAND-001", "s1")).toContain(
      "No candidate CAND-001",
    );
    const rule = { ...pack.rules[0], id: "ACME-CSS-002", fixtures: undefined };
    await mkdir(join(w.root, ".frontsmith", "candidates"), { recursive: true });
    await w.write(
      ".frontsmith/candidates/projects.json",
      JSON.stringify({
        schemaVersion: 1,
        feature: "projects",
        candidates: [{ id: "CAND-001", rule }],
      }),
    );
    expect(await harness.callCommand("rules", "promote CAND-001", "s1")).toContain(
      "Promoted `ACME-CSS-002`",
    );
    const local = JSON.parse(
      await readFile(join(w.root, ".frontsmith", "packs", "local", "pack.json"), "utf8"),
    );
    expect(local.rules.map((r: { id: string }) => r.id)).toEqual(["ACME-CSS-002"]);
    expect(await harness.callCommand("rules", "promote CAND-001", "s1")).toContain(
      "already exists",
    );
    await writeFile(
      join(w.root, ".frontsmith", "candidates", "bad.json"),
      JSON.stringify({
        schemaVersion: 1,
        feature: "bad",
        candidates: [{ id: "CAND-002", rule: { id: "FS-CSS-099" } }],
      }),
    );
    expect(await harness.callCommand("rules", "promote CAND-002", "s1")).toContain(
      "not a valid rule",
    );
  });

  it("reads only candidates files with schemaVersion 1 and a CAND-NNN id", async () => {
    const { ws: w, harness } = await project();
    const rule = {
      id: "ACME-CSS-003",
      title: "No red",
      severity: "minor",
      kind: "deterministic",
      category: "layout",
      engine: "css-declaration",
      params: { property: "^color$", value: "^red$" },
      files: ["**/*.css"],
      appliesWhen: {},
      message: "no red",
      fix: "use a token",
      rationale: "house style",
      source: "ACME style guide",
      suppressible: true,
      tags: [],
    };
    await w.write(
      ".frontsmith/candidates/old.json",
      JSON.stringify({ feature: "old", candidates: [{ id: "CAND-004", rule }] }),
    );
    await w.write(
      ".frontsmith/candidates/v2.json",
      JSON.stringify({ schemaVersion: 2, feature: "v2", candidates: [{ id: "CAND-005", rule }] }),
    );
    await w.write(
      ".frontsmith/candidates/odd.json",
      JSON.stringify({ schemaVersion: 1, feature: "odd", candidates: [{ id: "CAND-6", rule }] }),
    );
    for (const id of ["CAND-004", "CAND-005"])
      expect(await harness.callCommand("rules", `promote ${id}`, "s1")).toContain(
        `No candidate ${id}`,
      );
    expect(await harness.callCommand("rules", "promote CAND-006", "s1")).toContain(
      "No candidate CAND-006",
    );
    await w.write(
      ".frontsmith/candidates/good.json",
      JSON.stringify({ schemaVersion: 1, feature: "good", candidates: [{ id: "CAND-007", rule }] }),
    );
    expect(await harness.callCommand("rules", "promote CAND-007", "s1")).toContain(
      "Promoted `ACME-CSS-003`",
    );
  });
});

describe("alisio-frontsmith check", () => {
  const io = (cwd: string) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { cwd, stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) },
    };
  };

  it("exits 0, 1, 3 and 4 for PASS, FAIL, BLOCKED and REVIEW", async () => {
    ws = await tempWorkspace({
      "package.json": JSON.stringify({ name: "x" }),
      "src/a.css": ".a { color: var(--c); }\n",
      "src/styles/tokens.css": ":root { --c: #111; }\n",
    });
    const clean = io(ws.root);
    expect(await runCli(["check", "--json"], clean.io)).toBe(0);
    expect(JSON.parse(clean.out.join("")).verdict).toBe("PASS");

    await ws.write("src/bad.html", '<img src="a.png">\n');
    const failing = io(ws.root);
    expect(await runCli(["check", "--json"], failing.io)).toBe(1);
    expect(
      JSON.parse(failing.out.join("")).findings.some(
        (f: { ruleId: string }) => f.ruleId === "FS-A11Y-001",
      ),
    ).toBe(true);
    await ws.write("src/bad.html", "<p>fine</p>\n");

    await ws.write("src/a.css", ".a { transition: all 1s; }\n");
    const review = io(ws.root);
    expect(await runCli(["check"], review.io)).toBe(4);
    expect(review.out.join("")).toContain("## Rule check: REVIEW");

    await ws.write(".frontsmith/config.json", "{ nope");
    const blocked = io(ws.root);
    expect(await runCli(["check", "--json"], blocked.io)).toBe(3);
    expect(JSON.parse(blocked.out.join("")).verdict).toBe("BLOCKED");
  });

  it("prints frontsmith.rules-report/v1 and persists nothing", async () => {
    ws = await tempWorkspace({
      "package.json": "{}",
      "src/a.html": '<img src="a.png">\n',
    });
    const list = async (): Promise<string[]> =>
      (await readdir(ws.root, { recursive: true })).map(String).sort();
    const before = await list();
    const run = io(ws.root);
    expect(await runCli(["check", "--json"], run.io)).toBe(1);
    expect(JSON.parse(run.out.join("")).schema).toBe("frontsmith.rules-report/v1");
    expect(await list()).toEqual(before);
  });

  it("filters by --paths and --packs and rejects bad usage with exit 2", async () => {
    ws = await tempWorkspace({
      "package.json": "{}",
      "src/a.html": '<img src="a.png">\n',
      "lib/b.html": '<img src="b.png">\n',
    });
    const scoped = io(ws.root);
    expect(
      await runCli(["check", "--json", "--paths", "src/**", "--packs", "fs-a11y"], scoped.io),
    ).toBe(1);
    const files = JSON.parse(scoped.out.join("")).findings.map((f: { file: string }) => f.file);
    expect(new Set(files)).toEqual(new Set(["src/a.html"]));
    const bad = io(ws.root);
    expect(await runCli(["check", "--nope"], bad.io)).toBe(2);
  });
});
