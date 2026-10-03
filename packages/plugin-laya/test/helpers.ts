import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Clock } from "../src/runtime/supervisor.js";

interface Timer {
  id: number;
  at: number;
  fn: () => void;
}

/** A manual clock: timers only fire when `advance` is called. */
export class FakeClock implements Clock {
  private time = 0;
  private nextId = 1;
  private timers: Timer[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer = { id: this.nextId++, at: this.time + ms, fn };
    this.timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  pending(): number {
    return this.timers.length;
  }

  /** Let pending promise continuations run. */
  async flush(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    await this.flush();
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.fn();
      await this.flush();
    }
    this.time = target;
    await this.flush();
  }
}

export class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = null;
  signals: NodeJS.Signals[] = [];
  /** Signals this fake ignores (like a hung server). */
  ignore = new Set<NodeJS.Signals>();

  constructor(pid = 4000 + Math.floor(Math.random() * 1000)) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (this.ignore.has(signal) || this.exitCode !== null || this.signalCode !== null) return true;
    this.killed = true;
    queueMicrotask(() => this.exit(null, signal));
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}
