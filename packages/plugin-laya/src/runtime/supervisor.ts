/**
 * Process supervisor for the Laya server. A subprocess is never a sandbox: this module only
 * manages its lifecycle (lazy start, readiness, crash backoff, bounded shutdown).
 *
 * `stopped -> starting -> warming -> ready -> stopping -> stopped`, plus `failed` and `backoff`.
 * Every wait goes through the injected `Clock`, so the whole machine is testable deterministically.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { LayaWireRequest } from "../protocol/codec.js";
import type { RuntimeSnapshot, RuntimeStatus } from "../provider.js";
import type { LayaTransport } from "../transport/http.js";
import type { Pidfile } from "./pidfile.js";

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export type SupervisorState =
  | "stopped"
  | "starting"
  | "warming"
  | "ready"
  | "stopping"
  | "failed"
  | "backoff";

export type SpawnFn = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdio: ["ignore", "pipe", "pipe"];
    shell: false;
    windowsHide: true;
  },
) => ChildProcess;

export interface SupervisorOptions {
  command: () => { file: string; args: string[] } | null;
  cwd: string;
  buildEnv: (port: number, token: string) => Record<string, string>;
  pidfile: Pick<Pidfile, "write" | "remove" | "reapOrphan">;
  makeTransport: (port: number, token: string) => LayaTransport;
  warmupWire: LayaWireRequest;
  spawn?: SpawnFn;
  pickPort?: () => Promise<number>;
  clock?: Clock;
  /** Allow one automatic restart after the first crash (used with `preload`). */
  eagerRestart?: boolean;
  startDeadlineMs?: number;
  warmupDeadlineMs?: number;
  pollMs?: number;
  stopGraceMs?: number;
  maxFailures?: number;
  failureWindowMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  portRetries?: number;
  /** Uptime after which a crash starts a fresh failure streak. */
  stableMs?: number;
  onChange?: () => void;
}

export interface SupervisorStatus {
  state: SupervisorState;
  detail?: string;
  restarts: number;
  lastError?: string;
  nextRetryAt?: number;
  latencyMedianMs?: number;
}

const ADDRESS_IN_USE = /address already in use|EADDRINUSE|Errno 98|10048/i;
const RING_BYTES = 8 * 1024;

export async function pickLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

class Ring {
  private text = "";
  push(chunk: Buffer | string): void {
    this.text = (this.text + chunk.toString()).slice(-RING_BYTES);
  }
  read(token?: string): string {
    return token ? this.text.split(token).join("[redacted]") : this.text;
  }
}

export class Supervisor implements RuntimeStatus {
  private state: SupervisorState = "stopped";
  private detail: string | undefined;
  private child: ChildProcess | null = null;
  private liveTransport: LayaTransport | null = null;
  private token = "";
  private generation = 0;
  private stopPromise: Promise<void> | null = null;
  private startAbort: AbortController | null = null;
  private eagerTimer: unknown = null;
  private failureTimes: number[] = [];
  private consecutive = 0;
  private readyAt: number | null = null;
  private restartCount = 0;
  private lastError: string | undefined;
  private nextRetryAt: number | undefined;
  private latencies: number[] = [];
  private readonly ring = new Ring();
  private readonly clock: Clock;
  private readonly spawnFn: SpawnFn;
  private readonly opts: Required<
    Pick<
      SupervisorOptions,
      | "startDeadlineMs"
      | "warmupDeadlineMs"
      | "pollMs"
      | "stopGraceMs"
      | "maxFailures"
      | "failureWindowMs"
      | "backoffBaseMs"
      | "backoffCapMs"
      | "portRetries"
      | "stableMs"
    >
  >;

  constructor(private readonly options: SupervisorOptions) {
    this.clock = options.clock ?? realClock;
    this.spawnFn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
    this.opts = {
      startDeadlineMs: options.startDeadlineMs ?? 120_000,
      warmupDeadlineMs: options.warmupDeadlineMs ?? 60_000,
      pollMs: options.pollMs ?? 250,
      stopGraceMs: options.stopGraceMs ?? 1200,
      maxFailures: options.maxFailures ?? 5,
      failureWindowMs: options.failureWindowMs ?? 10 * 60_000,
      backoffBaseMs: options.backoffBaseMs ?? 1000,
      backoffCapMs: options.backoffCapMs ?? 60_000,
      portRetries: options.portRetries ?? 3,
      stableMs: options.stableMs ?? 60_000,
    };
  }

  // -- RuntimeStatus ---------------------------------------------------------------------------

  snapshot(): RuntimeSnapshot {
    switch (this.state) {
      case "stopping":
        return { state: "stopped" };
      case "failed":
      case "backoff":
        return { state: this.state, detail: this.detail ?? this.state };
      default:
        return this.detail ? { state: this.state, detail: this.detail } : { state: this.state };
    }
  }

