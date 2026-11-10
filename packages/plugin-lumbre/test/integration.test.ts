// Opt-in real run (LMB-AC-16): one real `npm ci`, build and live preview per stack. It needs the
// network and a few minutes, so `pnpm check` skips it. Run with:
//   LUMBRE_INTEGRATION=1 pnpm --filter @alisio/plugin-lumbre exec vitest run test/integration.test.ts
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectRuntime } from "../src/runtime.js";
import { Service } from "../src/service.js";
import type { Loose } from "./service-fixture.js";

const enabled = process.env.LUMBRE_INTEGRATION === "1";
const require = createRequire(import.meta.url);

const get = (url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    request(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on("error", reject)
      .end();
  });

describe.skipIf(!enabled)("real presets", () => {
  let root = "";
  let service: Service;
  const ctx = (key: string) => ({
    sessionId: "s",
    workspace: root,
    signal: new AbortController().signal,
    idempotencyKey: key,
  });
  let n = 0;
  const call = (action: string, input: Record<string, unknown> = {}) =>
    service.invoke(action, input, ctx(`k${++n}`)) as Promise<Loose>;
  const wait = async (jobId: string) => {
    for (;;) {
      // biome-ignore lint/suspicious/noExplicitAny: job JSON.
      const job = (await call("jobs.get", { jobId })) as any;
      if (job.state !== "running") return job;
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  afterAll(async () => {
    service?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["vanilla", { stack: "vanilla" }, "Your next idea starts here."],
    ["vanilla-tailwind", { stack: "vanilla", tailwind: true }, "Your next idea starts here."],
    ["vite", { stack: "vite" }, "Your next idea starts here."],
    ["react", { stack: "react" }, '<div id="root"></div>'],
    ["astro", { stack: "astro" }, "Your next idea starts here."],
    ["next", { stack: "next" }, "Your next idea starts here."],
  ];
  it.each(cases)(
    "%s installs, builds and serves",
    async (name, input, expected) => {
      if (!service) {
        root = await mkdtemp(join(tmpdir(), "lmb-real-"));
        service = await new Service({
          root: join(root, "state"),
          cacheDir: join(root, "npm-cache"),
          sessions: {
            create: async () => ({}) as never,
            run: async () => ({}) as never,
            cancel: () => 0,
          },
          instructions: async () => "",
          npmCli: () => join(dirname(require.resolve("npm/package.json")), "bin", "npm-cli.js"),
          runtime: (o) => new ProjectRuntime(o),
          openUrl: async () => {},
        }).init();
      }
      const started = Date.now();
      const p = await call("projects.create", { title: name, ...input });
      const install = await wait((await call("deps.install", { projectId: p.id })).jobId);
      expect(install.state, install.log).toBe("done");
      const installMs = Date.now() - started;
      const check = await wait((await call("preview.check", { projectId: p.id })).jobId);
      expect(check.state, check.log).toBe("done");
      expect(check.result).toEqual({ ok: true });
      const buildMs = Date.now() - started - installMs;
      const snap = await call("preview.snapshot", { projectId: p.id });
      const start = await wait((await call("server.start", { projectId: p.id })).jobId);
      expect(start.state, start.log).toBe("done");
      const url = start.result.server.url as string;
      const page = await get(url);
      expect(page.status).toBe(200);
      expect(page.body).toContain(expected);
      if (name === "next") {
        const api = await get(`${url}/api/hello`);
        expect(api.body).toContain("Hello from your Next.js backend");
      }
      const startMs = Date.now() - started - installMs - buildMs;
      await call("server.stop", { projectId: p.id });
      console.log(
        `[lumbre] ${name}: install ${installMs} ms, check ${buildMs} ms, start ${startMs} ms, thumbnail ${snap.kind} (${snap.css.length} css), port ${start.result.server.port}`,
      );
    },
    600_000,
  );
});
