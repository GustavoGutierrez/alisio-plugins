import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferCommands, resolveCommands } from "../src/application/detect/commands.js";
import { detectStack } from "../src/application/detect/stack.js";
import { NodeModuleResolver, NodeWorkspaceFs } from "../src/infrastructure/fs/workspace-fs.js";
import { type TempWorkspace, tempWorkspace } from "./helpers/workspace.js";

const projects = new URL("./fixtures/projects/", import.meta.url).pathname;
const resolver = new NodeModuleResolver();
let ws: TempWorkspace | undefined;
afterEach(async () => {
  await ws?.cleanup();
  ws = undefined;
});

const detect = (root: string) => detectStack(new NodeWorkspaceFs(root), resolver);

/** Installed packages are stubbed at test time because fixtures cannot commit node_modules. */
async function installStubs(root: string, installed: Record<string, string>): Promise<void> {
  for (const [name, version] of Object.entries(installed)) {
    const dir = join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }));
  }
}

describe("fixture projects", async () => {
  const names = (await readdir(projects)).sort();
  it("ships the six fixture projects", () => {
    expect(names).toEqual([
      "angular-basic",
      "next-app",
      "react-fsd",
      "svelte-basic",
      "tailwind-v4",
      "vue-basic",
    ]);
  });

  for (const name of names) {
    it(`detects ${name} with an exact StackProfile`, async () => {
      ws = await tempWorkspace();
      await cp(join(projects, name), ws.root, { recursive: true });
      const installed = JSON.parse(
        await readFile(join(projects, name, "installed.json"), "utf8"),
      ) as Record<string, string>;
      await installStubs(ws.root, installed);
      const expected = JSON.parse(await readFile(join(projects, name, "expected.json"), "utf8"));
      expect(await detect(ws.root)).toEqual(expected);
    });
  }
});

const pkg = (extra: Record<string, unknown>) => JSON.stringify({ name: "x", ...extra });

describe("framework precedence", () => {
  const profile = async (files: Record<string, string>, installed: Record<string, string> = {}) => {
    ws = await tempWorkspace(files);
    await installStubs(ws.root, installed);
    return detect(ws.root);
  };

  it("prefers angular over everything and records the version", async () => {
    const p = await profile(
      { "package.json": pkg({ dependencies: { "@angular/core": "^17.0.0", react: "^18.0.0" } }) },
      { "@angular/core": "17.1.2" },
    );
    expect(p).toMatchObject({ framework: "angular", meta: "angular", frameworkVersion: "17.1.2" });
  });

  it("maps meta frameworks onto their base framework", async () => {
    expect(
      await profile({ "package.json": pkg({ dependencies: { next: "15.0.0", react: "19.0.0" } }) }),
    ).toMatchObject({ framework: "react", meta: "next" });
    expect(
      await profile({ "package.json": pkg({ dependencies: { nuxt: "3.0.0", vue: "3.4.0" } }) }),
    ).toMatchObject({ framework: "vue", meta: "nuxt" });
    expect(
      await profile({
        "package.json": pkg({ devDependencies: { "@sveltejs/kit": "2.0.0", svelte: "4.0.0" } }),
      }),
    ).toMatchObject({ framework: "svelte", meta: "sveltekit" });
    expect(
      await profile({
        "package.json": pkg({ dependencies: { "@remix-run/react": "2.0.0", react: "18.2.0" } }),
      }),
    ).toMatchObject({ framework: "react", meta: "remix" });
    expect(
      await profile({
        "package.json": pkg({
          dependencies: { "react-router": "7.1.0", "@react-router/dev": "7.1.0", react: "19.0.0" },
        }),
      }),
    ).toMatchObject({ meta: "remix" });
    expect(
      await profile({
        "package.json": pkg({ dependencies: { "react-router": "6.4.0", react: "18.0.0" } }),
      }),
    ).toMatchObject({ meta: "none" });
  });

  it("takes the framework of an astro project from its integrations", async () => {
    const p = await profile({
      "package.json": pkg({
        dependencies: { astro: "4.0.0", "@astrojs/vue": "4.0.0", vue: "3.4.0" },
      }),
    });
    expect(p).toMatchObject({ framework: "vue", meta: "astro" });
    expect(
      await profile({ "package.json": pkg({ dependencies: { astro: "4.0.0" } }) }),
    ).toMatchObject({ framework: "none", meta: "astro" });
  });

  it("falls back through svelte, vue, solid, preact, react and none", async () => {
    expect(
      (await profile({ "package.json": pkg({ dependencies: { svelte: "4.0.0", vue: "3.0.0" } }) }))
        .framework,
    ).toBe("svelte");
    expect(
      (
        await profile({
          "package.json": pkg({ dependencies: { vue: "3.0.0", "solid-js": "1.0.0" } }),
        })
      ).framework,
    ).toBe("vue");
    expect(
      (
        await profile({
          "package.json": pkg({ dependencies: { "solid-js": "1.0.0", preact: "10.0.0" } }),
        })
      ).framework,
    ).toBe("solid");
    expect(
      (
        await profile({
          "package.json": pkg({ dependencies: { preact: "10.0.0", react: "18.0.0" } }),
        })
      ).framework,
    ).toBe("preact");
    expect(
      (await profile({ "package.json": pkg({ dependencies: { react: "18.0.0" } }) })).framework,
    ).toBe("react");
    expect((await profile({ "package.json": pkg({}) })).framework).toBe("none");
  });

  it("marks a version that is only declared", async () => {
    const p = await profile({ "package.json": pkg({ dependencies: { react: "^18.2.0" } }) });
    expect(p.frameworkVersion).toBe("^18.2.0 (declared)");
    expect(p.evidence).toContainEqual({
      fact: "framework=react",
      source: "package.json#dependencies.react",
    });
  });
});

