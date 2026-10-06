import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerFrontsmith } from "../src/index.js";
import { compose } from "../src/interface/composition.js";
import { cliRun } from "./helpers/cli.js";
import { createHarness } from "./helpers/harness.js";
import { tempWorkspace } from "./helpers/workspace.js";

const LIGHT = {
  "--color-bg-canvas": "#F8FAFC",
  "--color-bg-surface": "#FFFFFF",
  "--color-text-primary": "#0F172A",
  "--color-text-secondary": "#475569",
  "--color-action-bg": "#2563EB",
  "--color-action-fg": "#FFFFFF",
};
const DARK = {
  "--color-bg-canvas": "#020617",
  "--color-bg-surface": "#0F172A",
  "--color-text-primary": "#F1F5F9",
  "--color-text-secondary": "#CBD5E1",
  "--color-action-bg": "#60A5FA",
  "--color-action-fg": "#0F172A",
};
const block = (selector: string, values: Record<string, string>): string =>
  `${selector} {\n${Object.entries(values)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n")}\n}\n`;
const USAGE_CSS = `body { background: var(--color-bg-canvas); color: var(--color-text-primary); }
.card { background: var(--color-bg-surface); color: var(--color-text-secondary); }
.btn { background: var(--color-action-bg); color: var(--color-action-fg); }
`;
const tokensCss = (light = LIGHT, dark = DARK): string =>
  block(':root, [data-theme="light"]', light) + block('[data-theme="dark"]', dark);
const files = (css = tokensCss()): Record<string, string> => ({
  "package.json": JSON.stringify({ name: "demo", dependencies: { react: "18.3.1" } }),
  "src/styles/tokens.css": css,
  "src/styles/app.css": USAGE_CSS,
});

const setup = async (workspace: Record<string, string>) => {
  const ws = await tempWorkspace(workspace);
  const harness = createHarness(() => ws.root);
  registerFrontsmith(harness.api, { composition: compose() });
  return { ws, harness };
};
const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
  result.content[0]?.text ?? "";
const kinds = (result: { content: Array<{ type: string; block?: { kind: string } }> }): string[] =>
  result.content.map((c) => (c.type === "ui" ? (c.block?.kind as string) : c.type));

