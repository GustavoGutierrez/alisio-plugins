import {
  type EnvelopeError,
  type EnvelopeKind,
  parseChildJson,
} from "../../domain/envelopes/parse.js";
import {
  type EnvelopeByKind,
  type ValidationContext,
  validateEnvelope,
} from "../../domain/envelopes/registry.js";
import { readTools } from "../../domain/resources/frontmatter.js";
import type { ModelSource } from "../../domain/state/feature-state.js";
import type { AgentRunner, RunResult } from "../ports/agent-runner.js";
import { type AttemptSink, noAttempts } from "../ports/attempt-sink.js";
import type { Clock } from "../ports/clock.js";
import { systemClock } from "../ports/clock.js";
import { buildPrompt, buildRetryPrompt, type PromptSection } from "./prompts.js";
import { type AgentProfile, agentName, type FsRole, roleEnvelope } from "./roster.js";

/** Where a run's model comes from; fails closed on a configuration error (spec 16.5). */
export interface ModelBinding {
  resolve(
    workspace: string,
    agent: string,
  ): Promise<
    { ok: true; model: string | null; source: ModelSource } | { ok: false; message: string }
  >;
}

export interface DelegateDeps {
  runner: AgentRunner;
  profiles(agent: string): Promise<AgentProfile>;
  models: ModelBinding;
  attempts?: AttemptSink;
  clock?: Clock;
}

export interface DelegateRequest<K extends EnvelopeKind> {
  role: Exclude<FsRole, "coordinator">;
  kind: K;
  sections: readonly PromptSection[];
  note?: string;
  /** Label for the child session, for example `T-003 implementer`. */
  title: string;
  workspace: string;
  parentSession: string;
  /** Test engineer only: design mode narrows the build profile at spawn (W-03). */
  mode?: "design" | "build";
  reuseSession?: string;
  signal?: AbortSignal;
  validation?: ValidationContext;
}

export type DelegateOutcome<K extends EnvelopeKind> =
  | {
      status: "ok";
      value: EnvelopeByKind[K];
      sessionId: string | undefined;
      model: string | null;
      source: ModelSource;
      retried: boolean;
    }
  | { status: "invalid"; errors: EnvelopeError[]; retried: true; sessionId: string | undefined }
  | { status: "failed"; error: string; sessionId: string | undefined }
  | { status: "cancelled" }
  | { status: "model-error"; message: string };

/**
 * W-03: `fs-test-engineer` declares the build profile; in design mode the child is narrowed at
 * `sessions.create`: read-only, no write or process permission, 8 turns, read tools only.
 */
export function narrowProfile(profile: AgentProfile, mode: "design" | "build"): AgentProfile {
  if (profile.role !== "test-engineer" || mode === "build") return profile;
  return {
    ...profile,
    readOnly: true,
    permission: { write: "deny", process: "deny" },
    maxTurns: Math.min(profile.maxTurns, 8),
    tools: [...readTools],
  };
}

const addUsage = (
  total: { input: number; output: number },
  usage: RunResult["usage"],
): { input: number; output: number } => ({
  input: total.input + (usage?.input ?? 0),
  output: total.output + (usage?.output ?? 0),
});

/**
 * Run one child and return one validated envelope (AD-3): the final text must be one JSON value of
 * the requested kind. An invalid envelope gets exactly one retry in the same session with the
 * validation errors; a second failure, or a text cut off by the turn limit, is `invalid`, which the
 * caller turns into "Needs your decision". The model is resolved first and fails closed.
 */
