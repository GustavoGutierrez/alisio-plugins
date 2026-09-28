#!/usr/bin/env node
/**
 * Verify every publishable package's metadata, build outputs, and registered
 * resources before release. Runs through `pnpm pack:check`; pass a single
 * package name as the first argument to check just that package.
 *
 * RESOURCE POLICY. A plugin with no skill or agent resources at all is VALID.
 * AGENTS.md requires package-local `.agents/agents` definitions and
 * `.agents/skills` contracts only for "substantial methodology plugins"; every
 * other package still needs a description, README, LICENSE, and built
 * JavaScript/declarations. This check therefore does NOT require Wayfinder's
 * shape: it discovers the resources each package actually ships from its
 * working tree and asserts the packed tarball contains those exact files. A
 * resource-less package logs an informational line instead of failing.
 *
 * WHY DISCOVERY INSTEAD OF CONSTANTS. Hardcoding Wayfinder's ten agents and
 * eleven skills made `pnpm check` reject any new plugin with a different agent
 * or skill set, which defeats the purpose of the monorepo. Reading the working
 * tree keeps the real guarantee -- everything authored is packed -- without
 * coupling the check to one plugin.
 *
 * STRUCTURAL VALIDATION. Every discovered skill and agent is validated against
 * the intrinsic, plugin-independent contract: a skill needs a non-empty `name`
 * and a `description` beginning with `Trigger:` and at most 250 characters; an
 * agent needs a non-empty `name` and `description`. This uses a small local
 * frontmatter reader instead of a new dependency.
 *
 * DEEP ROLE CHECK. A package opts into the loader contract in its SOURCE tree:
 * `src/resources.ts`. When that source exists, the packed tarball MUST contain
 * `package/dist/resources.js` exporting `loadRoleInstructions`, and the check
 * runs it for every agent the package declares, preserving Wayfinder's stricter
 * role/agent/skill validation. Keying the requirement on the artifact being
 * validated would let a missing build output pass as "not applicable"; keying
 * on the source tree fails loudly instead. When no `src/resources.ts` exists the
 * step is skipped and reported as not applicable: a package is never required
 * to implement another plugin's private API.
 *
 * PACKAGE METADATA. AGENTS.md requires `repository`, `homepage`, and `bugs` in
 * every publishable package. The check asserts all three exist, that
 * `repository.url` points at this monorepo, and that `repository.directory`
 * matches the package's own directory.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

const selected = process.argv[2];
const REPOSITORY_URL = "https://github.com/GustavoGutierrez/alisio-plugins";
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

/** Every file under a directory, as forward-slash paths relative to it. */
const collectFiles = async (root, prefix = "") => {
  if (!(await exists(root))) return [];
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(join(root, entry.name), relative)));
    } else {
      out.push(relative);
    }
  }
  return out;
};

/**
 * Read the top-level scalar keys of a resource's YAML frontmatter. Nested
 * mapping lines (indented) are ignored because the intrinsic contract only
 * looks at `name` and `description`. Throws with the file label when the
 * frontmatter block is missing.
 */
const readFrontmatter = (source, label) => {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) throw new Error(`missing frontmatter: ${label}`);
  const fields = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const entry = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (entry) fields[entry[1]] = entry[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return fields;
};

const validateSkill = (front, label) => {
  if (!front.name) throw new Error(`skill is missing a non-empty name: ${label}`);
  if (!front.description) throw new Error(`skill is missing a description: ${label}`);
  if (!front.description.startsWith("Trigger:"))
    throw new Error(`skill description must start with "Trigger:": ${label}`);
  if (front.description.length > 250)
    throw new Error(
      `skill description exceeds 250 characters (${front.description.length}): ${label}`,
    );
};

const validateAgent = (front, label) => {
  if (!front.name) throw new Error(`agent is missing a non-empty name: ${label}`);
  if (!front.description) throw new Error(`agent is missing a description: ${label}`);
};

