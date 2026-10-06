#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaseMeasure, FocusStep, MeasureDoc } from "../../domain/fidelity/measure.js";
import {
  FOCUS_BASELINE_SCRIPT,
  FOCUS_STATE_SCRIPT,
  FREEZE_CSS,
  HIDE_MASKS_SCRIPT,
  MEASURE_SCRIPT,
  MUTATE_SCRIPT,
  READY_SCRIPT,
} from "./probe-scripts.js";
import {
  type ProbeCase,
  type ProbeLocator,
  type ProbeRequest,
  type ProbeSummary,
  parseProbeRequest,
} from "./request.js";

/** The small part of Playwright the probe uses; the project's own Playwright provides it (AD-7). */
export interface LocatorLike {
  first(): { elementHandle(options?: { timeout?: number }): Promise<unknown> };
}
export interface PageLike {
  goto(url: string, options?: { waitUntil?: string }): Promise<unknown>;
  evaluate(script: string | ((arg?: unknown) => unknown), arg?: unknown): Promise<unknown>;
  addStyleTag(options: { content: string }): Promise<unknown>;
  addScriptTag(options: { content: string }): Promise<unknown>;
  screenshot(options: Record<string, unknown>): Promise<Uint8Array>;
  getByRole(role: string, options?: { name?: string }): LocatorLike;
  getByLabel(text: string): LocatorLike;
  getByText(text: string): LocatorLike;
  locator(selector: string): LocatorLike;
  route(pattern: string, handler: (route: RouteLike) => unknown): Promise<unknown>;
  keyboard: { press(key: string): Promise<unknown> };
}
export interface RouteLike {
  request(): { url(): string };
  abort(): Promise<unknown>;
  continue(): Promise<unknown>;
}
export interface ContextLike {
  newPage(): Promise<PageLike>;
  addInitScript(script: string): Promise<unknown>;
  close(): Promise<unknown>;
}
export interface BrowserLike {
  version(): string;
  newContext(options: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<unknown>;
}
export interface PlaywrightLike {
  chromium?: { launch(options?: Record<string, unknown>): Promise<BrowserLike> };
  firefox?: { launch(options?: Record<string, unknown>): Promise<BrowserLike> };
  webkit?: { launch(options?: Record<string, unknown>): Promise<BrowserLike> };
}

export class ProbeBlocked extends Error {
  constructor(
    readonly reason: string,
    readonly hint: string,
  ) {
    super(reason);
    this.name = "ProbeBlocked";
  }
}

/** Resolve the workspace's own Playwright: `playwright`, then `@playwright/test` (spec 11.2). */
export function resolvePlaywright(workspace: string): { module: PlaywrightLike; version: string } {
  const require = createRequire(join(workspace, "package.json"));
  for (const name of ["playwright", "@playwright/test"]) {
    try {
      const module = require(name) as PlaywrightLike;
      let version = "unknown";
      try {
        version = (require(`${name}/package.json`) as { version?: string }).version ?? "unknown";
      } catch {
        // The version is informational.
      }
      return { module, version };
    } catch {
      // Try the next name.
    }
  }
  throw new ProbeBlocked(
    "playwright-not-installed",
    "Add playwright or @playwright/test to the project and run its browser install command",
  );
}

const locatorOf = (page: PageLike, locator: ProbeLocator): LocatorLike => {
  if (locator.role !== undefined)
    return page.getByRole(locator.role, locator.name !== undefined ? { name: locator.name } : {});
  if (locator.testId !== undefined)
    return page.locator(`[data-testid="${locator.testId.replace(/"/g, '\\"')}"]`);
  if (locator.label !== undefined) return page.getByLabel(locator.label);
  if (locator.text !== undefined) return page.getByText(locator.text);
  return page.locator(locator.css ?? "body");
};

export interface RunDeps {
  playwright: PlaywrightLike;
  playwrightVersion: string;
  outDir: string;
  workspace: string;
  platform: string;
  /** `axe.min.js` source when axe-core resolves from the workspace. */
  axeSource?: string;
  launchOptions?: Record<string, unknown>;
}

const MAX_TABS = 10;

async function handlesFor(page: PageLike, request: ProbeRequest): Promise<unknown[]> {
  const handles: unknown[] = [];
  for (const element of request.elements) {
    try {
      handles.push(await locatorOf(page, element.locator).first().elementHandle({ timeout: 1500 }));
    } catch {
      handles.push(null);
    }
  }
  return handles;
}

/**
 * Playwright evaluates a string as an expression and never calls it, so an in-page function kept as
 * a string must be passed as a real function. The wrapper keeps the source on `.source`.
 */
export function asFunction(source: string): ((arg?: unknown) => unknown) & { source: string } {
  const fn = new Function("arg", `return (${source})(arg);`) as ((arg?: unknown) => unknown) & {
    source: string;
  };
  fn.source = source;
  return fn;
}

const FUNCTION_SOURCE = /^\s*(async\s+)?\([^)]*\)\s*=>/;