describe("package manager, monorepo and typescript", () => {
  const profile = async (files: Record<string, string>) => {
    ws = await tempWorkspace({ "package.json": pkg({}), ...files });
    return detect(ws.root);
  };

  it("follows the lockfile precedence", async () => {
    expect(
      (await profile({ "pnpm-lock.yaml": "", "yarn.lock": "", "package-lock.json": "{}" }))
        .packageManager,
    ).toBe("pnpm");
    expect((await profile({ "yarn.lock": "", "package-lock.json": "{}" })).packageManager).toBe(
      "yarn",
    );
    expect((await profile({ "bun.lock": "", "package-lock.json": "{}" })).packageManager).toBe(
      "bun",
    );
    expect((await profile({ "bun.lockb": "" })).packageManager).toBe("bun");
    expect((await profile({ "package-lock.json": "{}" })).packageManager).toBe("npm");
    expect((await profile({})).packageManager).toBe("npm");
  });

  it("detects monorepos from workspaces and tool files", async () => {
    expect((await profile({ "pnpm-workspace.yaml": "packages: []" })).monorepo).toBe(true);
    expect((await profile({ "turbo.json": "{}" })).monorepo).toBe(true);
    expect((await profile({ "package.json": pkg({ workspaces: ["packages/*"] }) })).monorepo).toBe(
      true,
    );
    expect((await profile({})).monorepo).toBe(false);
  });

  it("detects typescript from tsconfig or the dependency", async () => {
    expect((await profile({ "tsconfig.json": "{}" })).typescript).toBe(true);
    expect(
      (await profile({ "package.json": pkg({ devDependencies: { typescript: "5.0.0" } }) }))
        .typescript,
    ).toBe(true);
    expect((await profile({})).typescript).toBe(false);
  });
});

describe("styling, state, tests and tooling", () => {
  it("detects styling from dependencies and files", async () => {
    ws = await tempWorkspace({
      "package.json": pkg({
        devDependencies: { tailwindcss: "^3.4.0", sass: "1.0.0", "styled-components": "6.0.0" },
      }),
      "src/a.module.css": ".a{}",
      "src/b.less": "",
      "src/c.css": "",
    });
    const p = await detect(ws.root);
    expect(p.styling).toEqual(["tailwind", "css-modules", "css-in-js", "scss", "less", "css"]);
    expect(p.tailwindMajor).toBe(3);
  });

  it("reads the installed tailwind major and falls back to the declared range", async () => {
    ws = await tempWorkspace({
      "package.json": pkg({ devDependencies: { tailwindcss: "^4.0.0-beta.1" } }),
    });
    expect((await detect(ws.root)).tailwindMajor).toBe(4);
  });

  it("lists state libraries and test tooling in a fixed order", async () => {
    ws = await tempWorkspace({
      "package.json": pkg({
        dependencies: { zustand: "4.0.0", "@tanstack/react-query": "5.0.0", pinia: "2.0.0" },
        devDependencies: {
          jest: "29.0.0",
          vitest: "1.0.0",
          "@testing-library/react": "14.0.0",
          cypress: "13.0.0",
          "@playwright/test": "1.40.0",
          "@storybook/react": "8.0.0",
        },
      }),
    });
    const p = await detect(ws.root);
    expect(p.state).toEqual(["@tanstack/react-query", "pinia", "zustand"]);
    expect(p.tests).toEqual(["vitest", "jest", "testing-library", "playwright", "cypress"]);
    expect(p.storybook).toBe(true);
  });

  it("reports whether playwright and axe-core resolve from the workspace", async () => {
    ws = await tempWorkspace({ "package.json": pkg({}) });
    expect(await detect(ws.root)).toMatchObject({
      playwrightResolvable: false,
      axeResolvable: false,
    });
    await installStubs(ws.root, { "@playwright/test": "1.40.0", "axe-core": "4.9.0" });
    expect(await detect(ws.root)).toMatchObject({
      playwrightResolvable: true,
      axeResolvable: true,
    });
  });

  it("survives a missing or invalid package.json", async () => {
    ws = await tempWorkspace({});
    expect(await detect(ws.root)).toMatchObject({
      framework: "none",
      packageManager: "npm",
      scripts: {},
    });
    await ws.write("package.json", "{ nope");
    expect((await detect(ws.root)).framework).toBe("none");
  });

  it("chooses source roots from the directories that hold sources", async () => {
    ws = await tempWorkspace({ "package.json": pkg({}), "src/a.ts": "", "app/b.ts": "" });
    expect((await detect(ws.root)).sourceRoots).toEqual(["src"]);
    await ws.cleanup();
    ws = await tempWorkspace({
      "package.json": pkg({}),
      "app/b.ts": "",
      "components/c.tsx": "",
      "lib/x.txt": "",
    });
    expect((await detect(ws.root)).sourceRoots).toEqual(["app", "components"]);
    await ws.cleanup();
    ws = await tempWorkspace({ "package.json": pkg({}) });
    expect((await detect(ws.root)).sourceRoots).toEqual([]);
  });
});

