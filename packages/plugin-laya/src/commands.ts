/** `/laya:setup`, `/laya:status` and `/laya:cancel`. Handlers return within seconds; setup is a job. */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, sep } from "node:path";
import type { AskQuestionsRequest, AskQuestionsResult } from "@alisio/sdk";
import {
  type ConfigKey,
  DEVICES,
  type LayaConfig,
  type LayaDevice,
  type LayaModel,
  loadConfigFile,
  MODELS,
  resolveConfig,
  saveConfigFile,
} from "./config.js";
import { assertContained } from "./paths.js";
import { buildChildEnv } from "./runtime/env.js";
import { layaServe, venvBinDir } from "./runtime/install-state.js";
import { buildPlan, formatConsentText, runInstall, uninstallRuntime } from "./runtime/installer.js";
import { digestsEnv, type ModelName } from "./runtime/manifest.js";
import { discoverPython } from "./runtime/python.js";
import { nodeRunner, type Runner } from "./runtime/runner.js";
import { runSmoke, warmupWire } from "./runtime/smoke.js";
import { Supervisor } from "./runtime/supervisor.js";
import type { LayaRuntime } from "./runtime.js";
import { createHttpTransport } from "./transport/http.js";

export interface CommandUi {
  interactive(): boolean;
  askQuestions(request: AskQuestionsRequest): Promise<AskQuestionsResult>;
  status(key: string, text: string | undefined, detail?: string): void;
}

export interface HostSupport {
  decisions: boolean;
  paths: boolean;
  options: boolean;
  registered: () => boolean;
  activeProviderId: () => string | null;
}

export interface CommandDeps {
  runtime: LayaRuntime;
  ui: CommandUi;
  runner?: Runner;
  env: Readonly<Record<string, string | undefined>>;
  host: HostSupport;
  discover?: typeof discoverPython;
  install?: typeof runInstall;
  smoke?: Parameters<typeof runInstall>[0]["smoke"];
  nvidia?: () => boolean;
  now?: () => Date;
}

export interface SetupFlags {
  device?: LayaDevice;
  model?: LayaModel;
  yes: boolean;
  repair: boolean;
  uninstall: boolean;
}

export type ParsedSetup = { ok: true; flags: SetupFlags } | { ok: false; error: string };

const USAGE =
  "Usage: /laya:setup [--device auto|cpu|cuda|mps] [--model multilingual|english|typed-decisions|auto] [--yes] [--repair] [--uninstall]";

export function parseSetupArgs(text: string): ParsedSetup {
  const tokens = text.split(/\s+/).filter(Boolean);
  const flags: SetupFlags = { yes: false, repair: false, uninstall: false };
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const [name, inline] = token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, undefined];
    if (name === "--yes" || name === "--repair" || name === "--uninstall") {
      if (inline !== undefined) return { ok: false, error: `${name} takes no value. ${USAGE}` };
      flags[name.slice(2) as "yes" | "repair" | "uninstall"] = true;
      continue;
    }
    if (name === "--device" || name === "--model") {
      if (seen.has(name)) return { ok: false, error: `${name} was given twice. ${USAGE}` };
      seen.add(name);
      const value = inline ?? tokens[++i];
      if (name === "--device") {
        if (!(DEVICES as readonly string[]).includes(value ?? "")) {
          return { ok: false, error: `device must be one of ${DEVICES.join(", ")}. ${USAGE}` };
        }
        flags.device = value as LayaDevice;
      } else {
        if (!(MODELS as readonly string[]).includes(value ?? "")) {
          return { ok: false, error: `model must be one of ${MODELS.join(", ")}. ${USAGE}` };
        }
        flags.model = value as LayaModel;
      }
      continue;
    }
    return { ok: false, error: `Unknown argument "${token.slice(0, 40)}". ${USAGE}` };
  }
  if (flags.repair && flags.uninstall) {
    return { ok: false, error: `--repair and --uninstall cannot be combined. ${USAGE}` };
  }
  return { ok: true, flags };
}

function nvidiaPresent(): boolean {
  return process.platform === "linux" && existsSync("/proc/driver/nvidia");
}

/** Default smoke test: a throwaway supervisor over the freshly installed venv. */
export function defaultSmoke(
  runtime: LayaRuntime,
  env: Readonly<Record<string, string | undefined>>,
) {
  return async (venvDir: string, models: ModelName[], signal: AbortSignal): Promise<void> => {
    const config: LayaConfig = {
      device: runtime.config.device,
      model: models.length > 1 ? "auto" : (models[0] as LayaModel),
      preload: true,
    };
    const supervisor = new Supervisor({
      command: () => ({ file: layaServe(venvDir, runtime.platform), args: [] }),
      cwd: runtime.paths.runtime,
      buildEnv: (port, token) =>
        buildChildEnv({
          host: env,
          port,
          token,
          config,
          hfHome: runtime.paths.hf,
          runtimeDir: runtime.paths.runtime,
          venvBin: venvBinDir(venvDir, runtime.platform),
          digests: digestsEnv(models, runtime.manifest),
          cpus: cpus().length,
          platform: runtime.platform,
        }),
      pidfile: { write: async () => {}, remove: async () => {}, reapOrphan: async () => "none" },
      makeTransport: (port, token) => createHttpTransport({ port, token }),
      warmupWire: warmupWire(),
      maxFailures: 1,
    });
    await runSmoke(supervisor, signal, config.model === "auto" ? {} : { model: config.model });
  };
}

