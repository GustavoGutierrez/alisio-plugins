import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateA11y } from "../src/domain/fidelity/a11y.js";
import type { MeasureDoc } from "../src/domain/fidelity/measure.js";
import { type ProbeRequest, parseProbeRequest } from "../src/domain/fidelity/request.js";
import { PlaywrightProbe } from "../src/infrastructure/probe/playwright-probe.js";
import {
  type BrowserLike,
  type ContextLike,
  type PageLike,
  type PlaywrightLike,
  ProbeBlocked,
  resolvePlaywright,
  runProbe,
} from "../src/infrastructure/probe/probe.js";
import {
  FOCUS_BASELINE_SCRIPT,
  FOCUS_STATE_SCRIPT,
  FREEZE_CSS,
  HIDE_MASKS_SCRIPT,
  MEASURE_SCRIPT,
  MUTATE_SCRIPT,
  READY_SCRIPT,
} from "../src/infrastructure/probe/probe-scripts.js";
import { NodeDevServer } from "../src/infrastructure/process/dev-server.js";
import { FakeProcess } from "./helpers/workflow.js";
import { tempWorkspace } from "./helpers/workspace.js";

const request = (over: Partial<ProbeRequest> = {}): ProbeRequest => ({
  schemaVersion: 1,
  baseUrl: "http://127.0.0.1:5173",
  browser: "chromium",
  cases: [
    {
      id: "main-desktop",
      url: "http://127.0.0.1:5173/",
      viewport: [800, 600],
      dpr: 1,
      theme: "light",
      locale: "en-US",
      timezone: "UTC",
      reducedMotion: "reduce",
      localStorage: { flag: "on" },
      masks: ["[data-clock]"],
    },
  ],
  elements: [
    { id: "cta", locator: { role: "button", name: "Create" } },
    { id: "card", locator: { testId: "card" } },
  ],
  styleProps: ["font-size", "color"],
  repetitions: 0,
  mutations: [],
  mutate: [],
  keyboard: { focusOrder: ["cta"] },
  axe: false,
  allowedOrigins: [],
  ...over,
});

describe("probe request validation", () => {
  it("accepts a well formed request", () => {
    expect(parseProbeRequest(request()).ok).toBe(true);
  });

  it("rejects remote origins, bad ids, wrong URLs, unknown mutations and absurd sizes", () => {
    const bad = (over: Record<string, unknown>) => parseProbeRequest({ ...request(), ...over });
    expect(bad({ baseUrl: "http://example.com" }).ok).toBe(false);
    expect(bad({ baseUrl: "https://127.0.0.1:5173" }).ok).toBe(false);
    expect(bad({ browser: "ie" }).ok).toBe(false);
    expect(bad({ cases: [] }).ok).toBe(false);
    expect(bad({ cases: [{ ...request().cases[0], id: "Bad Id" }] }).ok).toBe(false);
    expect(bad({ cases: [{ ...request().cases[0], url: "http://evil.example/" }] }).ok).toBe(false);
    expect(bad({ cases: [{ ...request().cases[0], viewport: [0, 600] }] }).ok).toBe(false);
    expect(bad({ cases: [{ ...request().cases[0], dpr: 9 }] }).ok).toBe(false);
    expect(bad({ mutations: ["delete-everything"] }).ok).toBe(false);
    expect(bad({ repetitions: 99 }).ok).toBe(false);
    expect(bad({ styleProps: ["color; background"] }).ok).toBe(false);
    expect(bad({ allowedOrigins: ["fonts.example"] }).ok).toBe(false);
    expect(bad({ schemaVersion: 2 }).ok).toBe(false);
    expect(parseProbeRequest("nope").ok).toBe(false);
  });
});

describe("browser-side scripts", () => {
  it("are function expressions that Playwright can evaluate with one argument", () => {
    for (const script of [
      READY_SCRIPT,
      MEASURE_SCRIPT,
      HIDE_MASKS_SCRIPT,
      FOCUS_BASELINE_SCRIPT,
      FOCUS_STATE_SCRIPT,
      MUTATE_SCRIPT,
    ])
      expect(() => new Function(`return (${script});`)()).not.toThrow();
    for (const script of [MEASURE_SCRIPT, MUTATE_SCRIPT])
      expect(typeof new Function(`return (${script});`)()).toBe("function");
    expect(FREEZE_CSS).toContain("animation:none!important");
    expect(FREEZE_CSS).toContain("caret-color:transparent!important");
  });
});

