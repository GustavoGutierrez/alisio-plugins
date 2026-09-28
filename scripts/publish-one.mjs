import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const [name, mode] = process.argv.slice(2);
if (!name || !/^@alisio\/plugin-[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error("Usage: pnpm publish-one -- @alisio/plugin-<name> [--publish]");
  process.exit(2);
}
if (mode && mode !== "--publish") {
  console.error(`Unknown option: ${mode}`);
  process.exit(2);
}
let selected;
for (const entry of await readdir("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = resolve("packages", entry.name);
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (manifest.name === name) selected = dir;
}
if (!selected) throw new Error(`Package not found: ${name}`);
const run = (args) => {
  const result = spawnSync("pnpm", args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(["--filter", name, "test"]);
run(["--filter", name, "build"]);
run(["pack:check", "--", name]);
if (mode === "--publish") {
  run(["--dir", selected, "publish", "--access", "public", "--no-git-checks"]);
} else {
  run(["--dir", selected, "publish", "--access", "public", "--dry-run", "--no-git-checks"]);
  console.log("Dry run only. Repeat with --publish after reviewing the output.");
}
