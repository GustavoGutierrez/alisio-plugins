import { readdir, readFile, writeFile } from "node:fs/promises";

const packagesDir = new URL("../packages/", import.meta.url);
for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = new URL(`${entry.name}/`, packagesDir);
  const manifest = JSON.parse(await readFile(new URL("package.json", dir), "utf8"));
  if (!/^@alisio\/plugin-/.test(manifest.name)) continue;
  const source = new URL("src/version.ts", dir);
  await writeFile(
    source,
    `// Updated by scripts/sync-versions.mjs.\nexport const VERSION = "${manifest.version}";\n`,
  );
  console.log(`${manifest.name}: ${manifest.version}`);
}
