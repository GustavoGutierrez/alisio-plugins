import { canonicalJson } from "../../domain/canonical-json.js";
import type { FrontsmithConfig } from "../../domain/config/defaults.js";
import type { UiContractEnvelope } from "../../domain/envelopes/ui-contract.js";
import { type A11yReport, evaluateA11y } from "../../domain/fidelity/a11y.js";
import {
  CALIBRATION_MUTATIONS,
  type CalibrationFile,
  calibrateCase,
  channelToleranceFrom,
  labelMutations,
  type ValidatorQuality,
  validatorQuality,
} from "../../domain/fidelity/calibration.js";
import {
  type CaseVisual,
  evaluateFidelity,
  type FidelityContract,
  type FidelityReport,
} from "../../domain/fidelity/evaluate.js";
import type { PngImage } from "../../domain/fidelity/image.js";
import type { CaseMeasure, MeasureDoc } from "../../domain/fidelity/measure.js";
import { diffMask, regionMetrics, validPixels } from "../../domain/fidelity/regions.js";
import type { ProbeCase, ProbeRequest } from "../../domain/fidelity/request.js";
import type { DraftFinding, Prepared } from "../../domain/gates/aggregate.js";
import type { AssetReader } from "../ports/asset-reader.js";
import type { BrowserProbe } from "../ports/browser-probe.js";
import type { Clock } from "../ports/clock.js";
import type { DevServer } from "../ports/dev-server.js";
import type { FeatureStore } from "../ports/feature-store.js";
import type { IntegrityReader } from "../ports/integrity.js";
import type { PngCodec } from "../ports/png-codec.js";
import type { ProjectStore } from "../ports/project-store.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";
import type { WorkspaceWriter } from "../ports/workspace-writer.js";
import type { FidelityPort } from "../workflow/env.js";

export interface FidelityDeps {
  fsFor(root: string): WorkspaceFs;
  store: FeatureStore;
  project: ProjectStore;
  probe: BrowserProbe;
  png: PngCodec;
  assets: AssetReader;
  writer: WorkspaceWriter;
  integrity: IntegrityReader;
  server: DevServer;
  clock: Clock;
  sha256(text: string): string;
}

export interface RunInput {
  root: string;
  feature: string;
  contractPath: string;
  cases?: readonly string[];
  runId: string;
  /** `measure` stops after the measurement stage: no baselines are compared. */
  stage?: "measure" | "full";
  signal?: AbortSignal;
}

interface LoadedContract {
  contract: UiContractEnvelope & {
    render?: { dpr?: number; locale?: string; timezone?: string; reducedMotion?: string };
    unknownBackground?: "BLOCKED" | "REVIEW";
    allowedOrigins?: string[];
    calibration?: { acceptableMutations?: string[] };
  };
}

export interface FidelityRunResult {
  report: FidelityReport;
  runDir: string;
  composite?: { path: string; bytes: Uint8Array };
  /** Region crops of the failing regions (at most 6, each under 500 KB) for the web (spec 18.3). */
  crops: Array<{ caseId: string; regionId: string; bytes: Uint8Array }>;
}

export interface A11yRunResult {
  report: A11yReport;
  runDir: string;
}

const STYLE_PROPS = [
  "font-size",
  "line-height",
  "font-weight",
  "letter-spacing",
  "font-family",
  "color",
  "border-color",
  "background-color",
];
const baselineDir = (feature: string): string => `.frontsmith/baselines/${feature}`;
const evidenceRoot = (feature: string): string => `.alisio/frontsmith/evidence/${feature}`;
const sha = (digest: string): string => digest.split(":").pop() ?? digest;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface BaselineMeta {
  schemaVersion: 1;
  files: Record<
    string,
    {
      sha256: string;
      browser: string;
      browserVersion: string;
      os: string;
      approvedAt: string;
      runId: string;
    }
  >;
}

/** The visual-fidelity pipeline of spec 11, as a service behind the tools, commands and the CLI. */
export class FidelityService implements FidelityPort {
  constructor(private readonly deps: FidelityDeps) {}

