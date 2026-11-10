import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { errorCode } from "../src/errors.js";
import { STACK_IDS, stack } from "../src/presets.js";
import { environment, ProjectRuntime, reapOrphans } from "../src/runtime.js";

const roots: string[] = [];
const runtimes: ProjectRuntime[] = [];
const strays: ChildProcess[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.stop("user");
  for (const c of strays.splice(0)) c.kill("SIGKILL");
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

async function projectDir() {
  const root = await mkdtemp(join(tmpdir(), "lmb-rt-"));
  roots.push(root);
  await mkdir(join(root, "work"), { recursive: true });
  return root;
}

/** A fake framework CLI inside node_modules: records its argv and listens where told. */
async function fakeCli(dir: string, pkg: string, bin: string, body: string) {
  const root = join(dir, "work", "node_modules", pkg);
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: pkg, bin: { [bin]: "bin/cli.js" } }),
  );
  await writeFile(join(root, "bin", "cli.js"), body);
}
const listening = (offset = 0) => `
const { createServer } = require("node:http");
const fs = require("node:fs");
fs.writeFileSync(process.cwd() + "/../argv.json", JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
const port = Number(process.argv[process.argv.indexOf("--port") + 1]) + ${offset};
createServer((q, s) => s.end("ok")).listen(port, "127.0.0.1", () => console.log("ready on " + port));
`;

const make = (
  dir: string,
  id: "vite" | "vanilla",
  extra: Partial<ConstructorParameters<typeof ProjectRuntime>[0]> = {},
) => {
  const r = new ProjectRuntime({
    dir,
    stack: stack(id, false),
    npmCli: "unused",
    cacheDir: join(dir, "cache"),
    readyTimeoutMs: 3_000,
    ...extra,
  });
  runtimes.push(r);
  return r;
};

