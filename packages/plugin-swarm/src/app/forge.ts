import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { FsBoardStore } from "../adapters/fs-board-store.js";
import { FsHandoffStore } from "../adapters/fs-handoff-store.js";
import { FsTaskStateStore } from "../adapters/fs-task-state-store.js";
import { type AttentionItem, deriveAttention } from "../domain/attention.js";
import { validateProjectName } from "../domain/identifiers.js";
import { type Pack, parsePack, roleIds } from "../domain/pack.js";
import { entryRole } from "../domain/pipeline.js";
import type { Board } from "../domain/task.js";
import type { TaskState } from "../domain/taskstate.js";
import type { AgentRunner } from "../ports/agent-runner.js";
import { type Clock, systemClock } from "../ports/clock.js";
import type { GateRunner } from "../ports/gate-runner.js";
import type { Isolation } from "../ports/isolation.js";
import { type Notifier, silentNotifier } from "../ports/notifier.js";
import { listShippedPacks, loadShippedPack } from "../resources.js";
import type { ProjectSnapshot } from "../status.js";
import { atomicWrite, ensureIgnoreEntries, Mutex, readText, resolveContained } from "../storage.js";
import { UsageMeter } from "./budget.js";
import { claimPidfile, releasePidfile } from "./pidfile.js";
import { MAX_TASK_TEXT, ProjectRuntime } from "./project.js";

export interface ForgeDeps {
  /** The workspace root: the forge lives under `<workspace>/.alisio/swarm`. */
  workspace: string;
  isolation: Isolation;
  runner: AgentRunner;
  clock?: Clock;
  notifier?: Notifier;
  /** Quality gates enforced by the pump after each role; absent means packs run ungated. */
  gates?: GateRunner;
  /** Soft cap on total tokens across the swarm (`options.tokenBudget`); absent means unlimited. */
  tokenBudget?: number;
  cloneUrl?: (repo: string) => string;
  maxConcurrent?: number;
  /** Start the background pump of opened projects (default true). Tests drive `drain()` instead. */
  autoStart?: boolean;
}

export interface PackInfo {
  name: string;
  description: string;
  roles: string[];
  source: "shipped" | "workspace";
}

export interface ProjectInfo {
  name: string;
  pack: string;
  open: boolean;
  running: boolean;
}

interface ProjectEntry {
  name: string;
  pack: string;
  createdAt: string;
  open: boolean;
}

interface ForgeState {
  schemaVersion: 1;
  projects: ProjectEntry[];
}

export interface NewProjectInput {
  name: string;
  pack?: string;
  mission: string;
  /** `owner/repo`: clone instead of `git init`. */
  github?: string;
  /** An edited pack definition (validated like any pack) used instead of the named pack. */
  packDefinition?: unknown;
}

const packNamePattern = /^[a-z0-9][a-z0-9-]{0,47}$/;
const githubPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const DEFAULT_PACK = "two-pack";

function validateState(value: unknown): ForgeState {
  const record = value as Record<string, unknown> | null;
  if (
    !record ||
    typeof record !== "object" ||
    record.schemaVersion !== 1 ||
    !Array.isArray(record.projects)
  ) {
    throw new Error("forge.json is corrupt or has an unsupported schemaVersion");
  }
  const projects = record.projects.map((raw): ProjectEntry => {
    const entry = raw as Record<string, unknown>;
    validateProjectName(entry.name as string);
    if (typeof entry.pack !== "string" || !packNamePattern.test(entry.pack)) {
      throw new Error("forge.json has an invalid pack name");
    }
    if (typeof entry.createdAt !== "string" || typeof entry.open !== "boolean") {
      throw new Error("forge.json has an invalid project entry");
    }
    return {
      name: entry.name as string,
      pack: entry.pack,
      createdAt: entry.createdAt,
      open: entry.open,
    };
  });
  return { schemaVersion: 1, projects };
}

/** The forge: `<workspace>/.alisio/swarm` with its projects, packs and open runtimes. */
export class Forge {
  readonly dir: string;
  private readonly clock: Clock;
  private readonly notifier: Notifier;
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private readonly opening = new Map<string, Promise<ProjectRuntime>>();
  private readonly stateLock = new Mutex();
  private meter: UsageMeter | undefined;

