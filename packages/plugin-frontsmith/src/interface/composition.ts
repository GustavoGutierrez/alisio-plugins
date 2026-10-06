import { randomUUID } from "node:crypto";
import type { ModelBinding } from "../application/agents/delegate.js";
import { ArchitectureService } from "../application/architecture/service.js";
import { FidelityService } from "../application/checks/fidelity-run.js";
import { engineValidators } from "../application/engines/index.js";
import { ModelsService } from "../application/models/service.js";
import { type AgentRunner, nullAgentRunner } from "../application/ports/agent-runner.js";
import type { BrowserProbe } from "../application/ports/browser-probe.js";
import type { Clock } from "../application/ports/clock.js";
import { systemClock } from "../application/ports/clock.js";
import type { DevServer } from "../application/ports/dev-server.js";
import type { ModelCatalog } from "../application/ports/model-catalog.js";
import type { ProcessRunner } from "../application/ports/process-runner.js";
import { RulesService } from "../application/rules/rules-service.js";
import { FrontsmithServices } from "../application/services.js";
import { TokensService } from "../application/tokens/service.js";
import type { WorkflowDeps } from "../application/workflow/env.js";
import { JobManager } from "../application/workflow/jobs.js";
import type { AgentProfile } from "../domain/agents/roster.js";
import { DefaultFileAnalyzer } from "../infrastructure/analysis/file-analyzer.js";
import { DefaultImportGraphBuilder } from "../infrastructure/analysis/graph-builder.js";
import { sha256 } from "../infrastructure/crypto/sha256.js";
import { FsArchitectureStore } from "../infrastructure/fs/architecture-store.js";
import { FsAssetReader } from "../infrastructure/fs/asset-reader.js";
import { FsFeatureStore } from "../infrastructure/fs/feature-store.js";
import { FsIntegrityReader } from "../infrastructure/fs/integrity.js";
import { FsModelsRuntimeStore } from "../infrastructure/fs/models-runtime-store.js";
import { FsProjectStore } from "../infrastructure/fs/project-store.js";
import { FsSourceReader } from "../infrastructure/fs/source-reader.js";
import { ensureIgnoreEntries } from "../infrastructure/fs/storage.js";
import { NodeModuleResolver, NodeWorkspaceFs } from "../infrastructure/fs/workspace-fs.js";
import { FsWorkspaceWriter } from "../infrastructure/fs/workspace-writer.js";
import { GitCli } from "../infrastructure/git/git-cli.js";
import { packageVersion } from "../infrastructure/package-info.js";
import {
  loadAriaCatalog,
  loadPairGraph,
  loadPaletteCatalog,
  loadPatternsCatalog,
} from "../infrastructure/packs/catalog-loader.js";
import { FsPackStore } from "../infrastructure/packs/loader.js";
import { nodePngCodec } from "../infrastructure/png/codec.js";
import { PlaywrightProbe } from "../infrastructure/probe/playwright-probe.js";
import { NodeDevServer } from "../infrastructure/process/dev-server.js";
import { ProcessExec } from "../infrastructure/process/process-exec.js";
import type { ToolDeps } from "./plugin/tools.js";

/** Test seams and the host-bound pieces the plugin supplies; the CLI uses the defaults. */
export interface ComposeOptions {
  clock?: Clock;
  /** Child sessions; the CLI has none (`NullAgentRunner`, spec 10.7). */
  runner?: AgentRunner;
  /** Agent files with their skills; the plugin entry supplies `loadAgentProfile`. */
  profiles?: (agent: string) => Promise<AgentProfile>;
  process?: ProcessRunner;
  /** `api.options.models` (layer 4) and the host's model catalog, when a host is present. */
  hostOptions?: () => unknown;
  catalog?: () => ModelCatalog | undefined;
  newId?: () => string;
  version?: string;
  /** Test seams of the visual-fidelity pipeline: the browser probe and the dev server. */
  probe?: BrowserProbe;
  server?: DevServer;
  /** Visual-fidelity capability (P9). */
  fidelity?: WorkflowDeps["fidelity"];
}

export interface Composition {
  tools: ToolDeps;
  rules: RulesService;
  architecture: ArchitectureService;
  tokens: TokensService;
  models: ModelsService;
  services: FrontsmithServices;
}

