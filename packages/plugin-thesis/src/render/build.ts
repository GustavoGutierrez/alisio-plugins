import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { modelFindings } from "../checks/document.js";
import { loadProject } from "../checks/project.js";
import { styleFindings } from "../checks/styles.js";
import { atomicWrite, canonicalJson } from "../storage.js";
import { styleFixtureFindings } from "../styles/golden.js";
import type { Finding, SectionState } from "../types.js";
import { assembleDocument } from "./assemble.js";
import { resolveAssets } from "./assets.js";
import { createDefaultRegistry } from "./default-registry.js";
import type { BuildScope } from "./model.js";
import type { Renderer } from "./port.js";
import type { RendererRegistry } from "./registry.js";

export interface BuildRequest {
  /** Absolute thesis root (the folder with thesis.yaml). */
  root: string;
  scope: BuildScope;
  section?: string;
  pdfa?: boolean;
  /** Output format; `pdf` is the only one with a shipped adapter. */
  format?: string;
  /** Section states from state.json, for the `approved` scope. */
  sections?: Record<string, SectionState>;
  env: NodeJS.ProcessEnv;
  cacheRoot: string;
  registry?: RendererRegistry;
  packsRoot?: string;
  now?: () => Date;
  signal?: AbortSignal;
  progress?: (note: string) => void;
}

export interface BuildOutcome {
  ok: boolean;
  scope: BuildScope;
  /** Absolute output path when a file was produced. */
  path?: string;
  engine: string;
  pages?: number;
  ms: number;
  findings: Finding[];
  warnings: string[];
  unrepresented: { construct: string; count: number; note?: string }[];
}

const blocking = (finding: Finding) => finding.severity === "error";

/**
 * Assemble the neutral document, materialize its assets and hand it to a renderer. Everything
 * before the renderer call is format-neutral. Writes `build/build-report.json` for BLD-001.
 */
