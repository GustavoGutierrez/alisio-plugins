import {
  DEFAULT_CUSTOM_TIER,
  parseBindingTarget,
  shippedAgentTiers,
} from "../../domain/models/agents.js";
import { parseAgentsMd } from "../../domain/models/agents-md.js";
import { parseModelValue, type Tier } from "../../domain/models/grammar.js";
import {
  describeModelDiagnostic,
  type ModelDiagnostic,
  type ModelLayer,
  validateModelLayer,
} from "../../domain/models/layers.js";
import { type ModelResolution, resolveModel } from "../../domain/models/resolve.js";
import type { ModelSource } from "../../domain/state/feature-state.js";
import type { ModelCatalog } from "../ports/model-catalog.js";
import type { ModelsRuntimeStore } from "../ports/models-runtime-store.js";
import type { ProjectStore } from "../ports/project-store.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

export interface ModelsServiceDeps {
  fsFor(root: string): WorkspaceFs;
  project: ProjectStore;
  runtime: ModelsRuntimeStore;
  sha256(text: string): string;
  /** Default catalog for `check`; callers with a live host pass one per call instead. */
  catalog?: ModelCatalog;
}

export interface ViewOptions {
  /** `api.options.models` of the host (layer 4). */
  hostOptions?: unknown;
}

export interface ModelRow extends ModelResolution {
  custom: boolean;
}

export interface ModelsView {
  rows: ModelRow[];
  /** Any entry here means the configuration fails closed (spec 16.5). */
  errors: ModelDiagnostic[];
  layers: ModelLayer[];
}

export interface CheckResult extends ModelsView {
  /** Selectors were validated against the host's connected models. */
  validated: boolean;
}

