import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type Handoff,
  type HandoffLocation,
  handoffFileName,
  type InboxBox,
  PHANTOM_SENDER,
  parseHandoff,
  parseHandoffFileName,
  type StoredHandoff,
  serializeHandoff,
} from "../domain/handoff.js";
import { rolePattern, validateRole } from "../domain/identifiers.js";
import type { Clock } from "../ports/clock.js";
import type { HandoffStore, RecoveryResult, ScanResult } from "../ports/handoff-store.js";
import { atomicWrite, Mutex, readText } from "../storage.js";

const flatKinds = [
  "outbox",
  "sent",
  "failed",
  "audit_pending",
  "pending_approval",
  "join_pending",
] as const;
const inboxBoxes: InboxBox[] = ["new", "in_process", "completed"];

/**
 * File-based durable queue under `<project>/.alisio/swarm/handoffs/<role>/...`. The files are the
 * source of truth: every transition is a rename or an atomic write, and `recover` replays leftovers.
 */
export class FsHandoffStore implements HandoffStore {
  private readonly root: string;
  private readonly mutex = new Mutex();
  private nextSeq: number | undefined;

  constructor(
    projectRoot: string,
    private readonly clock: Clock,
  ) {
    this.root = join(projectRoot, ".alisio", "swarm", "handoffs");
  }

  private dir(location: HandoffLocation): string {
    validateRole(location.role);
    return location.kind === "inbox"
      ? join(this.root, location.role, "inbox", location.box)
      : join(this.root, location.role, location.kind);
  }

  private path(location: HandoffLocation, fileName: string): string {
    return join(this.dir(location), fileName);
  }

  async ensureRoles(roles: string[]): Promise<void> {
    for (const role of roles) {
      validateRole(role);
      for (const kind of flatKinds) {
        await mkdir(join(this.root, role, kind), { recursive: true, mode: 0o700 });
      }
      for (const box of inboxBoxes) {
        await mkdir(join(this.root, role, "inbox", box), { recursive: true, mode: 0o700 });
      }
    }
  }

  private async allocateSeq(): Promise<number> {
    if (this.nextSeq === undefined) {
      const { records } = await this.scan();
      this.nextSeq = records.reduce(
        (max, r) => Math.max(max, parseHandoffFileName(r.fileName)?.seq ?? 0),
        0,
      );
    }
    this.nextSeq += 1;
    return this.nextSeq;
  }

  write(handoff: Handoff, location: HandoffLocation): Promise<StoredHandoff> {
    return this.mutex.run(async () => {
      const seq = await this.allocateSeq();
      const fileName = handoffFileName({
        priority: handoff.priority,
        createdAt: handoff.createdAt,
        seq,
        from: handoff.from,
        to: handoff.to,
      });
      await atomicWrite(this.path(location, fileName), serializeHandoff(handoff));
      return { handoff, location, fileName };
    });
  }

  async move(
    stored: StoredHandoff,
    to: HandoffLocation,
    patch: Partial<Pick<Handoff, "approved" | "completedAt" | "dequeuedAt" | "enqueuedAt">> = {},
  ): Promise<StoredHandoff> {
    const handoff = { ...stored.handoff, ...patch };
    const source = this.path(stored.location, stored.fileName);
    if (Object.keys(patch).length === 0) {
      await rename(source, this.path(to, stored.fileName));
    } else {
      await atomicWrite(this.path(to, stored.fileName), serializeHandoff(handoff));
      await rm(source, { force: true });
    }
    return { handoff, location: to, fileName: stored.fileName };
  }

  async discard(stored: StoredHandoff): Promise<void> {
    await rm(this.path(stored.location, stored.fileName), { force: true });
  }

  private async exists(location: HandoffLocation, fileName: string): Promise<boolean> {
    return (await readText(this.path(location, fileName))) !== undefined;
  }

  async deliver(stored: StoredHandoff): Promise<StoredHandoff[]> {
    const stamped: Handoff = {
      ...stored.handoff,
      enqueuedAt: stored.handoff.enqueuedAt ?? this.clock.now().toISOString(),
    };
    const copies: StoredHandoff[] = [];
    for (const role of stamped.to) {
      const location: HandoffLocation = { kind: "inbox", role, box: "new" };
      // Idempotent: a copy may already sit anywhere in the recipient's inbox after a replay.
      let present = false;
      for (const box of inboxBoxes) {
        present ||= await this.exists({ kind: "inbox", role, box }, stored.fileName);
      }
      if (!present)
        await atomicWrite(this.path(location, stored.fileName), serializeHandoff(stamped));
      copies.push({ handoff: stamped, location, fileName: stored.fileName });
    }
    if (stored.location.kind === "outbox") {
      const sent: HandoffLocation = { kind: "sent", role: stored.location.role };
      await atomicWrite(this.path(sent, stored.fileName), serializeHandoff(stamped));
      await rm(this.path(stored.location, stored.fileName), { force: true });
    }
    return copies;
  }

