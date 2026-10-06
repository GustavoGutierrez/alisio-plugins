import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fidelityPrepared } from "../src/application/checks/fidelity-run.js";
import type {
  BrowserProbe,
  ProbeInput,
  ProbeOutcome,
} from "../src/application/ports/browser-probe.js";
import type { PngImage } from "../src/domain/fidelity/image.js";
import type { MeasureDoc } from "../src/domain/fidelity/measure.js";
import { registerFrontsmith } from "../src/index.js";
import { FsAssetReader } from "../src/infrastructure/fs/asset-reader.js";
import { decodePng } from "../src/infrastructure/png/decode.js";
import { encodePng } from "../src/infrastructure/png/encode.js";
import { compose } from "../src/interface/composition.js";
import { loadAgentProfile } from "../src/resources.js";
import { cliRun } from "./helpers/cli.js";
import { createHarness } from "./helpers/harness.js";
import { clonePng, fillRect, solid } from "./helpers/png.js";
import {
  FakeProcess,
  NOW,
  ScriptedRunner,
  type WorkflowFixture,
  workflowFixture,
} from "./helpers/workflow.js";

// Each case encodes and decodes several full-size PNGs; allow for a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "fidelity", name), "utf8")) as T;
const assets = new FsAssetReader();
const CASES = ["projects-desktop-success", "projects-mobile-success"];

/** What each mutation does to the page in the fake browser: the 2 px translations are small, the rest visible. */
const mutated = (file: string): PngImage => {
  if (file.includes("mut-translate-x-2") || file.includes("mut-translate-y-2")) return page(2);
  if (file.includes(".mut-")) return page(4);
  return page();
};

/** The page as the fake browser draws it: a white page with a dark block inside the cards region. */
const page = (dx = 0, colour: [number, number, number, number] = [20, 20, 20, 255]): PngImage => {
  const image = solid(1024, 640);
  fillRect(image, 24, 80, 600, 400, [245, 245, 245, 255]);
  fillRect(image, 60 + dx, 120, 200, 100, colour);
  return image;
};

interface Plan {
  /** The capture of each case, by file name. */
  capture: (file: string, caseId: string) => PngImage;
  measure?: (doc: MeasureDoc) => void;
  outcome?: ProbeOutcome;
}

class FakeProbe implements BrowserProbe {
  readonly inputs: ProbeInput[] = [];
  plan: Plan = { capture: () => page() };
  async run(input: ProbeInput): Promise<ProbeOutcome> {
    this.inputs.push(input);
    if (this.plan.outcome) return this.plan.outcome;
    const doc = fixture<MeasureDoc>("measure-pass.json");
    for (const caseId of input.request.cases.map((c) => c.id)) {
      const record = doc.cases[caseId];
      if (!record) continue;
      await assets.write(
        input.root,
        `${input.runDir}/${record.capture}`,
        encodePng(this.plan.capture(record.capture, caseId)),
      );
      if (input.request.repetitions > 0) {
        record.repetitions = [];
        for (let rep = 1; rep <= input.request.repetitions; rep += 1) {
          const file = `${caseId}.rep${rep}.png`;
          await assets.write(
            input.root,
            `${input.runDir}/${file}`,
            encodePng(this.plan.capture(file, caseId)),
          );
          record.repetitions.push(file);
        }
      }
      if (input.request.mutations.length > 0) {
        record.mutations = {};
        for (const mutation of input.request.mutations) {
          const file = `${caseId}.mut-${mutation}.png`;
          await assets.write(
            input.root,
            `${input.runDir}/${file}`,
            encodePng(this.plan.capture(file, caseId)),
          );
          record.mutations[mutation] = file;
        }
      }
    }
    for (const caseId of Object.keys(doc.cases))
      if (!input.request.cases.some((c) => c.id === caseId)) delete doc.cases[caseId];
    this.plan.measure?.(doc);
    return { status: "ok", measure: doc, runDir: input.runDir };
  }
}

