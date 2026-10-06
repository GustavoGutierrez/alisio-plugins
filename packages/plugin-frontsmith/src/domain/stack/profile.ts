/** What the workspace is made of (spec 15.1). Pure data: detection lives in the application layer. */
export const packageManagers = ["pnpm", "yarn", "bun", "npm"] as const;
export type PackageManager = (typeof packageManagers)[number];

export const frameworks = [
  "angular",
  "react",
  "vue",
  "svelte",
  "solid",
  "preact",
  "astro",
  "none",
] as const;
export type Framework = (typeof frameworks)[number];

export const metaFrameworks = [
  "next",
  "nuxt",
  "sveltekit",
  "remix",
  "astro",
  "angular",
  "none",
] as const;
export type MetaFramework = (typeof metaFrameworks)[number];

export interface StackEvidence {
  fact: string;
  source: string;
}

export interface StackProfile {
  packageManager: PackageManager;
  monorepo: boolean;
  typescript: boolean;
  framework: Framework;
  /** Installed version, or the declared range followed by ` (declared)`. */
  frameworkVersion?: string;
  meta: MetaFramework;
  /** `tailwind`, `css-modules`, `css-in-js`, `vanilla-extract`, `scss`, `less`, `css`. */
  styling: string[];
  tailwindMajor?: number;
  state: string[];
  tests: string[];
  storybook: boolean;
  playwrightResolvable: boolean;
  axeResolvable: boolean;
  sourceRoots: string[];
  /** Package scripts matched to the command names `typecheck`, `lint`, `test`, `e2e`, `build`. */
  scripts: Record<string, string>;
  evidence: StackEvidence[];
}
