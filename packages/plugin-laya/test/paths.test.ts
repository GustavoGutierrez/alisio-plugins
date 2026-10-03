import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LayaConfigError } from "../src/errors.js";
import { assertContained, ensurePaths, resolvePaths } from "../src/paths.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-laya-paths-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolvePaths fallback (host without api.paths)", () => {
  const home = "/work/alice";

  it("uses ~/.config and ~/.local/state by default", () => {
    const paths = resolvePaths({ env: {}, home });
    expect(paths.source).toBe("fallback");
    expect(paths.config).toBe("/work/alice/.config/alisio/plugins/laya");
    expect(paths.state).toBe("/work/alice/.local/state/alisio/plugins/laya");
    expect(paths.cache).toBe(paths.state);
    expect(paths.runtime).toBe("/work/alice/.local/state/alisio/plugins/laya/runtime");
    expect(paths.hf).toBe(`${paths.runtime}/hf`);
    expect(paths.configFile).toBe("/work/alice/.config/alisio/plugins/laya/config.json");
  });

  it("honors XDG and ALISIO_* homes in that precedence", () => {
    const xdg = resolvePaths({
      env: { XDG_CONFIG_HOME: "/xdg/c", XDG_STATE_HOME: "/xdg/s" },
      home,
    });
    expect(xdg.config).toBe("/xdg/c/alisio/plugins/laya");
    expect(xdg.state).toBe("/xdg/s/alisio/plugins/laya");
    const explicit = resolvePaths({
      env: {
        ALISIO_CONFIG_HOME: "/a/c",
        ALISIO_STATE_HOME: "/a/s",
        XDG_CONFIG_HOME: "/xdg/c",
        XDG_STATE_HOME: "/xdg/s",
      },
      home,
    });
    expect(explicit.config).toBe("/a/c/plugins/laya");
    expect(explicit.state).toBe("/a/s/plugins/laya");
  });

  it("lets ALISIO_LAYA_HOME override the runtime root", () => {
    const paths = resolvePaths({ env: { ALISIO_LAYA_HOME: "/data/laya-runtime" }, home });
    expect(paths.runtime).toBe("/data/laya-runtime");
    expect(paths.hf).toBe("/data/laya-runtime/hf");
  });

  it("rejects relative or NUL-containing overrides", () => {
    expect(() => resolvePaths({ env: { ALISIO_LAYA_HOME: "relative/dir" }, home })).toThrow(
      LayaConfigError,
    );
    expect(() => resolvePaths({ env: { ALISIO_CONFIG_HOME: "rel" }, home })).toThrow(
      LayaConfigError,
    );
    expect(() => resolvePaths({ env: { ALISIO_STATE_HOME: "/a\0b" }, home })).toThrow(
      LayaConfigError,
    );
  });
});

describe("resolvePaths with api.paths", () => {
  it("uses the host values as-is, without appending another laya segment", () => {
    const paths = resolvePaths({
      apiPaths: {
        state: "/h/state/plugins/laya",
        config: "/h/config/plugins/laya",
        cache: "/h/cache/plugins/laya",
      },
      env: {},
      home: "/work/alice",
    });
    expect(paths.source).toBe("host");
    expect(paths.config).toBe("/h/config/plugins/laya");
    expect(paths.state).toBe("/h/state/plugins/laya");
    expect(paths.runtime).toBe("/h/state/plugins/laya/runtime");
    expect(paths.hf).toBe("/h/cache/plugins/laya/hf");
    expect(paths.configFile).toBe("/h/config/plugins/laya/config.json");
    expect(`${paths.runtime}${paths.configFile}`).not.toContain("laya/laya");
  });

  it("keeps the model cache under runtime when cache equals state", () => {
    const paths = resolvePaths({
      apiPaths: { state: "/h/p", config: "/h/c", cache: "/h/p" },
      env: {},
      home: "/x",
    });
    expect(paths.hf).toBe("/h/p/runtime/hf");
  });

  it("rejects a malformed api.paths and falls back never silently", () => {
    expect(() =>
      resolvePaths({
        apiPaths: { state: "relative", config: "/c", cache: "/s" },
        env: {},
        home: "/x",
      }),
    ).toThrow(LayaConfigError);
  });
});

describe("ensurePaths", () => {
  it("creates the directories with mode 0700", async () => {
    const paths = resolvePaths({
      apiPaths: { state: join(dir, "s"), config: join(dir, "c"), cache: join(dir, "k") },
      env: {},
      home: dir,
    });
    await ensurePaths(paths);
    for (const p of [paths.config, paths.state, paths.runtime]) {
      expect((await stat(p)).mode & 0o777).toBe(0o700);
    }
  });
});

describe("assertContained", () => {
  it("accepts paths inside the root, including not-yet-existing ones", async () => {
    await mkdir(join(dir, "root"));
    await expect(
      assertContained(join(dir, "root"), join(dir, "root", "venv", "bin")),
    ).resolves.toBe(join(dir, "root", "venv", "bin"));
  });

  it("rejects traversal and siblings", async () => {
    await mkdir(join(dir, "root"));
    await mkdir(join(dir, "root-evil"));
    await expect(assertContained(join(dir, "root"), join(dir, "root", "..", "x"))).rejects.toThrow(
      LayaConfigError,
    );
    await expect(assertContained(join(dir, "root"), join(dir, "root-evil"))).rejects.toThrow(
      LayaConfigError,
    );
    await expect(assertContained(join(dir, "root"), join(dir, "elsewhere"))).rejects.toThrow(
      LayaConfigError,
    );
  });

  it("rejects a symlink inside the root that escapes it", async () => {
    await mkdir(join(dir, "root"));
    await mkdir(join(dir, "outside"));
    await symlink(join(dir, "outside"), join(dir, "root", "link"));
    await expect(
      assertContained(join(dir, "root"), join(dir, "root", "link", "file")),
    ).rejects.toThrow(LayaConfigError);
  });

  it("rejects a target that is itself a symlink when asked", async () => {
    await mkdir(join(dir, "root"));
    await mkdir(join(dir, "outside"));
    await symlink(join(dir, "outside"), join(dir, "root", "link"));
    await expect(
      assertContained(join(dir, "root"), join(dir, "root", "link"), { forbidSymlink: true }),
    ).rejects.toThrow(LayaConfigError);
  });
});