const get = (url: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check: () => boolean, ms = 4_000) => {
  for (let i = 0; i < ms / 20 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  return check();
};

describe("child environment (LMB-AC-08)", () => {
  it("passes a minimal environment without provider credentials", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.GITHUB_TOKEN = "y";
    process.env.AWS_SECRET_ACCESS_KEY = "z";
    try {
      const env = environment();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(env.NEXT_TELEMETRY_DISABLED).toBe("1");
      expect(env.PATH ?? env.Path).toBeTruthy();
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GITHUB_TOKEN;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it("gives every dev server an explicit loopback port and a strict port", () => {
    for (const id of STACK_IDS) {
      const s = stack(id, true);
      if (!s.dev) continue;
      const args = s.dev(4567).args;
      expect(args, id).toContain("4567");
      expect(args.join(" "), id).toMatch(/127\.0\.0\.1/);
      const strict =
        args.includes("--strictPort") ||
        /strictPort: true/.test(Object.values(s.owned).join("\n")) ||
        id === "next";
      expect(strict, id).toBe(true);
    }
  });
});

describe("dev servers (LMB-AC-08, LMB-AC-09)", () => {
  it("starts on the chosen port, checks readiness there, writes a PID file and stops cleanly", async () => {
    const dir = await projectDir();
    await fakeCli(dir, "vite", "vite", listening());
    const r = make(dir, "vite");
    await r.start(new AbortController().signal);
    const snap = r.snapshot();
    expect(snap.state).toBe("running");
    const { argv, env } = JSON.parse(await readFile(join(dir, "argv.json"), "utf8"));
    expect(argv).toEqual(["--host", "127.0.0.1", "--port", String(snap.port), "--strictPort"]);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect((await get(snap.url as string)).body).toBe("ok");
    const pidFile = JSON.parse(await readFile(join(dir, "pids", "dev.json"), "utf8"));
    expect(alive(pidFile.pid)).toBe(true);
    expect(r.running).toBe(true);
    await r.stop("user");
    expect(r.running).toBe(false);
    expect(await until(() => !alive(pidFile.pid))).toBe(true);
    expect(existsSync(join(dir, "pids", "dev.json"))).toBe(false);
  });

  it("fails when nothing answers on the chosen port, and when the server exits", async () => {
    const dir = await projectDir();
    await fakeCli(dir, "vite", "vite", listening(1));
    const r = make(dir, "vite", { readyTimeoutMs: 1_200 });
    let code = "ok";
    try {
      await r.start(new AbortController().signal);
    } catch (error) {
      code = errorCode(error);
    }
    expect(code).toBe("server_timeout");
    expect(r.running).toBe(false);

    await fakeCli(dir, "vite", "vite", 'console.error("Error: config broke"); process.exit(1);');
    try {
      await r.start(new AbortController().signal);
    } catch (error) {
      code = errorCode(error);
    }
    expect(code).toBe("server_failed");
    expect(r.snapshot().logs).toContain("config broke");
  });

  it("kills its process group synchronously on dispose", async () => {
    const dir = await projectDir();
    await fakeCli(dir, "vite", "vite", listening());
    const r = make(dir, "vite");
    await r.start(new AbortController().signal);
    const { pid } = JSON.parse(await readFile(join(dir, "pids", "dev.json"), "utf8"));
    r.killSync();
    expect(r.running).toBe(false);
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it("reaps a verified orphan from a previous activation and leaves unrelated processes alone", async () => {
    const dir = await projectDir();
    await mkdir(join(dir, "pids"), { recursive: true });
    await mkdir(join(dir, "work", "node_modules", "x"), { recursive: true });
    const script = join(dir, "work", "node_modules", "x", "sleep.js");
    await writeFile(script, "setInterval(() => {}, 1000);");
    const orphan = spawn(process.execPath, [script], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    strays.push(orphan);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    strays.push(unrelated);
    await writeFile(
      join(dir, "pids", "dev.json"),
      JSON.stringify({ pid: orphan.pid, role: "dev" }),
    );
    await writeFile(
      join(dir, "pids", "css.json"),
      JSON.stringify({ pid: unrelated.pid, role: "css" }),
    );
    const reaped = await reapOrphans(dir);
    expect(reaped).toEqual([orphan.pid]);
    expect(await until(() => !alive(orphan.pid as number))).toBe(true);
    expect(alive(unrelated.pid as number)).toBe(true);
    expect(await readdir(join(dir, "pids"))).toEqual([]);
  });
});

describe("vanilla static server", () => {
  it("serves the work folder on loopback with live reload, refusing other hosts and hidden paths", async () => {
    const dir = await projectDir();
    await writeFile(join(dir, "work", "index.html"), "<html><body><h1>Hi</h1></body></html>");
    await mkdir(join(dir, "work", "node_modules"), { recursive: true });
    await writeFile(join(dir, "work", "node_modules", "x.js"), "secret");
    const r = make(dir, "vanilla");
    await r.start(new AbortController().signal);
    const { url, port } = r.snapshot();
    const page = await get(url as string);
    expect(page.status).toBe(200);
    expect(page.body).toContain("<h1>Hi</h1>");
    expect(page.body).toContain("/__lumbre/live");
    expect((await get(url as string, { Host: `evil.test:${port}` })).status).toBe(403);
    expect((await get(`${url}/node_modules/x.js`)).status).toBe(404);
    expect((await get(`${url}/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
    // Live reload: the SSE stream receives a reload when files change.
    const events = await new Promise<string>((resolve) => {
      const req = request(`${url}/__lumbre/live`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (chunk.includes("reload")) {
            req.destroy();
            resolve(chunk);
          }
        });
        setTimeout(() => r.reload(), 50);
      });
      req.end();
    });
    expect(events).toContain("reload");
  });

  it("stops by itself after the idle period so busy() can clear", async () => {
    const dir = await projectDir();
    await writeFile(join(dir, "work", "index.html"), "<h1>Hi</h1>");
    const r = make(dir, "vanilla", { idleMs: 1_000 });
    await r.start(new AbortController().signal);
    r.touch(Date.now());
    expect(await r.idleCheck(Date.now())).toBe(false);
    expect(await r.idleCheck(Date.now() + 1_500)).toBe(true);
    expect(r.running).toBe(false);
    expect(r.snapshot().stoppedReason).toBe("idle");
  });
});
