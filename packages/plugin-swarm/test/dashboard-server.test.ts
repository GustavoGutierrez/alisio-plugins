import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorktreeIsolation } from "../src/adapters/git-worktree.js";
import { SwarmServices } from "../src/app/services.js";
import { mutatingRoutes } from "../src/dashboard/api.js";
import { type DashboardHandle, startDashboard } from "../src/dashboard/server.js";
import {
  clarificationEnvelope,
  commitFile,
  gitIn,
  handoffEnvelope,
  ScriptedRunner,
  tempDir,
} from "./helpers.js";

const role = (id: string, isolation = "worktree") => ({
  id,
  agent: `swarm-${id}`,
  isolation,
  receive: "task",
  propagation: "forward-only",
});

const open: DashboardHandle[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((handle) => handle.close()));
});

async function setup(options: { project?: boolean } = {}) {
  const workspace = await tempDir();
  const runner = new ScriptedRunner();
  const services = new SwarmServices({
    isolation: new GitWorktreeIsolation(),
    runner,
    autoStart: false,
  });
  await services.forgeFor(workspace).init();
  await mkdir(join(workspace, ".alisio", "swarm", "packs"), { recursive: true });
  await writeFile(
    join(workspace, ".alisio", "swarm", "packs", "gated.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "gated",
      description: "Gate after the coder",
      toolchain: "node-ts",
      approval: { after: "coder" },
      roles: [role("coder", "master"), role("cleaner")],
    }),
  );
  const runtime =
    options.project === false
      ? undefined
      : await services.newProject(workspace, { name: "demo", pack: "gated", mission: "Build it" });
  const dash = await startDashboard({ services, workspace });
  open.push(dash);
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${dash.baseUrl}${path}`, {
      method,
      headers: {
        "x-swarm-token": dash.token,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    // biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON in a test helper
    return { status: response.status, json: json as any, text, headers: response.headers };
  };
  return { workspace, runner, services, runtime, dash, call };
}

/** Raw request so tests can control `Host` and `Origin`. */
function raw(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path ?? "/api/state",
        headers: options.headers ?? {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const head = (dir: string) => gitIn(dir, "rev-parse", "HEAD").slice(0, 10);

describe("dashboard server: authentication", () => {
  it("binds to loopback on an ephemeral port and returns a tokenised URL", async () => {
    const ctx = await setup({ project: false });
    expect(ctx.dash.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
    expect(ctx.dash.port).toBeGreaterThan(0);
  });

  it("rejects a missing or wrong token on every API route", async () => {
    const ctx = await setup({ project: false });
    for (const headers of [{}, { "x-swarm-token": "nope" }]) {
      const response = await raw(ctx.dash.port, {
        headers: { host: `127.0.0.1:${ctx.dash.port}`, ...headers },
      });
      expect(response.status).toBe(401);
      expect(JSON.parse(response.text)).toHaveProperty("error");
    }
  });

  it("does not accept the token in the query of an API route", async () => {
    const ctx = await setup({ project: false });
    const response = await fetch(`${ctx.dash.baseUrl}/api/state?token=${ctx.dash.token}`);
    expect(response.status).toBe(401);
  });

  it("exchanges the query token on / for an HttpOnly SameSite cookie and redirects", async () => {
    const ctx = await setup({ project: false });
    const response = await fetch(ctx.dash.url, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`swarm_token=${ctx.dash.token}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    const page = await fetch(`${ctx.dash.baseUrl}/`, {
      headers: { cookie: `swarm_token=${ctx.dash.token}` },
    });
    expect(page.status).toBe(200);
    const stateWithCookie = await fetch(`${ctx.dash.baseUrl}/api/state`, {
      headers: { cookie: `swarm_token=${ctx.dash.token}` },
    });
    expect(stateWithCookie.status).toBe(200);
  });

  it("refuses a wrong token on / without leaking the real one", async () => {
    const ctx = await setup({ project: false });
    const response = await fetch(`${ctx.dash.baseUrl}/?token=wrong`, { redirect: "manual" });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(ctx.dash.token);
  });

  it("requires the header token (not just the cookie) to mutate", async () => {
    const ctx = await setup({ project: false });
    const response = await fetch(`${ctx.dash.baseUrl}/api/tasks/retry`, {
      method: "POST",
      headers: { cookie: `swarm_token=${ctx.dash.token}`, "content-type": "application/json" },
      body: JSON.stringify({ project: "demo", task: "x" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects an unexpected Host (DNS rebinding) even with a valid token", async () => {
    const ctx = await setup({ project: false });
    const response = await raw(ctx.dash.port, {
      headers: { host: "evil.example", "x-swarm-token": ctx.dash.token },
    });
    expect(response.status).toBe(403);
  });

  it("rejects a foreign or null Origin and accepts the local one", async () => {
    const ctx = await setup({ project: false });
    const base = { host: `127.0.0.1:${ctx.dash.port}`, "x-swarm-token": ctx.dash.token };
    for (const origin of ["http://evil.example", "null"]) {
      expect((await raw(ctx.dash.port, { headers: { ...base, origin } })).status).toBe(403);
    }
    const ok = await raw(ctx.dash.port, {
      headers: { ...base, origin: `http://127.0.0.1:${ctx.dash.port}` },
    });
    expect(ok.status).toBe(200);
  });

  it("sends no CORS headers, answers OPTIONS with 405 and sets hardening headers", async () => {
    const ctx = await setup({ project: false });
    const base = { host: `127.0.0.1:${ctx.dash.port}`, "x-swarm-token": ctx.dash.token };
    const options = await raw(ctx.dash.port, { method: "OPTIONS", headers: base });
    expect(options.status).toBe(405);
    const ok = await raw(ctx.dash.port, { headers: base });
    expect(Object.keys(ok.headers).some((name) => name.startsWith("access-control-"))).toBe(false);
    expect(ok.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.headers["referrer-policy"]).toBe("no-referrer");
    expect(String(ok.headers["content-type"])).toContain("application/json");
  });
});

describe("dashboard server: static assets", () => {
  it("serves the page with the token in a meta tag, plus the stylesheet and script", async () => {
    const ctx = await setup({ project: false });
    const page = await ctx.call("GET", "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.text).toContain(`<meta name="swarm-token" content="${ctx.dash.token}">`);
    const css = await ctx.call("GET", "/dashboard.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    const js = await ctx.call("GET", "/dashboard.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.text).not.toContain(ctx.dash.token);
  });

  it("serves only the fixed assets and never traverses", async () => {
    const ctx = await setup({ project: false });
    for (const path of [
      "/dashboard.html",
      "/../package.json",
      "/%2e%2e/package.json",
      "/assets/x",
    ]) {
      expect((await ctx.call("GET", path)).status).toBe(404);
    }
  });
});

describe("dashboard server: request limits", () => {
  it("rejects bodies over 256 KiB, non-JSON content types and invalid JSON", async () => {
    const ctx = await setup({ project: false });
    const big = await raw(ctx.dash.port, {
      method: "POST",
      path: "/api/tasks/retry",
      headers: {
        host: `127.0.0.1:${ctx.dash.port}`,
        "x-swarm-token": ctx.dash.token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ task: "x".repeat(300 * 1024) }),
    }).catch(() => ({ status: 413 }));
    expect(big.status).toBe(413);
    const wrongType = await fetch(`${ctx.dash.baseUrl}/api/tasks/retry`, {
      method: "POST",
      headers: { "x-swarm-token": ctx.dash.token, "content-type": "text/plain" },
      body: "hi",
    });
    expect(wrongType.status).toBe(415);
    const invalid = await fetch(`${ctx.dash.baseUrl}/api/tasks/retry`, {
      method: "POST",
      headers: { "x-swarm-token": ctx.dash.token, "content-type": "application/json" },
      body: "{not json",
    });
    expect(invalid.status).toBe(400);
    const array = await ctx.call("POST", "/api/tasks/retry", [1]);
    expect(array.status).toBe(400);
  });

  it("answers unknown routes with 404 and wrong methods with 405 as JSON", async () => {
    const ctx = await setup({ project: false });
    const missing = await ctx.call("GET", "/api/nope");
    expect(missing.status).toBe(404);
    expect(missing.json).toHaveProperty("error");
    const wrong = await ctx.call("POST", "/api/state", {});
    expect(wrong.status).toBe(405);
  });
});

describe("dashboard routes: reads", () => {
  it("GET /api/state returns the snapshot", async () => {
    const ctx = await setup();
    const response = await ctx.call("GET", "/api/state");
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      schemaVersion: 1,
      initialised: true,
      projects: [{ name: "demo", columns: ["coder", "cleaner", "done"] }],
    });
  });

  it("GET /api/mission returns the mission and validates the project", async () => {
    const ctx = await setup();
    expect((await ctx.call("GET", "/api/mission?project=demo")).json).toEqual({
      project: "demo",
      mission: "Build it\n",
    });
    expect((await ctx.call("GET", "/api/mission?project=..")).status).toBe(400);
    expect((await ctx.call("GET", "/api/mission")).status).toBe(400);
    expect((await ctx.call("GET", "/api/mission?project=ghost")).status).toBe(404);
  });

  it("GET /api/agents/:role/tail validates identifiers and returns the tail", async () => {
    const ctx = await setup();
    const ok = await ctx.call("GET", "/api/agents/coder/tail?project=demo");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ role: "coder", state: "none", tail: [] });
    expect((await ctx.call("GET", "/api/agents/Bad_Role/tail?project=demo")).status).toBe(400);
    expect((await ctx.call("GET", "/api/agents/coder/tail?project=Bad")).status).toBe(400);
    expect((await ctx.call("GET", "/api/agents/ghost/tail?project=demo")).status).toBe(404);
  });
});

