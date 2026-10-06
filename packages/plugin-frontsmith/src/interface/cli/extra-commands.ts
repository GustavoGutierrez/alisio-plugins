import { canonicalJson } from "../../domain/canonical-json.js";
import { type ContrastKind, evaluateContrast } from "../../domain/color/contrast.js";
import type { Theme } from "../../domain/color/pairs.js";
import { isFeatureId } from "../../domain/ids.js";
import { type GateId, gateIds } from "../../domain/state/feature-state.js";
import { compose } from "../composition.js";
import { architectureMarkdown } from "../presenters/architecture.js";
import { fidelityMarkdown } from "../presenters/fidelity.js";
import { table } from "../presenters/markdown.js";
import { modelsMarkdown } from "../presenters/models.js";
import {
  contrastSummary,
  paletteSummary,
  paletteTable,
  tokensMarkdown,
} from "../presenters/tokens.js";
import { budgetMarkdown, doctorMarkdown, gateReportMarkdown } from "../presenters/workflow.js";
import { parseArgs, UsageError } from "./args.js";
import { type CliCommand, directoryArg, EXIT, EXIT_FOR, splitList } from "./shared.js";

async function arch(argv: string[], io: Parameters<CliCommand>[1]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, {
    flags: { json: "boolean", paths: "string" },
    maxPositionals: 1,
  });
  const dir = await directoryArg(io, positionals[0]);
  const paths = splitList(flags.paths);
  const outcome = await compose().architecture.check(dir, paths ? { paths } : {});
  if (flags.json === true) {
    io.stdout(
      `${JSON.stringify(
        {
          schema: "frontsmith.architecture-report/v1",
          verdict: outcome.state === "ok" ? outcome.result.verdict : "BLOCKED",
          ...(outcome.state === "ok"
            ? {
                violations: outcome.result.violations,
                byCheck: outcome.result.byCheck,
                graph: outcome.result.graph,
              }
            : { problem: outcome.state }),
        },
        null,
        2,
      )}\n`,
    );
  } else io.stdout(`${architectureMarkdown(outcome)}\n`);
  return outcome.state === "ok" ? EXIT_FOR[outcome.result.verdict] : EXIT.blocked;
}

async function tokens(argv: string[], io: Parameters<CliCommand>[1]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { flags: { json: "boolean" }, maxPositionals: 1 });
  const dir = await directoryArg(io, positionals[0]);
  const outcome = await compose().tokens.check(dir);
  if (flags.json === true)
    io.stdout(
      `${JSON.stringify(
        outcome.blocked
          ? {
              schema: "frontsmith.tokens-report/v1",
              verdict: "BLOCKED",
              problems: outcome.problems,
            }
          : {
              schema: "frontsmith.tokens-report/v1",
              verdict: outcome.verdict,
              sources: outcome.sources,
              findings: outcome.result.findings,
              pairs: outcome.rows,
              notEvaluated: outcome.notEvaluated,
            },
        null,
        2,
      )}\n`,
    );
  else io.stdout(`${tokensMarkdown(outcome)}\n`);
  return outcome.blocked ? EXIT.blocked : EXIT_FOR[outcome.verdict];
}

const KINDS = ["normal_text", "large_text", "non_text"];

async function contrast(argv: string[], io: Parameters<CliCommand>[1]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, {
    flags: { kind: "string", json: "boolean" },
    maxPositionals: 2,
  });
  const [fg, bg] = positionals;
  if (fg === undefined || bg === undefined) throw new UsageError("contrast needs <fg> and <bg>");
  const kind = typeof flags.kind === "string" ? flags.kind : "normal_text";
  if (!KINDS.includes(kind)) throw new UsageError(`--kind must be ${KINDS.join(", ")}`);
  const result = evaluateContrast({ fg, bg, kind: kind as ContrastKind });
  if (flags.json === true) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else io.stdout(`${contrastSummary([result])}\n`);
  return result.status === "PASS" ? EXIT.pass : result.status === "FAIL" ? EXIT.fail : EXIT.review;
}

async function palette(argv: string[], io: Parameters<CliCommand>[1]): Promise<number> {
  const { flags } = parseArgs(argv, {
    flags: { family: "string", themes: "string", json: "boolean" },
    maxPositionals: 0,
  });
  if (typeof flags.family !== "string") throw new UsageError("palette needs --family <id>");
  const themes = splitList(flags.themes) ?? ["light", "dark"];
  if (themes.length === 0 || !themes.every((t) => t === "light" || t === "dark"))
    throw new UsageError("--themes must list light and dark");
  const result = await compose().tokens.palette({
    family: flags.family,
    themes: themes as Theme[],
  });
  if (!result.ok) {
    if (result.kind === "invalid") throw new UsageError(result.reason);
    io.stdout(flags.json === true ? `${JSON.stringify(result, null, 2)}\n` : `${result.reason}\n`);
    return EXIT.fail;
  }
  if (flags.json === true) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const block = paletteTable(result);
    io.stdout(
      `${paletteSummary(result)}\n\n${block.kind === "table" ? table(block.columns, block.rows) : ""}\n`,
    );
  }
  return EXIT.pass;
}

