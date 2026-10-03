/**
 * The runtime controller: owns config, paths, the installed-runtime record, the setup job and the
 * supervisor, and presents them to the provider as a `RuntimeStatus`. It is inert until `activate()`.
 */
import { cpus, homedir } from "node:os";
import { join } from "node:path";
import {
  type ConfigKey,
  type ConfigSource,
  type LayaConfig,
  loadConfigFile,
  resolveConfig,
} from "./config.js";
import { ensurePaths, type HostPaths, type LayaPaths, resolvePaths } from "./paths.js";
import type { RuntimeSnapshot, RuntimeStatus } from "./provider.js";
import { buildChildEnv } from "./runtime/env.js";
import {
  type InstalledRuntime,
  layaServe,
  readInstalledRuntime,
  venvBinDir,
} from "./runtime/install-state.js";
import { SetupJobs } from "./runtime/jobs.js";
import { digestsEnv, MANIFEST, type Manifest, modelsToInstall } from "./runtime/manifest.js";
import { createPidfile } from "./runtime/pidfile.js";
import { warmupWire } from "./runtime/smoke.js";
import { Supervisor, type SupervisorStatus } from "./runtime/supervisor.js";
import { createHttpTransport, type LayaTransport } from "./transport/http.js";

/** The subset of `Supervisor` the controller uses; lets tests inject a fake. */
export interface ServerSupervisor extends RuntimeStatus {
  stop(): Promise<void>;
  killNow(): void;
  status(): SupervisorStatus;
  output(): string;
  reset(): void;
}

export interface SupervisorContext {
  venvDir: string;
  models: string[];
  config: LayaConfig;
  paths: LayaPaths;
}

export interface RuntimeDeps {
  env: Readonly<Record<string, string | undefined>>;
  home?: string;
  platform?: NodeJS.Platform;
  apiPaths?: HostPaths | undefined;
  hostOptions?: unknown;
  manifest?: Manifest;
  /** Fallback for hosts without `activate`: is Laya the active provider right now? */
  hostIsActive?: () => boolean;
  makeSupervisor?: (context: SupervisorContext) => ServerSupervisor;
  onChange?: () => void;
}

export class LayaRuntime implements RuntimeStatus {
  readonly paths: LayaPaths;
  readonly jobs: SetupJobs;
  config: LayaConfig;
  sources: Record<ConfigKey, ConfigSource>;
  configErrors: string[] = [];
  installed: InstalledRuntime = { kind: "none" };
  private active = false;
  private supervisor: ServerSupervisor | null = null;
  private supervisorVenv: string | null = null;
  readonly manifest: Manifest;
  readonly platform: NodeJS.Platform;
  readonly home: string;

  constructor(private readonly deps: RuntimeDeps) {
    this.platform = deps.platform ?? process.platform;
    this.home = deps.home ?? homedir();
    this.manifest = deps.manifest ?? MANIFEST;
    this.paths = resolvePaths({ apiPaths: deps.apiPaths, env: deps.env, home: this.home });
    this.jobs = new SetupJobs({
      dir: join(this.paths.runtime, "jobs"),
      ...(deps.onChange ? { onChange: () => deps.onChange?.() } : {}),
    });
    const initial = resolveConfig({ env: deps.env, hostOptions: deps.hostOptions });
    this.config = initial.config;
    this.sources = initial.sources;
    this.configErrors = initial.errors;
  }

  /** Read config file, installed runtime and the persisted job record. Never throws. */
  async init(): Promise<void> {
    try {
      await this.reloadConfig();
      await this.jobs.load();
      await this.readInstalled();
    } catch {
      /* the provider reports unavailable instead */
    }
  }

  async reloadConfig(): Promise<void> {
    const file = await loadConfigFile(this.paths.configFile);
    const resolved = resolveConfig({
      env: this.deps.env,
      hostOptions: this.deps.hostOptions,
      ...(file.raw !== undefined ? { file: file.raw } : {}),
    });
    this.config = resolved.config;
    this.sources = resolved.sources;
    this.configErrors = file.error
      ? [...resolved.errors, `config file: ${file.error}`]
      : resolved.errors;
  }

  async readInstalled(): Promise<void> {
    this.installed = await readInstalledRuntime(this.paths.runtime, this.manifest, this.platform);
  }

  /** Re-read the installed runtime and drop the supervisor so the next start uses fresh pins. */
  async refresh(): Promise<void> {
    await this.stopServer();
    this.supervisor = null;
    this.supervisorVenv = null;
    await this.readInstalled();
  }

  get isActive(): boolean {
    return this.active || (this.deps.hostIsActive?.() ?? false);
  }

