import type { AttentionItem } from "../domain/attention.js";
import { atomicWrite, readText } from "../storage.js";

interface UsageFile {
  schemaVersion: 1;
  total: number;
  /** Tokens the operator added on top of the configured budget. */
  raisedBy: number;
}

export interface UsageMeterOptions {
  file: string;
  /** `options.tokenBudget`: a soft cap on total tokens; absent means unlimited. */
  limit?: number;
}

/**
 * Swarm-wide token meter (spec 8.4). The budget is a soft cap: crossing it pauses the pumps from
 * starting new runs and raises a decision; runs already in flight finish. Persisted so a restart
 * does not reset the spend.
 */
export class UsageMeter {
  private constructor(
    private readonly file: string,
    private readonly base: number | undefined,
    private data: UsageFile,
  ) {}

  static async open(options: UsageMeterOptions): Promise<UsageMeter> {
    let data: UsageFile = { schemaVersion: 1, total: 0, raisedBy: 0 };
    const raw = await readText(options.file);
    if (raw !== undefined) {
      try {
        const parsed = JSON.parse(raw) as Partial<UsageFile>;
        if (
          parsed.schemaVersion === 1 &&
          Number.isFinite(parsed.total) &&
          Number.isFinite(parsed.raisedBy)
        ) {
          data = parsed as UsageFile;
        }
      } catch {
        // A corrupt meter starts from zero: it only guards cost, never correctness.
      }
    }
    return new UsageMeter(options.file, options.limit, data);
  }

  get total(): number {
    return this.data.total;
  }

  /** Effective limit including raises, or `undefined` when unlimited. */
  get limit(): number | undefined {
    return this.base === undefined ? undefined : this.base + this.data.raisedBy;
  }

  get exceeded(): boolean {
    const limit = this.limit;
    return limit !== undefined && this.data.total >= limit;
  }

  private save(): Promise<void> {
    return atomicWrite(this.file, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  /** Add spent tokens. Returns true exactly when this call crossed the limit. */
  async record(tokens: number): Promise<boolean> {
    if (!Number.isFinite(tokens) || tokens <= 0) return false;
    const before = this.exceeded;
    this.data = { ...this.data, total: this.data.total + Math.round(tokens) };
    await this.save();
    return !before && this.exceeded;
  }

  async raise(extra: number): Promise<void> {
    if (!Number.isFinite(extra) || extra <= 0)
      throw new Error("The extra budget must be a positive number");
    this.data = { ...this.data, raisedBy: this.data.raisedBy + Math.round(extra) };
    await this.save();
  }
}

/** The decision item raised while the soft cap is exceeded. */
export function budgetAttention(
  project: string,
  meter: UsageMeter | undefined,
  createdAt: string,
): AttentionItem | undefined {
  if (!meter?.exceeded) return undefined;
  return {
    id: `decision:${project}:budget`,
    kind: "decision",
    project,
    task: "budget",
    createdAt,
    actions: ["raise", "stop"],
    detail: `The token budget of ${meter.limit} is reached (${meter.total} used); no new agent runs start until you raise it`,
  };
}
