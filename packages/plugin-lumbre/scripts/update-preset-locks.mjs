// Maintainer script (needs the network): regenerates the committed lockfile of every preset with
// the npm version Lumbre ships, without running any package script. Run after changing a pinned
// version in src/presets.ts, then build: `pnpm build && node scripts/update-preset-locks.mjs`.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const { LOCK_KEYS, packageJson, stack } = await import("../dist/presets.js");
const require = createRequire(import.meta.url);
const npm = join(dirname(require.resolve("npm/package.json")), "bin/npm-cli.js");

for (const key of LOCK_KEYS) {
  const s = key === "vanilla-tailwind" ? stack("vanilla", true) : stack(key);
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
