// Maintainer script (needs the network): regenerates the committed lockfile of every preset with
// the npm version Lumbre ships, without running any package script. Run after changing a pinned
// version in src/presets.ts, then build: `pnpm build && node scripts/update-preset-locks.mjs`.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { allowlistFor, ASTRO_REACT, LOCK_KEYS, packageJson, stack } = await import(
  "../dist/presets.js"
);
const require = createRequire(import.meta.url);
const npm = join(dirname(require.resolve("npm/package.json")), "bin/npm-cli.js");

// `--check-extras`: resolve each stack WITH its whole allowlist (nothing is written) to prove that
// every allowed package fits the preset's peer ranges.
const checkExtras = process.argv.includes("--check-extras");
for (const key of LOCK_KEYS) {
  const s = key === "vanilla-tailwind" ? stack("vanilla", true) : stack(key);
  if (checkExtras) {
    const dir = await mkdtemp(join(tmpdir(), `lumbre-extras-${key}-`));
    try {
      // Astro is checked with React islands on, i.e. its widest allowlist.
      const all = allowlistFor(s, key === "astro" ? { ...ASTRO_REACT } : {});
      await writeFile(join(dir, "package.json"), packageJson(s, all));
      const run = spawnSync(
        process.execPath,
        [
          npm,
          "install",
          "--package-lock-only",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--strict-peer-deps",
        ],
        { cwd: dir, stdio: "inherit" },
      );
      if (run.status !== 0) throw new Error(`extras do not resolve for ${key}`);
      console.log(`${key}: ${Object.keys(all).length} extra packages resolve`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    continue;
  }
  const dir = await mkdtemp(join(tmpdir(), `lumbre-lock-${key}-`));
  try {
    await writeFile(join(dir, "package.json"), packageJson(s));
    const run = spawnSync(
      process.execPath,
      [npm, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd: dir, stdio: "inherit" },
    );
    if (run.status !== 0) throw new Error(`npm failed for ${key}`);
    const out = new URL(`../presets/${key}/`, import.meta.url);
    await mkdir(out, { recursive: true });
    await writeFile(
      new URL("package-lock.json", out),
      await readFile(join(dir, "package-lock.json")),
    );
    console.log(`presets/${key}/package-lock.json`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