  private async loadContract(input: RunInput): Promise<LoadedContract | { error: string }> {
    const read = await this.deps.fsFor(input.root).read(input.contractPath);
    if (read.kind !== "text")
      return { error: `The UI contract ${input.contractPath} was not found.` };
    try {
      const raw: unknown = JSON.parse(read.text);
      if (!isRecord(raw) || !Array.isArray(raw.cases) || !Array.isArray(raw.fidelityRules))
        return { error: "The UI contract is malformed." };
      return { contract: raw as unknown as LoadedContract["contract"] };
    } catch {
      return { error: "The UI contract is not valid JSON." };
    }
  }

  private selectCases(
    contract: LoadedContract["contract"],
    wanted: readonly string[] | undefined,
  ): ProbeCase[] | { error: string } {
    const chosen =
      wanted && wanted.length > 0
        ? contract.cases.filter((c) => wanted.includes(c.id))
        : contract.cases;
    if (wanted && wanted.length > 0) {
      const unknown = wanted.filter((id) => !contract.cases.some((c) => c.id === id));
      if (unknown.length > 0)
        return { error: `Unknown case${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}` };
    }
    return chosen.map((c) => ({
      id: c.id,
      url: "",
      viewport: c.viewport,
      dpr: 1,
      theme: c.theme,
      locale: "en-US",
      timezone: "UTC",
      reducedMotion: "reduce" as const,
      localStorage: c.setup.localStorage ?? {},
      masks: [],
    }));
  }

  private request(
    contract: LoadedContract["contract"],
    config: FrontsmithConfig,
    cases: ProbeCase[],
    extra: Partial<Pick<ProbeRequest, "axe" | "repetitions" | "mutations" | "mutate">>,
  ): ProbeRequest {
    const render = contract.render ?? {};
    const base = config.fidelity.baseUrl.replace(/\/$/, "");
    return {
      schemaVersion: 1,
      baseUrl: base,
      browser: config.fidelity.browser,
      cases: cases.map((c) => {
        const source = contract.cases.find((x) => x.id === c.id);
        const surface = contract.surfaces.find((s) => s.id === source?.surfaceId);
        const path = source?.setup.path ?? surface?.route ?? "/";
        return {
          ...c,
          url: `${base}${path.startsWith("/") ? path : `/${path}`}${source?.setup.query ?? ""}`,
          dpr: render.dpr ?? 1,
          locale: render.locale ?? "en-US",
          timezone: render.timezone ?? "UTC",
          reducedMotion: render.reducedMotion === "no-preference" ? "no-preference" : "reduce",
          masks: contract.masks.map((m) => m.selector),
        };
      }),
      elements: contract.elements.map((e) => ({ id: e.id, locator: e.locator })),
      styleProps: STYLE_PROPS,
      repetitions: extra.repetitions ?? 0,
      mutations: extra.mutations ?? [],
      mutate: extra.mutate ?? [],
      keyboard: { focusOrder: contract.focusOrder },
      axe: extra.axe ?? false,
      allowedOrigins: contract.allowedOrigins ?? [],
    };
  }

  /** Stage 0: every approved oracle still has its approved hash; the browser matches the recorded one. */
  private async integrityProblems(root: string, feature: string): Promise<string[]> {
    const problems: string[] = [];
    const opened = await this.deps.store.read(root, feature);
    for (const [path, expected] of Object.entries(opened?.state.protected ?? {})) {
      const digest = await this.deps.integrity.digestFile(root, path);
      if (digest === undefined) problems.push(`${path} is missing (an approved oracle)`);
      else if (sha(digest) !== expected) problems.push(`${path} changed after approval`);
    }
    return problems;
  }