function callable(page: PageLike): PageLike {
  return new Proxy(page, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "evaluate")
        return (script: unknown, arg?: unknown) =>
          target.evaluate(
            (typeof script === "string" && FUNCTION_SOURCE.test(script)
              ? asFunction(script)
              : script) as never,
            arg,
          );
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

async function prepare(
  browser: BrowserLike,
  request: ProbeRequest,
  c: ProbeCase,
): Promise<{ context: ContextLike; page: PageLike }> {
  const context = await browser.newContext({
    viewport: { width: c.viewport[0], height: c.viewport[1] },
    deviceScaleFactor: c.dpr,
    locale: c.locale,
    timezoneId: c.timezone,
    colorScheme: c.theme,
    reducedMotion: c.reducedMotion,
  });
  if (Object.keys(c.localStorage).length > 0)
    await context.addInitScript(
      `(() => { const values = ${JSON.stringify(c.localStorage)}; for (const key of Object.keys(values)) localStorage.setItem(key, values[key]); })()`,
    );
  const page = callable(await context.newPage());
  const allowed = new Set([new URL(request.baseUrl).origin, ...request.allowedOrigins]);
  await page.route("**/*", (route) => {
    let origin = "";
    try {
      origin = new URL(route.request().url()).origin;
    } catch {
      origin = "";
    }
    // `data:` and `blob:` URLs have no network origin and stay allowed.
    return allowed.has(origin) || origin === "null" || origin === ""
      ? route.continue()
      : route.abort();
  });
  await page.goto(c.url, { waitUntil: "load" });
  await page.evaluate(READY_SCRIPT);
  await page.addStyleTag({ content: FREEZE_CSS });
  return { context, page };
}

async function keyboardProbe(
  page: PageLike,
  request: ProbeRequest,
  handles: unknown[],
): Promise<FocusStep[]> {
  const ids = request.elements.map((e) => e.id);
  const baseline = (await page.evaluate(FOCUS_BASELINE_SCRIPT, { handles })) as string[];
  await page.evaluate("() => { document.body.focus(); return true; }");
  const steps: FocusStep[] = [];
  const presses = request.keyboard.focusOrder.length + MAX_TABS;
  for (let i = 0; i < presses; i += 1) {
    await page.keyboard.press("Tab");
    const state = (await page.evaluate(FOCUS_STATE_SCRIPT, { handles, ids, baseline })) as
      | { body: true }
      | {
          body: false;
          elementId: string | null;
          visible: boolean;
          obscured: boolean;
          indicator: boolean;
        };
    if (state.body) break;
    steps.push({
      elementId: state.elementId,
      visible: state.visible,
      obscured: state.obscured,
      indicator: state.indicator,
    });
  }
  return steps;
}

async function axeProbe(page: PageLike, deps: RunDeps): Promise<CaseMeasure["axe"]> {
  if (!deps.axeSource) return { blocked: "axe-core-not-installed" };
  // Under a strict CSP an injected script tag is blocked; evaluating the source is the second try (S-R17).
  let injected = false;
  try {
    await page.addScriptTag({ content: deps.axeSource });
    injected = (await page.evaluate("() => typeof window.axe === 'object'")) === true;
  } catch {
    injected = false;
  }
  if (!injected)
    try {
      await page.evaluate(deps.axeSource);
      injected = (await page.evaluate("() => typeof window.axe === 'object'")) === true;
    } catch {
      injected = false;
    }
  if (!injected) return { blocked: "axe-core-not-injectable" };
  const result = (await page.evaluate(
    `async () => { const r = await window.axe.run(document, { resultTypes: ["violations"] }); return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })); }`,
  )) as NonNullable<Extract<CaseMeasure["axe"], { violations: unknown }>>["violations"];
  return { violations: result };
}

/** Run every case of a request and write the PNGs and `measure.json` into `outDir` (spec 11.2). */
export async function runProbe(request: ProbeRequest, deps: RunDeps): Promise<MeasureDoc> {
  const engine = deps.playwright[request.browser];
  if (!engine)
    throw new ProbeBlocked("browser-unavailable", `Playwright has no ${request.browser} engine`);
  let browser: BrowserLike;
  try {
    browser = await engine.launch(deps.launchOptions ?? {});
  } catch (error) {
    throw new ProbeBlocked(
      "browser-unavailable",
      `${(error instanceof Error ? error.message : String(error)).slice(0, 500)} (install the browser with the project's Playwright install command)`,
    );
  }
  await mkdir(deps.outDir, { recursive: true });
  const cases: Record<string, CaseMeasure> = {};
  try {
    for (const c of request.cases) {
      const { context, page } = await prepare(browser, request, c);
      const handles = await handlesFor(page, request);
      const ids = request.elements.map((e) => e.id);
      const measured = (await page.evaluate(MEASURE_SCRIPT, {
        handles,
        ids,
        styleProps: request.styleProps,
        masks: c.masks,
      })) as {
        pageOverflow: boolean;
        fonts: Array<{ family: string; status: string }>;
        elements: CaseMeasure["elements"];
        maskBoxes: CaseMeasure["masks"];
      };
      const focus =
        request.keyboard.focusOrder.length > 0
          ? await keyboardProbe(page, request, handles)
          : undefined;
      const axe = request.axe ? await axeProbe(page, deps) : undefined;
      await page.evaluate(HIDE_MASKS_SCRIPT, c.masks);
      const capture = `${c.id}.png`;
      const shot = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
      await writeFile(join(deps.outDir, capture), shot);
      const size = readSize(shot);
      const record: CaseMeasure = {
        caseId: c.id,
        viewport: c.viewport,
        capture,
        captureSize: size,
        pageOverflow: measured.pageOverflow,
        elements: measured.elements,
        fonts: measured.fonts,
        masks: measured.maskBoxes,
        ...(focus ? { focus } : {}),
        ...(axe ? { axe } : {}),
      };
      for (let rep = 1; rep <= request.repetitions; rep += 1) {
        const again = await prepare(browser, request, c);
        await again.page.evaluate(HIDE_MASKS_SCRIPT, c.masks);
        const file = `${c.id}.rep${rep}.png`;
        await writeFile(
          join(deps.outDir, file),
          await again.page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }),
        );
        record.repetitions = [...(record.repetitions ?? []), file];
        await again.context.close();
      }
      for (const mutation of request.mutations) {
        const mutated = await prepare(browser, request, c);
        const targets = await handlesFor(mutated.page, {
          ...request,
          elements: request.elements.filter((e) => request.mutate.includes(e.id)),
        });
        await mutated.page.evaluate(MUTATE_SCRIPT, { handles: targets, mutation });
        await mutated.page.evaluate(HIDE_MASKS_SCRIPT, c.masks);
        const file = `${c.id}.mut-${mutation}.png`;
        await writeFile(
          join(deps.outDir, file),
          await mutated.page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }),
        );
        record.mutations = { ...(record.mutations ?? {}), [mutation]: file };
        await mutated.context.close();
      }
      cases[c.id] = record;
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const doc: MeasureDoc = {
    schemaVersion: 1,
    environment: {
      browser: request.browser,
      browserVersion: browser.version(),
      playwrightVersion: deps.playwrightVersion,
      os: deps.platform,
      dpr: request.cases[0]?.dpr ?? 1,
    },
    cases,
  };
  await writeFile(join(deps.outDir, "measure.json"), `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

/** Pixel size of a PNG from its header (the capture is in device pixels). */
function readSize(png: Uint8Array): [number, number] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
}

/** `node probe.js --request <file>`: prints one JSON line; exit 0 ok, 3 BLOCKED, 2 bad request. */
export async function main(argv: readonly string[], workspace = process.cwd()): Promise<number> {
  const at = argv.indexOf("--request");
  const file = at >= 0 ? argv[at + 1] : undefined;
  const print = (summary: ProbeSummary): void =>
    void process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!file) {
    process.stderr.write("usage: probe --request <file>\n");
    return 2;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(workspace, file), "utf8"));
  } catch (error) {
    process.stderr.write(
      `cannot read the request: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
  const parsed = parseProbeRequest(raw);
  if (!parsed.ok) {
    process.stderr.write(`invalid request: ${parsed.errors.join("; ")}\n`);
    return 2;
  }
  try {
    const { module, version } = resolvePlaywright(workspace);
    let axeSource: string | undefined;
    try {
      const require = createRequire(join(workspace, "package.json"));
      axeSource = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
    } catch {
      axeSource = undefined;
    }
    const executable = process.env.FRONTSMITH_BROWSER_EXECUTABLE;
    const doc = await runProbe(parsed.request, {
      playwright: module,
      playwrightVersion: version,
      outDir: dirname(resolve(workspace, file)),
      workspace,
      platform: process.platform,
      ...(axeSource ? { axeSource } : {}),
      launchOptions: {
        ...(executable ? { executablePath: executable } : {}),
        ...(process.env.FRONTSMITH_BROWSER_NO_SANDBOX === "1" ? { args: ["--no-sandbox"] } : {}),
      },
    });
    print({
      status: "ok",
      cases: Object.keys(doc.cases).length,
      outDir: dirname(resolve(workspace, file)),
    });
    return 0;
  } catch (error) {
    if (error instanceof ProbeBlocked) {
      print({ status: "BLOCKED", reason: error.reason, hint: error.hint });
      return 3;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