  /** Checkpoints required by the config that the installed runtime does not carry. */
  missingModels(): string[] {
    if (this.installed.kind !== "installed") return [];
    const have = this.installed.record.models as string[];
    return modelsToInstall(this.config.model).filter((m) => !have.includes(m));
  }

  snapshot(): RuntimeSnapshot {
    if (this.configErrors.length > 0) {
      return { state: "config_invalid", detail: this.configErrors.join("; ") };
    }
    if (this.installed.kind === "none") return { state: "not_installed" };
    if (this.installed.kind === "invalid")
      return { state: "not_installed", detail: this.installed.reason };
    const missing = this.missingModels();
    if (missing.length > 0) {
      return {
        state: "not_installed",
        detail: `checkpoint ${missing.join(", ")} is not installed`,
      };
    }
    if (this.jobs.current()?.state === "running") return { state: "setup_running" };
    if (!this.isActive) return { state: "inactive" };
    return this.supervisorFor()?.snapshot() ?? { state: "stopped" };
  }

  ensureStarted(): void {
    if (!this.canStart()) return;
    this.supervisorFor()?.ensureStarted();
  }

  transport(): LayaTransport | null {
    return this.supervisor?.transport() ?? null;
  }

  noteConnectionFailure(): void {
    this.supervisor?.noteConnectionFailure();
  }

  recordLatency(elapsedMs: number, questions: number): void {
    this.supervisor?.recordLatency(elapsedMs, questions);
  }

  supervisorStatus(): SupervisorStatus | null {
    return this.supervisor?.status() ?? null;
  }

  supervisorOutput(): string {
    return this.supervisor?.output() ?? "";
  }

  resetFailures(): void {
    this.supervisor?.reset();
  }

  private canStart(): boolean {
    return (
      this.isActive &&
      this.configErrors.length === 0 &&
      this.installed.kind === "installed" &&
      this.missingModels().length === 0 &&
      this.jobs.current()?.state !== "running"
    );
  }

  private supervisorFor(): ServerSupervisor | null {
    if (this.installed.kind !== "installed") return null;
    const { venvDir, record } = this.installed;
    if (this.supervisor && this.supervisorVenv === venvDir) return this.supervisor;
    const context: SupervisorContext = {
      venvDir,
      models: record.models,
      config: this.config,
      paths: this.paths,
    };
    this.supervisor = (this.deps.makeSupervisor ?? ((c) => this.defaultSupervisor(c)))(context);
    this.supervisorVenv = venvDir;
    return this.supervisor;
  }

  private defaultSupervisor(context: SupervisorContext): ServerSupervisor {
    const { venvDir, config, paths } = context;
    return new Supervisor({
      command: () => ({ file: layaServe(venvDir, this.platform), args: [] }),
      cwd: paths.runtime,
      buildEnv: (port, token) =>
        buildChildEnv({
          host: this.deps.env,
          port,
          token,
          config,
          hfHome: paths.hf,
          runtimeDir: paths.runtime,
          venvBin: venvBinDir(venvDir, this.platform),
          digests: digestsEnv(context.models as never, this.manifest),
          cpus: cpus().length,
          platform: this.platform,
        }),
      pidfile: createPidfile(join(paths.runtime, "server.pid"), { venvRoot: venvDir }),
      makeTransport: (port, token) => createHttpTransport({ port, token }),
      warmupWire: warmupWire(),
      eagerRestart: config.preload,
      ...(this.deps.onChange ? { onChange: () => this.deps.onChange?.() } : {}),
    });
  }

  // -- Lifecycle -------------------------------------------------------------------------------

  /** The core made Laya the active provider. Never throws, never waits for readiness. */
  async activate(): Promise<void> {
    this.active = true;
    try {
      await this.readInstalled();
      if (this.config.preload) this.ensureStarted();
    } catch {
      /* stays inert */
    }
  }

  /** The core stopped using Laya. Stops the server promptly. Never throws. */
  async deactivate(): Promise<void> {
    this.active = false;
    // Return promptly (the core bounds this call); the kill sequence finishes in the background.
    await Promise.race([this.stopServer(), new Promise<void>((r) => setTimeout(r, 500).unref())]);
  }

  async stopServer(): Promise<void> {
    try {
      await this.supervisor?.stop();
    } catch {
      /* best effort */
    }
  }

  /** Application close: cancel any setup job and stop the server, in parallel. Never throws. */
  async dispose(): Promise<void> {
    this.active = false;
    await Promise.allSettled([this.jobs.dispose(), this.stopServer()]);
  }

  /** Synchronous last resort for `process.on("exit")`. */
  killNow(): void {
    try {
      this.supervisor?.killNow();
    } catch {
      /* already gone */
    }
  }

  async ensureDirs(): Promise<void> {
    await ensurePaths(this.paths);
  }
}