describe("dashboard routes: follow-up only (complementary to the Alisio chat)", () => {
  it("has no route that creates, opens, closes or tears down projects and tasks", async () => {
    const ctx = await setup();
    const removed: Array<[string, string]> = [
      ["POST", "/api/projects"],
      ["POST", "/api/projects/open"],
      ["POST", "/api/projects/close"],
      ["POST", "/api/tasks"],
      ["POST", "/api/tasks/accept"],
      ["POST", "/api/chat"],
      ["GET", "/api/chat?project=demo"],
      ["POST", "/api/teardown"],
      ["POST", "/api/budget/raise"],
      ["GET", "/api/packs/two-pack"],
    ];
    for (const [method, path] of removed) {
      const response = await ctx.call(method, path, method === "POST" ? { name: "x" } : undefined);
      expect([404, 405], `${method} ${path}`).toContain(response.status);
    }
    expect(ctx.runtime?.board().tasks).toEqual([]);
    expect(await ctx.services.openProjects(ctx.workspace)).toEqual(["demo"]);
  });

  it("only exposes the gate decisions as mutating routes", () => {
    expect(mutatingRoutes()).toEqual([
      "POST /api/approvals/:id/:action",
      "POST /api/clarifications/:id/answer",
      "POST /api/tasks/delete",
      "POST /api/tasks/retry",
    ]);
  });

  it("retries and deletes a task and validates identifiers", async () => {
    const ctx = await setup();
    await ctx.services.createTask(ctx.workspace, "demo", "Add login");
    expect(
      (await ctx.call("POST", "/api/tasks/retry", { project: "demo", task: "add-login" })).status,
    ).toBe(400);
    expect(
      (await ctx.call("POST", "/api/tasks/delete", { project: "Bad", task: "add-login" })).status,
    ).toBe(400);
    expect(
      (await ctx.call("POST", "/api/tasks/delete", { project: "demo", task: "../x" })).status,
    ).toBe(400);
    expect(
      (await ctx.call("POST", "/api/tasks/delete", { project: "demo", task: "ghost" })).status,
    ).toBe(404);
    expect(
      (await ctx.call("POST", "/api/tasks/delete", { project: "demo", task: "add-login" })).status,
    ).toBe(200);
    expect(ctx.runtime?.board().tasks).toEqual([]);
  });
});

