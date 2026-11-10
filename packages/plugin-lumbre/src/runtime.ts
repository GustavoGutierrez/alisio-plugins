// Child processes and the live preview (decision A). Generated apps run as the user, after the
// host's process approval; this is NOT a sandbox. What it does guarantee:
// - a minimal environment (no provider credentials or tokens reach a child);
// - a free loopback port chosen by Lumbre, passed explicitly with a strict-port flag, and readiness
//   checked on that exact port;
// - a PID file per long-running child, reaped on the next activation only after the command line
//   is verified to belong to this project; process groups killed synchronously on dispose;
// - an idle stop, so a forgotten preview never keeps the workspace busy forever.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { createServer, request, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LumbreError } from "./errors.js";
import { type Command, nodeAtLeast, type Stack } from "./presets.js";
import { cleanLog } from "./safety.js";
import { writeAtomic } from "./store.js";

const PASS = [
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "SYSTEMROOT",
  "SystemDrive",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

/** The only variables a child sees: system basics, proxies and Lumbre's own switches. */
export function environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASS) if (process.env[key]) env[key] = process.env[key];
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    ASTRO_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    BROWSERSLIST_IGNORE_OLD_DATA: "1",
    ...extra,
  };
}

/** A port that was free a moment ago (the server then binds it with a strict-port flag). */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ok, fail) => {
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", ok);
  });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((ok) => probe.close(() => ok()));
  return port;
}