export async function delegate<K extends EnvelopeKind>(
  deps: DelegateDeps,
  request: DelegateRequest<K>,
): Promise<DelegateOutcome<K>> {
  const allowed = roleEnvelope[request.role];
  if (!allowed.includes(request.kind))
    throw new Error(`${agentName(request.role)} does not return a ${request.kind} envelope`);
  const clock = deps.clock ?? systemClock;
  const attempts = deps.attempts ?? noAttempts;
  const name = agentName(request.role);
  const bound = await deps.models.resolve(request.workspace, name);
  if (!bound.ok) return { status: "model-error", message: bound.message };
  const profile = narrowProfile(await deps.profiles(name), request.mode ?? "build");
  const startedAt = clock.now().toISOString();
  const seq = await attempts.begin({
    kind: "child",
    role: request.role,
    agent: name,
    ...(bound.model ? { model: bound.model } : {}),
    modelSource: bound.source,
    status: "running",
    startedAt,
  });
  let usage = { input: 0, output: 0 };
  let sessionId = request.reuseSession;
  const finish = async (
    status: "completed" | "failed" | "rejected" | "interrupted",
    error?: string,
  ): Promise<void> => {
    await attempts.finish(seq, {
      status,
      endedAt: clock.now().toISOString(),
      ...(sessionId ? { sessionId } : {}),
      usage,
      ...(error ? { error } : {}),
    });
  };
  const run = async (prompt: string): Promise<RunResult> => {
    const result = await deps.runner.run({
      profile,
      parentSession: request.parentSession,
      title: request.title,
      prompt,
      workspace: request.workspace,
      model: bound.model,
      ...(sessionId ? { reuseSession: sessionId } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    usage = addUsage(usage, result.usage);
    if (result.sessionId) sessionId = result.sessionId;
    return result;
  };

  const check = (
    result: RunResult,
  ):
    | { ok: true; value: EnvelopeByKind[K] }
    | { ok: false; errors: EnvelopeError[]; reason: string } => {
    if (result.turnsExceeded)
      return {
        ok: false,
        errors: [],
        reason:
          "You ran out of turns and your last message was cut off. Answer with the envelope now.",
      };
    const parsed = parseChildJson(result.text);
    if (!parsed.ok) return { ok: false, errors: [], reason: parsed.message };
    const valid = validateEnvelope(request.kind, parsed.value, request.validation);
    return valid.ok
      ? { ok: true, value: valid.value }
      : {
          ok: false,
          errors: valid.errors,
          reason: "Your previous final message was not a valid envelope.",
        };
  };

  let first: RunResult;
  try {
    first = await run(
      buildPrompt(
        request.role,
        request.kind,
        request.sections,
        request.note ? { note: request.note } : {},
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finish("failed", message);
    return { status: "failed", error: message, sessionId };
  }
  if (first.status === "cancelled") {
    await finish("interrupted");
    return { status: "cancelled" };
  }
  if (first.status === "failed") {
    await finish("failed", first.error ?? "the child session failed");
    return { status: "failed", error: first.error ?? "the child session failed", sessionId };
  }
  const firstCheck = check(first);
  if (firstCheck.ok) {
    await finish("completed");
    return {
      status: "ok",
      value: firstCheck.value,
      sessionId,
      model: bound.model,
      source: bound.source,
      retried: false,
    };
  }
  let second: RunResult;
  try {
    second = await run(buildRetryPrompt(request.kind, firstCheck.errors, firstCheck.reason));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finish("failed", message);
    return { status: "failed", error: message, sessionId };
  }
  if (second.status === "cancelled") {
    await finish("interrupted");
    return { status: "cancelled" };
  }
  if (second.status === "failed") {
    await finish("failed", second.error ?? "the child session failed");
    return { status: "failed", error: second.error ?? "the child session failed", sessionId };
  }
  const secondCheck = check(second);
  if (secondCheck.ok) {
    await finish("completed");
    return {
      status: "ok",
      value: secondCheck.value,
      sessionId,
      model: bound.model,
      source: bound.source,
      retried: true,
    };
  }
  const errors: EnvelopeError[] =
    secondCheck.errors.length > 0
      ? secondCheck.errors
      : [{ pointer: "", message: secondCheck.reason }];
  await finish(
    "rejected",
    errors
      .map((e) => `${e.pointer || "(root)"}: ${e.message}`)
      .slice(0, 5)
      .join("; "),
  );
  return { status: "invalid", errors, retried: true, sessionId };
}