describe("command inference", () => {
  const scripts = {
    "type-check": "tsc",
    lint: "eslint .",
    test: "vitest",
    "test:e2e": "playwright test",
    build: "vite build",
  };

  it("picks the first matching script and invokes it through the package manager", () => {
    const plan = inferCommands("pnpm", scripts, ["vitest"]);
    expect(plan.typecheck).toEqual({
      argv: ["pnpm", "run", "type-check"],
      source: "inferred:package.json#scripts.type-check",
    });
    expect(plan.lint?.argv).toEqual(["pnpm", "run", "lint"]);
    expect(plan.e2e?.argv).toEqual(["pnpm", "run", "test:e2e"]);
    expect(plan.build?.argv).toEqual(["pnpm", "run", "build"]);
    expect(plan.testRelated).toEqual({
      argv: ["pnpm", "exec", "vitest", "related", "--run", "{files}"],
      source: "inferred:vitest",
    });
  });

  it("spells the testRelated runner per package manager (spec 15.3)", () => {
    const argv = (pm: "npm" | "pnpm" | "yarn" | "bun", tests: string[]) =>
      inferCommands(pm, {}, tests).testRelated?.argv;
    expect(argv("npm", ["vitest"])).toEqual(["npx", "vitest", "related", "--run", "{files}"]);
    expect(argv("pnpm", ["vitest"])).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "related",
      "--run",
      "{files}",
    ]);
    expect(argv("yarn", ["vitest"])).toEqual(["yarn", "vitest", "related", "--run", "{files}"]);
    expect(argv("bun", ["vitest"])).toEqual(["bunx", "vitest", "related", "--run", "{files}"]);
    expect(argv("yarn", ["jest"])).toEqual(["yarn", "jest", "--findRelatedTests", "{files}"]);
    expect(argv("bun", ["jest"])).toEqual(["bunx", "jest", "--findRelatedTests", "{files}"]);
  });

  it("infers testRelated only for vitest and jest", () => {
    for (const runner of ["mocha", "playwright", "cypress", "node-test"])
      expect(inferCommands("pnpm", { test: "x" }, [runner]).testRelated).toBeUndefined();
  });

  it("uses the typecheck pattern order and the right runner per package manager", () => {
    expect(inferCommands("npm", { tsc: "tsc", typecheck: "x" }, []).typecheck?.argv).toEqual([
      "npm",
      "run",
      "typecheck",
    ]);
    expect(inferCommands("yarn", { build: "x" }, []).build?.argv).toEqual(["yarn", "run", "build"]);
    expect(inferCommands("bun", { build: "x" }, []).build?.argv).toEqual(["bun", "run", "build"]);
  });

  it("infers related tests for jest only and omits commands without scripts", () => {
    expect(inferCommands("npm", { test: "jest" }, ["jest"]).testRelated?.argv).toEqual([
      "npx",
      "jest",
      "--findRelatedTests",
      "{files}",
    ]);
    const none = inferCommands("npm", {}, []);
    expect(none).toEqual({});
  });

  it("lets configured commands win and reports their source", () => {
    const plan = resolveCommands(inferCommands("pnpm", scripts, []), {
      lint: ["biome", "check", "."],
    });
    expect(plan.lint).toEqual({ argv: ["biome", "check", "."], source: "config" });
    expect(plan.build?.source).toBe("inferred:package.json#scripts.build");
  });
});

void dirname;