/** The CLI script of `pkg` inside the project's node_modules (never outside it). */
export function resolveBin(work: string, command: Command): string {
  const root = join(work, "node_modules", ...command.pkg.split("/"));
  let manifest: { bin?: string | Record<string, string> };
  try {
    manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    throw new LumbreError("install_failed");
  }
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[command.bin];
  if (typeof entry !== "string") throw new LumbreError("install_failed");
  const target = resolve(root, entry);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new LumbreError("install_failed");
  return target;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Kills a child's whole process group (POSIX) or tree (Windows), synchronously. */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** The command line of a running process, or undefined when the platform cannot tell. */
function commandLine(pid: number): string | undefined {
  try {
    if (process.platform === "linux")
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
    if (process.platform === "darwin")
      return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    if (process.platform === "win32")
      return execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Kills dev servers left behind by an abrupt exit. A PID is killed only while its command line
 * still points inside this project's work folder (PIDs are reused by unrelated programs).
 */
export async function reapOrphans(projectDir: string): Promise<number[]> {
  const dir = join(projectDir, "pids");
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const work = join(projectDir, "work");
  let realWork = work;
  try {
    realWork = await realpath(work);
  } catch {
    // keep the plain path
  }
  const reaped: number[] = [];
  for (const name of names) {
    try {
      const { pid } = JSON.parse(await readFile(join(dir, name), "utf8")) as { pid?: unknown };
      if (Number.isInteger(pid) && (pid as number) > 1 && alive(pid as number)) {
        const cmd = commandLine(pid as number);
        if (cmd && (cmd.includes(work) || cmd.includes(realWork))) {
          killTree(pid as number, "SIGKILL");
          reaped.push(pid as number);
        }
      }
    } catch {
      // unreadable PID file: just remove it
    }
    await rm(join(dir, name), { force: true });
  }
  return reaped;
}

export type ServerState = "stopped" | "starting" | "running" | "failed";
export interface ServerSnapshot {
  state: ServerState;
  url: string | null;
  port: number | null;
  startedAt: number | null;
  stoppedReason: "idle" | "user" | "crash" | "dispose" | null;
  logs: string;
}

export interface RuntimeOptions {
  dir: string;
  stack: Stack;
  npmCli: string;
  cacheDir: string;
  /** Idle period before the preview stops itself (default 20 minutes). */
  idleMs?: number;
  readyTimeoutMs?: number;
  nodeVersion?: string;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".md": "text/plain; charset=utf-8",
};
const LIVE_SCRIPT =
  '<script>(()=>{const s=new EventSource("/__lumbre/live");s.onmessage=(e)=>{if(e.data==="reload")location.reload()}})();</script>';

export class ProjectRuntime {
  private child: ChildProcess | undefined;
  private watcher: ChildProcess | undefined;
  private server: Server | undefined;
  private clients = new Set<ServerResponse>();
  private state: ServerState = "stopped";
  private port: number | null = null;
  private startedAt: number | null = null;
  private stoppedReason: ServerSnapshot["stoppedReason"] = null;
  private logs = "";
  private lastActivity = Date.now();
  private watchedCss: string | undefined;
  readonly work: string;

  constructor(readonly options: RuntimeOptions) {
    this.work = join(options.dir, "work");
  }

  get running() {
    return this.state === "starting" || this.state === "running";
  }
  snapshot(): ServerSnapshot {
    return {
      state: this.state,
      url: this.port && this.running ? `http://127.0.0.1:${this.port}` : null,
      port: this.running ? this.port : null,
      startedAt: this.startedAt,
      stoppedReason: this.stoppedReason,
      logs: this.logs,
    };
  }
  log() {
    return this.logs;
  }
  touch(now = Date.now()) {
    this.lastActivity = now;
  }

  /** Stops the preview after the idle period; true when it stopped it. */
  async idleCheck(now = Date.now()) {
    if (!this.running) return false;
    if (now - this.lastActivity < (this.options.idleMs ?? 20 * 60_000)) return false;
    await this.stop("idle");
    return true;
  }

  private append(chunk: Buffer | string) {
    this.logs = cleanLog(this.logs + chunk.toString(), 32_000);
  }
  private requireNode() {
    if (!nodeAtLeast(this.options.nodeVersion ?? process.versions.node, this.options.stack.minNode))
      throw new LumbreError("node_too_old");
  }

  private spawnNode(args: string[], extra: Record<string, string> = {}) {
    return spawn(process.execPath, args, {
      cwd: this.work,
      env: environment(extra),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /** Runs a command to completion (install, build), killed on abort or timeout. */
  private async run(
    args: string[],
    signal: AbortSignal,
    timeoutMs: number,
    failure: "install_failed" | "build_failed",
    extra: Record<string, string> = {},
  ) {
    signal.throwIfAborted();
    this.logs = "";
    await new Promise<void>((ok, fail) => {
      const child = this.spawnNode(args, extra);
      let settled = false;
      const kill = () => killTree(child.pid, "SIGKILL");
      const timer = setTimeout(kill, timeoutMs);
      signal.addEventListener("abort", kill, { once: true });
      child.stdout?.on("data", (b: Buffer) => this.append(b));
      child.stderr?.on("data", (b: Buffer) => this.append(b));
      const done = (error?: LumbreError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
        error ? fail(error) : ok();
      };
      child.once("error", () => done(new LumbreError(failure)));
      child.once("close", (code) =>
        done(code === 0 ? undefined : new LumbreError(signal.aborted ? "cancelled" : failure)),
      );
    });
  }

  /** `npm ci` (or `npm install --save-exact` after approved extra packages), never running scripts. */
  async install(signal: AbortSignal, mode: "ci" | "install") {
    this.requireNode();
    const args = [
      this.options.npmCli,
      mode,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      ...(mode === "install" ? ["--save-exact"] : []),
    ];
    await this.run(args, signal, 10 * 60_000, "install_failed", {
      npm_config_cache: this.options.cacheDir,
      npm_config_update_notifier: "false",
    });
  }

  async build(signal: AbortSignal) {
    this.requireNode();
    const s = this.options.stack;
    const command = s.build ?? s.css?.build;
    if (!command) return;
    await this.run(
      [resolveBin(this.work, command), ...command.args],
      signal,
      5 * 60_000,
      "build_failed",
      {
        NODE_ENV: "production",
      },
    );
  }

  private async writePid(role: string, child: ChildProcess) {
    if (!child.pid) return;
    await mkdir(join(this.options.dir, "pids"), { recursive: true, mode: 0o700 });
    await writeAtomic(
      join(this.options.dir, "pids", `${role}.json`),
      JSON.stringify({ pid: child.pid, role, startedAt: Date.now() }),
    );
  }
  private async clearPid(role: string) {
    await rm(join(this.options.dir, "pids", `${role}.json`), { force: true });
  }

  /** Starts the live preview: the framework dev server, or the in-process static server. */
  async start(signal: AbortSignal) {
    if (this.running) return;
    this.requireNode();
    this.logs = "";
    this.stoppedReason = null;
    this.state = "starting";
    this.touch();
    try {
      const port = await freePort();
      this.port = port;
      const s = this.options.stack;
      if (s.dev) {
        const command = s.dev(port);
        const child = this.spawnNode([resolveBin(this.work, command), ...command.args]);
        this.attach(child, "dev");
        await this.writePid("dev", child);
        await this.waitReady(port, child, signal);
      } else {
        if (s.css) {
          const watcher = this.spawnNode([resolveBin(this.work, s.css.watch), ...s.css.watch.args]);
          this.attach(watcher, "css");
          await this.writePid("css", watcher);
          this.watchCss(join(this.work, "styles", "tailwind.css"));
        }
        await this.serveStatic(port);
      }
      this.state = "running";
      this.startedAt = Date.now();
    } catch (error) {
      await this.stop("crash");
      this.state = "failed";
      throw error instanceof LumbreError ? error : new LumbreError("server_failed");
    }
  }

  private attach(child: ChildProcess, role: "dev" | "css") {
    if (role === "dev") this.child = child;
    else this.watcher = child;
    child.stdout?.on("data", (b: Buffer) => this.append(b));
    child.stderr?.on("data", (b: Buffer) => this.append(b));
    child.once("close", () => {
      if (role === "dev" && this.child === child) this.child = undefined;
      if (role === "css" && this.watcher === child) this.watcher = undefined;
      void this.clearPid(role);
      // A crash while running stops the whole preview and says so.
      if (this.state === "running") void this.stop("crash").then(() => (this.state = "failed"));
    });
  }

  private async waitReady(port: number, child: ChildProcess, signal: AbortSignal) {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (child.exitCode !== null || child.signalCode !== null || this.child !== child)
        throw new LumbreError("server_failed");
      const status = await probe(port, 15_000);
      if (status !== null && status < 500) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new LumbreError("server_timeout");
  }

  /** Status of the live page right now (null when nothing answers). */
  async probe() {
    if (!this.running || !this.port) return null;
    return probe(this.port, 60_000);
  }

  private watchCss(file: string) {
    this.watchedCss = file;
    watchFile(file, { interval: 400 }, () => this.reload());
  }

  /** Tells open live pages to reload (vanilla; frameworks have their own hot reload). */
  reload() {
    for (const client of this.clients) client.write("data: reload\n\n");
  }

  private async serveStatic(port: number) {
    const root = await realpath(this.work);
    const server = createServer(async (req, res) => {
      this.touch();
      const host = req.headers.host;
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        res.writeHead(403).end();
        return;
      }
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/__lumbre/live") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          res.write(": connected\n\n");
          this.clients.add(res);
          req.on("close", () => this.clients.delete(res));
          return;
        }
        let name = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        if (!name || name.endsWith("/")) name += "index.html";
        const parts = name.split("/");
        if (parts.some((p) => !p || p.startsWith(".") || p === "node_modules" || p.includes("\\")))
          throw new Error("hidden");
        const target = resolve(root, ...parts);
        const real = await realpath(target);
        const rel = relative(root, real);
        if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
          throw new Error("outside");
        const info = await stat(real);
        if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error("not a file");
        const type = TYPES[extname(real).toLowerCase()] ?? "application/octet-stream";
        let body: Buffer | string = await readFile(real);
        if (type.startsWith("text/html")) {
          const html = body.toString("utf8");
          body = html.includes("</body>")
            ? html.replace("</body>", `${LIVE_SCRIPT}</body>`)
            : html + LIVE_SCRIPT;
        }
        res.writeHead(200, {
          "Content-Type": type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(body);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      }
    });
    await new Promise<void>((ok, fail) => {
      server.once("error", () => fail(new LumbreError("server_failed")));
      server.listen(port, "127.0.0.1", ok);
    });
    this.server = server;
  }

  /** Stops everything this preview owns. */
  async stop(reason: NonNullable<ServerSnapshot["stoppedReason"]>) {
    const children = [this.child, this.watcher].filter((c): c is ChildProcess => !!c);
    this.child = undefined;
    this.watcher = undefined;
    const wasRunning = this.running;
    this.state = "stopped";
    if (wasRunning) this.stoppedReason = reason;
    for (const c of children) killTree(c.pid, "SIGTERM");
    await Promise.all(
      children.map(
        (c) =>
          new Promise<void>((ok) => {
            if (c.exitCode !== null || c.signalCode !== null) return ok();
            const force = setTimeout(() => killTree(c.pid, "SIGKILL"), 2_000);
            const give = setTimeout(ok, 4_000);
            c.once("close", () => {
              clearTimeout(force);
              clearTimeout(give);
              ok();
            });
          }),
      ),
    );
    if (this.watchedCss) unwatchFile(this.watchedCss);
    this.watchedCss = undefined;
    await this.closeServer();
    await this.clearPid("dev");
    await this.clearPid("css");
    this.port = null;
  }

  private async closeServer() {
    const server = this.server;
    this.server = undefined;
    for (const c of this.clients) c.end();
    this.clients.clear();
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }

  /** Synchronous kill for `dispose`: SIGKILL to every group; PID files are reaped next time. */
  killSync() {
    for (const c of [this.child, this.watcher]) killTree(c?.pid, "SIGKILL");
    this.child = undefined;
    this.watcher = undefined;
    if (this.watchedCss) unwatchFile(this.watchedCss);
    for (const c of this.clients) c.destroy();
    this.clients.clear();
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
    if (this.running) this.stoppedReason = "dispose";
    this.state = "stopped";
    this.port = null;
  }
}

/** HTTP status of `/` on a loopback port, or null when nothing answers in time. */
function probe(port: number, timeoutMs: number): Promise<number | null> {
  return new Promise((ok) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/", method: "GET", timeout: timeoutMs },
      (res) => {
        res.resume();
        ok(res.statusCode ?? null);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      ok(null);
    });
    req.on("error", () => ok(null));
    req.end();
  });
}