/** A browser the test controls: every call is recorded, the evaluations are answered by script. */
function fakePlaywright(options: {
  measured?: Record<string, unknown>;
  launchError?: string;
  addScriptTagFails?: boolean;
  evaluateAxeFails?: boolean;
  focus?: Array<Record<string, unknown>>;
}): { playwright: PlaywrightLike; log: string[]; pages: number } {
  const log: string[] = [];
  const state = { pages: 0 };
  const png = (): Uint8Array => {
    const bytes = new Uint8Array(33);
    new DataView(bytes.buffer).setUint32(16, 800);
    new DataView(bytes.buffer).setUint32(20, 600);
    return bytes;
  };
  const makePage = (): PageLike => {
    let focusIndex = 0;
    return {
      goto: async (url) => void log.push(`goto ${url}`),
      addStyleTag: async () => void log.push("style"),
      addScriptTag: async () => {
        log.push("addScriptTag");
        if (options.addScriptTagFails) throw new Error("blocked by CSP");
      },
      screenshot: async (opts) => {
        log.push(`screenshot ${JSON.stringify(opts)}`);
        return png();
      },
      route: async (_pattern, handler) => {
        const verdicts: string[] = [];
        for (const url of [
          "http://127.0.0.1:5173/app.js",
          "https://tracker.example/x.js",
          "data:text/plain,hi",
        ])
          await handler({
            request: () => ({ url: () => url }),
            abort: async () => void verdicts.push(`abort ${url}`),
            continue: async () => void verdicts.push(`continue ${url}`),
          });
        log.push(`route ${verdicts.join(" | ")}`);
      },
      getByRole: (role, opts) => ({
        first: () => ({ elementHandle: async () => `role:${role}:${opts?.name ?? ""}` }),
      }),
      getByLabel: (text) => ({ first: () => ({ elementHandle: async () => `label:${text}` }) }),
      getByText: (text) => ({ first: () => ({ elementHandle: async () => `text:${text}` }) }),
      locator: (selector) => ({
        first: () => ({
          elementHandle: async () => {
            if (selector.includes("missing")) throw new Error("timeout");
            return `css:${selector}`;
          },
        }),
      }),
      keyboard: { press: async (key) => void log.push(`press ${key}`) },
      evaluate: async (given, arg) => {
        const script =
          typeof given === "function" ? (given as unknown as { source: string }).source : given;
        if (script === READY_SCRIPT) {
          log.push("ready");
          return true;
        }
        if (script === MEASURE_SCRIPT) {
          log.push(`measure ${JSON.stringify((arg as { ids: string[] }).ids)}`);
          return (
            options.measured ?? { pageOverflow: false, fonts: [], elements: {}, maskBoxes: [] }
          );
        }
        if (script === HIDE_MASKS_SCRIPT) {
          log.push(`hide ${JSON.stringify(arg)}`);
          return 1;
        }
        if (script === FOCUS_BASELINE_SCRIPT) return ["a", "b"];
        if (script === FOCUS_STATE_SCRIPT) {
          const step = options.focus?.[focusIndex++];
          return step ?? { body: true };
        }
        if (script === MUTATE_SCRIPT) {
          log.push(`mutate ${(arg as { mutation: string }).mutation}`);
          return (arg as { mutation: string }).mutation;
        }
        if (typeof script === "string" && script.includes("window.axe.run"))
          return [{ id: "image-alt", impact: "critical", help: "Images need alt", nodes: 2 }];
        if (typeof script === "string" && script.includes("typeof window.axe"))
          return !options.evaluateAxeFails && log.includes("axe-evaluated");
        if (typeof script === "string" && script.startsWith("AXE-SOURCE")) {
          log.push("axe-evaluated");
          return undefined;
        }
        return true;
      },
    };
  };
  const context: ContextLike = {
    newPage: async () => {
      state.pages += 1;
      return makePage();
    },
    addInitScript: async (script) => void log.push(`init ${script}`),
    close: async () => void log.push("context closed"),
  };
  const browser: BrowserLike = {
    version: () => "153.0.0.0",
    newContext: async (opts) => {
      log.push(`context ${JSON.stringify(opts)}`);
      return context;
    },
    close: async () => void log.push("browser closed"),
  };
  const playwright: PlaywrightLike = {
    chromium: {
      launch: async () => {
        if (options.launchError) throw new Error(options.launchError);
        return browser;
      },
    },
  };
  return {
    playwright,
    log,
    get pages() {
      return state.pages;
    },
  };
}

