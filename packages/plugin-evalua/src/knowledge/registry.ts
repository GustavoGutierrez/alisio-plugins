import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { Level } from "../types.js";
import { evaluateItemCheck } from "./check-item.js";
import { CheckCollector, type CheckReport } from "./report.js";
import {
  KB_CALIBRATION,
  KB_COLLISION,
  KB_ITEM_CHECK,
  KB_OBJECTIVES,
  KB_REQUIRES,
  KB_SCHEMA,
  KB_SOURCE,
  validatePackMeta,
  validateStaticItem,
  validateTopic,
} from "./schema.js";
import type {
  Layer,
  LoadedKnowledge,
  LoadedPack,
  LoadedTopic,
  PackMeta,
  StaticItem,
  Topic,
} from "./types.js";

export interface KnowledgeLimits {
  maxPackBytes: number;
  maxTopicBytes: number;
  maxItemBytes: number;
  /** YAML aliases are refused by default (an alias bomb is a load failure). */
  maxAliasCount: number;
  maxPacks: number;
  maxTopicsPerPack: number;
}

export const defaultKnowledgeLimits: KnowledgeLimits = {
  maxPackBytes: 64 * 1024,
  maxTopicBytes: 256 * 1024,
  maxItemBytes: 512 * 1024,
  maxAliasCount: 0,
  maxPacks: 64,
  maxTopicsPerPack: 512,
};

export interface LoadOptions {
  /** Shipped packs directory (`knowledge/packs`). */
  shippedDir: string;
  /** Workspace pack directories (`<root>/knowledge-packs`), highest precedence last. */
  workspaceDirs?: readonly string[];
  /** Registered item family ids. */
  families: readonly string[];
  limits?: Partial<KnowledgeLimits>;
}

interface DraftTopic extends Topic {
  dir: string;
  bankItems: StaticItem[];
}

