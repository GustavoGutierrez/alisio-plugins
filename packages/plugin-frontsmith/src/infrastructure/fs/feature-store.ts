import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptRecord, AttemptSink } from "../../application/ports/attempt-sink.js";
import {
  FeatureLockedError,
  type FeatureLockHandle,
  type FeatureStore,
  type JobRecord,
  type OpenedFeature,
  type StoredAttempt,
} from "../../application/ports/feature-store.js";
import { canonicalJson } from "../../domain/canonical-json.js";
import { isFeatureId } from "../../domain/ids.js";
import { type FeatureState, validateFeatureState } from "../../domain/state/feature-state.js";
import { migrate, NewerSchemaError, openState } from "../../domain/state/migrations.js";
import { acquireLock, LockHeldError } from "./lock.js";
import { atomicWrite, Mutex, readText } from "./storage.js";

const mutexes = new Map<string, Mutex>();
const mutexFor = (key: string): Mutex => {
  let mutex = mutexes.get(key);
  if (!mutex) {
    mutex = new Mutex();
    mutexes.set(key, mutex);
  }
  return mutex;
};

const MAX_ATTEMPT_FILES = 10_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Features under `<workspace>/.alisio/frontsmith/features/<feature>/` (spec 8.1). */
export class FsFeatureStore implements FeatureStore {
  private directory(root: string, feature: string): string {
    if (!isFeatureId(feature)) throw new Error(`Invalid feature id: ${JSON.stringify(feature)}`);
    return join(root, ".alisio", "frontsmith", "features", feature);
  }

  private statePath(root: string, feature: string): string {
    return join(this.directory(root, feature), "state.json");
  }

  async list(root: string): Promise<string[]> {
    try {
      const entries = await readdir(join(root, ".alisio", "frontsmith", "features"), {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isDirectory() && isFeatureId(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  async read(root: string, feature: string): Promise<OpenedFeature | undefined> {
    const path = this.statePath(root, feature);
    const text = await readText(path);
    if (text === undefined) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new Error(
        `${feature}/state.json is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    const opened = openState(raw);
    if (!opened.state) throw new Error(`${feature}/state.json has no feature state`);
    return { state: opened.state, readOnly: opened.readOnly, version: opened.version };
  }

  async create(root: string, state: FeatureState): Promise<void> {
    const checked = validateFeatureState(state);
    if (!checked.ok)
      throw new Error(
        `Invalid feature: ${checked.errors.map((e) => `${e.pointer} ${e.message}`).join("; ")}`,
      );
    const feature = state.feature;
    await mutexFor(`${root}\u0000${feature}`).run(async () => {
      if ((await readText(this.statePath(root, feature))) !== undefined)
        throw new Error(`Feature ${feature} already exists`);
      await atomicWrite(this.statePath(root, feature), canonicalJson(state));
    });
  }

  async update(
    root: string,
    feature: string,
    mutate: (draft: FeatureState) => void,
    now: string,
  ): Promise<FeatureState> {
    const path = this.statePath(root, feature);
    return mutexFor(`${root}\u0000${feature}`).run(async () => {
      const text = await readText(path);
      if (text === undefined) throw new Error(`Unknown feature: ${feature}`);
      const raw = JSON.parse(text) as unknown;
      const draft = migrate(raw); // throws NewerSchemaError for a newer schema
      mutate(draft);
      draft.updatedAt = now;
      const checked = validateFeatureState(draft);
      if (!checked.ok)
        throw new Error(
          `Invalid state: ${checked.errors.map((e) => `${e.pointer} ${e.message}`).join("; ")}`,
        );
      await atomicWrite(path, canonicalJson(draft));
      return draft;
    });
  }

  attempts(root: string, feature: string): AttemptSink {
    const directory = join(this.directory(root, feature), "attempts");
    const file = (seq: number): string => join(directory, `${String(seq).padStart(4, "0")}.json`);
    return {
      begin: async (attempt: AttemptRecord): Promise<number> => {
        let seq = 0;
        await this.update(
          root,
          feature,
          (draft) => {
            draft.attemptSeq += 1;
            seq = draft.attemptSeq;
          },
          attempt.startedAt,
        );
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await atomicWrite(file(seq), canonicalJson({ seq, ...attempt }));
        return seq;
      },
      finish: async (seq: number, patch: Partial<AttemptRecord>): Promise<void> => {
        await mutexFor(`${root}\u0000${feature}\u0000attempt`).run(async () => {
          const text = await readText(file(seq));
          if (text === undefined) return;
          await atomicWrite(
            file(seq),
            canonicalJson({ ...(JSON.parse(text) as object), ...patch }),
          );
        });
      },
    };
  }

  async listAttempts(root: string, feature: string): Promise<StoredAttempt[]> {
    const directory = join(this.directory(root, feature), "attempts");
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => /^\d{4,}\.json$/.test(name)).sort();
    } catch {
      return [];
    }
    const out: StoredAttempt[] = [];
    for (const name of names.slice(-MAX_ATTEMPT_FILES)) {
      const text = await readText(join(directory, name));
      if (text !== undefined) out.push(JSON.parse(text) as StoredAttempt);
    }
    return out;
  }

  async recoverInterrupted(root: string, feature: string, now: string): Promise<number> {
    const opened = await this.read(root, feature);
    if (!opened || opened.readOnly) return 0;
    const owner = opened.state.job?.ownerPid;
    if (owner !== undefined && isAlive(owner)) return 0;
    let marked = 0;
    const sink = this.attempts(root, feature);
    for (const attempt of await this.listAttempts(root, feature))
      if (attempt.status === "running") {
        await sink.finish(attempt.seq, { status: "interrupted", endedAt: now });
        marked += 1;
      }
    if (opened.state.job) await this.update(root, feature, (draft) => void delete draft.job, now);
    return marked;
  }

  async lock(root: string, feature: string): Promise<FeatureLockHandle> {
    try {
      return await acquireLock(join(this.directory(root, feature), ".lock"));
    } catch (error) {
      if (error instanceof LockHeldError) throw new FeatureLockedError(feature, error.pid);
      throw error;
    }
  }

  async writeJob(root: string, job: JobRecord): Promise<void> {
    await atomicWrite(
      join(this.directory(root, job.feature), "jobs", `${job.id}.json`),
      canonicalJson(job),
    );
  }

  async listJobs(root: string, feature: string): Promise<JobRecord[]> {
    const directory = join(this.directory(root, feature), "jobs");
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return [];
    }
    const out: JobRecord[] = [];
    for (const name of names) {
      const text = await readText(join(directory, name));
      if (text !== undefined) out.push(JSON.parse(text) as JobRecord);
    }
    return out;
  }
}

export { NewerSchemaError };