async function toApproval(ctx: Awaited<ReturnType<typeof setup>>) {
  ctx.runner.script(
    "coder",
    async (request) => handoffEnvelope(await commitFile(request.workdir, "spec.md", "# Spec\n")),
    (request) => handoffEnvelope(head(request.workdir)),
  );
  ctx.runner.script("cleaner", async (request) =>
    handoffEnvelope(await commitFile(request.workdir, "clean.ts", "x\n")),
  );
  ctx.runner.script("cleaner", (request) => handoffEnvelope(head(request.workdir)));
  await ctx.services.createTask(ctx.workspace, "demo", "Needs sign-off");
  await ctx.runtime?.drain();
}

describe("dashboard routes: approvals", () => {
  it("shows documents, blocks approval while comments exist, then approves", async () => {
    const ctx = await setup();
    await toApproval(ctx);
    const id = "approval:demo:needs-sign-off";
    const docs = await ctx.call("GET", "/api/doc?project=demo&task=needs-sign-off");
    expect(docs.status).toBe(200);
    expect(docs.json.docs[0]).toMatchObject({ path: "spec.md", text: "# Spec\n" });
    const comment = await ctx.call("POST", `/api/approvals/${id}/comments`, {
      doc: "spec.md",
      text: "Needs an example",
    });
    expect(comment.status).toBe(200);
    expect((await ctx.call("POST", `/api/approvals/${id}/approve`, {})).status).toBe(400);
    expect(
      (await ctx.call("GET", "/api/doc?project=demo&task=needs-sign-off")).json.docs[0].comments,
    ).toHaveLength(1);
    expect((await ctx.call("POST", `/api/approvals/${id}/comments`, { clear: true })).status).toBe(
      200,
    );
    const approved = await ctx.call("POST", `/api/approvals/${id}/approve`, {});
    expect(approved.status).toBe(200);
    await ctx.runtime?.drain();
    expect(ctx.runtime?.board().tasks[0]?.status).toBe("done");
  });

  it("rejects with retry, delete or accept and validates the action", async () => {
    const ctx = await setup();
    await toApproval(ctx);
    const id = "approval:demo:needs-sign-off";
    expect(
      (await ctx.call("POST", `/api/approvals/${id}/reject`, { action: "explode" })).status,
    ).toBe(400);
    expect((await ctx.call("POST", `/api/approvals/${id}/reject`, {})).status).toBe(400);
    const deleted = await ctx.call("POST", `/api/approvals/${id}/reject`, { action: "delete" });
    expect(deleted.status).toBe(200);
    expect(ctx.runtime?.board().tasks).toEqual([]);
  });

  it("rejects malformed approval ids and comment bodies", async () => {
    const ctx = await setup();
    await toApproval(ctx);
    for (const id of [
      "approval:demo",
      "clarification:demo:needs-sign-off",
      "approval:Demo:x",
      "approval:demo:..",
      "x",
    ]) {
      expect(
        (await ctx.call("POST", `/api/approvals/${encodeURIComponent(id)}/approve`, {})).status,
        id,
      ).toBe(400);
    }
    const base = "approval:demo:needs-sign-off";
    for (const body of [{ doc: "../x", text: "t" }, { doc: "a.md", text: "" }, { text: "t" }, {}]) {
      expect(
        (await ctx.call("POST", `/api/approvals/${base}/comments`, body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect((await ctx.call("POST", `/api/approvals/${base}/nope`, {})).status).toBe(404);
  });
});

describe("dashboard routes: clarifications", () => {
  it("answers a clarification", async () => {
    const ctx = await setup();
    ctx.runner.script("coder", clarificationEnvelope("Which database?"));
    ctx.runner.script("coder", (request) => handoffEnvelope(head(request.workdir)));
    await ctx.services.createTask(ctx.workspace, "demo", "Pick storage");
    await ctx.runtime?.drain();
    expect(ctx.runtime?.board().tasks[0]?.status).toBe("clarifying");
    const id = "clarification:demo:pick-storage";
    expect((await ctx.call("POST", `/api/clarifications/${id}/answer`, { text: "" })).status).toBe(
      400,
    );
    expect(
      (await ctx.call("POST", "/api/clarifications/approval:demo:x/answer", { text: "t" })).status,
    ).toBe(400);
    const answered = await ctx.call("POST", `/api/clarifications/${id}/answer`, {
      text: "Postgres",
    });
    expect(answered.status).toBe(200);
  });
});

describe("dashboard lifecycle", () => {
  it("is stopped by services.shutdown (teardown from the chat, dispose)", async () => {
    const ctx = await setup({ project: false });
    await ctx.services.shutdown();
    const refused = await fetch(`${ctx.dash.baseUrl}/api/state`).then(
      () => false,
      () => true,
    );
    expect(refused).toBe(true);
  });
});

describe("dashboard assets", () => {
  it("are CSP-clean: no inline script, handler or style block, no external URL", async () => {
    const html = await readFile(
      join(import.meta.dirname, "..", "assets", "dashboard.html"),
      "utf8",
    );
    const js = await readFile(join(import.meta.dirname, "..", "assets", "dashboard.js"), "utf8");
    const css = await readFile(join(import.meta.dirname, "..", "assets", "dashboard.css"), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<style/i);
    for (const text of [html, js, css]) expect(text).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
  });

  it("never offer project or task creation, teardown or chat", async () => {
    const html = await readFile(
      join(import.meta.dirname, "..", "assets", "dashboard.html"),
      "utf8",
    );
    const js = await readFile(join(import.meta.dirname, "..", "assets", "dashboard.js"), "utf8");
    for (const text of [html, js]) {
      expect(text).not.toMatch(/New Project|Open Project|New Task|Teardown|Lieutenant/);
      expect(js).not.toMatch(/\/api\/(projects|chat|teardown)/);
    }
    expect(html).toContain("Alisio");
  });
});
