import type { ModuleResolver, WorkspaceFs } from "../../application/ports/workspace-fs.js";
import type {
  Framework,
  MetaFramework,
  PackageManager,
  StackEvidence,
  StackProfile,
} from "../../domain/stack/profile.js";
import { matchedScripts } from "./commands.js";

type Dependencies = Record<string, { range: string; section: string }>;

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|css|scss|less)$/i;
const SOURCE_ROOT_CANDIDATES = ["app", "pages", "components", "lib"] as const;
const STATE_LIBRARIES = [
  "@ngrx/store",
  "@reduxjs/toolkit",
  "@tanstack/react-query",
  "jotai",
  "mobx",
  "nanostores",
  "pinia",
  "recoil",
  "redux",
  "swr",
  "valtio",
  "vuex",
  "xstate",
  "zustand",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readJson(
  fs: WorkspaceFs,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await fs.read(path);
    if (result.kind !== "text") return undefined;
    const parsed: unknown = JSON.parse(result.text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function collectDependencies(manifest: Record<string, unknown> | undefined): Dependencies {
  const out: Dependencies = {};
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const block = manifest?.[section];
    if (!isRecord(block)) continue;
    for (const [name, range] of Object.entries(block))
      if (typeof range === "string" && out[name] === undefined) out[name] = { range, section };
  }
  return out;
}

const majorOf = (version: string): number | undefined => {
  const match = /(\d+)/.exec(version.replace(/^[^\d]*/, ""));
  return match ? Number(match[1]) : undefined;
};

/** Pure function of the workspace's files (plus module resolution) to a `StackProfile`. */
export async function detectStack(
  fs: WorkspaceFs,
  resolver: ModuleResolver,
): Promise<StackProfile> {
  const evidence: StackEvidence[] = [];
  const note = (fact: string, source: string): void => {
    evidence.push({ fact, source });
  };
  const { files } = await fs.listFiles();
  const fileSet = new Set(files);
  const manifest = await readJson(fs, "package.json");
  const deps = collectDependencies(manifest);
  const has = (name: string): boolean => deps[name] !== undefined;
  const source = (name: string): string => `package.json#${deps[name]?.section}.${name}`;

  const installedVersion = async (name: string): Promise<string | undefined> => {
    const installed = await readJson(fs, `node_modules/${name}/package.json`).catch(
      () => undefined,
    );
    return typeof installed?.version === "string" ? installed.version : undefined;
  };
  const versionOf = async (name: string): Promise<{ text: string; source: string } | undefined> => {
    const installed = await installedVersion(name);
    if (installed) return { text: installed, source: `node_modules/${name}/package.json` };
    const declared = deps[name];
    return declared ? { text: `${declared.range} (declared)`, source: source(name) } : undefined;
  };

  let packageManager: PackageManager = "npm";
  const lockfiles: Array<[string, PackageManager]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ];
  const lock = lockfiles.find(([file]) => fileSet.has(file));
  if (lock) {
    packageManager = lock[1];
    note(`packageManager=${packageManager}`, lock[0]);
  } else note("packageManager=npm", "default");

  const monorepoSource = ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"].find(
    (file) => fileSet.has(file),
  );
  const monorepo = monorepoSource !== undefined || manifest?.workspaces !== undefined;
  if (monorepo) note("monorepo=true", monorepoSource ?? "package.json#workspaces");

  const typescript = fileSet.has("tsconfig.json") || has("typescript");
  if (typescript)
    note("typescript=true", fileSet.has("tsconfig.json") ? "tsconfig.json" : source("typescript"));

  // Framework precedence (spec 15.1).
  let framework: Framework = "none";
  let meta: MetaFramework = "none";
  let frameworkPackage: string | undefined;
  const reactRouterFramework =
    has("react-router") &&
    has("@react-router/dev") &&
    (majorOf(deps["react-router"]?.range ?? "") ?? 0) >= 7;
  if (has("@angular/core")) {
    framework = "angular";
    meta = "angular";
    frameworkPackage = "@angular/core";
  } else if (has("next")) {
    framework = "react";
    meta = "next";
    frameworkPackage = "react";
  } else if (has("nuxt")) {
    framework = "vue";
    meta = "nuxt";
    frameworkPackage = "vue";
  } else if (has("@sveltejs/kit")) {
    framework = "svelte";
    meta = "sveltekit";
    frameworkPackage = "svelte";
  } else if (has("@remix-run/react") || reactRouterFramework) {
    framework = "react";
    meta = "remix";
    frameworkPackage = "react";
  } else if (has("astro")) {
    meta = "astro";
    const integrations: Array<[string, Framework, string]> = [
      ["@astrojs/react", "react", "react"],
      ["@astrojs/vue", "vue", "vue"],
      ["@astrojs/svelte", "svelte", "svelte"],
      ["@astrojs/solid-js", "solid", "solid-js"],
      ["@astrojs/preact", "preact", "preact"],
    ];
    const found = integrations.find(([name]) => has(name));
    if (found) {
      framework = found[1];
      frameworkPackage = found[2];
    }
  } else {
    const base: Array<[string, Framework]> = [
      ["svelte", "svelte"],
      ["vue", "vue"],
      ["solid-js", "solid"],
      ["preact", "preact"],
      ["react", "react"],
    ];
    const found = base.find(([name]) => has(name));
    if (found) {
      framework = found[1];
      frameworkPackage = found[0];
    }
  }
  const frameworkSource =
    frameworkPackage && has(frameworkPackage) ? source(frameworkPackage) : undefined;
  const metaPackage: Record<string, string> = {
    next: "next",
    nuxt: "nuxt",
    sveltekit: "@sveltejs/kit",
    astro: "astro",
    angular: "@angular/core",
    remix: has("@remix-run/react") ? "@remix-run/react" : "react-router",
  };
  if (framework !== "none") note(`framework=${framework}`, frameworkSource ?? "inferred");
  else if (meta === "astro") note("framework=none", source("astro"));
  if (meta !== "none") note(`meta=${meta}`, source(metaPackage[meta] as string));
  let frameworkVersion: string | undefined;
  if (frameworkPackage) {
    const version = await versionOf(frameworkPackage);
    if (version) {
      frameworkVersion = version.text;
      note(`frameworkVersion=${version.text}`, version.source);
    }
  }

  // Styling.
  const styling: string[] = [];
  let tailwindMajor: number | undefined;
  if (has("tailwindcss")) {
    styling.push("tailwind");
    const version = await versionOf("tailwindcss");
    tailwindMajor = version ? majorOf(version.text) : undefined;
    note("styling=tailwind", source("tailwindcss"));
    if (tailwindMajor !== undefined && version)
      note(`tailwindMajor=${tailwindMajor}`, version.source);
  }
  const moduleCss = files.find((file) => /\.module\.(?:css|scss|less)$/i.test(file));
  if (moduleCss) {
    styling.push("css-modules");
    note("styling=css-modules", moduleCss);
  }
  const cssInJs = ["styled-components", "@emotion/react", "@emotion/styled"].find(has);
  if (cssInJs) {
    styling.push("css-in-js");
    note("styling=css-in-js", source(cssInJs));
  }
  if (has("@vanilla-extract/css")) {
    styling.push("vanilla-extract");
    note("styling=vanilla-extract", source("@vanilla-extract/css"));
  }
  const scssSource =
    ["sass", "sass-embedded", "node-sass"].find(has) ?? files.find((file) => /\.scss$/i.test(file));
  if (scssSource) {
    styling.push("scss");
    note("styling=scss", has(scssSource) ? source(scssSource) : scssSource);
  }
  const lessSource = has("less") ? "less" : files.find((file) => /\.less$/i.test(file));
  if (lessSource) {
    styling.push("less");
    note("styling=less", has(lessSource) ? source(lessSource) : lessSource);
  }
  const plainCss = files.find((file) => /\.css$/i.test(file) && !/\.module\.css$/i.test(file));
  if (plainCss) {
    styling.push("css");
    note("styling=css", plainCss);
  }

  const state = STATE_LIBRARIES.filter(has);
  for (const name of state) note(`state=${name}`, source(name));

  const tests: string[] = [];
  const testing: Array<[string, (name: string) => boolean]> = [
    ["vitest", (name) => name === "vitest"],
    ["jest", (name) => name === "jest"],
    ["testing-library", (name) => name.startsWith("@testing-library/")],
    ["playwright", (name) => name === "@playwright/test" || name === "playwright"],
    ["cypress", (name) => name === "cypress"],
  ];
  for (const [label, match] of testing) {
    const dep = Object.keys(deps).find(match);
    if (dep) {
      tests.push(label);
      note(`tests=${label}`, source(dep));
    }
  }
  const storybookDep = Object.keys(deps).find(
    (name) => name === "storybook" || name.startsWith("@storybook/"),
  );
  const storybook =
    storybookDep !== undefined || files.some((file) => file.startsWith(".storybook/"));
  if (storybook) note("storybook=true", storybookDep ? source(storybookDep) : ".storybook");

  const playwrightResolvable =
    resolver.resolvable(fs.root, "@playwright/test") || resolver.resolvable(fs.root, "playwright");
  if (playwrightResolvable) note("playwrightResolvable=true", "resolve:playwright");
  const axeResolvable = resolver.resolvable(fs.root, "axe-core");
  if (axeResolvable) note("axeResolvable=true", "resolve:axe-core");

  const sourceRoots = detectSourceRoots(files);
  for (const root of sourceRoots) note(`sourceRoot=${root}`, `dir:${root}`);

  const rawScripts = isRecord(manifest?.scripts)
    ? Object.fromEntries(
        Object.entries(manifest.scripts).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
  const scripts = matchedScripts(rawScripts);
  for (const name of Object.keys(scripts)) note(`script.${name}`, `package.json#scripts.${name}`);

  return {
    packageManager,
    monorepo,
    typescript,
    framework,
    ...(frameworkVersion !== undefined ? { frameworkVersion } : {}),
    meta,
    styling,
    ...(tailwindMajor !== undefined ? { tailwindMajor } : {}),
    state,
    tests,
    storybook,
    playwrightResolvable,
    axeResolvable,
    sourceRoots,
    scripts,
    evidence,
  };
}

/** `src` when it holds sources; otherwise the conventional top-level directories that do. */
export function detectSourceRoots(files: readonly string[]): string[] {
  const holdsSources = (directory: string): boolean =>
    files.some((file) => file.startsWith(`${directory}/`) && SOURCE_EXTENSIONS.test(file));
  if (holdsSources("src")) return ["src"];
  return SOURCE_ROOT_CANDIDATES.filter(holdsSources);
}
