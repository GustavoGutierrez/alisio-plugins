import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MUTATING_ROUTES } from "../src/interface/dashboard/api.js";
import { generateToken, hostAllowed, originAllowed } from "../src/interface/dashboard/auth.js";
import { type DashboardHandle, startDashboard } from "../src/interface/dashboard/server.js";
import { goodPlan, goodSpec, type WorkflowFixture, workflowFixture } from "./helpers/workflow.js";

const TOKEN = "t".repeat(64);
const ASSETS: Record<string, string> = {
  "index.html":
    "<!doctype html><title>Frontsmith</title><meta name=token content=__FRONTSMITH_TOKEN__>",
  "app.css": ":root{}",
  "app.js": "void 0;",
};

async function withDashboard<T>(
  run: (ctx: {
    f: WorkflowFixture;
    dash: DashboardHandle;
    get: typeof get;
    post: typeof post;
  }) => Promise<T>,
): Promise<T> {
  const f = await workflowFixture();
  const dash = await startDashboard({
    services: f.services,
    workspace: f.root,
    token: TOKEN,
    assets: async (name) => ASSETS[name] ?? "",
  });
  const headers = (extra: Record<string, string> = {}) => ({
    "x-frontsmith-token": TOKEN,
    ...extra,
  });
  const get = (path: string, extra: Record<string, string> = {}) =>
    fetch(`${dash.baseUrl}${path}`, { headers: headers(extra) });
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
    fetch(`${dash.baseUrl}${path}`, {
      method: "POST",
      headers: headers({ "content-type": "application/json", ...extra }),
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  try {
    return await run({ f, dash, get, post });
  } finally {
    await dash.close();
    await f.cleanup();
  }
}

describe("dashboard authentication", () => {
  it("generates a random 256-bit hex token", () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateToken()).not.toBe(generateToken());
  });

  it("accepts only loopback Host values with the bound port and local Origins", () => {
    expect(hostAllowed("127.0.0.1:4000", 4000)).toBe(true);
    expect(hostAllowed("localhost:4000", 4000)).toBe(true);
    expect(hostAllowed("evil.example:4000", 4000)).toBe(false);
    expect(hostAllowed("127.0.0.1:4001", 4000)).toBe(false);
    expect(hostAllowed(undefined, 4000)).toBe(false);
    expect(originAllowed(undefined, 4000)).toBe(true);
    expect(originAllowed("http://127.0.0.1:4000", 4000)).toBe(true);
    expect(originAllowed("http://evil.example", 4000)).toBe(false);
  });

  it("exchanges the query token for an HttpOnly SameSite=Strict cookie and then serves the page", async () => {
    await withDashboard(async ({ dash }) => {
      const noToken = await fetch(`${dash.baseUrl}/`, { redirect: "manual" });
      expect(noToken.status).toBe(401);
      const wrong = await fetch(`${dash.baseUrl}/?token=nope`, { redirect: "manual" });
      expect(wrong.status).toBe(401);
      const exchange = await fetch(dash.url, { redirect: "manual" });
      expect(exchange.status).toBe(302);
      const cookie = exchange.headers.get("set-cookie") ?? "";
      expect(cookie).toContain(`frontsmith_token=${TOKEN}`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      const page = await fetch(`${dash.baseUrl}/`, {
        headers: { cookie: cookie.split(";")[0] as string },
      });
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain(`content=${TOKEN}`);
      expect(html).not.toContain("__FRONTSMITH_TOKEN__");
      const csp = page.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("img-src 'self' data:");
      expect(page.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  it("refuses a wrong Host or Origin even with a valid token", async () => {
    await withDashboard(async ({ dash }) => {
      const origin = await fetch(`${dash.baseUrl}/api/state`, {
        headers: { "x-frontsmith-token": TOKEN, origin: "http://evil.example" },
      });
      expect(origin.status).toBe(403);
      const { request } = await import("node:http");
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: dash.port,
            path: "/api/state",
            headers: { host: "evil.example", "x-frontsmith-token": TOKEN },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(403);
    });
  });

  it("serves the static assets with their types and refuses the API without a token", async () => {
    await withDashboard(async ({ dash }) => {
      const css = await get_(dash, "/app.css");
      expect(css.headers.get("content-type")).toContain("text/css");
      const js = await get_(dash, "/app.js");
      expect(js.headers.get("content-type")).toContain("text/javascript");
      const bare = await fetch(`${dash.baseUrl}/api/state`);
      expect(bare.status).toBe(401);
    });
  });
});

const get_ = (dash: DashboardHandle, path: string) =>
  fetch(`${dash.baseUrl}${path}`, { headers: { "x-frontsmith-token": TOKEN } });

describe("dashboard read API", () => {
  it("lists features, shows one with its next command and reads a persisted gate report", async () => {
    await withDashboard(async ({ f, get }) => {
      const empty = await (await get("/api/state")).json();
      expect(empty).toMatchObject({ features: [] });
      await f.services.workflow.newFeature(f.root, {
        feature: "projects",
        intent: "List projects",
        level: "L1",
      });
      const list = (await (await get("/api/state")).json()) as {
        features: Array<{ feature: string }>;
      };
      expect(list.features.map((x) => x.feature)).toEqual(["projects"]);
      const one = (await (await get("/api/features/projects")).json()) as {
        state: { phase: string };
        next: { command: string };
        gateIds: string[];
      };
      expect(one.state.phase).toBe("intake");
      expect(one.next.command).toContain("/frontsmith:next projects");
      expect(one.gateIds).toContain("G2T");
      expect((await get("/api/features/missing")).status).toBe(404);

      await mkdir(join(f.root, "docs/frontsmith/projects/reports"), { recursive: true });
      await writeFile(
        join(f.root, "docs/frontsmith/projects/reports/G1.json"),
        JSON.stringify({ gate: "G1", verdict: "PASS" }),
      );
      const report = await get("/api/features/projects/reports/G1");
      expect(await report.json()).toEqual({ gate: "G1", verdict: "PASS" });
      expect((await get("/api/features/projects/reports/G6")).status).toBe(404);
      expect((await get("/api/features/projects/reports/G11")).status).toBe(400);
    });
  });

  it("lists the active rules", async () => {
    await withDashboard(async ({ get }) => {
      const body = (await (await get("/api/rules")).json()) as {
        rules: Array<{ id: string; severity: string }>;
      };
      expect(body.rules.length).toBeGreaterThan(0);
      expect(body.rules[0]).toHaveProperty("id");
    });
  });

  it("serves evidence PNGs only by validated names and contained paths", async () => {
    await withDashboard(async ({ f, get }) => {
      const dir = join(f.root, ".alisio/frontsmith/evidence/projects/run-1");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "composite-main.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      await f.services.workflow.newFeature(f.root, {
        feature: "projects",
        intent: "List projects",
        level: "L1",
      });
      const ok = await get("/api/features/projects/evidence/run-1/composite-main.png");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toBe("image/png");
      expect([...new Uint8Array(await ok.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      for (const bad of [
        "/api/features/projects/evidence/run-1/Composite.png",
        "/api/features/projects/evidence/run-1/a.jpg",
        "/api/features/projects/evidence/run-1/..%2Fx.png",
        "/api/features/projects/evidence/..%2F..%2Fx/a.png",
        "/api/features/projects/evidence/RUN/a.png",
      ])
        expect((await get(bad)).status, bad).toBe(400);
      expect((await get("/api/features/projects/evidence/run-1/missing.png")).status).toBe(404);
    });
  });

  it("validates identifiers and rejects unknown routes and methods", async () => {
    await withDashboard(async ({ dash, get }) => {
      expect((await get("/api/features/Bad_Name")).status).toBe(400);
      expect((await get("/api/features/..%2F..")).status).toBe(400);
      expect((await get("/api/nope")).status).toBe(404);
      expect((await get("/nope")).status).toBe(404);
      for (const method of ["PUT", "DELETE", "PATCH"]) {
        const res = await fetch(`${dash.baseUrl}/api/state`, {
          method,
          headers: { "x-frontsmith-token": TOKEN },
        });
        expect(res.status, method).toBe(405);
      }
    });
  });
});

describe("dashboard mutations", () => {
  it("exposes exactly the three POST routes of the review dashboard", () => {
    expect(MUTATING_ROUTES).toEqual([
      "POST /api/features/:f/approve",
      "POST /api/features/:f/reject",
      "POST /api/features/:f/baseline",
    ]);
  });

  it("answers 404 to any other POST path and requires the header token, JSON and a body under 256 KiB", async () => {
    await withDashboard(async ({ dash, post }) => {
      for (const path of [
        "/api/features/projects/delete",
        "/api/features/projects/waive",
        "/api/features/projects/next",
        "/api/rules",
        "/api/state",
        "/api/features/projects/reports/G1",
      ])
        expect((await post(path, {})).status, path).toBe(404);
      const cookieOnly = await fetch(`${dash.baseUrl}/api/features/projects/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `frontsmith_token=${TOKEN}` },
        body: JSON.stringify({ what: "spec" }),
      });
      expect(cookieOnly.status).toBe(401);
      const text = await fetch(`${dash.baseUrl}/api/features/projects/approve`, {
        method: "POST",
        headers: { "x-frontsmith-token": TOKEN, "content-type": "text/plain" },
        body: "x",
      });
      expect(text.status).toBe(415);
      const badJson = await post("/api/features/projects/approve", "{nope");
      expect(badJson.status).toBe(400);
      const big = await post("/api/features/projects/reject", {
        what: "spec",
        comments: "x".repeat(300 * 1024),
      }).catch(() => undefined);
      if (big) expect(big.status).toBe(413);
    });
  });

  it("approves a spec after the specify unit, rejects with comments and validates bodies", async () => {
    await withDashboard(async ({ f, post }) => {
      const { workflow } = f.services;
      await workflow.newFeature(f.root, {
        feature: "projects",
        intent: "List projects",
        level: "L1",
      });
      f.runner.on("specifier", goodSpec()).on("architect", goodPlan());
      for (let i = 0; i < 6; i += 1) {
        const out = await workflow.next(f.root, "projects", { sessionId: "s", foreground: true });
        if (out.kind === "unit" && out.result.kind !== "advanced") break;
      }
      expect((await post("/api/features/projects/approve", { what: "bogus" })).status).toBe(400);
      expect((await post("/api/features/projects/approve", {})).status).toBe(400);
      expect((await post("/api/features/projects/reject", { what: "spec" })).status).toBe(400);
      expect((await post("/api/features/missing/approve", { what: "spec" })).status).toBe(404);
      const approved = await post("/api/features/projects/approve", { what: "spec" });
      expect(approved.status).toBe(200);
      const body = (await approved.json()) as { message: string; next: { command: string } };
      expect(body.next.command).toContain("/frontsmith:next projects");
      expect((await workflow.status(f.root, "projects")).state.approvals.spec).toBeDefined();
    });
  });

  it("a baseline approval without a fidelity run explains what to do", async () => {
    await withDashboard(async ({ f, post }) => {
      await f.services.workflow.newFeature(f.root, {
        feature: "projects",
        intent: "x",
        level: "L1",
      });
      const res = await post("/api/features/projects/baseline", { caseId: "main-desktop-initial" });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("No fidelity run");
      expect((await post("/api/features/projects/baseline", { caseId: 7 })).status).toBe(400);
    });
  });
});

describe("dashboard theme tokens", () => {
  it("meet WCAG AA contrast in the light and the dark scheme, computed by the plugin's own module", async () => {
    const { contrastRatio, parseColor } = await import("../src/domain/color/contrast.js");
    const css = await readFile(new URL("../assets/dashboard/app.css", import.meta.url), "utf8");
    const read = (block: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g))
        out[m[1] as string] = m[2] as string;
      return out;
    };
    const light = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const dark =
      /prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)\s*\{([^}]*)\}/.exec(
        css,
      )?.[1] ?? "";
    const explicitDark = /:root\[data-theme="dark"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const pairs: Array<[string, string, number]> = [
      ["fg", "bg", 4.5],
      ["fg", "surface", 4.5],
      ["muted", "bg", 4.5],
      ["muted", "surface", 4.5],
      ["link", "bg", 4.5],
      ["on-accent", "accent", 4.5],
      ["pass-fg", "pass-bg", 4.5],
      ["fail-fg", "fail-bg", 4.5],
      ["review-fg", "review-bg", 4.5],
      ["blocked-fg", "blocked-bg", 4.5],
      ["border", "bg", 3],
      ["focus", "bg", 3],
    ];
    for (const [name, tokens] of [
      ["light", read(light)],
      ["dark", read(dark)],
      ["explicit dark", read(explicitDark)],
    ] as const) {
      expect(Object.keys(tokens).length, name).toBeGreaterThan(10);
      for (const [fg, bg, min] of pairs) {
        const a = parseColor(tokens[fg] as string);
        const b = parseColor(tokens[bg] as string);
        if (!a || !b) throw new Error(`${name}: missing token ${fg} or ${bg}`);
        expect(contrastRatio(a, b), `${name} ${fg}/${bg}`).toBeGreaterThanOrEqual(min);
      }
    }
  });
});
