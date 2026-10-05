import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitWorktreeIsolation } from "../src/adapters/git-worktree.js";
import { Forge } from "../src/app/forge.js";
import { gitIn, ScriptedRunner, tempDir } from "./helpers.js";

async function makeForge(
  options: { workspace?: string; cloneUrl?: (repo: string) => string } = {},
) {
  const workspace = options.workspace ?? (await tempDir());
  const runner = new ScriptedRunner();
  const forge = new Forge({
    workspace,
    isolation: new GitWorktreeIsolation(),
    runner,
    autoStart: false,
    ...(options.cloneUrl ? { cloneUrl: options.cloneUrl } : {}),
  });
  return { workspace, runner, forge };
}

describe("Forge.init", () => {
  it("creates the forge layout and is idempotent", async () => {
    const { workspace, forge } = await makeForge();
    expect(await forge.init()).toEqual({ created: true });
    expect(existsSync(join(workspace, ".alisio", "swarm", "projects"))).toBe(true);
    expect(existsSync(join(workspace, ".alisio", "swarm", "packs"))).toBe(true);
    const state = JSON.parse(
      await readFile(join(workspace, ".alisio", "swarm", "forge.json"), "utf8"),
    );
    expect(state).toEqual({ schemaVersion: 1, projects: [] });
    expect(await forge.init()).toEqual({ created: false });
  });

  it("ignores its state in the workspace .gitignore when the workspace is a repository", async () => {
    const { workspace, forge } = await makeForge();
    gitIn(workspace, "init", "--initial-branch=master");
    await forge.init();
    await forge.init();
    const ignore = await readFile(join(workspace, ".gitignore"), "utf8");
    expect(ignore.match(/\.alisio\/swarm\//g)).toHaveLength(1);
  });

  it("leaves a workspace that is not a repository alone", async () => {
    const { workspace, forge } = await makeForge();
    await forge.init();
    expect(existsSync(join(workspace, ".gitignore"))).toBe(false);
  });

  it("refuses to run commands before init", async () => {
    const { forge } = await makeForge();
    await expect(forge.listProjects()).rejects.toThrow(/init/i);
  });
});

describe("packs", () => {
  it("lists shipped packs and workspace-local packs", async () => {
    const { workspace, forge } = await makeForge();
    await forge.init();
    await writeFile(
      join(workspace, ".alisio", "swarm", "packs", "mine.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "mine",
        description: "Mine",
        toolchain: "node-ts",
        roles: [
          {
            id: "solo",
            agent: "coder",
            isolation: "master",
            receive: "task",
            propagation: "forward-only",
          },
        ],
      }),
    );
    await writeFile(join(workspace, ".alisio", "swarm", "packs", "broken.json"), "{nope");
    const packs = await forge.listPacks();
    expect(packs.map((p) => `${p.name}:${p.source}`)).toEqual([
      "four-pack:shipped",
      "mine:workspace",
      "six-pack:shipped",
      "two-pack:shipped",
    ]);
    expect(packs.find((p) => p.name === "two-pack")?.roles).toEqual(["coder", "cleaner"]);
    expect((await forge.invalidPacks()).map((p) => p.file)).toEqual(["broken.json"]);
  });

  it("rejects hostile pack names", async () => {
    const { forge } = await makeForge();
    await forge.init();
    await expect(forge.loadPack("../two-pack")).rejects.toThrow(/pack name/i);
    await expect(forge.loadPack("nine-pack")).rejects.toThrow(/unknown pack/i);
  });
});

describe("projects", () => {
  it("creates a git project with its pack copy, mission and registry entry, and opens it", async () => {
    const { workspace, forge } = await makeForge();
    await forge.init();
    const runtime = await forge.newProject({ name: "demo", pack: "two-pack", mission: "Build it" });
    const dir = join(workspace, ".alisio", "swarm", "projects", "demo");
    expect(runtime.dir).toBe(dir);
    expect(gitIn(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("master");
    expect(await readFile(join(dir, ".alisio", "swarm", "mission.md"), "utf8")).toContain(
      "Build it",
    );
    expect(
      JSON.parse(await readFile(join(dir, ".alisio", "swarm", "pack.json"), "utf8")).name,
    ).toBe("two-pack");
    expect(existsSync(join(dir, ".worktrees", "cleaner"))).toBe(true);
    expect(await forge.listProjects()).toEqual([
      { name: "demo", pack: "two-pack", open: true, running: true },
    ]);
    const state = JSON.parse(
      await readFile(join(workspace, ".alisio", "swarm", "forge.json"), "utf8"),
    );
    expect(state.projects).toMatchObject([{ name: "demo", pack: "two-pack", open: true }]);
  });

  it("validates names, packs and mission", async () => {
    const { forge } = await makeForge();
    await forge.init();
    await expect(
      forge.newProject({ name: "Bad Name", pack: "two-pack", mission: "m" }),
    ).rejects.toThrow(/project name/i);
    await expect(
      forge.newProject({ name: "demo", pack: "nine-pack", mission: "m" }),
    ).rejects.toThrow(/unknown pack/i);
    await expect(
      forge.newProject({ name: "demo", pack: "two-pack", mission: "  " }),
    ).rejects.toThrow(/mission/i);
  });

  it("refuses a duplicate project and an occupied directory", async () => {
    const { workspace, forge } = await makeForge();
    await forge.init();
    await forge.newProject({ name: "demo", pack: "two-pack", mission: "m" });
    await expect(
      forge.newProject({ name: "demo", pack: "two-pack", mission: "m" }),
    ).rejects.toThrow(/already exists/i);
    await mkdir(join(workspace, ".alisio", "swarm", "projects", "taken"), { recursive: true });
    await expect(
      forge.newProject({ name: "taken", pack: "two-pack", mission: "m" }),
    ).rejects.toThrow(/already exists/i);
  });

  it("refuses a project directory that escapes through a symlink", async () => {
    const { workspace, forge } = await makeForge();
    await forge.init();
    const outside = await tempDir();
    await symlink(outside, join(workspace, ".alisio", "swarm", "projects", "sneaky"));
    await expect(
      forge.newProject({ name: "sneaky", pack: "two-pack", mission: "m" }),
    ).rejects.toThrow(/already exists|symlink/i);
  });

  it("closes and reopens a project, keeping its state", async () => {
    const { forge } = await makeForge();
    await forge.init();
    const first = await forge.newProject({ name: "demo", pack: "two-pack", mission: "m" });
    await first.newTask("Remember me");
    await forge.closeProject("demo");
    expect(forge.runtime("demo")).toBeUndefined();
    expect(await forge.listProjects()).toMatchObject([
      { name: "demo", open: false, running: false },
    ]);
    const again = await forge.openProject("demo");
    expect(again.board().tasks.map((t) => t.name)).toEqual(["remember-me"]);
    expect(await forge.openProject("demo")).toBe(again);
  });

  it("rejects opening or closing an unknown project", async () => {
    const { forge } = await makeForge();
    await forge.init();
    await expect(forge.openProject("ghost")).rejects.toThrow(/unknown project/i);
    await expect(forge.closeProject("ghost")).rejects.toThrow(/unknown project/i);
    await expect(forge.openProject("../x")).rejects.toThrow(/project name/i);
  });

  it("uses a workspace-local pack and keeps an editable copy per project", async () => {
    const { workspace, forge } = await makeForge();
    await forge.init();
    await writeFile(
      join(workspace, ".alisio", "swarm", "packs", "mine.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "mine",
        description: "Mine",
        toolchain: "node-ts",
        roles: [
          {
            id: "solo",
            agent: "coder",
            isolation: "master",
            receive: "task",
            propagation: "forward-only",
          },
        ],
      }),
    );
    const runtime = await forge.newProject({ name: "demo", pack: "mine", mission: "m" });
    expect(runtime.pack.roles.map((r) => r.id)).toEqual(["solo"]);
    const copy = join(runtime.dir, ".alisio", "swarm", "pack.json");
    const edited = JSON.parse(await readFile(copy, "utf8"));
    edited.limits = { maxBounces: 1 };
    await writeFile(copy, JSON.stringify(edited));
    await forge.closeProject("demo");
    expect((await forge.openProject("demo")).pack.limits.maxBounces).toBe(1);
  });

  it("clones a GitHub repository through an injected URL builder", async () => {
    const source = await tempDir();
    gitIn(source, "init", "--initial-branch=master");
    await writeFile(join(source, "README.md"), "hello\n");
    gitIn(source, "add", "README.md");
    gitIn(source, "commit", "-m", "init");
    const seen: string[] = [];
    const { workspace, forge } = await makeForge({
      cloneUrl: (repo) => {
        seen.push(repo);
        return source;
      },
    });
    await forge.init();
    const runtime = await forge.newProject({
      name: "cloned",
      pack: "two-pack",
      mission: "m",
      github: "owner/repo",
    });
    expect(seen).toEqual(["owner/repo"]);
    expect(await readFile(join(runtime.dir, "README.md"), "utf8")).toBe("hello\n");
    expect(
      existsSync(
        join(workspace, ".alisio", "swarm", "projects", "cloned", ".worktrees", "cleaner"),
      ),
    ).toBe(true);
  });

  it("rejects malformed GitHub repositories before touching the network", async () => {
    const { forge } = await makeForge({
      cloneUrl: () => {
        throw new Error("must not be called");
      },
    });
    await forge.init();
    for (const bad of ["owner", "a/b/c", "../x", "o/r;rm", "-o/r", "o/ r"]) {
      await expect(
        forge.newProject({ name: "demo", pack: "two-pack", mission: "m", github: bad }),
      ).rejects.toThrow(/github/i);
    }
  });

  it("stops every pump on stopAll", async () => {
    const { forge, runner } = await makeForge();
    await forge.init();
    await forge.newProject({ name: "demo", pack: "two-pack", mission: "m" });
    await forge.stopAll();
    expect(runner.cancelled).toEqual(["demo"]);
    expect(forge.runtime("demo")).toBeUndefined();
  });
});

describe("tasks", () => {
  it("derives a slug, avoids collisions and honours an explicit name", async () => {
    const { forge } = await makeForge();
    await forge.init();
    const runtime = await forge.newProject({ name: "demo", pack: "two-pack", mission: "m" });
    expect((await runtime.newTask("Add Login Form!\nwith more detail")).name).toBe(
      "add-login-form",
    );
    expect((await runtime.newTask("Add Login Form!")).name).toBe("add-login-form-2");
    expect((await runtime.newTask("Anything", "my-name")).name).toBe("my-name");
    await expect(runtime.newTask("Again", "my-name")).rejects.toThrow(/already exists/i);
    await expect(runtime.newTask("x", "Bad Name")).rejects.toThrow(/task name/i);
  });

  it("rejects empty or unusable task text and oversized text", async () => {
    const { forge } = await makeForge();
    await forge.init();
    const runtime = await forge.newProject({ name: "demo", pack: "two-pack", mission: "m" });
    await expect(runtime.newTask("   ")).rejects.toThrow(/task text/i);
    await expect(runtime.newTask("***")).rejects.toThrow(/name/i);
    await expect(runtime.newTask("x".repeat(9000))).rejects.toThrow(/too long/i);
  });

  it("gives every task a unique valid id even within one millisecond", async () => {
    const { forge } = await makeForge();
    await forge.init();
    const runtime = await forge.newProject({ name: "demo", pack: "two-pack", mission: "m" });
    const cards = await Promise.all(["a", "b", "c", "d"].map((t) => runtime.newTask(`Task ${t}`)));
    expect(new Set(cards.map((c) => c.taskId)).size).toBe(4);
  });
});