  private async withServer<T>(
    root: string,
    config: FrontsmithConfig,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T | { serverProblem: string }> {
    const serve = config.fidelity.serve;
    if (!serve) return run();
    const started = await this.deps.server.start({
      root,
      argv: serve.command,
      readyUrl: serve.readyUrl,
      timeoutMs: serve.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (!started.ok)
      return { serverProblem: `the serve command did not become ready: ${started.reason}` };
    try {
      return await run();
    } finally {
      await started.server.stop();
    }
  }

  private async readCalibration(
    root: string,
    feature: string,
  ): Promise<CalibrationFile | undefined> {
    const read = await this.deps.fsFor(root).read(`.frontsmith/calibration/${feature}.json`);
    if (read.kind !== "text") return undefined;
    try {
      return JSON.parse(read.text) as CalibrationFile;
    } catch {
      return undefined;
    }
  }

  private async readMeta(root: string, feature: string): Promise<BaselineMeta> {
    const read = await this.deps.fsFor(root).read(`${baselineDir(feature)}/meta.json`);
    if (read.kind === "text")
      try {
        const parsed = JSON.parse(read.text) as BaselineMeta;
        if (parsed.schemaVersion === 1 && isRecord(parsed.files)) return parsed;
      } catch {
        // A damaged meta file is treated as absent; the baselines then have no recorded environment.
      }
    return { schemaVersion: 1, files: {} };
  }

  private decode(
    bytes: Uint8Array | undefined,
    label: string,
    blockers: string[],
  ): PngImage | undefined {
    if (!bytes) return undefined;
    try {
      return this.deps.png.decode(bytes);
    } catch (error) {
      blockers.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** Run the measurement and visual stages for the required cases (FID 15.9). */
  async runDetailed(input: RunInput): Promise<FidelityRunResult> {
    const { deps } = this;
    const runDir = `${evidenceRoot(input.feature)}/${input.runId}`;
    const loaded = await this.loadContract(input);
    const empty = (problem: string): FidelityRunResult => ({
      runDir,
      crops: [],
      report: evaluateFidelity({
        feature: input.feature,
        runId: input.runId,
        contract: { fidelityRules: [], regions: [], cases: [] },
        requiredCases: [],
        measure: undefined,
        integrity: [problem],
        evidenceDir: runDir,
      }),
    });
    if ("error" in loaded) return empty(loaded.error);
    const { contract } = loaded;
    const config = (await deps.project.readConfig(input.root)).config;
    const cases = this.selectCases(contract, input.cases);
    if ("error" in cases) return empty(cases.error);
    const evaluateContract: FidelityContract = {
      fidelityRules: contract.fidelityRules,
      regions: contract.regions,
      cases: contract.cases,
      ...(contract.unknownBackground ? { unknownBackground: contract.unknownBackground } : {}),
    };
    const requiredCases = cases.map((c) => c.id);
    const blocked = async (reason: string): Promise<FidelityRunResult> => ({
      runDir,
      crops: [],
      report: evaluateFidelity({
        feature: input.feature,
        runId: input.runId,
        contract: evaluateContract,
        requiredCases,
        measure: undefined,
        integrity: [reason],
        evidenceDir: runDir,
      }),
    });
    const integrity = await this.integrityProblems(input.root, input.feature);
    if (integrity.length > 0) return blocked(integrity.join("; "));

    const request = this.request(contract, config, cases, {});
    const outcome = await this.withServer(input.root, config, input.signal, () =>
      deps.probe.run({
        root: input.root,
        runDir,
        request,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
    if ("serverProblem" in outcome) return blocked(outcome.serverProblem);
    if (outcome.status === "BLOCKED")
      return blocked(`${outcome.reason}${outcome.hint ? `: ${outcome.hint}` : ""}`);
    const measure = outcome.measure;

    const calibration = await this.readCalibration(input.root, input.feature);
    const meta = await this.readMeta(input.root, input.feature);
    const environmentProblems: string[] = [];
    const env = measure.environment;
    if (calibration && calibration.browserVersion !== env.browserVersion)
      environmentProblems.push(
        `the calibration was made with ${calibration.browser} ${calibration.browserVersion} but this run uses ${env.browserVersion}; recalibrate with /frontsmith:fidelity calibrate`,
      );
    for (const [caseId, entry] of Object.entries(meta.files))
      if (
        requiredCases.includes(caseId) &&
        (entry.browserVersion !== env.browserVersion || entry.os !== env.os)
      )
        environmentProblems.push(
          `the baseline of ${caseId} was approved with ${entry.browser} ${entry.browserVersion} on ${entry.os}; baselines are valid only for that browser version and operating system`,
        );
    if (environmentProblems.length > 0)
      return {
        runDir,
        crops: [],
        report: evaluateFidelity({
          feature: input.feature,
          runId: input.runId,
          contract: evaluateContract,
          requiredCases,
          measure,
          integrity: environmentProblems,
          evidenceDir: runDir,
        }),
      };

    // Stage 2: visual regions against the approved baselines.
    const visual: Record<string, CaseVisual> = {};
    const blockers: string[] = [];
    const wantsVisual =
      input.stage !== "measure" && contract.fidelityRules.some((r) => r.kind === "visual");
    const decodedPairs: Record<
      string,
      { actual: PngImage; baseline: PngImage; tolerance: number }
    > = {};
    if (wantsVisual)
      for (const caseId of requiredCases) {
        const measured = measure.cases[caseId];
        if (!measured) continue;
        const baselineBytes = await deps.assets.read(
          input.root,
          `${baselineDir(input.feature)}/${caseId}.png`,
        );
        if (!baselineBytes) {
          visual[caseId] = { baselineMissing: true, regions: {} };
          continue;
        }
        const actual = this.decode(
          await deps.assets.read(input.root, `${runDir}/${measured.capture}`),
          `${caseId} capture`,
          blockers,
        );
        const baseline = this.decode(baselineBytes, `${caseId} baseline`, blockers);
        if (!actual || !baseline) {
          visual[caseId] = { baselineMissing: true, regions: {} };
          continue;
        }
        const sizes = {
          actual: [actual.width, actual.height] as [number, number],
          baseline: [baseline.width, baseline.height] as [number, number],
        };
        if (actual.width !== baseline.width || actual.height !== baseline.height) {
          visual[caseId] = { sizes, regions: {} };
          continue;
        }
        const tolerance = calibration?.cases[caseId]?.channelTolerance ?? 0;
        const mask = diffMask(baseline.data, actual.data, actual.width, actual.height, tolerance);
        const dpr = contract.render?.dpr ?? 1;
        const scale = (box: { x: number; y: number; width: number; height: number }) => ({
          x: box.x * dpr,
          y: box.y * dpr,
          width: box.width * dpr,
          height: box.height * dpr,
        });
        const valid = validPixels(actual.width, actual.height, measured.masks.map(scale));
        const regions: CaseVisual["regions"] = {};
        for (const region of contract.regions) {
          const element = measured.elements[region.elementId];
          if (!element) continue;
          regions[region.id] = regionMetrics(
            mask,
            valid,
            actual.width,
            actual.height,
            scale(element.box),
            calibration?.cases[caseId]?.regions[region.id]?.k ?? 16,
          );
        }
        visual[caseId] = { sizes, regions };
        decodedPairs[caseId] = { actual, baseline, tolerance };
      }

    let report = evaluateFidelity({
      feature: input.feature,
      runId: input.runId,
      contract: evaluateContract,
      requiredCases,
      measure,
      visual,
      calibration,
      integrity: blockers,
      evidenceDir: runDir,
    });

    // Evidence: one composite per case that needs a person's eyes.
    let composite: FidelityRunResult["composite"];
    const failing = [
      ...new Set(
        report.failures
          .filter((f) => f.status === "FAIL" || f.status === "REVIEW")
          .map((f) => f.caseId),
      ),
    ];
    for (const caseId of failing) {
      const pair = decodedPairs[caseId];
      if (!pair) continue;
      const dpr = contract.render?.dpr ?? 1;
      const measured = measure.cases[caseId] as CaseMeasure;
      const boxes = contract.regions.flatMap((r) => {
        const element = measured.elements[r.elementId];
        return element
          ? [
              {
                x: element.box.x * dpr,
                y: element.box.y * dpr,
                width: element.box.width * dpr,
                height: element.box.height * dpr,
              },
            ]
          : [];
      });
      const made = deps.png.composeEvidence({
        reference: pair.baseline,
        actual: pair.actual,
        maxWidth: 2400,
        maxBytes: config.fidelity.maxImageBytes,
        channelTolerance: pair.tolerance,
        regions: boxes,
      });
      const path = `${runDir}/composite-${caseId}.png`;
      await deps.assets.write(input.root, path, made.png);
      composite ??= { path, bytes: made.png };
    }
    const crops: FidelityRunResult["crops"] = [];
    for (const region of report.regions) {
      if (crops.length >= 6) break;
      if (region.status !== "FAIL" && region.status !== "REVIEW") continue;
      const pair = decodedPairs[region.caseId];
      const def = contract.regions.find((r) => r.id === region.regionId);
      const box = def ? measure.cases[region.caseId]?.elements[def.elementId]?.box : undefined;
      if (!pair || !box) continue;
      const dpr = contract.render?.dpr ?? 1;
      const bytes = deps.png.crop(
        pair.actual,
        { x: box.x * dpr, y: box.y * dpr, width: box.width * dpr, height: box.height * dpr },
        500_000,
      );
      if (bytes) crops.push({ caseId: region.caseId, regionId: region.regionId, bytes });
    }
    if (composite)
      report = {
        ...report,
        evidence: { dir: runDir, composite: composite.path.split("/").pop() as string },
      };
    await deps.writer.write(input.root, `${runDir}/fidelity-report.json`, canonicalJson(report));
    await deps.writer.write(
      input.root,
      `${evidenceRoot(input.feature)}/latest.json`,
      canonicalJson({
        schemaVersion: 1,
        runId: input.runId,
        runDir,
        environment: env,
        cases: Object.fromEntries(
          Object.values(measure.cases).map((c) => [c.caseId, `${runDir}/${c.capture}`]),
        ),
      }),
    );
    return { report, runDir, crops, ...(composite ? { composite } : {}) };
  }

  /** `FidelityPort.run`: the gate-ready summary of a run (spec 7.2 G7). */
  async run(input: RunInput): Promise<Prepared> {
    return fidelityPrepared((await this.runDetailed(input)).report);
  }

  /** Runtime accessibility: axe, the keyboard probe and the contrast of the painted colours (spec 11.6). */
  async a11yDetailed(input: RunInput): Promise<A11yRunResult> {
    const { deps } = this;
    const runDir = `${evidenceRoot(input.feature)}/${input.runId}`;
    const loaded = await this.loadContract(input);
    const blockedReport = (message: string): A11yRunResult => ({
      runDir,
      report: {
        schema: "frontsmith.a11y-report/v1",
        status: "BLOCKED",
        findings: [
          {
            ruleId: "FS-AXE-RUN",
            caseId: "-",
            elementId: null,
            severity: "blocker",
            status: "BLOCKED",
            message,
          },
        ],
        coverage: [],
        disclaimer: "Automated checks do not establish WCAG conformance.",
      },
    });
    if ("error" in loaded) return blockedReport(loaded.error);
    const { contract } = loaded;
    const config = (await deps.project.readConfig(input.root)).config;
    const cases = this.selectCases(contract, input.cases);
    if ("error" in cases) return blockedReport(cases.error);
    const request = this.request(contract, config, cases, { axe: true });
    const outcome = await this.withServer(input.root, config, input.signal, () =>
      deps.probe.run({
        root: input.root,
        runDir,
        request,
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    );
    if ("serverProblem" in outcome) return blockedReport(outcome.serverProblem);
    if (outcome.status === "BLOCKED")
      return blockedReport(`${outcome.reason}${outcome.hint ? `: ${outcome.hint}` : ""}`);
    const report = evaluateA11y({
      cases: Object.values(outcome.measure.cases),
      focusOrder: contract.focusOrder,
      target: config.accessibility.target,
      margin: config.accessibility.operationalMargin,
      axeRequested: true,
    });
    await deps.writer.write(input.root, `${runDir}/a11y-report.json`, canonicalJson(report));
    return { report, runDir };
  }

  /** `FidelityPort.a11y`: the gate-ready summary of the runtime accessibility run. */
  async a11y(input: RunInput): Promise<Prepared> {
    const { report } = await this.a11yDetailed(input);
    return {
      status: report.status,
      summary: `${report.findings.length} finding${report.findings.length === 1 ? "" : "s"}. ${report.disclaimer}`,
      findings: report.findings.map<Omit<DraftFinding, "check">>((f) => ({
        ruleId: f.ruleId,
        severity: f.severity,
        status: f.status,
        kind: "deterministic",
        message: `${f.caseId}${f.elementId ? ` ${f.elementId}` : ""}: ${f.message}`,
      })),
    };
  }

  // ---- baselines (spec 7.4, 11.1) ----

  /** `/frontsmith:baseline approve`: copy a reviewed capture of the latest run (a human command). */
  async approveBaseline(
    root: string,
    feature: string,
    caseId?: string,
  ): Promise<{ ok: true; approved: string[] } | { ok: false; reason: string }> {
    const opened = await this.deps.store.read(root, feature);
    if (!opened) return { ok: false, reason: `Unknown feature ${feature}.` };
    if (opened.readOnly)
      return { ok: false, reason: "The feature state was written by a newer Frontsmith." };
    // Never during the acceptance evaluation (FID 11.2): a baseline cannot be created to make G9 pass.
    if (["accept", "archive", "closed"].includes(opened.state.phase) || opened.state.gates.G9)
      return {
        ok: false,
        reason: `Baselines are not approved during or after acceptance (${feature} is in ${opened.state.phase}).`,
      };
    const latest = await this.deps.fsFor(root).read(`${evidenceRoot(feature)}/latest.json`);
    if (latest.kind !== "text")
      return {
        ok: false,
        reason: `No fidelity run exists yet: run /frontsmith:fidelity run ${feature} and review the captures first.`,
      };
    const info = JSON.parse(latest.text) as {
      runId: string;
      environment: { browser: string; browserVersion: string; os: string };
      cases: Record<string, string>;
    };
    const wanted = caseId ? [caseId] : Object.keys(info.cases);
    if (caseId && !info.cases[caseId])
      return { ok: false, reason: `The latest run has no case ${caseId}.` };
    const meta = await this.readMeta(root, feature);
    const approved: string[] = [];
    const protectedUpdates: Record<string, string> = {};
    for (const id of wanted) {
      const bytes = await this.deps.assets.read(root, info.cases[id] as string);
      if (!bytes)
        return { ok: false, reason: `The capture of ${id} is missing from the latest run.` };
      try {
        this.deps.png.decode(bytes);
      } catch (error) {
        return {
          ok: false,
          reason: `The capture of ${id} cannot be used: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const path = `${baselineDir(feature)}/${id}.png`;
      await this.deps.assets.write(root, path, bytes);
      const digest = await this.deps.integrity.digestFile(root, path);
      const hash = digest ? sha(digest) : "";
      meta.files[id] = {
        sha256: hash,
        browser: info.environment.browser,
        browserVersion: info.environment.browserVersion,
        os: info.environment.os,
        approvedAt: this.deps.clock.now().toISOString(),
        runId: info.runId,
      };
      protectedUpdates[path] = hash;
      approved.push(id);
    }
    await this.deps.writer.write(root, `${baselineDir(feature)}/meta.json`, canonicalJson(meta));
    const metaDigest = await this.deps.integrity.digestFile(
      root,
      `${baselineDir(feature)}/meta.json`,
    );
    if (metaDigest) protectedUpdates[`${baselineDir(feature)}/meta.json`] = sha(metaDigest);
    // Re-approving replaces earlier hashes of the same files, so the old ones never block a later run.
    await this.deps.store.update(
      root,
      feature,
      (d) => void Object.assign(d.protected, protectedUpdates),
      this.deps.clock.now().toISOString(),
    );
    return { ok: true, approved };
  }

  async listBaselines(root: string, feature: string): Promise<BaselineMeta["files"]> {
    return (await this.readMeta(root, feature)).files;
  }

  // ---- calibration (spec 11.4) ----

  /**
   * `/frontsmith:fidelity calibrate`: repeat unchanged captures, inject the known mutations, derive
   * limits. The file is written only when `confirm` is true; without it the plan is returned.
   */
  async calibrate(
    root: string,
    feature: string,
    input: { contractPath: string; runId: string; confirm: boolean; signal?: AbortSignal },
  ): Promise<
    | {
        ok: true;
        written: boolean;
        file: CalibrationFile;
        quality: Record<string, ValidatorQuality>;
        unseparable: string[];
      }
    | { ok: false; reason: string }
  > {
    const { deps } = this;
    const loaded = await this.loadContract({
      root,
      feature,
      contractPath: input.contractPath,
      runId: input.runId,
    });
    if ("error" in loaded) return { ok: false, reason: loaded.error };
    const { contract } = loaded;
    const config = (await deps.project.readConfig(root)).config;
    const cases = this.selectCases(contract, undefined);
    if ("error" in cases) return { ok: false, reason: cases.error };
    const meta = await this.readMeta(root, feature);
    const missing = cases.filter((c) => !meta.files[c.id]).map((c) => c.id);
    if (missing.length > 0)
      return {
        ok: false,
        reason: `Calibration needs an approved baseline for every case; missing: ${missing.join(", ")}. Use /frontsmith:baseline approve ${feature}.`,
      };
    const integrity = await this.integrityProblems(root, feature);
    if (integrity.length > 0)
      return { ok: false, reason: `An approved oracle changed: ${integrity.join("; ")}` };
    const labels = labelMutations(contract.calibration?.acceptableMutations);
    const critical = contract.elements.filter((e) => e.critical).map((e) => e.id);
    const runDir = `${evidenceRoot(feature)}/${input.runId}`;
    const request = this.request(contract, config, cases, {
      repetitions: config.fidelity.repetitions,
      mutations: [...CALIBRATION_MUTATIONS],
      mutate: critical,
    });
    const outcome = await this.withServer(root, config, input.signal, () =>
      deps.probe.run({ root, runDir, request, ...(input.signal ? { signal: input.signal } : {}) }),
    );
    if ("serverProblem" in outcome) return { ok: false, reason: outcome.serverProblem };
    if (outcome.status === "BLOCKED")
      return { ok: false, reason: `${outcome.reason}${outcome.hint ? `: ${outcome.hint}` : ""}` };
    const env = outcome.measure.environment;
    for (const id of cases.map((c) => c.id)) {
      const entry = meta.files[id];
      if (entry && (entry.browserVersion !== env.browserVersion || entry.os !== env.os))
        return {
          ok: false,
          reason: `The baseline of ${id} was approved with ${entry.browser} ${entry.browserVersion} on ${entry.os}; calibrate with the same browser version.`,
        };
    }
    const dpr = contract.render?.dpr ?? 1;
    const caseResults: CalibrationFile["cases"] = {};
    const quality: Record<string, ValidatorQuality> = {};
    const unseparable: string[] = [];
    for (const c of cases) {
      const measured = outcome.measure.cases[c.id] as CaseMeasure;
      const baseline = this.decode(
        await deps.assets.read(root, `${baselineDir(feature)}/${c.id}.png`),
        `${c.id} baseline`,
        [],
      );
      if (!baseline) return { ok: false, reason: `The baseline of ${c.id} cannot be read.` };
      const load = async (file: string): Promise<PngImage | undefined> =>
        this.decode(await deps.assets.read(root, `${runDir}/${file}`), file, []);
      const reps = (await Promise.all((measured.repetitions ?? []).map(load))).filter(
        (i): i is PngImage => i !== undefined,
      );
      // Step 2: noise on unchanged captures sets the channel tolerance (capped at 8).
      let maxChannel = 0;
      for (const rep of reps) {
        if (rep.width !== baseline.width || rep.height !== baseline.height)
          return {
            ok: false,
            reason: `CAL-002 unstable environment: repeated captures of ${c.id} change size.`,
          };
        for (let i = 0; i < rep.data.length; i += 1)
          maxChannel = Math.max(
            maxChannel,
            Math.abs((rep.data[i] as number) - (baseline.data[i] as number)),
          );
      }
      const tolerance = channelToleranceFrom([maxChannel]);
      if (!tolerance.ok) return { ok: false, reason: tolerance.message };
      const scale = (box: { x: number; y: number; width: number; height: number }) => ({
        x: box.x * dpr,
        y: box.y * dpr,
        width: box.width * dpr,
        height: box.height * dpr,
      });
      const valid = validPixels(baseline.width, baseline.height, measured.masks.map(scale));
      const sample = (image: PngImage): Record<string, { dR: number; qK: number; k: number }> => {
        const mask = diffMask(
          baseline.data,
          image.data,
          baseline.width,
          baseline.height,
          tolerance.tolerance,
        );
        const out: Record<string, { dR: number; qK: number; k: number }> = {};
        for (const region of contract.regions) {
          const element = measured.elements[region.elementId];
          if (!element) continue;
          const m = regionMetrics(
            mask,
            valid,
            baseline.width,
            baseline.height,
            scale(element.box),
            16,
          );
          out[region.id] = { dR: m.dR, qK: m.qK, k: m.k };
        }
        return out;
      };
      const mutations: Array<{
        id: string;
        defect: boolean;
        regions: Record<string, { dR: number; qK: number; k: number }>;
      }> = [];
      for (const label of labels) {
        const file = measured.mutations?.[label.id];
        const image = file ? await load(file) : undefined;
        if (image && image.width === baseline.width && image.height === baseline.height)
          mutations.push({ id: label.id, defect: label.defect, regions: sample(image) });
      }
      const set = {
        channelTolerance: tolerance.tolerance,
        repetitions: reps.map((r) => ({ regions: sample(r) })),
        mutations,
      };
      const calibrated = calibrateCase(set, config.fidelity.calibrationPosition);
      caseResults[c.id] = calibrated;
      quality[c.id] = validatorQuality(set, calibrated.regions);
      for (const [regionId, region] of Object.entries(calibrated.regions))
        if (region.status === "UNSEPARABLE") unseparable.push(`${c.id}/${regionId}`);
    }
    const inputsSha256 = deps.sha256(
      canonicalJson({
        cases: caseResults,
        contract: input.contractPath,
        browser: env.browserVersion,
      }),
    );
    const file: CalibrationFile = {
      schemaVersion: 1,
      id: `cal-${inputsSha256.slice(0, 8)}`,
      browser: env.browser,
      browserVersion: env.browserVersion,
      createdAt: deps.clock.now().toISOString(),
      cases: caseResults,
      inputsSha256,
    };
    if (!input.confirm) return { ok: true, written: false, file, quality, unseparable };
    await this.saveCalibration(root, feature, file);
    return { ok: true, written: true, file, quality, unseparable };
  }

  /** Write a confirmed calibration and freeze it as a protected oracle (spec 11.4 step 5). */
  async saveCalibration(root: string, feature: string, file: CalibrationFile): Promise<string> {
    const path = `.frontsmith/calibration/${feature}.json`;
    await this.deps.writer.write(root, path, canonicalJson(file));
    const digest = await this.deps.integrity.digestFile(root, path);
    if (digest)
      await this.deps.store.update(
        root,
        feature,
        (d) => {
          d.protected[path] = sha(digest);
        },
        this.deps.clock.now().toISOString(),
      );
    return path;
  }

  /** The approved UI contract of a feature, or why there is none. */
  async contractPathOf(
    root: string,
    feature: string,
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    const opened = await this.deps.store.read(root, feature);
    if (!opened) return { ok: false, reason: `Unknown feature ${feature}.` };
    const entry = opened.state.artifacts["ui-contract"];
    return entry
      ? { ok: true, path: entry.path }
      : { ok: false, reason: `${feature} has no UI contract yet (levels L2 and L3 produce one).` };
  }
}

/** The fidelity report as a G7 check (spec 7.2): failures become findings, the status is the report's. */
export function fidelityPrepared(report: FidelityReport): Prepared {
  return {
    status: report.status,
    summary: `${report.coverage.executed} of ${report.coverage.required} cases measured, ${report.failures.length} open finding${report.failures.length === 1 ? "" : "s"}${report.blockers.length > 0 ? `; ${report.blockers[0]}` : ""}`,
    findings: [
      ...report.failures.map<Omit<DraftFinding, "check">>((f) => ({
        ruleId: f.ruleId,
        severity: f.severity,
        status: f.status,
        kind: "deterministic",
        message: `${f.caseId} ${f.elementId}.${f.property}: expected ${String(f.expected)}${f.actual === null ? "" : `, actual ${String(f.actual)}`}${f.error === null ? "" : ` (error ${f.error}, tolerance ${f.tolerance})`}${f.note ? `. ${f.note}` : ""}`,
      })),
      ...(report.status === "BLOCKED" && report.failures.length === 0
        ? [
            {
              ruleId: "FID-BLOCKED",
              severity: "blocker" as const,
              status: "BLOCKED" as const,
              kind: "deterministic" as const,
              message: report.blockers.join("; ") || "the fidelity pipeline could not run",
            },
          ]
        : []),
    ],
  };
}

export type { MeasureDoc };
