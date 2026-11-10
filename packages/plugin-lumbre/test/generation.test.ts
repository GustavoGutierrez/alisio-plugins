// 0.1.1: delimited blocks, plan + batches, continuations after a cut answer, partial proposals,
// failure categories and per-job diagnostics, with a realistic ~30 KB multi-file landing.
import { afterEach, describe, expect, it } from "vitest";
import { blocks, cutInside, LANDING, legacy } from "./fixtures/landing.js";
import { type Fixture, fixture } from "./service-fixture.js";

const open: Fixture[] = [];
async function setup(options?: Parameters<typeof fixture>[0]) {
  const f = await fixture(options);
  open.push(f);
  return f;
}
afterEach(async () => {
  for (const f of open.splice(0)) await f.cleanup();
});

const pick = (...paths: string[]) =>
  Object.fromEntries(paths.map((p) => [p, LANDING[p] as string]));
const ALL = Object.keys(LANDING);
const keys = (job: { steps: Array<{ key: string }> }) => job.steps.map((s) => s.key);

/** A project past its starter revision, so a request goes straight to writing (no plan). */
async function existing(f: Fixture) {
  const p = await f.call("projects.create", { title: "La Espiga", stack: "vanilla" });
  await f.call("files.save", {
    projectId: p.id,
    path: "notes.md",
    content: "x",
    baseRevision: p.head,
  });
  return p;
}

describe("plan first, then files in batches (new projects)", () => {
  it("(a) plans, writes two batches sized to the output budget and proposes every file", async () => {
    const f = await setup({ models: [{ reference: "acme/fast", contextWindow: 64_000 }] });
    const p = await f.call("projects.create", { title: "La Espiga", stack: "vanilla" });
    f.respond(
      {
        text: `<<<LUMBRE-META>>>\n{"summary":"Bakery landing page","delete":["styles.css"]}\n<<<LUMBRE-END>>>\n<<<LUMBRE-MESSAGE>>>\nVoy a crear la página.\n<<<LUMBRE-END>>>\n<<<LUMBRE-PLAN>>>\nindex.html | large | page\nstyles.css | large | styles\nscript.js | small | behaviour\nabout.html | small | about\nassets/logo.svg | small | logo\n<<<LUMBRE-END>>>\n<<<LUMBRE-DONE>>>`,
        output: 400,
      },
      { text: blocks(pick("index.html", "styles.css"), { meta: {}, message: "" }), output: 9_000 },
      {
        text: blocks(pick("script.js", "about.html", "assets/logo.svg"), { meta: {}, message: "" }),
        output: 2_000,
      },
    );
    const job = await f.waitJob(
      (await f.call("chat.send", { projectId: p.id, text: "Bakery site" })).jobId,
    );
    expect([job.state, job.error, job.diagnostics?.reason]).toEqual(["done", null, null]);
    expect(keys(job)).toEqual(expect.arrayContaining(["planning", "writingBatch", "reviewReady"]));
    expect(
      job.steps
        .filter((s: { key: string }) => s.key === "writingBatch")
        .map((s: { args: unknown }) => s.args),
    ).toEqual([
      { part: 1, total: 2 },
      { part: 2, total: 2 },
    ]);
    expect(f.prompts[0]).toMatch(/PLAN FIRST/);
    expect(f.prompts[1]).toMatch(/part 1 of 2/);
    expect(f.prompts[1]).toContain("- index.html");
    expect(f.prompts[2]).toContain("- assets/logo.svg");
    // All batches run on the same child session (its conversation keeps the plan).
    expect(new Set(f.runs).size).toBe(1);
    const proposal = await f.call("proposal.get", { projectId: p.id });
    // The starter's styles.css is rewritten by batch 1, so its planned deletion is dropped.
    expect(Object.keys(proposal.files).sort()).toEqual([...ALL].sort());
    expect(proposal.partial).toBeUndefined();
    expect(job.diagnostics).toMatchObject({
      model: "acme/fast",
      contextWindow: 64_000,
      contextSource: "provider",
      outputBudget: 32_000,
      outputSource: "estimated",
      planned: true,
      batches: 2,
      continuations: 0,
      usageOutput: 11_400,
      reason: null,
    });
  });

  it("answers directly when the planning turn already holds the files (or only a reply)", async () => {
    const f = await setup();
    const p = await f.call("projects.create", { title: "X", stack: "vanilla" });
    f.respond({ text: legacy(pick("index.html", "about.html")) });
    const job = await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "go" })).jobId);
    expect(job.state).toBe("done");
    expect(f.prompts.length).toBe(1);
    expect(Object.keys((await f.call("proposal.get", { projectId: p.id })).files).sort()).toEqual([
      "about.html",
      "index.html",
    ]);
  });
});