const deps = async (playwright: PlaywrightLike, axeSource?: string) => {
  const ws = await tempWorkspace();
  return {
    ws,
    deps: {
      playwright,
      playwrightVersion: "1.63.0",
      outDir: join(ws.root, "run"),
      workspace: ws.root,
      platform: "linux",
      ...(axeSource ? { axeSource } : {}),
    },
  };
};

describe("runProbe orchestration (fake Playwright)", () => {
  it("per case: context options, storage seed, origin allow-list, ready wait, freeze, measure, masks hidden, full-page capture", async () => {
    const fake = fakePlaywright({
      measured: {
        pageOverflow: true,
        fonts: [{ family: "Inter", status: "loaded" }],
        elements: { cta: null, card: null },
        maskBoxes: [{ x: 1, y: 2, width: 3, height: 4 }],
      },
    });
    const { ws, deps: d } = await deps(fake.playwright);
    try {
      const doc = await runProbe(request(), d);
      const log = fake.log.join("\n");
      expect(log).toContain('"viewport":{"width":800,"height":600}');
      expect(log).toContain('"deviceScaleFactor":1');
      expect(log).toContain('"colorScheme":"light"');
      expect(log).toContain('"reducedMotion":"reduce"');
      expect(log).toContain('"timezoneId":"UTC"');
      expect(log).toContain('"flag":"on"');
      expect(log).toContain("continue http://127.0.0.1:5173/app.js");
      expect(log).toContain("abort https://tracker.example/x.js");
      expect(log).toContain("continue data:text/plain,hi");
      expect(fake.log.indexOf("ready")).toBeLessThan(fake.log.indexOf("style"));
      expect(fake.log.findIndex((l) => l.startsWith("measure"))).toBeLessThan(
        fake.log.findIndex((l) => l.startsWith("hide")),
      );
      expect(log).toContain('"fullPage":true');
      expect(log).toContain('"animations":"disabled"');
      expect(log).toContain('"caret":"hide"');
      expect(log).toContain('measure ["cta","card"]');
      expect(log).toContain('hide ["[data-clock]"]');
      expect(fake.log.at(-1)).toBe("browser closed");
      expect(doc).toMatchObject({
        schemaVersion: 1,
        environment: {
          browser: "chromium",
          browserVersion: "153.0.0.0",
          playwrightVersion: "1.63.0",
          os: "linux",
          dpr: 1,
        },
      });
      expect(doc.cases["main-desktop"]).toMatchObject({
        capture: "main-desktop.png",
        captureSize: [800, 600],
        pageOverflow: true,
        masks: [{ x: 1, y: 2, width: 3, height: 4 }],
      });
      const onDisk = JSON.parse(
        await readFile(join(d.outDir, "measure.json"), "utf8"),
      ) as MeasureDoc;
      expect(onDisk).toEqual(doc);
      expect((await readFile(join(d.outDir, "main-desktop.png"))).length).toBe(33);
    } finally {
      await ws.cleanup();
    }
  });

  it("builds locators by role, test id, label, text and css; a locator that times out is a missing element", async () => {
    const fake = fakePlaywright({});
    const { ws, deps: d } = await deps(fake.playwright);
    try {
      await runProbe(
        request({
          elements: [
            { id: "a-role", locator: { role: "button", name: "Go" } },
            { id: "b-test", locator: { testId: 'x"y' } },
            { id: "c-label", locator: { label: "Email" } },
            { id: "d-text", locator: { text: "Hello" } },
            { id: "e-css", locator: { css: ".missing" } },
          ],
          keyboard: { focusOrder: [] },
        }),
        d,
      );
      expect(fake.log.some((l) => l.startsWith('measure ["a-role"'))).toBe(true);
    } finally {
      await ws.cleanup();
    }
  });

  it("walks the focus order with Tab until focus returns to the body", async () => {
    const fake = fakePlaywright({
      focus: [
        { body: false, elementId: "cta", visible: true, obscured: false, indicator: true },
        { body: false, elementId: null, visible: true, obscured: true, indicator: false },
      ],
    });
    const { ws, deps: d } = await deps(fake.playwright);
    try {
      const doc = await runProbe(request(), d);
      expect(fake.log.filter((l) => l === "press Tab")).toHaveLength(3);
      expect(doc.cases["main-desktop"]?.focus).toEqual([
        { elementId: "cta", visible: true, obscured: false, indicator: true },
        { elementId: null, visible: true, obscured: true, indicator: false },
      ]);
      const report = evaluateA11y({
        cases: Object.values(doc.cases),
        focusOrder: ["cta"],
        target: "AA",
        margin: { text: 4.5, nonText: 3 },
        axeRequested: false,
      });
      expect(report.findings.filter((f) => f.ruleId === "FOC-OBSCURED")).toHaveLength(0);
    } finally {
      await ws.cleanup();
    }
  });

  it("takes repetitions and applies each mutation on a fresh page before its capture", async () => {
    const fake = fakePlaywright({});
    const { ws, deps: d } = await deps(fake.playwright);
    try {
      const doc = await runProbe(
        request({
          repetitions: 2,
          mutations: ["translate-x-2", "hide-icons"],
          mutate: ["cta"],
          keyboard: { focusOrder: [] },
        }),
        d,
      );
      expect(doc.cases["main-desktop"]).toMatchObject({
        repetitions: ["main-desktop.rep1.png", "main-desktop.rep2.png"],
        mutations: {
          "translate-x-2": "main-desktop.mut-translate-x-2.png",
          "hide-icons": "main-desktop.mut-hide-icons.png",
        },
      });
      expect(fake.log.filter((l) => l.startsWith("mutate "))).toEqual([
        "mutate translate-x-2",
        "mutate hide-icons",
      ]);
      expect(fake.pages).toBe(1 + 2 + 2);
      expect((await readFile(join(d.outDir, "main-desktop.mut-hide-icons.png"))).length).toBe(33);
    } finally {
      await ws.cleanup();
    }
  });

  it("injects axe with a script tag first and by evaluation when the page forbids it (S-R17); blocks when neither works or axe is absent", async () => {
    const ok = fakePlaywright({ addScriptTagFails: true });
    const a = await deps(ok.playwright, "AXE-SOURCE window.axe = {}");
    try {
      const doc = await runProbe(request({ axe: true, keyboard: { focusOrder: [] } }), a.deps);
      expect(ok.log).toContain("addScriptTag");
      expect(ok.log).toContain("axe-evaluated");
      expect(doc.cases["main-desktop"]?.axe).toEqual({
        violations: [{ id: "image-alt", impact: "critical", help: "Images need alt", nodes: 2 }],
      });
    } finally {
      await a.ws.cleanup();
    }
    const stuck = fakePlaywright({ addScriptTagFails: true, evaluateAxeFails: true });
    const b = await deps(stuck.playwright, "AXE-SOURCE window.axe = {}");
    try {
      const doc = await runProbe(request({ axe: true, keyboard: { focusOrder: [] } }), b.deps);
      expect(doc.cases["main-desktop"]?.axe).toEqual({ blocked: "axe-core-not-injectable" });
    } finally {
      await b.ws.cleanup();
    }
    const absent = fakePlaywright({});
    const c = await deps(absent.playwright);
    try {
      const doc = await runProbe(request({ axe: true, keyboard: { focusOrder: [] } }), c.deps);
      expect(doc.cases["main-desktop"]?.axe).toEqual({ blocked: "axe-core-not-installed" });
    } finally {
      await c.ws.cleanup();
    }
  });

  it("is BLOCKED with the reason when the browser cannot start or the engine is missing", async () => {
    const broken = fakePlaywright({ launchError: "Executable doesn't exist at /x/chrome" });
    const a = await deps(broken.playwright);
    try {
      await expect(runProbe(request(), a.deps)).rejects.toMatchObject({
        reason: "browser-unavailable",
      });
      await expect(runProbe(request({ browser: "firefox" }), a.deps)).rejects.toBeInstanceOf(
        ProbeBlocked,
      );
    } finally {
      await a.ws.cleanup();
    }
  });
});

