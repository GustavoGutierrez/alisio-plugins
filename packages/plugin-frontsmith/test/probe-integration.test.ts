import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProbeRequest } from "../src/domain/fidelity/request.js";
import { decodePng } from "../src/infrastructure/png/decode.js";
import { resolvePlaywright, runProbe } from "../src/infrastructure/probe/probe.js";
import { tempWorkspace } from "./helpers/workspace.js";

/**
 * Real-browser integration. Point FRONTSMITH_TEST_PLAYWRIGHT_ROOT at a directory whose
 * node_modules holds `playwright` (with its browser installed); FRONTSMITH_BROWSER_EXECUTABLE and
 * FRONTSMITH_BROWSER_NO_SANDBOX=1 are honoured as in production.
 */
const root = process.env.FRONTSMITH_TEST_PLAYWRIGHT_ROOT;
let resolved: ReturnType<typeof resolvePlaywright> | undefined;
try {
  resolved = root ? resolvePlaywright(root) : undefined;
} catch {
  resolved = undefined;
}
if (!resolved)
  console.info(
    "probe-integration skipped: set FRONTSMITH_TEST_PLAYWRIGHT_ROOT to a directory with playwright installed",
  );

const PAGE = `<!doctype html><html lang="en"><head><title>t</title><style>
body{margin:0;font:16px sans-serif;background:#fff}
button{position:absolute;left:100px;top:100px;width:120px;height:40px;background:#123456;color:#fff;border:0}
button:focus-visible{outline:3px solid #f00}
.clock{position:absolute;left:300px;top:100px}
</style></head><body><button data-testid="cta">Create</button><span class="clock" data-clock>12:00</span></body></html>`;

describe.skipIf(!resolved)("probe against a real browser", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((_q, res) => {
      res.setHeader("content-type", "text/html");
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("measures, captures deterministically, walks focus and applies a mutation", async () => {
    const ws = await tempWorkspace();
    try {
      const request: ProbeRequest = {
        schemaVersion: 1,
        baseUrl: base,
        browser: "chromium",
        cases: [
          {
            id: "home-desktop",
            url: `${base}/`,
            viewport: [640, 400],
            dpr: 1,
            theme: "light",
            locale: "en-US",
            timezone: "UTC",
            reducedMotion: "reduce",
            localStorage: {},
            masks: ["[data-clock]"],
          },
        ],
        elements: [
          { id: "cta", locator: { testId: "cta" } },
          { id: "ghost", locator: { testId: "nope" } },
        ],
        styleProps: ["font-size", "color"],
        repetitions: 1,
        mutations: ["translate-x-2"],
        mutate: ["cta"],
        keyboard: { focusOrder: ["cta"] },
        axe: false,
        allowedOrigins: [],
      };
      const doc = await runProbe(request, {
        playwright: resolved?.module as never,
        playwrightVersion: resolved?.version ?? "0",
        outDir: join(ws.root, "run"),
        workspace: ws.root,
        platform: process.platform,
        launchOptions: {
          ...(process.env.FRONTSMITH_BROWSER_EXECUTABLE
            ? { executablePath: process.env.FRONTSMITH_BROWSER_EXECUTABLE }
            : {}),
          ...(process.env.FRONTSMITH_BROWSER_NO_SANDBOX === "1" ? { args: ["--no-sandbox"] } : {}),
        },
      });
      const record = doc.cases["home-desktop"];
      expect(record?.captureSize).toEqual([640, 400]);
      expect(record?.elements.cta).toMatchObject({
        box: { x: 100, y: 100, width: 120, height: 40 },
      });
      expect(record?.elements.ghost).toBeNull();
      expect(record?.focus?.[0]).toMatchObject({ elementId: "cta", visible: true });
      const first = decodePng(
        new Uint8Array(await readFile(join(ws.root, "run", "home-desktop.png"))),
      );
      const again = decodePng(
        new Uint8Array(await readFile(join(ws.root, "run", "home-desktop.rep1.png"))),
      );
      expect([first.width, first.height]).toEqual([640, 400]);
      expect(Buffer.from(first.data).equals(Buffer.from(again.data))).toBe(true);
      const moved = decodePng(
        new Uint8Array(await readFile(join(ws.root, "run", "home-desktop.mut-translate-x-2.png"))),
      );
      expect(Buffer.from(first.data).equals(Buffer.from(moved.data))).toBe(false);
    } finally {
      await ws.cleanup();
    }
  }, 60_000);
});

describe.skipIf(!!resolved)("probe against a real browser (skipped)", () => {
  it.skip("needs FRONTSMITH_TEST_PLAYWRIGHT_ROOT", () => undefined);
});