/** The production wiring of ports to adapters, shared by the plugin and the CLI. */
export function compose(options: ComposeOptions = {}): Composition {
  const clock = options.clock ?? systemClock;
  const processRunner = options.process ?? new ProcessExec();
  const git = new GitCli(new ProcessExec());
  const analyzer = new DefaultFileAnalyzer();
  const resolver = new NodeModuleResolver();
  const fsFor = (root: string) => new NodeWorkspaceFs(root, { git });
  let aria: ReturnType<typeof loadAriaCatalog> | undefined;
  const project = new FsProjectStore();
  const graphBuilder = new DefaultImportGraphBuilder();
  let palette: ReturnType<typeof loadPaletteCatalog> | undefined;
  let pairGraph: ReturnType<typeof loadPairGraph> | undefined;
  const rules = new RulesService({
    fsFor,
    packs: new FsPackStore(engineValidators),
    project,
    resolver,
    analyzer,
    graphBuilder,
    aria: () => {
      aria ??= loadAriaCatalog();
      return aria;
    },
    clock,
    validators: engineValidators,
  });
  const architecture = new ArchitectureService({
    fsFor,
    project,
    store: new FsArchitectureStore(),
    analyzer,
    graphBuilder,
  });
  const models = new ModelsService({
    fsFor,
    project,
    runtime: new FsModelsRuntimeStore(),
    sha256,
  });
  const writer = new FsWorkspaceWriter();
  const tokens = new TokensService({
    fsFor,
    project,
    rules,
    analyzer,
    writer,
    palette: () => (palette ??= loadPaletteCatalog()),
    pairGraph: () => (pairGraph ??= loadPairGraph()),
    sha256,
  });
  const binding: ModelBinding = {
    resolve: async (root, agent) => {
      const catalog = options.catalog?.();
      const outcome = await models.forRun(root, agent, {
        hostOptions: options.hostOptions?.(),
        ...(catalog ? { catalog } : {}),
      });
      return outcome.ok ? { ok: true, model: outcome.model, source: outcome.source } : outcome;
    },
  };
  const runner = options.runner ?? nullAgentRunner;
  const store = new FsFeatureStore();
  const integrity = new FsIntegrityReader();
  const assets = new FsAssetReader();
  const browserEnv: Record<string, string> = {};
  for (const key of ["FRONTSMITH_BROWSER_EXECUTABLE", "FRONTSMITH_BROWSER_NO_SANDBOX"]) {
    const value = process.env[key];
    if (value !== undefined) browserEnv[key] = value;
  }
  const fidelity = new FidelityService({
    fsFor,
    store,
    project,
    probe:
      options.probe ??
      new PlaywrightProbe({
        process: processRunner,
        writer,
        readText: async (root, relative) => {
          const read = await fsFor(root).read(relative);
          return read.kind === "text" ? read.text : undefined;
        },
        env: browserEnv,
      }),
    png: nodePngCodec,
    assets,
    writer,
    integrity,
    server: options.server ?? new NodeDevServer(),
    clock,
    sha256,
  });
  const deps: WorkflowDeps = {
    store,
    project,
    fsFor,
    writer,
    rules,
    architecture,
    tokens,
    agents: {
      runner,
      profiles:
        options.profiles ??
        (async (agent) => {
          throw new Error(`No agent resources are available for ${agent}`);
        }),
      models: binding,
      clock,
    },
    process: processRunner,
    git,
    integrity,
    assets,
    resolver,
    analyzer,
    sources: new FsSourceReader(),
    patterns: () => loadPatternsCatalog(),
    modelProblems: async (root) => {
      const catalog = options.catalog?.();
      const view = await models.check(root, {
        hostOptions: options.hostOptions?.(),
        ...(catalog ? { catalog } : {}),
      });
      return view.errors.map((e) => `${e.code} ${e.layer}: ${e.message}`);
    },
    jobs: new JobManager({
      store,
      clock,
      newId: options.newId ?? (() => randomUUID().slice(0, 8)),
      pid: process.pid,
    }),
    clock,
    sha256,
    version: options.version ?? packageVersion(),
    newId: options.newId ?? (() => `r${randomUUID().slice(0, 8)}`),
    ignore: async (root, entries) => ensureIgnoreEntries(`${root}/.gitignore`, entries),
    fidelity: options.fidelity ?? fidelity,
  };
  return {
    tools: { fsFor, resolver, analyzer },
    architecture,
    rules,
    models,
    tokens,
    services: new FrontsmithServices(fidelity, deps, rules, architecture, tokens, models),
  };
}