export interface CommandHandlers {
  setup(args: string): Promise<string>;
  status(args?: string): Promise<string>;
  cancel(args?: string): Promise<string>;
}

export function createCommandHandlers(deps: CommandDeps): CommandHandlers {
  const { runtime, ui } = deps;
  const runner = deps.runner ?? nodeRunner;
  const now = deps.now ?? (() => new Date());

  const collapse = (path: string): string => {
    const home = runtime.home;
    return home && (path === home || path.startsWith(home + sep))
      ? `~${path.slice(home.length)}`
      : path;
  };

  function jobLine(): string {
    const job = runtime.jobs.current();
    if (!job) return "setup: no job has run";
    const parts = [`setup: ${job.kind} ${job.state}`];
    if (job.step) parts.push(`step ${job.step.n}/${job.step.total} (${job.step.name})`);
    if (job.state === "running") {
      parts.push(
        `elapsed ${Math.max(0, Math.round((now().getTime() - Date.parse(job.startedAt)) / 1000))}s`,
      );
    }
    if (job.failureCode) parts.push(`code ${job.failureCode}`);
    if (job.message && job.state !== "succeeded") parts.push(job.message);
    return parts.join(", ");
  }

  async function status(): Promise<string> {
    const lines: string[] = ["Laya decision provider"];
    const { host } = deps;
    const yn = (v: boolean) => (v ? "yes" : "no");
    lines.push(
      `host: decisions API: ${yn(host.decisions)}, api.paths: ${yn(host.paths)}, api.options: ${yn(host.options)}`,
    );
    if (!host.decisions) {
      lines.push(
        "This Alisio core has no decision support. Laya needs Alisio core 0.3.0 or newer.",
      );
    } else {
      lines.push(
        `provider: registered ${yn(host.registered())}, active: ${host.activeProviderId() ?? "none"}`,
      );
    }
    lines.push(jobLine());

    const installed = runtime.installed;
    if (installed.kind === "installed") {
      const { record } = installed;
      lines.push(
        `runtime: laya ${record.laya}, python ${record.python}, torch ${record.torch}, checkpoints ${record.models.join(", ")}`,
      );
      if (installed.outdated) lines.push("runtime outdated: run /laya:setup --repair");
    } else if (installed.kind === "invalid") {
      lines.push(`runtime: not installed (${installed.reason})`);
    } else {
      lines.push("runtime: not installed");
    }
    lines.push(`runtime directory: ${collapse(runtime.paths.runtime)}`);

    lines.push("config:");
    for (const key of ["device", "model", "preload"] as ConfigKey[]) {
      lines.push(`  ${key}: ${String(runtime.config[key])} (${runtime.sources[key]})`);
    }
    for (const error of runtime.configErrors) lines.push(`  config problem: ${error}`);
    for (const missing of runtime.missingModels())
      lines.push(`  checkpoint ${missing} is not installed: run /laya:setup`);

    const snap = runtime.snapshot();
    lines.push(`server: ${snap.state}${snap.detail ? ` (${snap.detail})` : ""}`);
    const sup = runtime.supervisorStatus();
    if (sup) {
      lines.push(`restarts: ${sup.restarts}`);
      if (sup.lastError) lines.push(`last error: ${sup.lastError}`);
      if (sup.latencyMedianMs !== undefined)
        lines.push(`latency: ${sup.latencyMedianMs} ms per question (median)`);
    }

    const job = runtime.jobs.current();
    let next: string;
    if (job?.state === "running") next = "setup is running; /laya:cancel aborts it";
    else if (installed.kind !== "installed") next = "run /laya:setup";
    else if (snap.state === "failed" || snap.state === "backoff")
      next = "run /laya:setup --repair if it keeps failing";
    else if (!runtime.isActive)
      next = 'set decisions.provider = "laya" in the Alisio configuration';
    else next = "nothing; Laya is active";
    lines.push(`next step: ${next}`);
    return lines.join("\n");
  }

  async function confirm(
    id: string,
    header: string,
    question: string,
    yesValue: string,
    yesLabel: string,
    yes: boolean,
  ): Promise<"yes" | "no" | "headless"> {
    if (yes) return "yes";
    if (!ui.interactive()) return "headless";
    let answers: AskQuestionsResult;
    try {
      answers = await ui.askQuestions({
        questions: [
          {
            id,
            header,
            question,
            options: [
              { value: yesValue, label: yesLabel, description: "Proceed as described above." },
              {
                value: "cancel",
                label: "Cancel",
                description: "Do nothing; nothing is downloaded or changed.",
              },
            ],
          },
        ],
      });
    } catch {
      return "no";
    }
    return answers[id] === yesValue ? "yes" : "no";
  }

  const started =
    "\nSetup started in the background. Check progress with /laya:status; cancel with /laya:cancel.";

  async function persistFlags(flags: SetupFlags): Promise<void> {
    if (!flags.device && !flags.model) return;
    const file = await loadConfigFile(runtime.paths.configFile);
    const base = resolveConfig({
      env: {},
      ...(file.raw !== undefined && !file.error ? { file: file.raw } : {}),
    }).config;
    await saveConfigFile(runtime.paths.configFile, {
      ...base,
      ...(flags.device ? { device: flags.device } : {}),
      ...(flags.model ? { model: flags.model } : {}),
    });
  }

  async function setup(args: string): Promise<string> {
    const parsed = parseSetupArgs(args);
    if (!parsed.ok) return parsed.error;
    const { flags } = parsed;
    if (runtime.jobs.current()?.state === "running") {
      return `Setup is already running.\n${jobLine()}\nCancel it with /laya:cancel.`;
    }
    if (runtime.configErrors.length > 0) {
      return `Fix the Laya configuration first:\n- ${runtime.configErrors.join("\n- ")}`;
    }

    if (flags.uninstall) {
      const decision = await confirm(
        "laya-uninstall-confirm",
        "Remove Laya",
        `Remove the managed Laya runtime and downloaded models from ${collapse(runtime.paths.runtime)}?`,
        "remove",
        "Remove",
        flags.yes,
      );
      if (decision === "headless")
        return "No interactive UI is available. Re-run with --yes to confirm the removal.";
      if (decision === "no") return "Uninstall cancelled. Nothing was removed.";
      const outcome = runtime.jobs.start("uninstall", async (ctx) => {
        ctx.step(1, "stopping server");
        await runtime.stopServer();
        await uninstallRuntime({
          runtimeRoot: runtime.paths.runtime,
          parent: dirname(runtime.paths.runtime),
        });
        if (!runtime.paths.hf.startsWith(runtime.paths.runtime + sep)) {
          const parent = dirname(runtime.paths.hf);
          await assertContained(parent, runtime.paths.hf, { forbidSymlink: true });
          await rm(runtime.paths.hf, { recursive: true, force: true });
        }
        await runtime.refresh();
        return "removed";
      });
      return outcome === "started"
        ? `Uninstall started.${started}`
        : `Setup is already running.\n${jobLine()}`;
    }

    const config: LayaConfig = {
      ...runtime.config,
      ...(flags.device ? { device: flags.device } : {}),
      ...(flags.model ? { model: flags.model } : {}),
    };
    const discover = deps.discover ?? discoverPython;
    const python = await discover({ env: deps.env, platform: runtime.platform, runner });
    if (!python.ok) return `Setup cannot start: ${python.reason}.`;

    const plan = buildPlan({
      config,
      platform: runtime.platform,
      nvidia: (deps.nvidia ?? nvidiaPresent)(),
      manifest: runtime.manifest,
    });
    const consentText = formatConsentText(plan, collapse(runtime.paths.runtime));
    const decision = await confirm(
      "laya-setup-consent",
      "Laya setup",
      `${consentText}\n\nInstall now?`,
      "install",
      "Install",
      flags.yes,
    );
    if (decision === "headless") {
      return `${consentText}\n\nNo interactive UI is available. Re-run with --yes to consent explicitly.`;
    }
    if (decision === "no") return "Setup cancelled. Nothing was downloaded or written.";

    const install = deps.install ?? runInstall;
    const smoke = deps.smoke ?? defaultSmoke(runtime, deps.env);
    const outcome = runtime.jobs.start(flags.repair ? "repair" : "install", async (ctx) => {
      await runtime.ensureDirs();
      await runtime.stopServer();
      const record = await install({
        runtimeDir: runtime.paths.runtime,
        hfHome: runtime.paths.hf,
        config,
        python,
        manifest: runtime.manifest,
        runner,
        smoke,
        platform: runtime.platform,
        hostEnv: deps.env,
        signal: ctx.signal,
        onStep: (n, name) => {
          ctx.step(n, name);
          ui.status("laya", `setup ${n}/6 ${name}`);
        },
        nvidia: (deps.nvidia ?? nvidiaPresent)(),
        now,
      });
      await persistFlags(flags);
      await runtime.reloadConfig();
      await runtime.refresh();
      return `installed laya ${record.laya}`;
    });
    ui.status("laya", outcome === "started" ? "setup starting" : undefined);
    void runtime.jobs.whenIdle().then(() => {
      ui.status("laya", undefined);
      // The job record is final only now, so the runtime may start the server.
      if (
        runtime.jobs.current()?.state === "succeeded" &&
        runtime.isActive &&
        runtime.config.preload
      ) {
        runtime.ensureStarted();
      }
    });
    return outcome === "started"
      ? `${consentText}${started}`
      : `Setup is already running.\n${jobLine()}`;
  }

  async function cancel(): Promise<string> {
    return runtime.jobs.cancel() === "cancelled"
      ? "Cancelling setup; the previous runtime, if any, stays untouched."
      : "No setup job is running.";
  }

  return { setup, status, cancel };
}
