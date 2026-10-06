import { canonicalJson } from "../../../domain/canonical-json.js";
import type { TokensEnvelope } from "../../../domain/envelopes/tokens.js";
import type { UiContractEnvelope } from "../../../domain/envelopes/ui-contract.js";
import { type G2TInput, type G2TPair, gateG2T } from "../../../domain/gates/g2t.js";
import { detectStack } from "../../detect/stack.js";
import { approvalToLeave } from "../approvals.js";
import {
  delegateChild,
  describeFailure,
  finishGate,
  loadArtifact,
  type PhaseEnv,
  passes,
  readJson,
  readState,
  type UnitResult,
  updateState,
  writeArtifact,
  writePlain,
} from "../env.js";
import { inventoryRows } from "../project.js";
import { advance, clip, compact, failureSummary, feedbackSection, sections } from "./shared.js";

/** Naming rules of FS-TOK-003 and FS-TOK-004, applied to the names the tokensmith proposes. */
const NAMING = /^--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FORBIDDEN =
  /^--(?:(?:red|blue|green|yellow|orange|purple|pink|teal|cyan|indigo|violet|gray|grey|black|white|dark|light)-(?!\d+$)[a-z]|(?:left|right|top|bottom)-[a-z]|[a-z]+\d+$)/;

export function namingProblems(envelope: TokensEnvelope): string[] {
  const problems: string[] = [];
  for (const role of envelope.roles) {
    if (!NAMING.test(role.token)) problems.push(`${role.token} is not kebab-case`);
    else if (role.layer !== "primitive" && FORBIDDEN.test(role.token))
      problems.push(`${role.token} names a colour or position instead of a function`);
  }
  return problems;
}

/** Tokens phase (spec 7.1, 12.3): the tokensmith picks roles and constraints, the solver picks values. */
export async function runTokens(env: PhaseEnv): Promise<UnitResult> {
  const state = await readState(env);
  const contract = await loadArtifact<UiContractEnvelope>(env, state, "ui-contract");
  let envelope = await readJson<TokensEnvelope>(
    env,
    `${(state.artifacts.tokens?.path ?? "").replace(/tokens\.json$/, "")}tokens-envelope.json`,
  );
  const stale = state.gates.G2T?.verdict === "FAIL";
  if (!state.artifacts.tokens || !envelope || stale) {
    const { deps } = env;
    const stack = await detectStack(deps.fsFor(env.root), deps.resolver);
    const rows = await inventoryRows(env);
    env.progress("tokens: tokensmith running");
    const outcome = await delegateChild(env, {
      role: "tokensmith",
      kind: "tokens",
      title: `${env.feature} tokensmith`,
      sections: sections(
        { title: "Tokens the UI contract needs", body: compact(contract?.tokensNeeded ?? []) },
        {
          title: "Existing token files and names",
          body: clip(
            rows
              .filter((r) => r.kind === "token")
              .slice(0, 200)
              .map((r) => `- ${r.name} (${r.path})`)
              .join("\n") || "None found.",
            8000,
          ),
        },
        { title: "Styling approach", body: stack.styling.join(", ") || "none detected" },
        { title: "Palette catalog families", body: (await deps.tokens.families()).join(", ") },
        feedbackSection(state, "tokens"),
        stale ? await failureSummary(env, state, "G2T") : undefined,
      ),
    });
    if (outcome.status === "cancelled")
      return { kind: "cancelled", message: "tokens was cancelled." };
    if (outcome.status !== "ok") {
      const message = describeFailure(outcome);
      await updateState(env, (d) => {
        d.blocked = { reason: message, at: env.deps.clock.now().toISOString() };
      });
      return { kind: "blocked", message };
    }
    envelope = outcome.value;
    await writePlain(env, "tokens-envelope.json", canonicalJson(envelope));
    let solver: G2TInput["solver"] = {
      status: "skipped",
      reason: "strategy none: existing values are only validated",
    };
    let pairs: G2TPair[] = [];
    let tokensText = canonicalJson({
      $extensions: { frontsmith: { requiredPairs: envelope.requiredPairs } },
    });
    if (envelope.generation.strategy === "catalog" && envelope.generation.family) {
      const roleTokens = await deps.tokens.roleTokens();
      const byToken = new Map(Object.entries(roleTokens).map(([role, token]) => [token, role]));
      const locked: Record<string, string> = {};
      for (const [token, value] of Object.entries(envelope.generation.locked)) {
        const role = byToken.get(token);
        if (role) locked[role] = value;
      }
      const generated = await deps.tokens.generate(
        env.root,
        { family: envelope.generation.family, themes: envelope.themes, locked },
        { write: false },
      );
      if (generated.state === "unsat" || generated.state === "invalid")
        solver = { status: "unsat", reason: generated.reason };
      else {
        solver = { status: "ok" };
        pairs = generated.plan.palette.themes.flatMap((theme) =>
          theme.pairs.map((pair) => ({
            fg: pair.fg,
            bg: pair.bg,
            theme: theme.theme,
            ratio: pair.ratio,
            minimum: pair.min,
          })),
        );
        tokensText = generated.plan.tokensText;
        const themeOutput = env.config.paths.themeOutput;
        // TODO(owner): an existing theme file is human-owned and is never replaced by the phase.
        if (!(await deps.fsFor(env.root).exists(themeOutput)))
          await deps.writer.write(env.root, themeOutput, generated.plan.cssText);
      }
    } else {
      const checked = await deps.tokens.check(env.root);
      if (!checked.blocked)
        pairs = checked.rows
          .filter((row) => row.ratio !== null)
          .map((row) => ({
            fg: row.fg,
            bg: row.bg,
            theme: row.theme,
            ratio: row.ratio as number,
            minimum: row.minimum,
          }));
    }
    await writeArtifact(env, "tokens", "tokens.json", tokensText);
    await updateState(env, (d) => {
      delete d.blocked;
      delete d.feedback?.tokens;
    });
    const report = await finishGate(
      env,
      "G2T",
      gateG2T({ namingProblems: namingProblems(envelope), solver, pairs, lockedViolations: [] }),
    );
    return afterGate(
      env,
      report.verdict,
      report.checks
        .filter((c) => c.status === "FAIL" || c.status === "BLOCKED")
        .map((c) => `${c.id}: ${c.summary}`),
    );
  }
  const entry = state.gates.G2T;
  return afterGate(env, entry?.verdict ?? "BLOCKED", entry?.failedChecks ?? []);
}

async function afterGate(env: PhaseEnv, verdict: string, failing: string[]): Promise<UnitResult> {
  if (!passes(verdict as "PASS")) {
    const message = `G2T ${verdict}: ${failing.join("; ")}. Run /frontsmith:next ${env.feature} to have the tokensmith fix it.`;
    await updateState(env, (d) => {
      d.blocked = { reason: message, at: env.deps.clock.now().toISOString(), gate: "G2T" };
    });
    return { kind: "blocked", gate: "G2T", message };
  }
  void approvalToLeave;
  await advance(env);
  return { kind: "advanced", message: `Tokens ready (G2T ${verdict}).` };
}