describe("continuations after a cut answer", () => {
  it("(b) continues on the same child from the cut file and merges everything", async () => {
    const f = await setup();
    const p = await existing(f);
    f.respond(
      { text: cutInside(blocks(), "about.html"), output: 31_500 },
      {
        text: blocks(pick("about.html", "assets/logo.svg"), { meta: {}, message: "" }),
        output: 900,
      },
    );
    const job = await f.waitJob(
      (await f.call("chat.send", { projectId: p.id, text: "Bakery" })).jobId,
    );
    expect(job.state).toBe("done");
    expect(keys(job)).toContain("continuing");
    expect(job.steps.find((s: { key: string }) => s.key === "continuing").args).toEqual({
      part: 2,
    });
    expect(f.prompts[0]).not.toMatch(/PLAN FIRST/);
    expect(f.prompts[1]).toMatch(/cut off by the output limit/);
    expect(f.prompts[1]).toContain(
      "Already received complete (do not repeat them): index.html, styles.css, script.js.",
    );
    expect(f.prompts[1]).toContain("Rewrite about.html from its first line");
    expect(new Set(f.runs).size).toBe(1);
    const proposal = await f.call("proposal.get", { projectId: p.id });
    expect(proposal.files["about.html"]).toBe(LANDING["about.html"]);
    expect(proposal.files["index.html"]).toBe(LANDING["index.html"]);
    expect(proposal.partial).toBeUndefined();
    expect(job.diagnostics).toMatchObject({ continuations: 1, usageOutput: 32_400, reason: null });
  });

  it("treats an answer near the output limit without the DONE marker as cut", async () => {
    const f = await setup();
    const p = await existing(f);
    f.respond(
      { text: blocks(pick("index.html"), { done: false }), output: 31_900 },
      { text: blocks(pick("styles.css"), { meta: {}, message: "" }), output: 100 },
    );
    const job = await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "go" })).jobId);
    expect(job.diagnostics.continuations).toBe(1);
    expect(Object.keys((await f.call("proposal.get", { projectId: p.id })).files).sort()).toEqual([
      "index.html",
      "styles.css",
    ]);
  });

  it("keeps the files that arrived when continuations run out, with a clear note", async () => {
    const f = await setup();
    const p = await existing(f);
    const stillCut = cutInside(
      blocks(pick("about.html", "assets/logo.svg"), { meta: {}, message: "" }),
      "about.html",
    );
    f.respond(
      { text: cutInside(blocks(), "about.html"), output: 32_000 },
      { text: stillCut, output: 32_000 },
      { text: stillCut, output: 32_000 },
      { text: stillCut, output: 32_000 },
    );
    const job = await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "go" })).jobId);
    expect(job.state).toBe("done");
    expect(job.result.partial).toEqual({ received: 3, missing: ["about.html"] });
    expect(job.diagnostics).toMatchObject({ continuations: 3, reason: "truncated" });
    expect(f.prompts.length).toBe(4);
    const proposal = await f.call("proposal.get", { projectId: p.id });
    expect(Object.keys(proposal.files).sort()).toEqual(
      ["index.html", "styles.css"].sort().concat(["script.js"]).sort(),
    );
    expect(proposal.partial).toEqual({ received: 3, missing: ["about.html"] });
    const view = await f.call("projects.get", { projectId: p.id });
    expect(view.chat.at(-1)).toMatchObject({ role: "notice", notice: "output_partial", count: 3 });
  });

  it("fails with output_truncated, not invalid_output, when no complete file ever arrives", async () => {
    const f = await setup();
    const p = await existing(f);
    const cut = {
      status: "failed" as const,
      error:
        "The model acme/fast was cut off once by the output-token limit (32768 tokens, set by you) before it produced a usable response",
      output: 32_768,
    };
    f.respond(cut, cut, cut, cut);
    const job = await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "go" })).jobId);
    expect(job).toMatchObject({ state: "failed", error: "output_truncated" });
    expect(job.diagnostics).toMatchObject({ continuations: 3, reason: "truncated" });
    const view = await f.call("projects.get", { projectId: p.id });
    expect(view.chat.at(-1)).toMatchObject({
      notice: "generation_failed",
      code: "output_truncated",
    });
    // A cut legacy JSON answer is a truncation too.
    f.respond(
      { text: legacy().slice(0, 9_000), output: 32_000 },
      { text: blocks(pick("index.html")), output: 100 },
    );
    const second = await f.waitJob(
      (await f.call("chat.send", { projectId: p.id, text: "again" })).jobId,
    );
    expect(second.state).toBe("done");
    expect(second.diagnostics.continuations).toBe(1);
  });

  it("still reports a malformed answer as invalid_output", async () => {
    const f = await setup();
    const p = await existing(f);
    f.respond({ text: "Sorry, I will not do that.", output: 50 });
    const job = await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "go" })).jobId);
    expect(job).toMatchObject({ state: "failed", error: "invalid_output" });
    expect(job.diagnostics.reason).toBe("invalid_output");
  });
});