for (const [dir, manifest] of packageDirs) {
  const fail = (message) => {
    throw new Error(`${manifest.name}: ${message}`);
  };
  if (!/^@alisio\/plugin-[a-z0-9][a-z0-9-]*$/.test(manifest.name)) fail("invalid package name");
  if (!manifest.keywords?.includes("alisio-plugin")) fail("missing alisio-plugin keyword");
  if (manifest.type !== "module") fail("must be ESM");
  if (manifest.engines?.node !== ">=22.16") fail("engines.node must be >=22.16");
  if (!manifest.description?.trim()) fail("missing description");

  // AGENTS.md requires repository, homepage, and bugs in every publishable package.
  if (!manifest.repository?.url) fail("missing repository.url metadata");
  if (!manifest.homepage?.trim()) fail("missing homepage metadata");
  if (!manifest.bugs?.url) fail("missing bugs.url metadata");
  const repoUrl = manifest.repository.url
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (repoUrl !== REPOSITORY_URL)
    fail(`repository.url must point at ${REPOSITORY_URL} (got ${manifest.repository.url})`);
  const expectedDirectory = relative(process.cwd(), dir).split(sep).join("/");
  if (manifest.repository.directory !== expectedDirectory)
    fail(
      `repository.directory must be ${expectedDirectory} (got ${manifest.repository.directory})`,
    );

  if (!manifest.files?.includes("dist")) fail("files must include dist");
  if (
    manifest.exports?.["."]?.import !== "./dist/index.js" ||
    manifest.exports?.["."]?.types !== "./dist/index.d.ts"
  )
    fail("invalid exports");
  for (const path of ["README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"]) {
    if (!(await exists(join(dir, path)))) fail(`missing ${path}`);
  }

  // Discover the resources this package actually ships, from the working tree.
  const agentFiles = (await collectFiles(join(dir, ".agents", "agents")))
    .filter((file) => file.endsWith(".md"))
    .sort();
  const skillFiles = [];
  const skillsRoot = join(dir, ".agents", "skills");
  if (await exists(skillsRoot)) {
    for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (await exists(join(skillsRoot, entry.name, "SKILL.md")))
        skillFiles.push(`.agents/skills/${entry.name}/SKILL.md`);
    }
    skillFiles.sort();
  }
  const registeredSkills = (await collectFiles(join(dir, "resources")))
    .filter((file) => file.endsWith("SKILL.md"))
    .map((file) => `resources/${file}`)
    .sort();
  const resourceFiles = [
    ...agentFiles.map((file) => `.agents/agents/${file}`),
    ...skillFiles,
    ...registeredSkills,
  ];

  // Validate the intrinsic contract of every discovered resource.
  const validateResource = async (label, validate) => {
    try {
      validate(readFrontmatter(await readFile(join(dir, label), "utf8"), label), label);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  };
  for (const file of agentFiles) await validateResource(`.agents/agents/${file}`, validateAgent);
  for (const label of [...skillFiles, ...registeredSkills])
    await validateResource(label, validateSkill);

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
    for (const relative of resourceFiles) {
      const packedPath = `package/${relative}`;
      if (!files.includes(packedPath)) fail(`packed tarball missing ${packedPath}`);
    }
    if (resourceFiles.length === 0)
      console.log(
        `INFO ${manifest.name}: no skill or agent resources declared; resource-less plugins are valid`,
      );
    if (
      (await exists(join(dir, "src", "version.ts"))) &&
      !files.includes("package/dist/version.js")
    )
      fail("src/version.ts exists but packed tarball is missing package/dist/version.js");

    // The loader contract is opted into in the SOURCE tree. Keying the
    // requirement on src/resources.ts, not on the packed artifact, means a
    // package that should be deep-checked but is missing its build output fails
    // here instead of passing as "not applicable".
    const hasResourcesSource = await exists(join(dir, "src", "resources.ts"));
    if (hasResourcesSource && !files.includes("package/dist/resources.js"))
      fail("src/resources.ts exists but packed tarball is missing package/dist/resources.js");

    const unpacked = join(temp, "unpacked");
    await mkdir(unpacked);
    const extract = spawnSync("tar", ["-xf", archive, "-C", unpacked], { encoding: "utf8" });
    if (extract.status !== 0) fail(`cannot extract tarball: ${extract.stderr.trim()}`);

    let deepChecked = false;
    if (hasResourcesSource) {
      const resourcesModule = join(unpacked, "package/dist/resources.js");
      const module = await import(resourcesModule);
      if (typeof module.loadRoleInstructions !== "function")
        fail(
          "src/resources.ts exists but package/dist/resources.js does not export loadRoleInstructions",
        );
      for (const file of agentFiles) {
        await module.loadRoleInstructions(file.replace(/\.md$/, ""));
      }
      deepChecked = true;
    }
    if (!deepChecked)
      console.log(
        `INFO ${manifest.name}: no src/resources.ts; loadRoleInstructions deep check not applicable`,
      );

    const assetsDir = join(dir, "assets");
    if (await exists(assetsDir)) {
      for (const relative of (await collectFiles(assetsDir)).filter((file) =>
        file.endsWith(".svg"),
      )) {
        const packedPath = `package/assets/${relative}`;
        if (!files.includes(packedPath)) fail(`packed tarball missing ${packedPath}`);
      }
    }
    console.log(`OK ${manifest.name}@${manifest.version}`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