  constructor(private readonly deps: ForgeDeps) {
    this.dir = join(deps.workspace, ".alisio", "swarm");
    this.clock = deps.clock ?? systemClock;
    this.notifier = deps.notifier ?? silentNotifier;
  }

  private get statePath(): string {
    return join(this.dir, "forge.json");
  }

  private get projectsDir(): string {
    return join(this.dir, "projects");
  }

  private get packsDir(): string {
    return join(this.dir, "packs");
  }

  async init(): Promise<{ created: boolean }> {
    await mkdir(this.projectsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.packsDir, { recursive: true, mode: 0o700 });
    const created = (await readText(this.statePath)) === undefined;
    if (created) {
      await atomicWrite(
        this.statePath,
        `${JSON.stringify({ schemaVersion: 1, projects: [] }, null, 2)}\n`,
      );
    }
    const root = this.deps.workspace;
    if (existsSync(join(root, ".git")) || existsSync(join(root, ".gitignore"))) {
      await ensureIgnoreEntries(join(root, ".gitignore"), [".alisio/swarm/"]);
    }
    return { created };
  }

  private async readState(): Promise<ForgeState> {
    const raw = await readText(this.statePath);
    if (raw === undefined)
      throw new Error("The swarm forge is not initialised; run /swarm:init first");
    try {
      return validateState(JSON.parse(raw));
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "forge.json is corrupt");
    }
  }

  private mutateState<T>(change: (state: ForgeState) => T): Promise<T> {
    return this.stateLock.run(async () => {
      const state = await this.readState();
      const result = change(state);
      await atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
      return result;
    });
  }

  // ---- packs ----

  private async scanLocalPacks(): Promise<{
    packs: Array<{ pack: Pack }>;
    invalid: Array<{ file: string; error: string }>;
  }> {
    const packs: Array<{ pack: Pack }> = [];
    const invalid: Array<{ file: string; error: string }> = [];
    let names: string[] = [];
    try {
      names = (await readdir(this.packsDir)).filter((file) => file.endsWith(".json")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const file of names) {
      try {
        const pack = parsePack(JSON.parse((await readText(join(this.packsDir, file))) as string));
        if (`${pack.name}.json` !== file) throw new Error("The pack name must match its file name");
        packs.push({ pack });
      } catch (error) {
        invalid.push({ file, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { packs, invalid };
  }

  async invalidPacks(): Promise<Array<{ file: string; error: string }>> {
    return (await this.scanLocalPacks()).invalid;
  }

  async listPacks(): Promise<PackInfo[]> {
    const byName = new Map<string, PackInfo>();
    for (const name of await listShippedPacks()) {
      const pack = await loadShippedPack(name);
      byName.set(name, {
        name,
        description: pack.description,
        roles: roleIds(pack),
        source: "shipped",
      });
    }
    for (const { pack } of (await this.scanLocalPacks()).packs) {
      byName.set(pack.name, {
        name: pack.name,
        description: pack.description,
        roles: roleIds(pack),
        source: "workspace",
      });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A workspace-local pack shadows a shipped pack of the same name. */
  async loadPack(name: string): Promise<Pack> {
    if (!packNamePattern.test(name)) throw new Error("Invalid pack name");
    const local = (await this.scanLocalPacks()).packs.find((entry) => entry.pack.name === name);
    if (local) return local.pack;
    if ((await listShippedPacks()).includes(name)) return loadShippedPack(name);
    throw new Error(`Unknown pack: ${name}`);
  }

  // ---- projects ----

  async isInitialised(): Promise<boolean> {
    return (await readText(this.statePath)) !== undefined;
  }

  /** Everything the status views need, including closed projects (read from their files). */
  async snapshot(only?: string): Promise<ProjectSnapshot[]> {
    const state = await this.readState();
    if (only !== undefined && !state.projects.some((entry) => entry.name === only)) {
      throw new Error(`Unknown project: ${only}`);
    }
    const out: ProjectSnapshot[] = [];
    for (const entry of state.projects) {
      if (only !== undefined && entry.name !== only) continue;
      const runtime = this.runtimes.get(entry.name);
      const dir = await resolveContained(this.projectsDir, entry.name);
      let pack: Pack | undefined = runtime?.pack;
      if (!pack) {
        try {
          pack = parsePack(
            JSON.parse((await readText(join(dir, ".alisio", "swarm", "pack.json"))) as string),
          );
        } catch {
          pack = undefined;
        }
      }
      let board: Board | undefined = runtime?.board();
      if (!board) {
        try {
          board = await new FsBoardStore(dir).read();
        } catch {
          board = undefined;
        }
      }
      let attention: AttentionItem[] = [];
      if (runtime) attention = runtime.attention();
      else if (board) {
        const states = new Map<string, TaskState>();
        for (const saved of await new FsTaskStateStore(dir).list()) states.set(saved.taskId, saved);
        attention = deriveAttention(entry.name, board, states);
      }
      out.push({
        name: entry.name,
        open: entry.open,
        running: Boolean(runtime),
        pack,
        board,
        attention,
      });
    }
    return out;
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const state = await this.readState();
    return state.projects.map((entry) => ({
      name: entry.name,
      pack: entry.pack,
      open: entry.open,
      running: this.runtimes.has(entry.name),
    }));
  }

  runtime(name: string): ProjectRuntime | undefined {
    return this.runtimes.get(name);
  }

  /** Every running project, for synchronous views (the TUI panel). */
  runningRuntimes(): ProjectRuntime[] {
    return [...this.runtimes.values()];
  }

  /** The mission text of a known project, open or closed. */
  async mission(name: string): Promise<string> {
    validateProjectName(name);
    const state = await this.readState();
    if (!state.projects.some((entry) => entry.name === name)) {
      throw new Error(`Unknown project: ${name}`);
    }
    const dir = await resolveContained(this.projectsDir, name);
    return (await readText(join(dir, ".alisio", "swarm", "mission.md"))) ?? "";
  }

  async newProject(input: NewProjectInput): Promise<ProjectRuntime> {
    const name = validateProjectName(input.name);
    const mission = input.mission.trim();
    if (!mission) throw new Error("A project needs a mission");
    if (mission.length > MAX_TASK_TEXT) throw new Error("The mission is too long");
    if (
      input.github !== undefined &&
      (!githubPattern.test(input.github) || input.github.includes(".."))
    ) {
      throw new Error("Invalid GitHub repository: expected owner/repo");
    }
    const pack =
      input.packDefinition !== undefined
        ? parsePack(input.packDefinition)
        : await this.loadPack(input.pack ?? DEFAULT_PACK);
    const state = await this.readState();
    const dir = await resolveContained(this.projectsDir, name);
    if (state.projects.some((entry) => entry.name === name) || existsSync(dir)) {
      throw new Error(`Project ${name} already exists`);
    }
    const masterRole = entryRole(pack);
    try {
      if (input.github !== undefined) {
        const url = (this.deps.cloneUrl ?? ((repo) => `https://github.com/${repo}.git`))(
          input.github,
        );
        await this.deps.isolation.cloneProject(url, dir, { masterRole });
      } else {
        await this.deps.isolation.initProject(dir, { mission, masterRole });
      }
      await atomicWrite(
        join(dir, ".alisio", "swarm", "pack.json"),
        `${JSON.stringify(pack, null, 2)}\n`,
      );
      await atomicWrite(join(dir, ".alisio", "swarm", "mission.md"), `${mission}\n`);
      await this.mutateState((current) => {
        current.projects.push({
          name,
          pack: pack.name,
          createdAt: this.clock.now().toISOString(),
          open: false,
        });
      });
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return this.openProject(name);
  }

  async openProject(name: string): Promise<ProjectRuntime> {
    validateProjectName(name);
    const existing = this.runtimes.get(name);
    if (existing) return existing;
    const pending = this.opening.get(name);
    if (pending) return pending;
    const work = this.doOpen(name).finally(() => this.opening.delete(name));
    this.opening.set(name, work);
    return work;
  }

  private async doOpen(name: string): Promise<ProjectRuntime> {
    const state = await this.readState();
    if (!state.projects.some((entry) => entry.name === name))
      throw new Error(`Unknown project: ${name}`);
    const dir = await resolveContained(this.projectsDir, name);
    const raw = await readText(join(dir, ".alisio", "swarm", "pack.json"));
    if (raw === undefined) throw new Error(`Project ${name} has no pack.json`);
    const pack = parsePack(JSON.parse(raw));
    const meter = await this.usageMeter();
    await this.claimPid();
    const runtime = await ProjectRuntime.open({
      name,
      dir,
      pack,
      isolation: this.deps.isolation,
      runner: this.deps.runner,
      handoffs: new FsHandoffStore(dir, this.clock),
      boards: new FsBoardStore(dir),
      states: new FsTaskStateStore(dir),
      clock: this.clock,
      notifier: this.notifier,
      maxConcurrent: this.deps.maxConcurrent ?? 3,
      autoStart: this.deps.autoStart ?? true,
      meter,
      ...(this.deps.gates ? { gates: this.deps.gates } : {}),
    });
    this.runtimes.set(name, runtime);
    await this.mutateState((current) => {
      const entry = current.projects.find((candidate) => candidate.name === name);
      if (entry) entry.open = true;
    });
    return runtime;
  }

  private get pidPath(): string {
    return join(this.dir, "swarm.pid");
  }

  /** The first open project claims the pidfile; a dead previous owner is reaped and reported. */
  private async claimPid(): Promise<void> {
    if (this.runtimes.size > 0) return;
    const claim = await claimPidfile(this.pidPath).catch(() => ({}) as Record<string, never>);
    const notify = (message: string): void =>
      this.notifier.notify({ type: "error", project: "-", message });
    if ("stale" in claim && claim.stale !== undefined) {
      notify(
        `A previous swarm process (pid ${claim.stale}) ended without cleaning up; its state was replayed`,
      );
    } else if ("other" in claim && claim.other !== undefined) {
      notify(`Another process (pid ${claim.other}) is running this swarm forge`);
    }
  }

  private async releasePid(): Promise<void> {
    if (this.runtimes.size === 0) await releasePidfile(this.pidPath).catch(() => undefined);
  }

  private async usageMeter(): Promise<UsageMeter> {
    this.meter ??= await UsageMeter.open({
      file: join(this.dir, "usage.json"),
      ...(this.deps.tokenBudget !== undefined ? { limit: this.deps.tokenBudget } : {}),
    });
    return this.meter;
  }

  /** The swarm-wide token meter (spec 8.4). */
  budget(): { total: number; limit: number | undefined; exceeded: boolean } {
    return {
      total: this.meter?.total ?? 0,
      limit: this.meter?.limit ?? this.deps.tokenBudget,
      exceeded: this.meter?.exceeded ?? false,
    };
  }

  /** Raise the soft cap and wake every pump that paused for it. */
  async raiseBudget(extra: number): Promise<void> {
    const meter = await this.usageMeter();
    if (meter.limit === undefined) throw new Error("No token budget is configured");
    await meter.raise(extra);
    for (const runtime of this.runtimes.values()) runtime.pump.wake();
  }

  /** Stop a project's agents and pump but keep it registered as open (it can be reopened). */
  async stopProject(name: string): Promise<void> {
    validateProjectName(name);
    const state = await this.readState();
    if (!state.projects.some((entry) => entry.name === name))
      throw new Error(`Unknown project: ${name}`);
    const runtime = this.runtimes.get(name);
    if (!runtime) return;
    await runtime.close();
    this.runtimes.delete(name);
    await this.releasePid();
  }

  /** Stop the pump and cancel sessions. Never touches project directories. */
  async closeProject(name: string): Promise<void> {
    validateProjectName(name);
    const state = await this.readState();
    if (!state.projects.some((entry) => entry.name === name))
      throw new Error(`Unknown project: ${name}`);
    const runtime = this.runtimes.get(name);
    if (runtime) {
      await runtime.close();
      this.runtimes.delete(name);
      await this.releasePid();
    }
    await this.mutateState((current) => {
      const entry = current.projects.find((candidate) => candidate.name === name);
      if (entry) entry.open = false;
    });
  }

  /** Stop every running project (dispose, teardown). Registry flags are left as they were. */
  async stopAll(): Promise<void> {
    const open = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.allSettled(open.map((runtime) => runtime.close()));
    this.deps.gates?.cancelAll?.();
    await this.releasePid();
  }
}