async function models(argv: string[], io: Parameters<CliCommand>[1]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { flags: { json: "boolean" }, maxPositionals: 1 });
  const dir = await directoryArg(io, positionals[0]);
  const view = await compose().models.view(dir, {});
  if (flags.json === true)
    io.stdout(
      `${JSON.stringify(
        {
          schema: "frontsmith.models-report/v1",
          agents: view.rows.map(({ agent, defaultTier, effectiveTier, model, source, trail }) => ({
            agent,
            defaultTier,
            effectiveTier,
            model,
            source,
            trail,
          })),
          diagnostics: view.errors,
        },
        null,
        2,
      )}\n`,
    );
  else io.stdout(`${modelsMarkdown(view, undefined)}\n`);
  return view.errors.length > 0 ? EXIT.blocked : EXIT.pass;
}

async function gate(argv: string[], io: Parameters<CliCommand>[1]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, {
    flags: { json: "boolean", task: "string" },
    maxPositionals: 3,
  });
  const [feature, gateId] = positionals;
  if (
    !feature ||
    !isFeatureId(feature) ||
    !gateId ||
    !(gateIds as readonly string[]).includes(gateId)
  )
    throw new UsageError(
      `Usage: alisio-frontsmith gate <feature> <${gateIds.join("|")}> [dir] [--task T-001] [--json]`,
    );
  const task = typeof flags.task === "string" ? flags.task : undefined;
  if (task !== undefined && !/^T-\d{3}$/.test(task))
    throw new UsageError("--task must look like T-001");
  const dir = await directoryArg(io, positionals[2]);
  const report = await compose().services.checkGate(
    dir,
    feature,
    gateId as GateId,
    task ? { taskId: task } : {},
  );
  io.stdout(flags.json === true ? canonicalJson(report) : `${gateReportMarkdown(report)}\n`);
  return EXIT_FOR[report.verdict];
}

async function budget(argv: string[], io: Parameters<CliCommand>[1]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { flags: { json: "boolean" }, maxPositionals: 1 });
  const dir = await directoryArg(io, positionals[0]);
  const result = await compose().services.budgetCheck(dir);
  if (flags.json === true)
    io.stdout(
      canonicalJson({
        schema: "frontsmith.budget-report/v1",
        verdict: result.status,
        lines: result.lines,
        findings: result.findings,
        problems: result.problems,
      }),
    );
  else io.stdout(`${budgetMarkdown(result)}\n`);
  return EXIT_FOR[result.status];
}

async function doctor(argv: string[], io: Parameters<CliCommand>[1]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, { flags: { json: "boolean" }, maxPositionals: 1 });
  const dir = await directoryArg(io, positionals[0]);
  const items = await compose().services.doctor(dir);
  if (flags.json === true)
    io.stdout(canonicalJson({ schema: "frontsmith.doctor-report/v1", items }));
  else io.stdout(`${doctorMarkdown(items)}\n`);
  return items.some((i) => i.status === "FAIL")
    ? EXIT.fail
    : items.some((i) => i.status === "BLOCKED")
      ? EXIT.blocked
      : EXIT.pass;
}

async function fidelity(argv: string[], io: Parameters<CliCommand>[1]): Promise<number> {
  const { positionals, flags } = parseArgs(argv, {
    flags: { json: "boolean", cases: "string" },
    maxPositionals: 2,
  });
  const [feature] = positionals;
  if (!feature || !isFeatureId(feature))
    throw new UsageError(
      "Usage: alisio-frontsmith fidelity <feature> [dir] [--cases a,b] [--json]",
    );
  const dir = await directoryArg(io, positionals[1]);
  const services = compose().services;
  const found = await services.fidelity.contractPathOf(dir, feature);
  if (!found.ok) throw new UsageError(found.reason);
  const cases = splitList(flags.cases);
  const run = await services.fidelity.runDetailed({
    root: dir,
    feature,
    contractPath: found.path,
    runId: services.deps.newId(),
    ...(cases ? { cases } : {}),
  });
  io.stdout(
    flags.json === true
      ? canonicalJson(run.report)
      : `${fidelityMarkdown(run.report, run.composite?.path)}\n`,
  );
  return EXIT_FOR[run.report.status];
}

/** Commands added after the first CLI release; `main.ts` dispatches to this table. */
export const extraCommands: Readonly<Record<string, CliCommand>> = {
  arch,
  tokens,
  contrast,
  palette,
  models,
  gate,
  budget,
  doctor,
  fidelity,
};

export const EXTRA_USAGE = `  alisio-frontsmith arch [dir] [--paths <glob,...>] [--json]
                                            Check the import graph against .frontsmith/architecture.json
  alisio-frontsmith tokens [dir] [--json]   Check design tokens, themes and contrast pairs
  alisio-frontsmith contrast <fg> <bg> [--kind normal_text|large_text|non_text]
                                            Compute WCAG 2.2 contrast for one pair
  alisio-frontsmith palette --family <id> [--themes light,dark] [--json]
                                            Generate a deterministic palette from the curated catalog
  alisio-frontsmith models [dir] [--json]   Show the model and source layer of every agent
  alisio-frontsmith gate <feature> <G0|G1|G2|G2T|G3|G4|G5|G6|G7|G8|G9> [dir] [--task T-001] [--json]
                                            Run one gate on a feature as it is now
  alisio-frontsmith fidelity <feature> [dir] [--cases a,b] [--json]
                                            Measure the rendered feature and compare it with the approved baselines
  alisio-frontsmith budget [dir] [--json]   Check the performance budgets against the build output
  alisio-frontsmith doctor [dir] [--json]   Check what a Frontsmith run needs
`;