describe("resolvePlaywright (spec 11.2)", () => {
  it("is BLOCKED with the install hint when the workspace has neither playwright nor @playwright/test", async () => {
    const ws = await tempWorkspace({ "package.json": "{}" });
    try {
      try {
        resolvePlaywright(ws.root);
        throw new Error("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ProbeBlocked);
        expect((error as ProbeBlocked).reason).toBe("playwright-not-installed");
        expect((error as ProbeBlocked).hint).toContain("browser install command");
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("resolves the project's own copy: playwright first, then @playwright/test", async () => {
    const ws = await tempWorkspace({ "package.json": "{}" });
    try {
      await mkdir(join(ws.root, "node_modules/@playwright/test"), { recursive: true });
      await writeFile(
        join(ws.root, "node_modules/@playwright/test/package.json"),
        JSON.stringify({ name: "@playwright/test", version: "9.9.9", main: "index.js" }),
      );
      await writeFile(
        join(ws.root, "node_modules/@playwright/test/index.js"),
        "module.exports = { chromium: { name: 'from-test' } };",
      );
      expect(resolvePlaywright(ws.root)).toMatchObject({
        version: "9.9.9",
        module: { chromium: { name: "from-test" } },
      });
      await mkdir(join(ws.root, "node_modules/playwright"), { recursive: true });
      await writeFile(
        join(ws.root, "node_modules/playwright/package.json"),
        JSON.stringify({ name: "playwright", version: "1.0.0", main: "index.js" }),
      );
      await writeFile(
        join(ws.root, "node_modules/playwright/index.js"),
        "module.exports = { chromium: { name: 'from-playwright' } };",
      );
      expect(resolvePlaywright(ws.root)).toMatchObject({
        version: "1.0.0",
        module: { chromium: { name: "from-playwright" } },
      });
    } finally {
      await ws.cleanup();
    }
  });
});

describe("PlaywrightProbe adapter", () => {
  const files = new Map<string, string>();
  const make = (proc: FakeProcess, over: { env?: Record<string, string> } = {}) =>
    new PlaywrightProbe({
      process: proc,
      writer: { write: async (_root, path, content) => void files.set(path, content) },
      readText: async (_root, relative) => files.get(relative),
      probeScript: "/pkg/dist/infrastructure/probe/probe.js",
      ...(over.env ? { env: over.env } : {}),
    });
  const input = {
    root: "/w/app",
    runDir: ".alisio/frontsmith/evidence/projects/r1",
    request: request(),
  };
  const measure = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures/fidelity/measure-pass.json"), "utf8"),
  ) as MeasureDoc;

  it("writes the request, runs node on the compiled probe with the workspace as cwd and reads measure.json back", async () => {
    files.clear();
    files.set(`${input.runDir}/measure.json`, JSON.stringify(measure));
    const proc = new FakeProcess().when(
      () => true,
      () => ({ stdout: `noise\n${JSON.stringify({ status: "ok", cases: 2, outDir: "x" })}\n` }),
    );
    const outcome = await make(proc, { env: { FRONTSMITH_BROWSER_NO_SANDBOX: "1" } }).run(input);
    expect(outcome).toMatchObject({ status: "ok", runDir: input.runDir });
    expect(proc.calls[0]).toEqual({
      argv: [
        "node",
        "/pkg/dist/infrastructure/probe/probe.js",
        "--request",
        `${input.runDir}/request.json`,
      ],
      cwd: "/w/app",
    });
    expect(JSON.parse(files.get(`${input.runDir}/request.json`) ?? "{}")).toMatchObject({
      schemaVersion: 1,
      baseUrl: "http://127.0.0.1:5173",
    });
  });

  it("passes the BLOCKED summary of the probe through", async () => {
    files.clear();
    const proc = new FakeProcess().when(
      () => true,
      () => ({
        code: 3,
        stdout: `${JSON.stringify({ status: "BLOCKED", reason: "playwright-not-installed", hint: "Add playwright" })}\n`,
      }),
    );
    expect(await make(proc).run(input)).toEqual({
      status: "BLOCKED",
      reason: "playwright-not-installed",
      hint: "Add playwright",
    });
  });

  it("is BLOCKED, never ok, on a crash, a timeout, a cancellation, a missing or damaged measure.json", async () => {
    files.clear();
    const crash = new FakeProcess().when(
      () => true,
      () => ({ code: 2, stderr: "invalid request: baseUrl must be loopback" }),
    );
    expect(await make(crash).run(input)).toMatchObject({
      status: "BLOCKED",
      reason: "probe-failed",
      hint: expect.stringContaining("invalid request"),
    });
    const slow = new FakeProcess().when(
      () => true,
      () => ({ code: null, timedOut: true }),
    );
    expect(await make(slow).run(input)).toMatchObject({
      status: "BLOCKED",
      reason: "probe-timeout",
    });
    const cancelled = new FakeProcess().when(
      () => true,
      () => ({ code: null, cancelled: true }),
    );
    expect(await make(cancelled).run(input)).toMatchObject({
      status: "BLOCKED",
      reason: "cancelled",
    });
    const ok = new FakeProcess().when(
      () => true,
      () => ({ stdout: `${JSON.stringify({ status: "ok", cases: 1, outDir: "x" })}\n` }),
    );
    expect(await make(ok).run(input)).toMatchObject({
      status: "BLOCKED",
      hint: "measure.json was not written",
    });
    files.set(`${input.runDir}/measure.json`, "{not json");
    expect(await make(ok).run(input)).toMatchObject({
      status: "BLOCKED",
      hint: "measure.json is not valid JSON",
    });
    files.set(`${input.runDir}/measure.json`, JSON.stringify({ schemaVersion: 1 }));
    expect(await make(ok).run(input)).toMatchObject({ status: "BLOCKED", reason: "probe-failed" });
    const silent = new FakeProcess().when(
      () => true,
      () => ({ stdout: "" }),
    );
    expect(await make(silent).run(input)).toMatchObject({
      status: "BLOCKED",
      reason: "probe-failed",
      hint: "the probe produced no result",
    });
  });

  it("sizes the timeout by the number of captures", async () => {
    files.clear();
    const seen: number[] = [];
    const proc = {
      calls: [],
      run: async (_a: readonly string[], o: { timeoutMs: number }) => {
        seen.push(o.timeoutMs);
        return {
          code: 1,
          stdout: "",
          stderr: "",
          timedOut: false,
          truncated: false,
          cancelled: false,
          durationMs: 1,
        };
      },
    };
    await new PlaywrightProbe({
      process: proc as never,
      writer: { write: async () => undefined },
      readText: async () => undefined,
      probeScript: "/p.js",
    }).run({
      ...input,
      request: request({ repetitions: 7, mutations: ["translate-x-2", "hide-icons"] }),
    });
    expect(seen[0]).toBe(15_000 * 10);
  });
});

describe("NodeDevServer", () => {
  it("starts a command, waits for the ready URL and stops the process group", async () => {
    const ws = await tempWorkspace();
    try {
      const probe = createServer((_req, res) => res.end("up"));
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
      const port = (probe.address() as { port: number }).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      const script = `require("http").createServer((q, r) => r.end("ok")).listen(${port}, "127.0.0.1")`;
      const started = await new NodeDevServer().start({
        root: ws.root,
        argv: [process.execPath, "-e", script],
        readyUrl: `http://127.0.0.1:${port}/`,
        timeoutMs: 15_000,
      });
      expect(started.ok).toBe(true);
      if (started.ok) {
        expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
        await started.server.stop();
        await new Promise((r) => setTimeout(r, 300));
        await expect(
          fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }),
        ).rejects.toBeDefined();
      }
    } finally {
      await ws.cleanup();
    }
  });

  it("reports a command that exits early, one that never answers, an empty command and a cancellation", async () => {
    const ws = await tempWorkspace();
    try {
      const server = new NodeDevServer();
      expect(
        await server.start({
          root: ws.root,
          argv: [process.execPath, "-e", "process.exit(1)"],
          readyUrl: "http://127.0.0.1:9/",
          timeoutMs: 10_000,
        }),
      ).toEqual({ ok: false, reason: "the serve command exited before it was ready" });
      const never = await server.start({
        root: ws.root,
        argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
        readyUrl: "http://127.0.0.1:9/",
        timeoutMs: 600,
      });
      expect(never).toMatchObject({
        ok: false,
        reason: expect.stringContaining("did not answer within 600 ms"),
      });
      expect(
        await server.start({
          root: ws.root,
          argv: [],
          readyUrl: "http://127.0.0.1:9/",
          timeoutMs: 100,
        }),
      ).toMatchObject({ ok: false });
      const controller = new AbortController();
      controller.abort();
      expect(
        await server.start({
          root: ws.root,
          argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
          readyUrl: "http://127.0.0.1:9/",
          timeoutMs: 5000,
          signal: controller.signal,
        }),
      ).toEqual({ ok: false, reason: "cancelled" });
      expect(
        await server.start({
          root: ws.root,
          argv: ["definitely-not-a-command-xyz"],
          readyUrl: "http://127.0.0.1:9/",
          timeoutMs: 5000,
        }),
      ).toMatchObject({ ok: false });
    } finally {
      await ws.cleanup();
    }
  });
});