export async function buildThesis(request: BuildRequest): Promise<BuildOutcome> {
  const started = Date.now();
  const registry = request.registry ?? createDefaultRegistry();
  const format = request.format ?? "pdf";
  const finish = async (
    partial: Omit<BuildOutcome, "ms" | "scope" | "warnings" | "unrepresented"> &
      Partial<Pick<BuildOutcome, "unrepresented">>,
  ): Promise<BuildOutcome> => {
    const outcome: BuildOutcome = {
      scope: request.scope,
      ms: Date.now() - started,
      unrepresented: [],
      warnings: [],
      ...partial,
    };
    outcome.warnings = outcome.findings
      .filter((f) => f.severity !== "error")
      .map((f) => `${f.code} ${f.message}`);
    const errors = outcome.findings.filter(blocking).length;
    try {
      await atomicWrite(
        join(request.root, "build", "build-report.json"),
        canonicalJson({
          at: (request.now ?? (() => new Date()))().toISOString(),
          scope: request.scope,
          ...(request.section ? { section: request.section } : {}),
          ok: outcome.ok,
          errors,
          warnings: outcome.warnings.length,
          engine: outcome.engine,
          ...(outcome.pages === undefined ? {} : { pages: outcome.pages }),
          findings: outcome.findings.slice(0, 50),
        }),
      );
    } catch {
      // The report is advisory; a read-only workspace must not hide the build result.
    }
    return outcome;
  };
  const failure = (message: string, hint?: string, code = "BLD-001"): Promise<BuildOutcome> =>
    finish({
      ok: false,
      engine: "none",
      findings: [{ code, gate: "G8", severity: "error", message, ...(hint ? { hint } : {}) }],
    });

  if (request.scope === "section" && !request.section) {
    return failure("Section scope needs a section id such as SEC-03");
  }
  const formatRenderers = registry.byFormat(format);
  if (formatRenderers.length === 0) {
    return failure(`No renderer is available for the "${format}" format in this release`);
  }
  // PDF/A is an archival profile only some engines can write.
  const candidates = formatRenderers.filter(
    (candidate) => !request.pdfa || candidate.capabilities().pdfa,
  );
  if (candidates.length === 0) {
    return failure(
      `No ${format} renderer can write PDF/A`,
      "Run /thesis:setup to install the pinned Typst.",
    );
  }

  request.progress?.("loading the thesis");
  const project = await loadProject(request.root, {
    ...(request.packsRoot ? { packsRoot: request.packsRoot } : {}),
    ...(request.sections ? { sections: request.sections } : {}),
    ...(request.now ? { now: request.now() } : {}),
  });
  const assembled = assembleDocument(project, {
    scope: request.scope,
    ...(request.section ? { section: request.section } : {}),
    ...(request.sections ? { sections: request.sections } : {}),
  });
  if (!assembled) {
    return failure(
      "thesis.yaml has errors; run /thesis:check and fix them first",
      undefined,
      "BRF-001",
    );
  }
  const { document } = assembled;
  const findings: Finding[] = [...assembled.findings];
  if (request.scope === "section" && document.body.length === 0) {
    return failure(
      `No chapter file declares section ${request.section}`,
      "Add `section: SEC-xx` to the chapter's front matter.",
    );
  }
  // Notes about the selected citation style; CSL-001 and PRF-001 errors came from the assembly.
  findings.push(
    ...styleFindings(project, "selected").filter(
      (finding) => finding.code === "CSL-020" || finding.code === "CSL-021",
    ),
  );
  // Cross-references and math are checked on the model; a partial scope degrades references first.
  findings.push(...modelFindings(document).filter((finding) => finding.code !== "XRF-002"));
  if (findings.some(blocking)) {
    return finish({ ok: false, engine: "none", findings });
  }

  // Engine order (spec 10.6): the first available renderer of the format wins; a later one is a
  // fallback and its differences are reported.
  const environment = { env: request.env, cacheRoot: request.cacheRoot, root: request.root };
  const skipped: { renderer: Renderer; reason: string; hint?: string }[] = [];
  let renderer: Renderer | undefined;
  for (const candidate of candidates) {
    const availability = await candidate.available(environment);
    if (availability.available) {
      renderer = candidate;
      break;
    }
    skipped.push({
      renderer: candidate,
      reason: availability.reason,
      ...(availability.hint ? { hint: availability.hint } : {}),
    });
  }
  if (!renderer) {
    const first = skipped[0] as (typeof skipped)[number];
    const message =
      skipped.length === 1
        ? first.reason
        : `No ${format.toUpperCase()} engine is available. ${skipped
            .map((entry) => `${entry.renderer.id}: ${entry.reason}`)
            .join(". ")}`;
    const hint =
      skipped.length === 1
        ? first.hint
        : "Run /thesis:setup to install the pinned Typst, or install Google Chrome or Chromium for the fallback.";
    return finish({
      ok: false,
      engine: "none",
      findings: [
        ...findings,
        {
          code: "BLD-001",
          gate: "G8",
          severity: "error",
          message,
          ...(hint ? { hint } : {}),
        },
      ],
    });
  }
  if (skipped.length > 0) {
    findings.push({
      code: "BLD-004",
      gate: "G8",
      severity: "warning",
      message: `Using the ${renderer.id} fallback because ${(skipped[0] as (typeof skipped)[number]).renderer.id} is unavailable (${(skipped[0] as (typeof skipped)[number]).reason}); the page layout differs from the Typst output`,
      hint: "Run /thesis:setup to install the pinned Typst for the reference layout.",
    });
  }

  // CSL-010: a selected workspace style must still render its approved fixtures.
  if (document.bibliography.csl.source === "workspace") {
    findings.push(
      ...(
        await styleFixtureFindings(project, {
          env: request.env,
          cacheRoot: request.cacheRoot,
          only: document.bibliography.csl.id,
        })
      ).filter((finding) => finding.severity === "error"),
    );
    if (findings.some(blocking)) return finish({ ok: false, engine: "none", findings });
  }

  const buildDir = join(request.root, "build");
  await mkdir(join(buildDir, "cache"), { recursive: true, mode: 0o700 });
  request.progress?.("preparing figures");
  findings.push(
    ...(await resolveAssets(document, {
      root: request.root,
      buildDir,
      cacheDir: join(buildDir, "cache"),
      meta: document.meta,
    })),
  );
  if (findings.some(blocking)) return finish({ ok: false, engine: "none", findings });

  request.progress?.(`rendering with ${renderer.id}`);
  const result = await renderer.render(
    document,
    {
      scope: request.scope,
      ...(request.section ? { section: request.section } : {}),
      ...(request.pdfa ? { pdfa: true } : {}),
    },
    {
      env: request.env,
      cacheRoot: request.cacheRoot,
      root: request.root,
      buildDir,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.progress ? { progress: request.progress } : {}),
    },
  );
  return finish({
    ok: result.ok,
    engine: result.engine,
    ...(result.output ? { path: join(buildDir, result.output) } : {}),
    ...(result.pages === undefined ? {} : { pages: result.pages }),
    findings: [...findings, ...result.findings],
    unrepresented: result.unrepresented,
  });
}
