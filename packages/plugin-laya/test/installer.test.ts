import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type LayaConfig } from "../src/config.js";
import { layaServe, readInstalledRuntime } from "../src/runtime/install-state.js";
import {
  buildPlan,
  DOWNLOAD_SCRIPT,
  formatConsentText,
  InstallCancelled,
  InstallFailure,
  runInstall,
  uninstallRuntime,
} from "../src/runtime/installer.js";
import type { Manifest } from "../src/runtime/manifest.js";
import type { Runner, RunResult } from "../src/runtime/runner.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const FILES = {
  "model.safetensors": "weights-bytes",
  "encoder/config.json": "{}",
  "tokenizer/tokenizer.json": "tok",
};

function testManifest(): Manifest {
  return {
    schemaVersion: 1,
    laya: { version: "9.9.9", requirement: "laya[serve]==9.9.9", extra: "serve" },
    python: { minMajor: 3, minMinor: 10 },
    torch: { cpuIndexUrl: "https://example.test/whl/cpu" },
    hub: { repo: "owner/bundle", revision: "a".repeat(40) },
    hosts: ["pypi.org", "huggingface.co"],
    models: {
      multilingual: {
        subfolder: "multilingual",
        files: Object.entries(FILES).map(([path, text]) => ({
          path,
          size: text.length,
          sha256: sha(text),
        })),
      },
      english: {
        files: Object.entries(FILES).map(([path, text]) => ({
          path,
          size: text.length,
          sha256: sha(text),
        })),
      },
      "typed-decisions": {
        subfolder: "typed-decisions",
        files: Object.entries(FILES).map(([path, text]) => ({
          path,
          size: text.length,
          sha256: sha(text),
        })),
      },
    },
  };
}

let dir: string;
let runtimeDir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "alisio-laya-install-"));
  runtimeDir = join(dir, "runtime");
  await mkdir(runtimeDir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  file: string;
  args: string[];
  env: Record<string, string> | undefined;
}