  async inject(handoff: Handoff): Promise<StoredHandoff[]> {
    if (handoff.from !== PHANTOM_SENDER)
      throw new Error("Only the phantom sender may inject a handoff");
    const seq = await this.mutex.run(() => this.allocateSeq());
    const stamped: Handoff = { ...handoff, enqueuedAt: this.clock.now().toISOString() };
    const fileName = handoffFileName({
      priority: stamped.priority,
      createdAt: stamped.createdAt,
      seq,
      from: stamped.from,
      to: stamped.to,
    });
    const copies: StoredHandoff[] = [];
    for (const role of stamped.to) {
      const location: HandoffLocation = { kind: "inbox", role, box: "new" };
      await atomicWrite(this.path(location, fileName), serializeHandoff(stamped));
      copies.push({ handoff: stamped, location, fileName });
    }
    return copies;
  }

  private async listInbox(role: string, box: InboxBox): Promise<StoredHandoff[]> {
    const location: HandoffLocation = { kind: "inbox", role, box };
    const out: StoredHandoff[] = [];
    for (const fileName of await this.names(location)) {
      try {
        out.push({
          handoff: parseHandoff(await readFile(this.path(location, fileName), "utf8")),
          location,
          fileName,
        });
      } catch {
        // Invalid files surface through scan(); a claim simply skips them.
      }
    }
    return out;
  }

  private async names(location: HandoffLocation): Promise<string[]> {
    try {
      return (await readdir(this.dir(location))).filter((n) => parseHandoffFileName(n));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async pending(role: string): Promise<number> {
    return (await this.names({ kind: "inbox", role, box: "new" })).length;
  }

  claim(role: string, options: { batch?: boolean } = {}): Promise<StoredHandoff[]> {
    return this.mutex.run(async () => {
      const waiting = await this.listInbox(role, "new");
      waiting.sort(
        (a, b) =>
          a.handoff.priority - b.handoff.priority ||
          a.handoff.createdAt.localeCompare(b.handoff.createdAt) ||
          (parseHandoffFileName(a.fileName)?.seq ?? 0) -
            (parseHandoffFileName(b.fileName)?.seq ?? 0),
      );
      const head = waiting[0];
      if (!head) return [];
      const chosen = options.batch
        ? waiting.filter(
            (item) =>
              item.handoff.priority === head.handoff.priority &&
              item.handoff.taskId === head.handoff.taskId,
          )
        : [head];
      const claimed: StoredHandoff[] = [];
      for (const item of chosen) {
        claimed.push(
          await this.move(
            item,
            { kind: "inbox", role, box: "in_process" },
            { dequeuedAt: this.clock.now().toISOString() },
          ),
        );
      }
      return claimed;
    });
  }

  async complete(items: StoredHandoff[]): Promise<StoredHandoff[]> {
    const done: StoredHandoff[] = [];
    for (const item of items) {
      if (item.location.kind !== "inbox") throw new Error("Only inbox items can be completed");
      done.push(
        await this.move(
          item,
          { kind: "inbox", role: item.location.role, box: "completed" },
          { completedAt: this.clock.now().toISOString() },
        ),
      );
    }
    return done;
  }

  async scan(): Promise<ScanResult> {
    const records: StoredHandoff[] = [];
    const invalid: string[] = [];
    let roles: string[] = [];
    try {
      roles = (await readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && rolePattern.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const role of roles) {
      const locations: HandoffLocation[] = [
        ...flatKinds.map((kind): HandoffLocation => ({ kind, role })),
        ...inboxBoxes.map((box): HandoffLocation => ({ kind: "inbox", role, box })),
      ];
      for (const location of locations) {
        for (const fileName of await this.names(location)) {
          try {
            const handoff = parseHandoff(await readFile(this.path(location, fileName), "utf8"));
            records.push({ handoff, location, fileName });
          } catch {
            invalid.push(`${role}/${relativeDir(location)}/${fileName}`);
          }
        }
      }
    }
    return { records, invalid };
  }

  /** Remove every file of one task from every role and location (task deletion). */
  purge(taskId: string): Promise<StoredHandoff[]> {
    return this.mutex.run(async () => {
      const { records } = await this.scan();
      const mine = records.filter((record) => record.handoff.taskId === taskId);
      for (const record of mine) await this.discard(record);
      return mine;
    });
  }

  recover(): Promise<RecoveryResult> {
    return this.mutex.run(async () => {
      const result: RecoveryResult = { redelivered: 0, requeued: 0 };
      const { records } = await this.scan();
      for (const record of records) {
        if (record.location.kind === "outbox") {
          await this.deliver(record);
          result.redelivered += 1;
        } else if (record.location.kind === "inbox" && record.location.box === "in_process") {
          await this.move(record, { kind: "inbox", role: record.location.role, box: "new" });
          result.requeued += 1;
        }
      }
      return result;
    });
  }
}

const relativeDir = (location: HandoffLocation): string =>
  location.kind === "inbox" ? `inbox/${location.box}` : location.kind;