interface DraftPack {
  meta: PackMeta;
  dir: string;
  layer: Layer;
  topics: DraftTopic[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readYaml(
  path: string,
  subject: string,
  maxBytes: number,
  limits: KnowledgeLimits,
  collector: CheckCollector,
): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      collector.error(KB_SOURCE, subject, `file not found: ${basename(path)}`);
      return undefined;
    }
    throw error;
  }
  if (Buffer.byteLength(text) > maxBytes) {
    collector.error(KB_SCHEMA, subject, `${basename(path)} exceeds the ${maxBytes} byte limit`);
    return undefined;
  }
  try {
    return parse(text, {
      schema: "core",
      maxAliasCount: limits.maxAliasCount,
      uniqueKeys: true,
    });
  } catch (error) {
    collector.error(
      KB_SCHEMA,
      subject,
      `${basename(path)} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

async function readStaticItems(
  path: string,
  subject: string,
  source: string,
  limits: KnowledgeLimits,
  collector: CheckCollector,
): Promise<StaticItem[]> {
  const parsed = await readYaml(path, subject, limits.maxItemBytes, limits, collector);
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    collector.error(KB_SCHEMA, subject, `${source} must contain a list of items`);
    return [];
  }
  const items: StaticItem[] = [];
  for (const [index, entry] of parsed.entries()) {
    const itemSubject = `${subject} item ${index + 1}`;
    const item = validateStaticItem(entry, itemSubject, source, collector);
    if (item === undefined) continue;
    const reason = evaluateItemCheck(item);
    if (reason !== undefined) {
      collector.error(KB_ITEM_CHECK, `${subject} item ${item.id}`, reason);
      continue;
    }
    items.push(item);
  }
  return items;
}

async function readPack(
  dir: string,
  layer: Layer,
  families: readonly string[],
  limits: KnowledgeLimits,
  collector: CheckCollector,
): Promise<DraftPack | undefined> {
  const folder = basename(dir);
  const packPath = join(dir, "pack.yaml");
  const parsed = await readYaml(packPath, `pack ${folder}`, limits.maxPackBytes, limits, collector);
  if (parsed === undefined) return undefined;
  const rawId = isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : folder;
  const meta = validatePackMeta(parsed, `pack ${rawId}`, collector);
  if (meta === undefined) return undefined;

  const topicsDir = join(dir, "topics");
  let files: string[] = [];
  try {
    files = (await readdir(topicsDir)).filter((name) => name.endsWith(".yaml")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (files.length > limits.maxTopicsPerPack) {
    collector.error(
      KB_SCHEMA,
      `pack ${meta.id}`,
      `more than ${limits.maxTopicsPerPack} topic files`,
    );
  }
  const topics: DraftTopic[] = [];
  const seenIds = new Set<string>();
  const seenCodes = new Set<string>();
  for (const file of files) {
    const subject = `pack ${meta.id} ${file}`;
    const topicParsed = await readYaml(
      join(topicsDir, file),
      subject,
      limits.maxTopicBytes,
      limits,
      collector,
    );
    if (topicParsed === undefined) continue;
    const topic = validateTopic(topicParsed, subject, collector);
    if (topic === undefined) continue;
    if (seenIds.has(topic.id)) {
      collector.error(KB_COLLISION, `pack ${meta.id}`, `duplicate topic id "${topic.id}"`);
      continue;
    }
    if (seenCodes.has(topic.code)) {
      collector.error(
        KB_COLLISION,
        `pack ${meta.id}`,
        `duplicate topic code "${topic.code}" (topic ${topic.id})`,
      );
      continue;
    }
    seenIds.add(topic.id);
    seenCodes.add(topic.code);
    const bankItems: StaticItem[] = [];
    for (const source of topic.sources) {
      if (source.kind === "family") {
        if (!families.includes(source.family)) {
          collector.error(
            KB_SOURCE,
            `pack ${meta.id}/${topic.id}`,
            `unknown item family "${source.family}"`,
          );
        }
        continue;
      }
      bankItems.push(
        ...(await readStaticItems(
          join(dir, source.file),
          `pack ${meta.id}/${topic.id}`,
          source.file,
          limits,
          collector,
        )),
      );
    }
    topics.push({ ...topic, dir, bankItems });
  }
  return { meta, dir, layer, topics };
}

async function readPackLayer(
  dir: string,
  layer: Layer,
  families: readonly string[],
  limits: KnowledgeLimits,
  collector: CheckCollector,
): Promise<DraftPack[]> {
  const packs: DraftPack[] = [];
  for (const folder of await listDirectories(dir)) {
    const pack = await readPack(join(dir, folder), layer, families, limits, collector);
    if (pack !== undefined) packs.push(pack);
  }
  return packs;
}

function resolveExtends(packs: DraftPack[], collector: CheckCollector): Map<string, DraftTopic[]> {
  const byId = new Map(packs.map((pack) => [pack.meta.id, pack]));
  for (const pack of packs) {
    for (const required of pack.meta.requires) {
      if (!byId.has(required)) {
        collector.error(
          KB_REQUIRES,
          `pack ${pack.meta.id}`,
          `required pack "${required}" was not found`,
        );
      }
    }
    if (pack.meta.extends !== null && !byId.has(pack.meta.extends)) {
      collector.error(
        KB_REQUIRES,
        `pack ${pack.meta.id}`,
        `extended pack "${pack.meta.extends}" was not found`,
      );
    }
  }

  const graph = new Map(
    packs.map((pack) => [
      pack.meta.id,
      [...pack.meta.requires, ...(pack.meta.extends === null ? [] : [pack.meta.extends])],
    ]),
  );
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: string[]): void => {
    const current = state.get(id);
    if (current === "done") return;
    if (current === "visiting") {
      collector.error(
        KB_REQUIRES,
        `pack ${id}`,
        `requires/extends cycle: ${[...trail, id].join(" -> ")}`,
      );
      return;
    }
    state.set(id, "visiting");
    for (const next of graph.get(id) ?? []) {
      if (byId.has(next)) visit(next, [...trail, id]);
    }
    state.set(id, "done");
  };
  for (const pack of packs) visit(pack.meta.id, []);

  const effective = new Map<string, DraftTopic[]>();
  const compute = (id: string): DraftTopic[] => {
    const memo = effective.get(id);
    if (memo !== undefined) return memo;
    const pack = byId.get(id);
    if (pack === undefined) return [];
    const inherited =
      pack.meta.extends === null ? [] : compute(pack.meta.extends).map((topic) => ({ ...topic }));
    const byTopicId = new Map(inherited.map((topic) => [topic.id, topic]));
    for (const topic of pack.topics) {
      if (byTopicId.has(topic.id) && !pack.meta.overrides) {
        collector.error(
          KB_COLLISION,
          `pack ${pack.meta.id}`,
          `topic "${topic.id}" already comes from the extended pack; set overrides: true to replace it`,
        );
        continue;
      }
      byTopicId.set(topic.id, topic);
    }
    const result = [...byTopicId.values()].sort((a, b) => a.id.localeCompare(b.id));
    effective.set(id, result);
    return result;
  };
  for (const pack of packs) compute(pack.meta.id);
  return effective;
}

function checkObjectives(pack: LoadedPack, collector: CheckCollector): void {
  for (const topic of pack.topics) {
    const declared = new Set<Level>();
    for (const source of topic.sources) {
      if (source.kind === "family") for (const level of source.levels) declared.add(level);
    }
    for (const level of declared) {
      const covered = topic.objectives.some((objective) => objective.levels.includes(level));
      if (!covered) {
        collector.warning(
          KB_OBJECTIVES,
          `pack ${topic.fullId}`,
          `no objective covers the declared level "${level}"`,
        );
      }
    }
  }
}

function checkPrerequisites(topics: LoadedTopic[], collector: CheckCollector): void {
  const fullIds = new Set(topics.map((topic) => topic.fullId));
  const bareCounts = new Map<string, number>();
  for (const topic of topics) {
    bareCounts.set(topic.id, (bareCounts.get(topic.id) ?? 0) + 1);
  }
  for (const topic of topics) {
    for (const prerequisite of topic.prerequisites) {
      const known = prerequisite.includes("/")
        ? fullIds.has(prerequisite)
        : (bareCounts.get(prerequisite) ?? 0) > 0;
      if (!known) {
        collector.error(
          KB_SOURCE,
          `pack ${topic.fullId}`,
          `unknown prerequisite "${prerequisite}"`,
        );
      }
    }
  }
}

/** The knowledge-base check catalog ids this loader can emit (spec 12.2). */
export const knowledgeCheckIds = [
  KB_SCHEMA,
  KB_COLLISION,
  KB_REQUIRES,
  KB_SOURCE,
  KB_CALIBRATION,
  KB_OBJECTIVES,
  KB_ITEM_CHECK,
] as const;

/** Loads and validates every knowledge pack, merging layers (workspace > shipped). */
export async function loadKnowledge(options: LoadOptions): Promise<LoadedKnowledge> {
  const limits: KnowledgeLimits = { ...defaultKnowledgeLimits, ...options.limits };
  const collector = new CheckCollector();

  const drafts: DraftPack[] = [];
  drafts.push(
    ...(await readPackLayer(options.shippedDir, "shipped", options.families, limits, collector)),
  );
  for (const dir of options.workspaceDirs ?? []) {
    drafts.push(...(await readPackLayer(dir, "workspace", options.families, limits, collector)));
  }
  if (drafts.length > limits.maxPacks) {
    collector.error(KB_SCHEMA, "knowledge", `more than ${limits.maxPacks} packs were found`);
  }

  const byId = new Map<string, DraftPack>();
  for (const draft of drafts) {
    const existing = byId.get(draft.meta.id);
    if (existing === undefined) {
      byId.set(draft.meta.id, draft);
      continue;
    }
    if (draft.layer === "workspace" && draft.meta.overrides) {
      byId.set(draft.meta.id, draft);
      continue;
    }
    collector.error(
      KB_COLLISION,
      `pack ${draft.meta.id}`,
      `id collision with the ${existing.layer} pack; set overrides: true to replace it`,
    );
  }

  const byCode = new Map<string, string>();
  for (const pack of byId.values()) {
    const owner = byCode.get(pack.meta.code);
    if (owner !== undefined && owner !== pack.meta.id) {
      collector.error(
        KB_COLLISION,
        `pack ${pack.meta.id}`,
        `code "${pack.meta.code}" is already used by pack ${owner}`,
      );
    } else {
      byCode.set(pack.meta.code, pack.meta.id);
    }
  }

  const effective = resolveExtends([...byId.values()], collector);
  const packs: LoadedPack[] = [...byId.values()]
    .map((draft) => {
      const topics = (effective.get(draft.meta.id) ?? draft.topics)
        .map((topic) => ({
          ...topic,
          packId: draft.meta.id,
          fullId: `${draft.meta.id}/${topic.id}`,
        }))
        .sort((a, b) => a.fullId.localeCompare(b.fullId));
      return { ...draft.meta, layer: draft.layer, dir: draft.dir, topics };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const topics = packs.flatMap((pack) => pack.topics);
  for (const pack of packs) checkObjectives(pack, collector);
  checkPrerequisites(topics, collector);

  const report: CheckReport = collector.report();
  return { packs, topics, report };
}
