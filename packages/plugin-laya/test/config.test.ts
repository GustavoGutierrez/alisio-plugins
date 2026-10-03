import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  loadConfigFile,
  resolveConfig,
  saveConfigFile,
  validateLayer,
} from "../src/config.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-laya-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("defaults", () => {
  it("defaults to multilingual with preload on and automatic device", () => {
    expect(DEFAULT_CONFIG).toEqual({ device: "auto", model: "multilingual", preload: true });
    const resolved = resolveConfig({ env: {} });
    expect(resolved.config).toEqual(DEFAULT_CONFIG);
    expect(resolved.errors).toEqual([]);
    expect(resolved.sources).toEqual({ device: "default", model: "default", preload: "default" });
  });
});

describe("precedence: env > host options > file > default", () => {
  it("applies each layer per key and records the source", () => {
    const resolved = resolveConfig({
      env: { ALISIO_LAYA_DEVICE: "cuda" },
      hostOptions: { device: "cpu", model: "english" },
      file: { version: 1, device: "mps", model: "typed-decisions", preload: false },
    });
    expect(resolved.config).toEqual({ device: "cuda", model: "english", preload: false });
    expect(resolved.sources).toEqual({ device: "env", model: "host", preload: "file" });
    expect(resolved.errors).toEqual([]);
  });

  it("parses boolean env values", () => {
    for (const [raw, expected] of [
      ["1", true],
      ["true", true],
      ["YES", true],
      ["on", true],
      ["0", false],
      ["false", false],
      ["No", false],
      ["off", false],
    ] as const) {
      expect(resolveConfig({ env: { ALISIO_LAYA_PRELOAD: raw } }).config.preload).toBe(expected);
    }
  });
});

describe("strict validation", () => {
  it("rejects unknown keys, bad enums and wrong types with actionable messages", () => {
    const layer = validateLayer({ device: "tpu", model: 3, preload: "yes", extra: 1 }, "host");
    expect(layer.values).toEqual({});
    expect(layer.errors.join("\n")).toMatch(/device/);
    expect(layer.errors.join("\n")).toMatch(/model/);
    expect(layer.errors.join("\n")).toMatch(/preload/);
    expect(layer.errors.join("\n")).toMatch(/extra/);
  });

  it("does not expose xpu", () => {
    expect(validateLayer({ device: "xpu" }, "host").errors).not.toEqual([]);
  });

  it("rejects secret-shaped keys without echoing their value", () => {
    const layer = validateLayer({ apiKey: "sk-supersecretvalue", token: "abc" }, "file");
    expect(layer.errors.length).toBeGreaterThan(0);
    expect(layer.errors.join("\n")).not.toContain("supersecretvalue");
    expect(layer.errors.join("\n")).toMatch(/secret/i);
  });

  it("rejects a non-object layer", () => {
    expect(validateLayer("nope", "host").errors).not.toEqual([]);
    expect(validateLayer([], "host").errors).not.toEqual([]);
    expect(validateLayer(null, "host").errors).not.toEqual([]);
  });

  it("makes resolveConfig report errors while keeping defaults for invalid layers", () => {
    const resolved = resolveConfig({ env: { ALISIO_LAYA_DEVICE: "tpu" } });
    expect(resolved.errors.length).toBe(1);
    expect(resolved.config.device).toBe("auto");
  });

  it("rejects an unsupported higher file version", () => {
    const resolved = resolveConfig({ env: {}, file: { version: 2, device: "cpu" } });
    expect(resolved.errors.join("\n")).toMatch(/version/);
  });

  it("allows `version` only in the file layer", () => {
    expect(validateLayer({ version: 1 }, "host").errors).not.toEqual([]);
    expect(validateLayer({ version: 1 }, "file").errors).toEqual([]);
  });
});

describe("config file", () => {
  it("reports a missing file as absent, not an error", async () => {
    expect(await loadConfigFile(join(dir, "nope.json"))).toEqual({});
  });

  it("reports invalid JSON and oversized files as errors", async () => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{not json");
    expect((await loadConfigFile(bad)).error).toMatch(/JSON/);
    const big = join(dir, "big.json");
    await writeFile(big, JSON.stringify({ pad: "x".repeat(20000) }));
    expect((await loadConfigFile(big)).error).toMatch(/large/);
  });

  it("refuses to follow a symlink", async () => {
    const target = join(dir, "target.json");
    await writeFile(target, JSON.stringify({ version: 1 }));
    const link = join(dir, "link.json");
    await symlink(target, link);
    expect((await loadConfigFile(link)).error).toMatch(/symlink|regular/);
  });

  it("saves atomically with restrictive modes and round-trips", async () => {
    const path = join(dir, "nested", "laya", "config.json");
    await saveConfigFile(path, { device: "cpu", model: "english", preload: false });
    const text = await readFile(path, "utf8");
    expect(JSON.parse(text)).toEqual({
      version: 1,
      device: "cpu",
      model: "english",
      preload: false,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "nested", "laya"))).mode & 0o777).toBe(0o700);
    const loaded = await loadConfigFile(path);
    expect(loaded.raw).toEqual(JSON.parse(text));
  });

  it("leaves no temp files behind", async () => {
    const path = join(dir, "config.json");
    await saveConfigFile(path, DEFAULT_CONFIG);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(dir)).toEqual(["config.json"]);
  });
});