export type ChangeResult = { ok: true } | { ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Per-agent model resolution over the five layers, and the runtime layer's writes (spec 16). */
export class ModelsService {
  constructor(private readonly deps: ModelsServiceDeps) {}

  /** Shipped and custom agents with their default tiers; custom ones only from a valid config. */
  private async agents(root: string): Promise<{
    list: Array<{ name: string; tier: Tier; custom: boolean }>;
    errors: ModelDiagnostic[];
  }> {
    const list = Object.entries(shippedAgentTiers).map(([name, tier]) => ({
      name,
      tier,
      custom: false,
    }));
    const config = await this.deps.project.readConfig(root);
    const errors: ModelDiagnostic[] = config.diagnostics.map((d) => ({
      code: d.code === "CFG-001" ? "CFG-001" : "CFG-002",
      layer: "config",
      message: `${d.pointer || "/"}: ${d.message}`,
    }));
    for (const custom of config.config.agents.custom)
      list.push({ name: custom.name, tier: custom.tier ?? DEFAULT_CUSTOM_TIER, custom: true });
    return { list, errors };
  }

  async view(root: string, options: ViewOptions = {}): Promise<ModelsView> {
    const { deps } = this;
    const { list, errors } = await this.agents(root);
    const knownAgents = list.map((agent) => agent.name);
    const layers: ModelLayer[] = [];
    const fs = deps.fsFor(root);

    const runtime = await deps.runtime.read(root);
    if (runtime.state === "invalid")
      errors.push({
        code: "CFG-002",
        layer: "runtime",
        message: `models.runtime.json is not valid JSON: ${runtime.message}`,
      });
    else if (runtime.state === "ok") {
      const checked = validateModelLayer(runtime.value, { layer: "runtime", knownAgents });
      if (checked.ok) layers.push(checked.layer);
      else errors.push(...checked.diagnostics);
    }

    const agentsMd = await fs.read("AGENTS.md");
    if (agentsMd.kind === "text") {
      const parsed = parseAgentsMd(agentsMd.text, { knownAgents, sha256: deps.sha256 });
      if (parsed.diagnostics.length > 0) errors.push(...parsed.diagnostics);
      else if (parsed.present)
        layers.push({ name: "agents-md", tiers: parsed.tiers, agents: parsed.agents });
    }

    const configFile = await fs.read(".frontsmith/config.json");
    if (configFile.kind === "text") {
      let raw: unknown;
      try {
        raw = JSON.parse(configFile.text);
      } catch {
        raw = undefined; // reported by the config diagnostics above
      }
      if (isRecord(raw) && raw.models !== undefined) {
        const checked = validateModelLayer(raw.models, { layer: "config", knownAgents });
        if (checked.ok) layers.push(checked.layer);
        else if (!errors.some((e) => e.layer === "config")) errors.push(...checked.diagnostics);
      }
    }

    if (options.hostOptions !== undefined && options.hostOptions !== null) {
      const checked = validateModelLayer(options.hostOptions, {
        layer: "host-options",
        knownAgents,
      });
      if (checked.ok) layers.push(checked.layer);
      else errors.push(...checked.diagnostics);
    }

    const rows = list.map((agent) => ({
      ...resolveModel(agent.name, agent.tier, layers),
      custom: agent.custom,
    }));
    return { rows, errors, layers };
  }

  /** `view` plus validation of every distinct selector against the host catalog (FSM-007). */
  async check(
    root: string,
    options: ViewOptions & { catalog?: ModelCatalog } = {},
  ): Promise<CheckResult> {
    const view = await this.view(root, options);
    const catalog = options.catalog ?? this.deps.catalog;
    if (!catalog) return { ...view, validated: false };
    const uses = new Map<string, Array<{ layer: ModelLayer["name"]; key: string }>>();
    for (const layer of view.layers) {
      for (const [tier, value] of Object.entries(layer.tiers))
        if (value !== "inherit") addUse(uses, value, layer.name, `tier.${tier}`);
      for (const [agent, value] of Object.entries(layer.agents))
        if (value !== "inherit" && !value.startsWith("@"))
          addUse(uses, value, layer.name, `agent.${agent}`);
    }
    const errors = [...view.errors];
    for (const [selector, places] of [...uses].sort(([a], [b]) => a.localeCompare(b))) {
      const outcome = await catalog.resolve(selector);
      if (outcome.ok) continue;
      for (const place of places)
        errors.push({
          code: "FSM-007",
          layer: place.layer,
          message: `${place.key} = ${selector}: ${outcome.message}`,
        });
    }
    return { ...view, errors, validated: true };
  }

  /**
   * The model of one agent for a run (spec 16.3 to 16.5). Fails closed: any diagnostic in any layer
   * refuses the run with the layer named, and a selector the host cannot resolve (checked when a
   * catalog is given) refuses it too. A resolved selector is returned in its canonical form.
   */
  async forRun(
    root: string,
    agent: string,
    options: ViewOptions & { catalog?: ModelCatalog } = {},
  ): Promise<
    | { ok: true; model: string | null; source: ModelSource; trail: ModelResolution["trail"] }
    | { ok: false; message: string }
  > {
    const view = await this.view(root, options);
    const first = view.errors[0];
    if (first) return { ok: false, message: describeModelDiagnostic(first) };
    const row = view.rows.find((entry) => entry.agent === agent);
    if (!row) return { ok: false, message: `FSM-004 unknown agent ${agent}` };
    if (row.model === null) return { ok: true, model: null, source: row.source, trail: row.trail };
    const catalog = options.catalog ?? this.deps.catalog;
    if (!catalog) return { ok: true, model: row.model, source: row.source, trail: row.trail };
    const outcome = await catalog.resolve(row.model);
    if (!outcome.ok)
      return {
        ok: false,
        message: `Model configuration error in ${row.source}: FSM-007 ${row.model}: ${outcome.message}`,
      };
    return { ok: true, model: outcome.reference, source: row.source, trail: row.trail };
  }

  async explain(
    root: string,
    agent: string,
    options: ViewOptions = {},
  ): Promise<{ resolution: ModelResolution; errors: ModelDiagnostic[] } | undefined> {
    const view = await this.view(root, options);
    const row = view.rows.find((entry) => entry.agent === agent);
    return row ? { resolution: row, errors: view.errors } : undefined;
  }

  private async mutate(
    root: string,
    target: string,
    change: (
      current: { tiers: Record<string, string>; agents: Record<string, string> },
      name: string,
      kind: "tier" | "agent",
    ) => ChangeResult | undefined,
    value?: string,
  ): Promise<ChangeResult> {
    const parsedTarget = parseBindingTarget(target);
    if (!parsedTarget)
      return {
        ok: false,
        message: `Invalid target ${target}: use tier.reasoning, tier.standard, tier.fast or agent.<name>`,
      };
    const { list } = await this.agents(root);
    if (parsedTarget.kind === "agent" && !list.some((agent) => agent.name === parsedTarget.name))
      return { ok: false, message: `FSM-004 unknown agent ${parsedTarget.name}` };
    if (value !== undefined) {
      const parsed = parseModelValue(value, { tierRef: parsedTarget.kind === "agent" });
      if (!parsed.ok) return { ok: false, message: `${parsed.code} ${parsed.message}` };
    }
    const stored = await this.deps.runtime.read(root);
    if (stored.state === "invalid")
      return {
        ok: false,
        message: `The runtime layer .alisio/frontsmith/models.runtime.json is not valid JSON (${stored.message}); fix or delete it with /frontsmith:models reset.`,
      };
    const current = { tiers: {} as Record<string, string>, agents: {} as Record<string, string> };
    if (stored.state === "ok") {
      const checked = validateModelLayer(stored.value, {
        layer: "runtime",
        knownAgents: list.map((agent) => agent.name),
      });
      if (!checked.ok)
        return {
          ok: false,
          message: `The runtime layer is invalid; run /frontsmith:models reset. ${checked.diagnostics.map(describeModelDiagnostic).join("; ")}`,
        };
      Object.assign(current.tiers, checked.layer.tiers);
      Object.assign(current.agents, checked.layer.agents);
    }
    const refused = change(current, parsedTarget.name, parsedTarget.kind);
    if (refused) return refused;
    await this.deps.runtime.write(root, current);
    return { ok: true };
  }

  set(root: string, target: string, value: string): Promise<ChangeResult> {
    return this.mutate(
      root,
      target,
      (current, name, kind) => {
        (kind === "tier" ? current.tiers : current.agents)[name] = value;
        return undefined;
      },
      value,
    );
  }

  unset(root: string, target: string): Promise<ChangeResult> {
    return this.mutate(root, target, (current, name, kind) => {
      const bucket = kind === "tier" ? current.tiers : current.agents;
      if (bucket[name] === undefined)
        return { ok: false, message: `${target} is not set in the runtime layer` };
      delete bucket[name];
      return undefined;
    });
  }

  async reset(root: string): Promise<{ ok: true; removed: boolean }> {
    return { ok: true, removed: await this.deps.runtime.remove(root) };
  }

  /** Connected model references for `pick`; empty when the host cannot list them. */
  async references(catalog: ModelCatalog | undefined): Promise<string[]> {
    if (!catalog) return [];
    try {
      return [...new Set(await catalog.list())].sort();
    } catch {
      return [];
    }
  }
}

function addUse(
  uses: Map<string, Array<{ layer: ModelLayer["name"]; key: string }>>,
  selector: string,
  layer: ModelLayer["name"],
  key: string,
): void {
  const places = uses.get(selector) ?? [];
  places.push({ layer, key });
  uses.set(selector, places);
}