function makeRunner(
  manifest: Manifest,
  override: (call: Call, index: number) => Partial<RunResult> | undefined = () => undefined,
  corrupt = false,
) {
  const calls: Call[] = [];
  const runner: Runner = {
    async run(file, args, options) {
      const call = { file, args, env: options?.env };
      const index = calls.push(call) - 1;
      const forced = override(call, index);
      if (forced) return { code: 0, stdout: "", stderr: "", aborted: false, ...forced };
      if (args[0] === "-m" && args[1] === "venv") {
        const target = args.at(-1) as string;
        await mkdir(dirname(layaServe(target)), { recursive: true });
        await writeFile(layaServe(target), "#!/bin/sh\n");
      }
      if (args[0] === "-c" && args[1] === DOWNLOAD_SCRIPT) {
        const [repo, revision, ...patterns] = args.slice(2);
        const hf = options?.env?.HF_HOME as string;
        const root = join(
          hf,
          "hub",
          `models--${(repo as string).replace("/", "--")}`,
          "snapshots",
          revision as string,
        );
        for (const pattern of patterns) {
          const rel = pattern.replace(/^(multilingual|typed-decisions)\//, "");
          const body = (FILES as Record<string, string>)[rel] ?? "";
          await mkdir(dirname(join(root, pattern)), { recursive: true });
          await writeFile(
            join(root, pattern),
            corrupt && rel === "model.safetensors" ? "tampered" : body,
          );
        }
      }
      return { code: 0, stdout: "", stderr: "", aborted: false };
    },
  };
  return { runner, calls, manifest };
}

const python = { ok: true as const, command: "python3", args: [], version: "3.12.1" };

function baseInput(over: Partial<Parameters<typeof runInstall>[0]> = {}) {
  const manifest = testManifest();
  const { runner, calls } = makeRunner(manifest);
  const steps: Array<[number, string]> = [];
  const smoke = vi.fn(async () => {});
  const input = {
    runtimeDir,
    hfHome: join(runtimeDir, "hf"),
    config: { ...DEFAULT_CONFIG } as LayaConfig,
    python,
    manifest,
    runner,
    smoke,
    platform: "linux" as NodeJS.Platform,
    hostEnv: {
      PATH: "/usr/bin",
      HOME: "/work/alice",
      PIP_INDEX_URL: "https://evil.example",
      PYTHONPATH: "/evil",
      HTTPS_PROXY: "http://proxy:3128",
      OPENAI_API_KEY: "sk-leak",
    },
    signal: new AbortController().signal,
    onStep: (n: number, name: string) => {
      steps.push([n, name]);
    },
    nvidia: false,
    now: () => new Date("2026-10-03T00:00:00Z"),
    ...over,
  };
  return { input, calls, steps, smoke, manifest };
}

describe("buildPlan and consent text", () => {
  it("plans a CPU install for the default multilingual config", () => {
    const plan = buildPlan({ config: DEFAULT_CONFIG, platform: "linux", nvidia: false });
    expect(plan.torch).toBe("cpu");
    expect(plan.models).toEqual(["multilingual"]);
    expect(plan.downloadBytes).toBeGreaterThan(640_000_000);
    expect(plan.diskBytes).toBeGreaterThan(1.5e9);
    expect(plan.diskBytes).toBeLessThan(2.2e9);
  });

  it("uses default torch wheels for cuda and macOS, cpu index otherwise", () => {
    expect(
      buildPlan({ config: { ...DEFAULT_CONFIG, device: "cuda" }, platform: "linux", nvidia: false })
        .torch,
    ).toBe("default");
    expect(buildPlan({ config: DEFAULT_CONFIG, platform: "darwin", nvidia: false }).torch).toBe(
      "default",
    );
    expect(buildPlan({ config: DEFAULT_CONFIG, platform: "linux", nvidia: true }).torch).toBe(
      "default",
    );
    expect(
      buildPlan({ config: { ...DEFAULT_CONFIG, device: "cpu" }, platform: "linux", nvidia: true })
        .torch,
    ).toBe("cpu");
    expect(buildPlan({ config: DEFAULT_CONFIG, platform: "win32", nvidia: false }).torch).toBe(
      "cpu",
    );
  });

  it("plans both checkpoints for model auto", () => {
    const plan = buildPlan({
      config: { ...DEFAULT_CONFIG, model: "auto" },
      platform: "linux",
      nvidia: false,
    });
    expect(plan.models).toEqual(["english", "multilingual"]);
  });

  it("states pins, sizes, hosts and the runtime directory in the consent text", () => {
    const plan = buildPlan({ config: DEFAULT_CONFIG, platform: "linux", nvidia: false });
    const text = formatConsentText(plan, "~/.local/state/alisio/plugins/laya/runtime");
    expect(text).toContain("laya[serve]==");
    expect(text).toContain("multilingual");
    expect(text).toMatch(/\d+(\.\d+)? (GB|MB)/);
    expect(text).toContain("pypi.org");
    expect(text).toContain("huggingface.co");
    expect(text).toContain("download.pytorch.org");
    expect(text).toContain("~/.local/state/alisio/plugins/laya/runtime");
    expect(text).toMatch(/offline/i);
  });

  it("omits the pytorch host for default wheels", () => {
    const plan = buildPlan({
      config: { ...DEFAULT_CONFIG, device: "cuda" },
      platform: "linux",
      nvidia: false,
    });
    expect(formatConsentText(plan, "r")).not.toContain("download.pytorch.org");
  });
});

describe("runInstall", () => {
  it("creates the venv, installs, downloads, verifies, smoke tests and commits", async () => {
    const { input, calls, steps, smoke } = baseInput();
    const record = await runInstall(input);
    expect(steps.map((s) => s[1])).toEqual([
      "creating environment",
      "installing packages",
      "downloading model",
      "verifying model",
      "smoke test",
      "committing",
    ]);
    expect(steps.map((s) => s[0])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(smoke).toHaveBeenCalledOnce();
    expect(record.models).toEqual(["multilingual"]);
    const installed = await readInstalledRuntime(runtimeDir, input.manifest, "linux");
    expect(installed.kind).toBe("installed");
    const body = await readFile(join(runtimeDir, "runtime.json"), "utf8");
    expect(body).not.toContain(dir);
    expect(JSON.parse(body)).toMatchObject({
      schemaVersion: 1,
      laya: "9.9.9",
      torch: "cpu",
      models: ["multilingual"],
    });
    expect(calls[0]?.args.slice(0, 2)).toEqual(["-m", "venv"]);
  });

  it("upgrades pip first: the venv's bundled pip 22 crashes resolving laya[serve] (AssertionError)", async () => {
    const { input, calls } = baseInput();
    await runInstall(input);
    const pip = calls.filter((c) => c.args.includes("pip"));
    expect(pip[0]?.args).toContain("--upgrade");
    expect(pip[0]?.args).toContain("pip>=24");
    expect(pip[0]?.args).not.toContain("--index-url");
    expect(pip[0]?.args).not.toContain("torch");
  });

  it("installs the CPU torch wheel from the CPU index only, then laya[serve] from PyPI", async () => {
    const { input, calls } = baseInput();
    await runInstall(input);
    const pip = calls.filter((c) => c.args.includes("pip"));
    expect(pip).toHaveLength(3);
    expect(pip[1]?.args).toContain("--index-url");
    expect(pip[1]?.args).toContain("https://example.test/whl/cpu");
    expect(pip[1]?.args).toContain("torch");
    expect(pip[2]?.args).toContain("laya[serve]==9.9.9");
    expect(pip[2]?.args).not.toContain("--index-url");
    for (const call of pip) {
      expect(call.args).not.toContain("--extra-index-url");
      expect(call.args).toEqual(
        expect.arrayContaining([
          "--no-input",
          "--disable-pip-version-check",
          "--require-virtualenv",
        ]),
      );
    }
  });

  it("skips the separate torch step for default wheels", async () => {
    const { input, calls } = baseInput({ config: { ...DEFAULT_CONFIG, device: "cuda" } });
    await runInstall(input);
    expect(calls.filter((c) => c.args.includes("pip"))).toHaveLength(2);
  });

  it("scrubs the child environment: no PIP_*, PYTHONPATH or inherited secrets; proxies kept", async () => {
    const { input, calls } = baseInput();
    await runInstall(input);
    for (const call of calls) {
      const env = call.env ?? {};
      expect(env).not.toHaveProperty("PIP_INDEX_URL");
      expect(env).not.toHaveProperty("PYTHONPATH");
      expect(env).not.toHaveProperty("OPENAI_API_KEY");
      expect(env.PYTHONNOUSERSITE).toBe("1");
    }
    expect(calls[1]?.env?.HTTPS_PROXY).toBe("http://proxy:3128");
  });

  it("downloads with a constant script and argv-only inputs, pinned revision, HF_HOME set", async () => {
    const { input, calls } = baseInput();
    await runInstall(input);
    const download = calls.find((c) => c.args[0] === "-c" && c.args[1] === DOWNLOAD_SCRIPT);
    expect(download).toBeDefined();
    expect(download?.args.slice(2, 4)).toEqual(["owner/bundle", "a".repeat(40)]);
    expect(download?.args.slice(4)).toContain("multilingual/model.safetensors");
    expect(download?.env?.HF_HOME).toBe(join(runtimeDir, "hf"));
    expect(DOWNLOAD_SCRIPT).not.toContain("owner/bundle");
  });

  it("removes the previous venv only after the new runtime is committed", async () => {
    const first = baseInput();
    await runInstall(first.input);
    const before = (await readdir(runtimeDir)).filter((n) => n.startsWith("venv-"));
    expect(before).toHaveLength(1);
    const second = baseInput();
    await runInstall(second.input);
    const after = (await readdir(runtimeDir)).filter((n) => n.startsWith("venv-"));
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    const installed = await readInstalledRuntime(runtimeDir, second.input.manifest, "linux");
    expect(installed.kind).toBe("installed");
  });

  const failureStages: Array<[string, (c: Call, i: number) => boolean]> = [
    ["venv creation", (c) => c.args[1] === "venv"],
    ["torch install", (c) => c.args.includes("torch")],
    ["laya install", (c) => c.args.includes("laya[serve]==9.9.9")],
    ["model download", (c) => c.args[1] === DOWNLOAD_SCRIPT],
  ];

  it.each(failureStages)(
    "a failure at %s leaves the previous runtime intact and no new venv",
    async (_name, match) => {
      const good = baseInput();
      await runInstall(good.input);
      const previous = (await readdir(runtimeDir)).filter((n) => n.startsWith("venv-"));
      const bad = baseInput();
      const { runner } = makeRunner(bad.manifest, (call) =>
        match(call, 0) ? { code: 1, stderr: "boom: network is unreachable" } : undefined,
      );
      await expect(runInstall({ ...bad.input, runner })).rejects.toBeInstanceOf(InstallFailure);
      const now = (await readdir(runtimeDir)).filter((n) => n.startsWith("venv-"));
      expect(now).toEqual(previous);
      const installed = await readInstalledRuntime(runtimeDir, bad.manifest, "linux");
      expect(installed.kind).toBe("installed");
      expect(bad.smoke).not.toHaveBeenCalled();
    },
  );

  it("a smoke-test failure aborts before the commit", async () => {
    const { input } = baseInput({
      smoke: vi.fn(async () => {
        throw new Error("smoke failed");
      }),
    });
    await expect(runInstall(input)).rejects.toBeInstanceOf(InstallFailure);
    expect((await readdir(runtimeDir)).filter((n) => n.startsWith("venv-"))).toEqual([]);
    await expect(stat(join(runtimeDir, "runtime.json"))).rejects.toThrow();
  });

  it("aborts on a checksum mismatch, deletes the partial cache and never commits", async () => {
    const manifest = testManifest();
    const { runner } = makeRunner(manifest, () => undefined, true);
    const { input, smoke } = baseInput({ manifest, runner });
    const failure = await runInstall(input).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(InstallFailure);
    expect((failure as InstallFailure).code).toBe("checksum_mismatch");
    await expect(stat(join(runtimeDir, "hf", "hub", "models--owner--bundle"))).rejects.toThrow();
    await expect(stat(join(runtimeDir, "runtime.json"))).rejects.toThrow();
    expect(smoke).not.toHaveBeenCalled();
  });

  it("aborts when a file is missing after the download", async () => {
    const manifest = testManifest();
    const { runner } = makeRunner(manifest, (call) =>
      call.args[1] === DOWNLOAD_SCRIPT ? { code: 0 } : undefined,
    );
    const { input } = baseInput({ manifest, runner });
    const failure = await runInstall(input).catch((e: unknown) => e);
    expect((failure as InstallFailure).code).toBe("checksum_mismatch");
  });

  it("cancels cleanly: child aborted, new venv removed, previous runtime untouched", async () => {
    const good = baseInput();
    await runInstall(good.input);
    const previous = (await readdir(runtimeDir)).filter((n) => n.startsWith("venv-"));
    const controller = new AbortController();
    const manifest = testManifest();
    const { runner } = makeRunner(manifest, (call) => {
      if (call.args.includes("laya[serve]==9.9.9")) {
        controller.abort();
        return { code: null, aborted: true };
      }
      return undefined;
    });
    const { input } = baseInput({ manifest, runner, signal: controller.signal });
    await expect(runInstall(input)).rejects.toBeInstanceOf(InstallCancelled);
    expect((await readdir(runtimeDir)).filter((n) => n.startsWith("venv-"))).toEqual(previous);
  });

  it("does not start a step once cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { input, calls } = baseInput({ signal: controller.signal });
    await expect(runInstall(input)).rejects.toBeInstanceOf(InstallCancelled);
    expect(calls).toHaveLength(0);
  });

  it("keeps stderr hints short and free of absolute home paths", async () => {
    const manifest = testManifest();
    const { runner } = makeRunner(manifest, (call) =>
      call.args.includes("laya[serve]==9.9.9")
        ? {
            code: 1,
            stderr: `ERROR: could not install /work/alice/secret/project/pkg ${"x".repeat(500)}\n`,
          }
        : undefined,
    );
    const { input } = baseInput({ manifest, runner });
    const failure = (await runInstall(input).catch((e: unknown) => e)) as InstallFailure;
    expect(failure.message.length).toBeLessThan(400);
    expect(failure.message).not.toContain("/work/alice/secret");
  });
});

describe("uninstallRuntime", () => {
  it("removes only the runtime directory after a containment check", async () => {
    await writeFile(join(runtimeDir, "runtime.json"), "{}");
    await mkdir(join(runtimeDir, "venv-x"));
    await uninstallRuntime({ runtimeRoot: runtimeDir, parent: dir });
    await expect(stat(runtimeDir)).rejects.toThrow();
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("refuses when the runtime path is a symlink to elsewhere", async () => {
    const outside = join(dir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "precious"), "keep");
    await rm(runtimeDir, { recursive: true });
    await symlink(outside, runtimeDir);
    await expect(uninstallRuntime({ runtimeRoot: runtimeDir, parent: dir })).rejects.toThrow();
    expect(await readFile(join(outside, "precious"), "utf8")).toBe("keep");
  });

  it("refuses a runtime path outside its parent", async () => {
    await expect(
      uninstallRuntime({ runtimeRoot: dir, parent: join(dir, "runtime") }),
    ).rejects.toThrow();
  });

  it("is a no-op when nothing is installed", async () => {
    await rm(runtimeDir, { recursive: true });
    await expect(
      uninstallRuntime({ runtimeRoot: runtimeDir, parent: dir }),
    ).resolves.toBeUndefined();
  });
});