const contractFile = (): Record<string, unknown> => {
  const base = fixture<{ fidelityRules: Array<{ id: string }>; regions: unknown; cases: unknown }>(
    "contract.json",
  );
  const keep = new Set(["VIS-CARDS", "GEO-CTA", "REL-GAP"]);
  const element = (id: string, testId: string, critical = false) => ({
    id,
    locator: { testId },
    critical,
  });
  return {
    schemaVersion: 1,
    kind: "ui-contract",
    mode: "build",
    surfaces: [{ id: "projects-page", route: "/projects", purpose: "operate" }],
    stateMatrix: [],
    viewports: [[1024, 640]],
    breakpoints: [],
    elements: [
      element("primary-cta", "cta", true),
      element("toolbar", "toolbar"),
      element("cards", "cards", true),
    ],
    componentMap: [],
    interactions: [],
    focusOrder: [],
    fidelityRules: base.fidelityRules.filter((r) => keep.has(r.id)),
    typography: [],
    regions: base.regions,
    masks: [],
    cases: base.cases,
    tokensNeeded: [],
    references: [],
    questions: [],
    render: {
      browser: "chromium",
      dpr: 1,
      locale: "en-US",
      timezone: "UTC",
      colorScheme: ["light"],
      reducedMotion: "reduce",
    },
    unknownBackground: "BLOCKED",
    allowedOrigins: [],
    calibration: { acceptableMutations: [] },
  };
};

async function setup(): Promise<{
  composition: ReturnType<typeof compose>;
  f: WorkflowFixture;
  probe: FakeProbe;
  services: ReturnType<typeof compose>["services"];
  contractPath: string;
  run: (
    over?: object,
  ) => ReturnType<ReturnType<typeof compose>["services"]["fidelity"]["runDetailed"]>;
  next: () => string;
}> {
  const f = await workflowFixture();
  const probe = new FakeProbe();
  let n = 0;
  const composition = compose({
    clock: { now: () => new Date(NOW) },
    runner: new ScriptedRunner(),
    process: new FakeProcess(),
    profiles: loadAgentProfile,
    probe,
    newId: () => `run${++n}`,
    version: "0.1.0",
  });
  const { services } = composition;
  await services.workflow.newFeature(f.root, { feature: "projects", intent: "x", level: "L2" });
  const contractPath = "docs/frontsmith/projects/ui-contract.json";
  await services.deps.writer.write(
    f.root,
    contractPath,
    `${JSON.stringify(contractFile(), null, 2)}\n`,
  );
  await services.deps.store.update(
    f.root,
    "projects",
    (d) => {
      d.artifacts["ui-contract"] = { path: contractPath, sha256: "x", writtenAt: NOW };
    },
    NOW,
  );
  return {
    composition,
    f,
    probe,
    services,
    contractPath,
    run: (over = {}) =>
      services.fidelity.runDetailed({
        root: f.root,
        feature: "projects",
        contractPath,
        runId: `r${++n}`,
        ...over,
      }),
    next: () => `run${++n}`,
  };
}

