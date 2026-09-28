import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const selected = process.argv[2];
const packageDirs = [];
for (const entry of await readdir("packages", { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = resolve("packages", entry.name);
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (!manifest.private && (!selected || manifest.name === selected))
    packageDirs.push([dir, manifest]);
}
if (selected && packageDirs.length !== 1)
  throw new Error(`Publishable package not found: ${selected}`);
if (packageDirs.length === 0) throw new Error("No publishable packages found");
const exists = async (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
for (const [dir, manifest] of packageDirs) {
  const fail = (message) => {
    throw new Error(`${manifest.name}: ${message}`);
  };
  if (!/^@alisio\/plugin-[a-z0-9][a-z0-9-]*$/.test(manifest.name)) fail("invalid package name");
  if (!manifest.keywords?.includes("alisio-plugin")) fail("missing alisio-plugin keyword");
  if (manifest.type !== "module") fail("must be ESM");
  if (manifest.engines?.node !== ">=22.16") fail("engines.node must be >=22.16");
  if (!manifest.description?.trim()) fail("missing description");
  if (!manifest.files?.includes("dist")) fail("files must include dist");
  if (!manifest.files?.includes("resources") && !manifest.files?.includes(".agents"))
    fail("files must include registered resources or .agents");
  if (
    manifest.exports?.["."]?.import !== "./dist/index.js" ||
    manifest.exports?.["."]?.types !== "./dist/index.d.ts"
  )
    fail("invalid exports");
  for (const path of ["README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
    if (!(await exists(join(dir, path)))) fail(`missing ${path}`);
  }
  const temp = await mkdtemp(join(tmpdir(), "alisio-pack-"));
  try {
    const packed = spawnSync("pnpm", ["--dir", dir, "pack", "--pack-destination", temp], {
      encoding: "utf8",
    });
    if (packed.status !== 0) fail(`pnpm pack failed: ${packed.stderr.trim()}`);
    const archive = join(temp, basename(packed.stdout.trim().split("\n").at(-1)));
    const listed = spawnSync("tar", ["-tf", archive], { encoding: "utf8" });
    if (listed.status !== 0) fail(`cannot inspect tarball: ${listed.stderr.trim()}`);
    const files = listed.stdout.split("\n");
    for (const required of [
      "package/README.md",
      "package/LICENSE",
      "package/dist/index.js",
      "package/dist/index.d.ts",
    ]) {
      if (!files.includes(required)) fail(`packed tarball missing ${required}`);
    }
    if (manifest.files.includes("resources")) {
      if (!files.some((file) => file.includes("/resources/") && file.endsWith("SKILL.md")))
        fail("packed tarball missing skill resources");
    }
    if (manifest.files.includes(".agents")) {
      const expectedAgents = [
        "coordinator",
        "discoverer",
        "proposer",
        "specifier",
        "designer",
        "planner",
        "implementer",
        "verifier",
        "mutationist",
        "archivist",
      ];
      const expectedSkills = [
        "wayfinder-coordinate",
        "wayfinder-discover",
        "wayfinder-propose",
        "wayfinder-specify",
        "wayfinder-design",
        "wayfinder-plan",
        "wayfinder-implement",
        "wayfinder-verify",
        "wayfinder-mutate",
        "wayfinder-archive",
        "wayfinder-test-design",
      ];
      for (const agent of expectedAgents) {
        if (!files.includes(`package/.agents/agents/${agent}.md`))
          fail(`packed tarball missing agent ${agent}`);
      }
      for (const skill of expectedSkills) {
        if (!files.includes(`package/.agents/skills/${skill}/SKILL.md`))
          fail(`packed tarball missing skill ${skill}`);
      }
      const unpacked = join(temp, "unpacked");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(unpacked));
      const extract = spawnSync("tar", ["-xf", archive, "-C", unpacked], { encoding: "utf8" });
      if (extract.status !== 0) fail(`cannot extract tarball: ${extract.stderr.trim()}`);
      const module = await import(join(unpacked, "package/dist/resources.js"));
      for (const role of expectedAgents) await module.loadRoleInstructions(role);
    }
    console.log(`OK ${manifest.name}@${manifest.version}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