describe("fs_tokens_check", () => {
  it("passes a token file whose default pairs all meet the target, and says what it did not evaluate", async () => {
    const { ws, harness } = await setup(files());
    try {
      const result = await harness.callTool("fs_tokens_check", {}, ws.root);
      expect(kinds(result)).toEqual(["text", "test-results", "table"]);
      const text = textOf(result);
      expect(text).toContain("Verdict: PASS");
      expect(text).toContain("css token files");
      expect(text).toMatch(/not evaluated/i);
      const table = result.content[2] as { block: { rows: string[][] } };
      const rows = table.block.rows.map((row) => row.join(" "));
      expect(
        rows.some(
          (r) =>
            r.includes("--color-text-primary") &&
            r.includes("--color-bg-surface") &&
            r.includes("light"),
        ),
      ).toBe(true);
      expect(rows.every((r) => r.includes("PASS"))).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("fails a token file with a failing pair through FS-TOK-008 in every theme", async () => {
    const { ws, harness } = await setup(
      files(tokensCss({ ...LIGHT, "--color-text-primary": "#777777" })),
    );
    try {
      const result = await harness.callTool("fs_tokens_check", {}, ws.root);
      const text = textOf(result);
      expect(text).toContain("Verdict: FAIL");
      expect(text).toContain("FS-TOK-008");
      const table = result.content[2] as { block: { rows: string[][] } };
      expect(table.block.rows.some((r) => r.includes("FAIL"))).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("resolves var() references and prefers-color-scheme blocks", async () => {
    const css = `:root { --blue-600: #2563EB; --white: #FFFFFF; --color-action-bg: var(--blue-600); --color-action-fg: var(--white); }
@media (prefers-color-scheme: dark) { :root { --blue-600: #60A5FA; --white: #0F172A; } }
`;
    const { ws, harness } = await setup({
      ...files(css),
      "src/styles/app.css":
        ".btn { background: var(--color-action-bg); color: var(--color-action-fg); }\n",
    });
    try {
      const result = await harness.callTool("fs_tokens_check", {}, ws.root);
      const table = result.content[2] as { block: { rows: string[][] } };
      const themes = table.block.rows
        .filter((r) => r.includes("--color-action-fg"))
        .map((r) => r[1]);
      expect(themes.sort()).toEqual(["dark", "light"]);
      expect(textOf(result)).toContain("Verdict: PASS");
    } finally {
      await ws.cleanup();
    }
  });

  it("never counts an unsupported colour format as evidence", async () => {
    const css = block(":root", {
      "--color-bg-surface": "oklch(98% 0.01 250)",
      "--color-text-primary": "#0F172A",
    });
    const { ws, harness } = await setup({
      ...files(css),
      "src/styles/app.css":
        ".a { color: var(--color-text-primary); background: var(--color-bg-surface); }\n",
    });
    try {
      const result = await harness.callTool("fs_tokens_check", {}, ws.root);
      const text = textOf(result);
      expect(text).toMatch(/not evaluated/i);
      expect(text).toContain("--color-bg-surface");
      const table = result.content[2] as { block: { rows: string[][] } };
      expect(table.block.rows).toEqual([]);
    } finally {
      await ws.cleanup();
    }
  });

  it("uses tokens.json files with their required pairs and merges several of them", async () => {
    const ok = {
      "--color-text": { $type: "color", $value: { light: "#0F172A" } },
      "--color-bg": { $type: "color", $value: { light: "#FFFFFF" } },
      $extensions: {
        frontsmith: {
          requiredPairs: [{ fg: "--color-text", bg: "--color-bg", kind: "normal_text" }],
        },
      },
    };
    const bad = {
      ...ok,
      "--color-text": { $type: "color", $value: { light: "#777777" } },
    };
    const { ws, harness } = await setup({
      ...files(),
      "docs/frontsmith/a/tokens.json": JSON.stringify(ok),
      "docs/frontsmith/b/tokens.json": JSON.stringify(bad),
    });
    try {
      const result = await harness.callTool("fs_tokens_check", {}, ws.root);
      const text = textOf(result);
      expect(text).toContain("Verdict: FAIL");
      expect(text).toContain("docs/frontsmith/b/tokens.json");
      expect(text).not.toContain("docs/frontsmith/a/tokens.json:1");
      expect((text.match(/FS-TOK-008/g) ?? []).length).toBe(1);
      expect(text).toContain("tokens.json files");
    } finally {
      await ws.cleanup();
    }
  });

  it("is BLOCKED when a tokens file or the config is invalid", async () => {
    const { ws, harness } = await setup({
      ...files(),
      "docs/frontsmith/a/tokens.json": JSON.stringify({ "--a": { $type: "color" } }),
    });
    try {
      const result = await harness.callTool("fs_tokens_check", {}, ws.root);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("BLOCKED");
      expect(textOf(result)).toContain("docs/frontsmith/a/tokens.json");
    } finally {
      await ws.cleanup();
    }
    const config = await setup({ ...files(), ".frontsmith/config.json": "{ nope" });
    try {
      const result = await config.harness.callTool("fs_tokens_check", {}, config.ws.root);
      expect(result.isError).toBe(true);
    } finally {
      await config.ws.cleanup();
    }
  });

  it("reports nothing to check when the workspace has no tokens, and rejects extra input", async () => {
    const { ws, harness } = await setup({ "src/a.ts": "export const a = 1;\n" });
    try {
      const result = await harness.callTool("fs_tokens_check", {}, ws.root);
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toMatch(/no token/i);
      expect((await harness.callTool("fs_tokens_check", { x: 1 }, ws.root)).isError).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });
});

describe("fs_contrast", () => {
  it("returns a table with composited colour, unrounded ratio at 6 decimals and the minimum", async () => {
    const { ws, harness } = await setup({});
    try {
      const result = await harness.callTool(
        "fs_contrast",
        {
          pairs: [
            { fg: "#777777", bg: "#FFFFFF", kind: "normal_text" },
            { fg: "#767676", bg: "#FFFFFF", kind: "normal_text" },
            { fg: "rgba(0, 0, 0, 0.5)", bg: "#FFFFFF", kind: "large_text" },
            {
              fg: "#FFFFFF",
              bg: "rgba(0,0,0,0.5)",
              backgroundStack: ["#FFFFFF"],
              kind: "non_text",
            },
            { fg: "hsl(0 0% 0%)", bg: "#FFFFFF", kind: "normal_text" },
          ],
        },
        ws.root,
      );
      expect(kinds(result)).toEqual(["text", "table"]);
      const rows = (result.content[1] as { block: { columns: string[]; rows: string[][] } }).block;
      expect(rows.columns).toEqual(["fg", "bg", "composited fg", "ratio", "minimum", "status"]);
      expect(rows.rows[0]).toEqual(["#777777", "#FFFFFF", "#777777", "4.478089", "4.5", "FAIL"]);
      expect(rows.rows[1]?.[5]).toBe("PASS");
      expect(rows.rows[2]).toEqual([
        "rgba(0, 0, 0, 0.5)",
        "#FFFFFF",
        "#808080",
        "3.949440",
        "3",
        "PASS",
      ]);
      expect(rows.rows[3]?.[3]).toBe("3.949440");
      expect(rows.rows[4]?.[5]).toBe("REVIEW");
      expect(textOf(result)).toContain("REVIEW");
    } finally {
      await ws.cleanup();
    }
  });

  it("validates its input: kinds, size, unknown keys", async () => {
    const { ws, harness } = await setup({});
    try {
      const bad: unknown[] = [
        {},
        { pairs: [] },
        { pairs: [{ fg: "#000", bg: "#fff", kind: "huge" }] },
        { pairs: [{ fg: 1, bg: "#fff", kind: "normal_text" }] },
        { pairs: [{ fg: "#000", bg: "#fff", kind: "normal_text", extra: 1 }] },
        { pairs: [{ fg: "#000", bg: "#fff", kind: "normal_text", backgroundStack: "x" }] },
        {
          pairs: Array.from({ length: 201 }, () => ({ fg: "#000", bg: "#fff", kind: "non_text" })),
        },
        { pairs: [{ fg: "#000", bg: "#fff", kind: "non_text" }], other: true },
      ];
      for (const input of bad)
        expect(
          (await harness.callTool("fs_contrast", input as never, ws.root)).isError,
          JSON.stringify(input).slice(0, 60),
        ).toBe(true);
      const max = await harness.callTool(
        "fs_contrast",
        {
          pairs: Array.from({ length: 200 }, () => ({ fg: "#000", bg: "#fff", kind: "non_text" })),
        },
        ws.root,
      );
      expect(max.isError).not.toBe(true);
    } finally {
      await ws.cleanup();
    }
  });
});

describe("fs_palette_generate", () => {
  it("returns a roles by themes table, the tokens as json and the hashes", async () => {
    const { ws, harness } = await setup({});
    try {
      const result = await harness.callTool(
        "fs_palette_generate",
        { family: "blue", themes: ["light", "dark"] },
        ws.root,
      );
      expect(kinds(result)).toEqual(["text", "table", "json"]);
      const table = (result.content[1] as { block: { columns: string[]; rows: string[][] } }).block;
      expect(table.columns).toEqual(["role", "light", "dark"]);
      expect(table.rows).toContainEqual(["action", "#2563EB", "#60A5FA"]);
      expect(textOf(result)).toContain("outputSha256");
      const again = await harness.callTool(
        "fs_palette_generate",
        { family: "blue", themes: ["light", "dark"] },
        ws.root,
      );
      expect(textOf(again)).toBe(textOf(result));
    } finally {
      await ws.cleanup();
    }
  });

  it("answers UNSAT as text, rejects bad input and pins the catalog version", async () => {
    const { ws, harness } = await setup({});
    try {
      const unsat = await harness.callTool(
        "fs_palette_generate",
        { family: "blue", themes: ["light"], locked: { canvas: "#1E293B" } },
        ws.root,
      );
      expect(textOf(unsat)).toBe("UNSAT: locked canvas violates text/canvas");
      expect(unsat.isError).not.toBe(true);
      const bad: unknown[] = [
        {},
        { family: "green", themes: ["light"] },
        { family: "blue", themes: [] },
        { family: "blue", themes: ["sepia"] },
        { family: "blue", themes: ["light"], locked: { action: "red" } },
        { family: "blue", themes: ["light"], locked: { nope: "#000000" } },
        { family: "blue", themes: ["light"], catalog: "0.0.1" },
        { family: "blue", themes: ["light"], extra: 1 },
      ];
      for (const input of bad)
        expect(
          (await harness.callTool("fs_palette_generate", input as never, ws.root)).isError,
          JSON.stringify(input),
        ).toBe(true);
      const pinned = await harness.callTool(
        "fs_palette_generate",
        { family: "teal", themes: ["dark"], catalog: "1.0.0" },
        ws.root,
      );
      expect(pinned.isError).not.toBe(true);
    } finally {
      await ws.cleanup();
    }
  });
});

describe("/frontsmith:tokens", () => {
  it("check summarises the verdict and usage covers unknown subcommands", async () => {
    const { ws, harness } = await setup(files());
    try {
      expect(await harness.callCommand("tokens", "check", "s")).toContain("Tokens check: PASS");
      expect(await harness.callCommand("tokens", "", "s")).toContain("Usage");
      expect(await harness.callCommand("tokens", "generate", "s")).toContain("Usage");
      expect(await harness.callCommand("tokens", "generate --family green", "s")).toContain(
        "not curated",
      );
      expect(
        await harness.callCommand("tokens", "generate --family blue --themes sepia", "s"),
      ).toContain("Usage");
      expect(
        await harness.callCommand("tokens", "generate --family blue --confirm NOPE", "s"),
      ).toContain("Usage");
    } finally {
      await ws.cleanup();
    }
  });

  it("generate previews without writing, then writes tokens.json and the theme CSS once confirmed", async () => {
    const { ws, harness } = await setup(files());
    try {
      const preview = await harness.callCommand("tokens", "generate --family blue", "s");
      expect(preview).toContain("/frontsmith:tokens generate --family blue --confirm WRITE");
      expect(preview).toContain("docs/frontsmith/tokens.json");
      expect(preview).toContain("src/styles/frontsmith-tokens.css");
      await expect(
        readFile(join(ws.root, "docs/frontsmith/tokens.json"), "utf8"),
      ).rejects.toThrow();
      const done = await harness.callCommand(
        "tokens",
        "generate --family blue --confirm WRITE",
        "s",
      );
      expect(done).toContain("Wrote");
      const json = JSON.parse(await readFile(join(ws.root, "docs/frontsmith/tokens.json"), "utf8"));
      expect(json["--color-action-bg"]).toEqual({
        $type: "color",
        $value: { light: "#2563EB", dark: "#60A5FA" },
      });
      const css = await readFile(join(ws.root, "src/styles/frontsmith-tokens.css"), "utf8");
      expect(css).toContain(':root, [data-theme="light"] {');
      const check = await harness.callCommand("tokens", "check", "s");
      expect(check).toContain("Tokens check");
      const replaced = await harness.callCommand(
        "tokens",
        "generate --family teal --themes light --confirm WRITE",
        "s",
      );
      expect(replaced).toContain("replaced");
    } finally {
      await ws.cleanup();
    }
  });

  it("asks for confirmation interactively and leaves files alone on a refusal", async () => {
    const ws = await tempWorkspace(files());
    try {
      const harness = createHarness(() => ws.root);
      let answer: string | undefined = "cancel";
      const asked: unknown[] = [];
      Object.assign(harness.api.ui, {
        interactive: () => true,
        askQuestions: async (request: unknown) => {
          asked.push(request);
          return { confirm: answer };
        },
      });
      registerFrontsmith(harness.api, { composition: compose() });
      const refused = await harness.callCommand("tokens", "generate --family blue", "s");
      expect(refused).toContain("Nothing was written");
      await expect(
        readFile(join(ws.root, "docs/frontsmith/tokens.json"), "utf8"),
      ).rejects.toThrow();
      answer = "write";
      const written = await harness.callCommand("tokens", "generate --family blue", "s");
      expect(written).toContain("Wrote");
      expect(asked[0]).toMatchObject({
        session: "s",
        label: expect.stringContaining("Frontsmith"),
      });
    } finally {
      await ws.cleanup();
    }
  });
});

describe("CLI contrast, palette and tokens", () => {
  it("contrast exits 0 on PASS, 1 on FAIL, 4 on REVIEW and 2 on bad usage", async () => {
    expect((await cliRun(["contrast", "#767676", "#FFFFFF"])).code).toBe(0);
    const fail = await cliRun(["contrast", "#777777", "#FFFFFF"]);
    expect(fail.code).toBe(1);
    expect(fail.stdout).toContain("4.478089");
    expect((await cliRun(["contrast", "#777777", "#FFFFFF", "--kind", "large_text"])).code).toBe(0);
    expect((await cliRun(["contrast", "hsl(0 0% 0%)", "#FFFFFF"])).code).toBe(4);
    expect((await cliRun(["contrast", "#000"])).code).toBe(2);
    expect((await cliRun(["contrast", "#000", "#fff", "--kind", "huge"])).code).toBe(2);
  });

  it("palette prints a table or JSON and exits 1 on UNSAT, 2 on invalid input", async () => {
    const table = await cliRun(["palette", "--family", "blue"]);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("#2563EB");
    const json = JSON.parse(
      (await cliRun(["palette", "--family", "teal", "--themes", "dark", "--json"])).stdout,
    );
    expect(json.themes[0].tokens.action).toBe("#2DD4BF");
    expect((await cliRun(["palette", "--family", "green"])).code).toBe(2);
    expect((await cliRun(["palette"])).code).toBe(2);
    expect((await cliRun(["palette", "--family", "blue", "--themes", "sepia"])).code).toBe(2);
  });

  it("tokens exits 0 when clean, 1 when a pair fails and 3 when blocked", async () => {
    const clean = await tempWorkspace(files());
    const bad = await tempWorkspace(
      files(tokensCss({ ...LIGHT, "--color-text-primary": "#777777" })),
    );
    const blocked = await tempWorkspace({ ...files(), ".frontsmith/config.json": "{ nope" });
    try {
      expect((await cliRun(["tokens", clean.root])).code).toBe(0);
      const failing = await cliRun(["tokens", bad.root, "--json"]);
      expect(failing.code).toBe(1);
      expect(JSON.parse(failing.stdout).verdict).toBe("FAIL");
      expect((await cliRun(["tokens", blocked.root])).code).toBe(3);
    } finally {
      await Promise.all([clean.cleanup(), bad.cleanup(), blocked.cleanup()]);
    }
  });
});