describe("fidelity run", () => {
  it("is BLOCKED without a baseline, then REVIEW with one but no calibration, then PASS once calibrated", async () => {
    const { f, services, run, contractPath, probe } = await setup();
    try {
      const first = await run();
      expect(first.report.status).toBe("BLOCKED");
      expect(first.report.failures.find((x) => x.ruleId === "VIS-CARDS")?.status).toBe("BLOCKED");
      expect(first.report.blockers.join(" ")).toContain("baseline");
      expect(
        JSON.parse(
          await readFile(join(f.root, ".alisio/frontsmith/evidence/projects/latest.json"), "utf8"),
        ),
      ).toMatchObject({
        cases: {
          "projects-desktop-success": expect.stringContaining("projects-desktop-success.png"),
        },
      });

      const approved = await services.fidelity.approveBaseline(f.root, "projects");
      expect(approved).toEqual({ ok: true, approved: CASES });
      const meta = await services.fidelity.listBaselines(f.root, "projects");
      expect(meta["projects-desktop-success"]).toMatchObject({
        browser: "chromium",
        browserVersion: "153.0.0.0",
        os: "linux",
      });
      const state = (await services.workflow.status(f.root, "projects")).state;
      expect(Object.keys(state.protected)).toEqual(
        expect.arrayContaining([
          ".frontsmith/baselines/projects/projects-desktop-success.png",
          ".frontsmith/baselines/projects/meta.json",
        ]),
      );

      const uncalibrated = await run();
      expect(uncalibrated.report.status).toBe("REVIEW");
      expect(uncalibrated.report.visualStatus).toBe("REVIEW");

      probe.plan = { capture: mutated };
      const plan = await services.fidelity.calibrate(f.root, "projects", {
        contractPath,
        runId: "cal1",
        confirm: false,
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.written).toBe(false);
      expect(
        await services.deps.fsFor(f.root).exists(".frontsmith/calibration/projects.json"),
      ).toBe(false);
      expect(plan.file.cases["projects-desktop-success"]?.regions.cards?.status).toBe("OK");
      expect(plan.quality["projects-desktop-success"]).toMatchObject({ falsePositiveRate: 0 });
      const savedPath = await services.fidelity.saveCalibration(f.root, "projects", plan.file);
      expect(savedPath).toBe(".frontsmith/calibration/projects.json");
      probe.plan = { capture: () => page() };
      expect(
        await services.deps.fsFor(f.root).exists(".frontsmith/calibration/projects.json"),
      ).toBe(true);
      expect(
        Object.keys((await services.workflow.status(f.root, "projects")).state.protected),
      ).toContain(".frontsmith/calibration/projects.json");

      const passing = await run();
      expect(passing.report.status).toBe("PASS");
      expect(passing.report.visualStatus).toBe("PASS");
      expect(passing.report.coverage).toMatchObject({ required: 2, executed: 2, pending: 0 });
      expect(fidelityPrepared(passing.report)).toMatchObject({ status: "PASS", findings: [] });
    } finally {
      await f.cleanup();
    }
  });

  it("fails a changed region, writes the composite and region crops, and maps the report to gate findings", async () => {
    const { f, services, run, probe, contractPath } = await setup();
    try {
      await run();
      await services.fidelity.approveBaseline(f.root, "projects");
      probe.plan = { capture: mutated };
      await services.fidelity.calibrate(f.root, "projects", {
        contractPath,
        runId: "cal",
        confirm: true,
      });
      probe.plan = { capture: () => page(40) };
      const result = await run();
      expect(result.report.status).toBe("FAIL");
      expect(result.report.visualStatus).toBe("FAIL");
      expect(result.composite?.path).toMatch(/composite-projects-desktop-success\.png$/);
      expect(result.report.evidence.composite).toBe("composite-projects-desktop-success.png");
      const composite = decodePng(result.composite?.bytes ?? new Uint8Array());
      // 3 panels of 1024 px do not fit 2400 px: every panel is halved (whole-number reduction).
      expect(composite.width).toBe(512 * 3 + 16);
      expect(result.crops.length).toBeGreaterThan(0);
      expect(result.crops.length).toBeLessThanOrEqual(6);
      for (const crop of result.crops) expect(crop.bytes.length).toBeLessThan(500_000);
      expect(
        await services.deps.fsFor(f.root).exists(`${result.runDir}/fidelity-report.json`),
      ).toBe(true);
      const prepared = fidelityPrepared(result.report);
      expect(prepared.status).toBe("FAIL");
      expect(prepared.findings?.some((x) => x.ruleId === "VIS-CARDS" && x.status === "FAIL")).toBe(
        true,
      );
    } finally {
      await f.cleanup();
    }
  });

  it("blocks when an approved oracle changed or went missing after approval (stage 0)", async () => {
    const { f, services, run } = await setup();
    try {
      await run();
      await services.fidelity.approveBaseline(f.root, "projects");
      await assets.write(
        f.root,
        ".frontsmith/baselines/projects/projects-desktop-success.png",
        encodePng(page(5)),
      );
      const changed = await run();
      expect(changed.report.status).toBe("BLOCKED");
      expect(changed.report.blockers[0]).toContain("changed after approval");
      expect(changed.report.coverage.pending).toBe(2);
      const { rm } = await import("node:fs/promises");
      await rm(join(f.root, ".frontsmith/baselines/projects/projects-mobile-success.png"));
      expect((await run()).report.blockers.join(" ")).toContain("is missing");
    } finally {
      await f.cleanup();
    }
  });

  it("blocks when the browser is not the one the baselines were approved with", async () => {
    const { f, services, run, probe } = await setup();
    try {
      await run();
      await services.fidelity.approveBaseline(f.root, "projects");
      probe.plan = {
        capture: () => page(),
        measure: (doc) => {
          doc.environment.browserVersion = "154.0.0.0";
        },
      };
      const report = (await run()).report;
      expect(report.status).toBe("BLOCKED");
      expect(report.blockers.join(" ")).toContain("valid only for that browser version");
    } finally {
      await f.cleanup();
    }
  });

  it("reports a missing Playwright as BLOCKED with the hint, never PASS, and a size mismatch as VIS-DIM", async () => {
    const { f, services, run, probe } = await setup();
    try {
      probe.plan = {
        capture: () => page(),
        outcome: {
          status: "BLOCKED",
          reason: "playwright-not-installed",
          hint: "Add playwright to the project",
        },
      };
      const blocked = (await run()).report;
      expect(blocked.status).toBe("BLOCKED");
      expect(blocked.blockers[0]).toContain("playwright-not-installed: Add playwright");
      probe.plan = { capture: () => page() };
      await run();
      await services.fidelity.approveBaseline(f.root, "projects");
      probe.plan = { capture: () => solid(1024, 700) };
      const dim = (await run()).report;
      expect(dim.status).toBe("FAIL");
      expect(dim.failures.some((x) => x.note?.includes("VIS-DIM"))).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("refuses unknown cases, a feature without a contract and measure-only runs skip the baselines", async () => {
    const { f, services, run } = await setup();
    try {
      const unknown = await run({ cases: ["nope-case"] });
      expect(unknown.report.status).toBe("BLOCKED");
      expect(unknown.report.blockers[0]).toContain("Unknown case");
      expect(await services.fidelity.contractPathOf(f.root, "ghost")).toEqual({
        ok: false,
        reason: "Unknown feature ghost.",
      });
      const measureOnly = await run({ stage: "measure" });
      expect(measureOnly.report.visualStatus).toBe("BLOCKED");
      expect(measureOnly.report.failures.filter((x) => x.ruleId !== "VIS-CARDS")).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});

describe("baselines", () => {
  it("are never approved during or after acceptance, without a run, or for an unknown case", async () => {
    const { f, services, run } = await setup();
    try {
      expect(await services.fidelity.approveBaseline(f.root, "projects")).toMatchObject({
        ok: false,
        reason: expect.stringContaining("No fidelity run exists yet"),
      });
      await run();
      expect(
        await services.fidelity.approveBaseline(f.root, "projects", "nope-case"),
      ).toMatchObject({ ok: false, reason: expect.stringContaining("no case nope-case") });
      expect(
        await services.fidelity.approveBaseline(f.root, "projects", "projects-mobile-success"),
      ).toEqual({ ok: true, approved: ["projects-mobile-success"] });
      await services.deps.store.update(
        f.root,
        "projects",
        (d) => {
          d.phase = "accept";
        },
        NOW,
      );
      expect(await services.fidelity.approveBaseline(f.root, "projects")).toMatchObject({
        ok: false,
        reason: expect.stringContaining("during or after acceptance"),
      });
      await services.deps.store.update(
        f.root,
        "projects",
        (d) => {
          d.phase = "validate";
          d.gates.G9 = { verdict: "PASS", reportPath: "x", at: NOW };
        },
        NOW,
      );
      expect(await services.fidelity.approveBaseline(f.root, "projects")).toMatchObject({
        ok: false,
      });
      expect(await services.fidelity.approveBaseline(f.root, "ghost")).toMatchObject({
        ok: false,
        reason: "Unknown feature ghost.",
      });
    } finally {
      await f.cleanup();
    }
  });
});

describe("calibration", () => {
  it("needs an approved baseline for every case", async () => {
    const { f, services, run, contractPath } = await setup();
    try {
      await run();
      await services.fidelity.approveBaseline(f.root, "projects", "projects-desktop-success");
      const result = await services.fidelity.calibrate(f.root, "projects", {
        contractPath,
        runId: "c",
        confirm: true,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("projects-mobile-success"),
      });
    } finally {
      await f.cleanup();
    }
  });

  it("refuses an unstable environment (CAL-002) and writes nothing", async () => {
    const { f, services, run, probe, contractPath } = await setup();
    try {
      await run();
      await services.fidelity.approveBaseline(f.root, "projects");
      probe.plan = {
        capture: (file) => (file.includes(".rep") ? page(0, [20 + 12, 20, 20, 255]) : page()),
      };
      const result = await services.fidelity.calibrate(f.root, "projects", {
        contractPath,
        runId: "c",
        confirm: true,
      });
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("CAL-002 unstable environment"),
      });
      expect(
        await services.deps.fsFor(f.root).exists(".frontsmith/calibration/projects.json"),
      ).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  it("marks regions UNSEPARABLE when noise is as large as the smallest defect", async () => {
    const { f, services, run, probe, contractPath } = await setup();
    try {
      await run();
      await services.fidelity.approveBaseline(f.root, "projects");
      // The mutations change nothing the region can see, so there is no defect to separate noise from.
      probe.plan = { capture: () => page() };
      const result = await services.fidelity.calibrate(f.root, "projects", {
        contractPath,
        runId: "c",
        confirm: false,
      });
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.unseparable).toEqual([
          "projects-desktop-success/cards",
          "projects-mobile-success/cards",
        ]);
    } finally {
      await f.cleanup();
    }
  });

  it("protects the written calibration as an oracle", async () => {
    const { f, services, run, probe, contractPath } = await setup();
    try {
      await run();
      await services.fidelity.approveBaseline(f.root, "projects");
      probe.plan = { capture: mutated };
      await services.fidelity.calibrate(f.root, "projects", {
        contractPath,
        runId: "c",
        confirm: true,
      });
      await services.deps.writer.write(f.root, ".frontsmith/calibration/projects.json", "{}\n");
      probe.plan = { capture: () => page() };
      const report = (await run()).report;
      expect(report.status).toBe("BLOCKED");
      expect(report.blockers.join(" ")).toContain(
        ".frontsmith/calibration/projects.json changed after approval",
      );
    } finally {
      await f.cleanup();
    }
  });
});

describe("fidelity commands and tools", () => {
  const plugin = async () => {
    const s = await setup();
    const harness = createHarness(() => s.f.root, {
      interactive: () => false,
      askQuestions: async () => ({}),
    });
    registerFrontsmith(harness.api, { composition: s.composition });
    return { ...s, harness };
  };
  const prepare = async (s: Awaited<ReturnType<typeof plugin>>) => {
    await s.run();
    await s.services.fidelity.approveBaseline(s.f.root, "projects");
    s.probe.plan = { capture: mutated };
    await s.services.fidelity.calibrate(s.f.root, "projects", {
      contractPath: s.contractPath,
      runId: "cal",
      confirm: true,
    });
    s.probe.plan = { capture: () => page() };
  };

  it("registers the two commands and two process tools", async () => {
    const s = await plugin();
    try {
      for (const name of ["fidelity", "baseline"])
        expect(s.harness.commands.get(name), name).toBeDefined();
      for (const name of ["fs_fidelity_run", "fs_a11y_run"])
        expect(s.harness.tools.get(name)?.effect, name).toBe("process");
    } finally {
      await s.f.cleanup();
    }
  });

  it("baseline approve and list; usage problems are friendly", async () => {
    const s = await plugin();
    try {
      await s.run();
      expect(await s.harness.callCommand("baseline", "list projects", "s")).toContain("projects");
      expect(await s.harness.callCommand("baseline", "approve projects", "s")).toContain(
        "Approved baselines",
      );
      expect(
        await s.harness.callCommand("baseline", "approve projects projects-desktop-success", "s"),
      ).toContain("Approved baseline:");
      expect(await s.harness.callCommand("baseline", "approve projects BAD", "s")).toContain(
        "Usage:",
      );
      expect(await s.harness.callCommand("baseline", "frob projects", "s")).toContain("Usage:");
      expect(await s.harness.callCommand("baseline", "", "s")).toContain("Usage:");
      expect(await s.harness.callCommand("fidelity", "run Bad_Id", "s")).toContain("Usage:");
      expect(await s.harness.callCommand("fidelity", "run projects BAD", "s")).toContain("Usage:");
      expect(await s.harness.callCommand("fidelity", "frob projects", "s")).toContain("Usage:");
      expect(
        await s.harness.callCommand("fidelity", "calibrate projects --confirm nope", "s"),
      ).toContain("Usage:");
    } finally {
      await s.f.cleanup();
    }
  });

  it("fidelity run reports; calibrate previews headless and writes only with the exact confirmation", async () => {
    const s = await plugin();
    try {
      await s.run();
      await s.services.fidelity.approveBaseline(s.f.root, "projects");
      s.probe.plan = { capture: mutated };
      const preview = await s.harness.callCommand("fidelity", "calibrate projects", "s");
      expect(preview).toContain("--confirm CALIBRATE");
      expect(
        await s.services.deps.fsFor(s.f.root).exists(".frontsmith/calibration/projects.json"),
      ).toBe(false);
      await s.harness.callCommand("fidelity", "calibrate projects --confirm CALIBRATE", "s");
      expect(
        await s.services.deps.fsFor(s.f.root).exists(".frontsmith/calibration/projects.json"),
      ).toBe(true);
      s.probe.plan = { capture: () => page() };
      const run = await s.harness.callCommand(
        "fidelity",
        "run projects projects-desktop-success",
        "s",
      );
      expect(run).toContain("PASS");
      expect(s.probe.inputs.at(-1)?.request.cases.map((c) => c.id)).toEqual([
        "projects-desktop-success",
      ]);
      await s.services.deps.writer.write(s.f.root, ".frontsmith/calibration/projects.json", "{}\n");
      expect(await s.harness.callCommand("fidelity", "calibrate projects", "s")).toContain(
        "oracle",
      );
    } finally {
      await s.f.cleanup();
    }
  });

  it("calibrate asks when interactive and honours the answer", async () => {
    const s = await setup();
    const asked: string[] = [];
    const harness = createHarness(() => s.f.root, {
      interactive: () => true,
      askQuestions: async (r) => {
        asked.push(r.label ?? "");
        return { calibrate: "cancel" };
      },
    });
    registerFrontsmith(harness.api, { composition: s.composition });
    try {
      await s.run();
      await s.services.fidelity.approveBaseline(s.f.root, "projects");
      s.probe.plan = { capture: mutated };
      await harness.callCommand("fidelity", "calibrate projects", "s1");
      expect(asked).toEqual(["Frontsmith › projects"]);
      expect(
        await s.services.deps.fsFor(s.f.root).exists(".frontsmith/calibration/projects.json"),
      ).toBe(false);
    } finally {
      await s.f.cleanup();
    }
  });

  it("fs_fidelity_run returns text, test results, the composite image, a table and the crops, in that order", async () => {
    const s = await plugin();
    try {
      await prepare(s);
      s.probe.plan = { capture: () => page(40) };
      const result = await s.harness.callTool("fs_fidelity_run", { feature: "projects" }, s.f.root);
      const kinds = (result?.content ?? []).map((c: { type: string }) => c.type);
      expect(kinds[0]).toBe("text");
      expect(kinds.filter((k: string) => k === "image").length).toBeGreaterThanOrEqual(2);
      expect(kinds.indexOf("image")).toBeGreaterThan(0);
      expect(result?.isError).not.toBe(true);
    } finally {
      await s.f.cleanup();
    }
  });

  it("the tools refuse unknown keys, bad ids and bad cases; calibrate through the tool never writes", async () => {
    const s = await plugin();
    try {
      const run = {
        execute: (input: Record<string, unknown>, _c?: unknown) =>
          s.harness.callTool("fs_fidelity_run", input, s.f.root),
      };
      const a11y = {
        execute: (input: Record<string, unknown>, _c?: unknown) =>
          s.harness.callTool("fs_a11y_run", input, s.f.root),
      };
      const ctx = undefined;
      expect((await run?.execute({ feature: "projects", extra: 1 }, ctx))?.isError).toBe(true);
      expect((await run?.execute({ feature: "Bad_Id" }, ctx))?.isError).toBe(true);
      expect((await run?.execute({ feature: "projects", cases: ["BAD"] }, ctx))?.isError).toBe(
        true,
      );
      expect((await run?.execute({ feature: "projects", stage: "weird" }, ctx))?.isError).toBe(
        true,
      );
      expect((await a11y?.execute({ feature: "Bad_Id" }, ctx))?.isError).toBe(true);
      expect((await a11y?.execute({ feature: "projects", cases: [1] }, ctx))?.isError).toBe(true);
      expect((await run?.execute({ feature: "nothing-here" }, ctx))?.isError).toBe(true);
      await s.run();
      await s.services.fidelity.approveBaseline(s.f.root, "projects");
      s.probe.plan = { capture: mutated };
      const preview = await run?.execute({ feature: "projects", calibrate: true }, ctx);
      expect(preview?.isError).not.toBe(true);
      expect(
        await s.services.deps.fsFor(s.f.root).exists(".frontsmith/calibration/projects.json"),
      ).toBe(false);
    } finally {
      await s.f.cleanup();
    }
  });

  it("fs_a11y_run reports runtime accessibility with a findings table", async () => {
    const s = await plugin();
    try {
      await s.run();
      const result = await s.harness.callTool("fs_a11y_run", { feature: "projects" }, s.f.root);
      expect(result).toBeDefined();
      expect((result?.content ?? [])[0]?.type).toBe("text");
    } finally {
      await s.f.cleanup();
    }
  });
});

describe("fidelity CLI", () => {
  it("prints usage and fails on a bad feature id or a missing contract", async () => {
    const f = await workflowFixture();
    try {
      expect((await cliRun(["fidelity"], f.root)).code).not.toBe(0);
      expect((await cliRun(["fidelity", "Bad_Id", f.root], f.root)).code).not.toBe(0);
      const missing = await cliRun(["fidelity", "nothing-here", f.root], f.root);
      expect(missing.code).not.toBe(0);
    } finally {
      await f.cleanup();
    }
  });
});

void clonePng;