describe("failures and limits", () => {
  it("reports agent_failed with a category and never keeps the child's error text", async () => {
    const f = await setup();
    const p = await existing(f);
    f.respond({
      status: "failed",
      error: "429 Too Many Requests: secret-ish provider detail",
      output: 0,
    });
    const job = await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "go" })).jobId);
    expect(job).toMatchObject({ state: "failed", error: "agent_failed" });
    expect(job.diagnostics.reason).toBe("rate_limit");
    expect(JSON.stringify(job)).not.toMatch(/Too Many Requests|secret-ish/);
    const view = await f.call("projects.get", { projectId: p.id });
    expect(JSON.stringify(view.chat)).not.toMatch(/Too Many Requests/);
  });

  it("uses the reported output limit, and retries once without an estimated one the provider rejects", async () => {
    const reported = await setup({
      models: [{ reference: "acme/fast", contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
    });
    const p = await existing(reported);
    reported.respond({ text: blocks(pick("index.html")) });
    const ok = await reported.waitJob(
      (await reported.call("chat.send", { projectId: p.id, text: "go" })).jobId,
    );
    expect(reported.specs[0]?.maxOutputTokens).toBe(128_000);
    expect(ok.diagnostics).toMatchObject({
      outputBudget: 128_000,
      outputSource: "provider",
      contextSource: "provider",
    });

    // The owner's case: the catalog reports no limits (OpenCode Go).
    const f = await setup({ models: [{ reference: "acme/fast" }] });
    const q = await existing(f);
    f.respond(
      {
        status: "failed",
        error: "400 Bad Request: max_tokens is too large for this model",
        output: 0,
      },
      { text: blocks(pick("index.html")) },
    );
    const job = await f.waitJob((await f.call("chat.send", { projectId: q.id, text: "go" })).jobId);
    expect(job.state).toBe("done");
    expect(f.specs[0]?.maxOutputTokens).toBe(32_768);
    expect(f.specs[1]?.maxOutputTokens).toBeUndefined();
    expect(job.diagnostics).toMatchObject({
      contextWindow: 128_000,
      contextSource: "estimated",
      outputBudget: 32_768,
      outputSource: "estimated",
      retriedWithoutLimit: true,
    });
  });

  it("(c) accepts prose and fences around the answer through the whole flow", async () => {
    const f = await setup();
    const p = await existing(f);
    f.respond({
      text: `Here you go!\n\`\`\`\n${blocks(pick("index.html", "styles.css"))}\n\`\`\`\nEnjoy.`,
    });
    const job = await f.waitJob((await f.call("chat.send", { projectId: p.id, text: "go" })).jobId);
    expect(job.state).toBe("done");
    const proposal = await f.call("proposal.get", { projectId: p.id });
    expect(proposal.files["styles.css"]).toBe(LANDING["styles.css"]);
  });
});