  transport(): LayaTransport | null {
    return this.state === "ready" ? this.liveTransport : null;
  }

  recordLatency(elapsedMs: number, questions: number): void {
    if (questions <= 0) return;
    this.latencies.push(elapsedMs / questions);
    if (this.latencies.length > 50) this.latencies.shift();
  }

  ensureStarted(): void {
    if (this.stopPromise) return;
    if (this.state === "starting" || this.state === "warming" || this.state === "ready") return;
    if (this.state === "failed" || this.state === "stopping") return;
    if (
      this.state === "backoff" &&
      this.nextRetryAt !== undefined &&
      this.clock.now() < this.nextRetryAt
    ) {
      return;
    }
    void this.run();
  }

  noteConnectionFailure(): void {
    if (this.state !== "ready" || !this.liveTransport) return;
    const generation = this.generation;
    const transport = this.liveTransport;
    void transport.probe().then((result) => {
      if (generation !== this.generation || this.state !== "ready" || result === "up") return;
      this.killChild("SIGKILL");
      this.recordFailure("connection to the local server was lost");
    });
  }

  // -- Control ---------------------------------------------------------------------------------

  status(): SupervisorStatus {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
    return {
      state: this.state,
      ...(this.detail ? { detail: this.detail } : {}),
      restarts: this.restartCount,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.nextRetryAt !== undefined ? { nextRetryAt: this.nextRetryAt } : {}),
      ...(median !== undefined ? { latencyMedianMs: Math.round(median) } : {}),
    };
  }

  /** Short sanitized tail of the server output, for diagnostics. */
  output(): string {
    return this.ring.read(this.token || undefined);
  }

  /** Clear `failed`/`backoff` so a repair or a new session can start again. */
  reset(): void {
    if (this.state === "failed" || this.state === "backoff") {
      this.failureTimes = [];
      this.consecutive = 0;
      this.nextRetryAt = undefined;
      this.setState("stopped", undefined);
    }
  }

  /** Synchronous last resort for `process.on("exit")`. */
  killNow(): void {
    this.killChild("SIGKILL");
  }

  /** Idempotent graceful stop: SIGTERM, bounded grace, then SIGKILL. Never throws. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state === "stopped" && !this.child) return Promise.resolve();
    this.stopPromise = this.doStop().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  // -- Internals -------------------------------------------------------------------------------

  private setState(state: SupervisorState, detail: string | undefined): void {
    this.state = state;
    this.detail = detail;
    this.options.onChange?.();
  }

  private sleep(ms: number, abort?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const handle = this.clock.setTimeout(resolve, ms);
      abort?.addEventListener(
        "abort",
        () => {
          this.clock.clearTimeout(handle);
          resolve();
        },
        { once: true },
      );
    });
  }

  private killChild(signal: NodeJS.Signals): void {
    try {
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill(signal);
      }
    } catch {
      /* the process is already gone */
    }
  }

  private async run(): Promise<void> {
    const generation = ++this.generation;
    const abort = new AbortController();
    this.startAbort = abort;
    this.setState("starting", undefined);
    try {
      await this.launch(generation, abort);
    } catch {
      if (generation === this.generation) {
        this.killChild("SIGKILL");
        this.recordFailure("the local server could not be started");
      }
    }
  }

  private async launch(generation: number, abort: AbortController): Promise<void> {
    const command = this.options.command();
    if (!command) {
      this.setState("failed", "not installed: run /laya:setup");
      return;
    }
    await this.options.pidfile.reapOrphan();
    const stale = () => generation !== this.generation || abort.signal.aborted;

    for (let attempt = 0; attempt <= this.opts.portRetries; attempt++) {
      if (stale()) return;
      const port = await (this.options.pickPort ?? pickLoopbackPort)();
      this.token = randomBytes(32).toString("hex");
      const child = this.spawnFn(command.file, command.args, {
        cwd: this.options.cwd,
        env: this.options.buildEnv(port, this.token),
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
      this.child = child;
      child.stdout?.on("data", (chunk: Buffer) => this.ring.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => this.ring.push(chunk));
      let exited = child.exitCode !== null || child.signalCode !== null;
      let notifyExit: () => void = () => {};
      const exitedPromise = new Promise<void>((resolve) => {
        notifyExit = resolve;
        if (exited) resolve();
      });
      child.once("exit", (code, signal) => {
        exited = true;
        notifyExit();
        void this.options.pidfile.remove();
        if (this.child !== child) return;
        if (this.state === "ready") {
          this.child = null;
          this.recordFailure(`the local server exited (${code ?? signal ?? "unknown"})`);
        }
      });
      child.once("error", () => {
        exited = true;
        notifyExit();
      });
      if (child.pid)
        await this.options.pidfile.write({ pid: child.pid, startedAt: this.clock.now() });

      const transport = this.options.makeTransport(port, this.token);
      const outcome = await this.waitUntilUp(transport, () => exited, exitedPromise, abort);
      if (stale()) {
        this.killChild("SIGKILL");
        return;
      }
      if (outcome === "exited") {
        this.child = null;
        if (attempt < this.opts.portRetries && ADDRESS_IN_USE.test(this.ring.read())) continue;
        this.recordFailure("the local server exited during start");
        return;
      }
      if (outcome === "deadline") {
        this.killChild("SIGKILL");
        this.child = null;
        this.recordFailure("the local server did not become ready in time");
        return;
      }

      this.setState("warming", undefined);
      const warm = new AbortController();
      const warmTimer = this.clock.setTimeout(() => warm.abort(), this.opts.warmupDeadlineMs);
      abort.signal.addEventListener("abort", () => warm.abort(), { once: true });
      try {
        await transport.infer(this.options.warmupWire, { signal: warm.signal });
      } catch {
        this.clock.clearTimeout(warmTimer);
        if (stale()) return;
        this.killChild("SIGKILL");
        this.child = null;
        this.recordFailure("the model did not warm up");
        return;
      }
      this.clock.clearTimeout(warmTimer);
      if (stale()) return;
      this.liveTransport = transport;
      this.readyAt = this.clock.now();
      this.nextRetryAt = undefined;
      this.setState("ready", undefined);
      return;
    }
  }

  private async waitUntilUp(
    transport: LayaTransport,
    hasExited: () => boolean,
    exitedPromise: Promise<void>,
    abort: AbortController,
  ): Promise<"up" | "exited" | "deadline" | "aborted"> {
    const deadline = this.clock.now() + this.opts.startDeadlineMs;
    for (;;) {
      if (abort.signal.aborted) return "aborted";
      if (hasExited()) return "exited";
      const probe = new AbortController();
      const probeTimer = this.clock.setTimeout(() => probe.abort(), this.opts.pollMs * 4);
      const result = await Promise.race([
        transport.probe(probe.signal),
        exitedPromise.then(() => "exited" as const),
      ]);
      this.clock.clearTimeout(probeTimer);
      if (result === "up") return "up";
      if (result === "exited" || hasExited()) return "exited";
      if (this.clock.now() >= deadline) return "deadline";
      await Promise.race([this.sleep(this.opts.pollMs, abort.signal), exitedPromise]);
    }
  }

  private recordFailure(reason: string): void {
    this.liveTransport = null;
    this.lastError = reason;
    const now = this.clock.now();
    // A server that stayed up long enough ends the failure streak; a flapping one does not.
    if (this.readyAt !== null && now - this.readyAt >= this.opts.stableMs) {
      this.failureTimes = [];
    }
    this.readyAt = null;
    this.failureTimes = [
      ...this.failureTimes.filter((t) => now - t < this.opts.failureWindowMs),
      now,
    ];
    this.consecutive = this.failureTimes.length;
    this.restartCount += 1;
    if (this.consecutive >= this.opts.maxFailures) {
      this.setState("failed", `${reason}; automatic restarts exhausted, run /laya:setup --repair`);
      return;
    }
    const delay = Math.min(
      this.opts.backoffCapMs,
      this.opts.backoffBaseMs * 2 ** (this.consecutive - 1),
    );
    this.nextRetryAt = now + delay;
    this.setState("backoff", `${reason}; retry in ${Math.ceil(delay / 1000)}s`);
    if (this.options.eagerRestart && this.consecutive === 1) {
      this.eagerTimer = this.clock.setTimeout(() => {
        this.eagerTimer = null;
        this.ensureStarted();
      }, delay);
    }
  }

  private async doStop(): Promise<void> {
    this.generation++;
    this.startAbort?.abort();
    if (this.eagerTimer !== null) {
      this.clock.clearTimeout(this.eagerTimer);
      this.eagerTimer = null;
    }
    this.setState("stopping", undefined);
    this.liveTransport = null;
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const gone = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      this.killChild("SIGTERM");
      const cancelWait = new AbortController();
      await Promise.race([gone, this.sleep(this.opts.stopGraceMs, cancelWait.signal)]);
      cancelWait.abort();
      if (child.exitCode === null && child.signalCode === null) this.killChild("SIGKILL");
    }
    this.child = null;
    try {
      await this.options.pidfile.remove();
    } catch {
      /* best effort */
    }
    this.failureTimes = [];
    this.consecutive = 0;
    this.readyAt = null;
    this.nextRetryAt = undefined;
    this.setState("stopped", undefined);
  }
}
