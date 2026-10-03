import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../src/runtime/env.js";

const base = {
  host: {
    PATH: "/should/not/leak",
    HOME: "/work/alice",
    TMPDIR: "/tmp",
    OPENAI_API_KEY: "sk-leak",
    ANTHROPIC_API_KEY: "sk-leak2",
    GITHUB_TOKEN: "ghp_leak",
    PIP_INDEX_URL: "https://evil.example",
    PYTHONPATH: "/evil",
    HF_TOKEN: "hf_leak",
    LAYA_HOST: "0.0.0.0",
  },
  port: 4242,
  token: "t".repeat(64),
  config: { device: "auto", model: "multilingual", preload: true } as const,
  hfHome: "/rt/hf",
  runtimeDir: "/rt",
  venvBin: "/rt/venv/bin",
  digests: '{"multilingual":{"model.safetensors":"abc"}}',
  cpus: 8,
  platform: "linux" as NodeJS.Platform,
};

describe("buildChildEnv", () => {
  it("is an allowlist: no inherited secrets or pip/python/hf tokens", () => {
    const env = buildChildEnv(base);
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GITHUB_TOKEN",
      "PIP_INDEX_URL",
      "PYTHONPATH",
      "HF_TOKEN",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
    expect(JSON.stringify(env)).not.toContain("leak");
    expect(env.PATH).not.toContain("/should/not/leak");
    expect(env.PATH?.startsWith("/rt/venv/bin")).toBe(true);
  });

  it("forces loopback, the port, the bearer token and offline flags", () => {
    const env = buildChildEnv(base);
    expect(env.LAYA_HOST).toBe("127.0.0.1");
    expect(env.LAYA_PORT).toBe("4242");
    expect(env.LAYA_API_KEY).toBe(base.token);
    expect(env.HF_HUB_OFFLINE).toBe("1");
    expect(env.TRANSFORMERS_OFFLINE).toBe("1");
    expect(env.HF_HOME).toBe("/rt/hf");
    expect(env.HF_HUB_DISABLE_TELEMETRY).toBe("1");
    expect(env.DO_NOT_TRACK).toBe("1");
    expect(env.PYTHONNOUSERSITE).toBe("1");
    expect(env.PYTHONUNBUFFERED).toBe("1");
    expect(env.LAYA_PRELOAD).toBe("1");
    expect(env.LAYA_AUTO_TASK).toBe("0");
    expect(env.LAYA_REVISION).toBe("reviewed");
    expect(env.LAYA_SHA256_DIGESTS).toBe(base.digests);
    expect(env.HOME).toBe("/work/alice");
    expect(env.TMPDIR).toBe("/tmp");
  });

  it("passes only the configured checkpoint(s) and a default model", () => {
    expect(buildChildEnv(base).LAYA_MODELS).toBe("multilingual");
    expect(buildChildEnv(base).LAYA_DEFAULT_MODEL).toBe("multilingual");
    expect(buildChildEnv(base).LAYA_MAX_LOADED).toBe("1");
    const auto = buildChildEnv({ ...base, config: { ...base.config, model: "auto" } });
    expect(auto.LAYA_MODELS).toBe("english,multilingual");
    expect(auto.LAYA_DEFAULT_MODEL).toBeUndefined();
    expect(auto.LAYA_MAX_LOADED).toBe("2");
  });

  it("sets LAYA_DEVICE only when not auto", () => {
    expect(buildChildEnv(base)).not.toHaveProperty("LAYA_DEVICE");
    expect(buildChildEnv({ ...base, config: { ...base.config, device: "cuda" } }).LAYA_DEVICE).toBe(
      "cuda",
    );
  });

  it("derives threads from the CPU count within [1, 4]", () => {
    expect(buildChildEnv({ ...base, cpus: 1 }).LAYA_THREADS).toBe("1");
    expect(buildChildEnv({ ...base, cpus: 4 }).LAYA_THREADS).toBe("2");
    expect(buildChildEnv({ ...base, cpus: 64 }).LAYA_THREADS).toBe("4");
  });

  it("always preloads in the child (the plugin decides when to start it)", () => {
    expect(
      buildChildEnv({ ...base, config: { ...base.config, preload: false } }).LAYA_PRELOAD,
    ).toBe("1");
  });

  it("keeps Windows system variables on win32", () => {
    const env = buildChildEnv({
      ...base,
      platform: "win32",
      host: { SYSTEMROOT: "C:\\Windows", USERPROFILE: "C:\\Profiles\\x", PATH: "leak" },
    });
    expect(env.SYSTEMROOT).toBe("C:\\Windows");
    expect(env.USERPROFILE).toBe("C:\\Profiles\\x");
    expect(env.PATH).not.toContain("leak");
  });
});
